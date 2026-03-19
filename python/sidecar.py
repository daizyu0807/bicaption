#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import os
import queue
import re
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from typing import Any

import numpy as np
import sounddevice as sd
from deep_translator import GoogleTranslator
from opencc import OpenCC
import sherpa_onnx

SAMPLE_RATE = 16_000
CHANNELS = 1
TRANSLATION_BATCH_WINDOW_MS = 220
SHORT_SEGMENT_WORDS = 4
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_BASE_DIR = os.environ.get("BICAPTION_MODEL_DIR", SCRIPT_DIR)
SENSEVOICE_MODEL_DIR = os.path.join(MODEL_BASE_DIR, "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17")
WHISPER_TINY_EN_MODEL_DIR = os.path.join(MODEL_BASE_DIR, "sherpa-onnx-whisper-tiny.en")
WHISPER_SMALL_MODEL_DIR = os.path.join(MODEL_BASE_DIR, "sherpa-onnx-whisper-small")
ZIPFORMER_KOREAN_MODEL_DIR = os.path.join(MODEL_BASE_DIR, "sherpa-onnx-zipformer-korean-2024-06-24")
SILERO_VAD_MODEL = os.path.join(MODEL_BASE_DIR, "silero_vad.onnx")
APPLE_STT_BIN = os.path.join(SCRIPT_DIR, "apple-stt")
LOCAL_LLM_REWRITE_BIN = os.path.join(SCRIPT_DIR, "local-llm-rewrite.py")
DEFAULT_EMIT_CONTEXT = {
    "mode": "subtitle",
    "sessionId": "bootstrap",
}
_emit_context = dict(DEFAULT_EMIT_CONTEXT)
TRACE_PATH = os.environ.get("BICAPTION_TRACE_PATH", "").strip()


def trace_debug(message: str) -> None:
    if not TRACE_PATH:
        return
    try:
        os.makedirs(os.path.dirname(TRACE_PATH), exist_ok=True)
        with open(TRACE_PATH, "a", encoding="utf-8") as handle:
            handle.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} [python-sidecar] {message}\n")
    except OSError:
        return


def emit(event: dict[str, Any]) -> None:
    event.setdefault("mode", _emit_context["mode"])
    event.setdefault("sessionId", _emit_context["sessionId"])
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def set_emit_context(mode: str, session_id: str) -> None:
    _emit_context["mode"] = mode
    _emit_context["sessionId"] = session_id


def now_ms() -> int:
    return int(time.time() * 1000)


def normalize_text(text: str) -> str:
    return " ".join(text.strip().split())


def count_words(text: str) -> int:
    return len([token for token in re.split(r"\s+", normalize_text(text)) if token])


def looks_like_garbage_text(text: str) -> bool:
    normalized = normalize_text(text)
    if not normalized:
        return True
    compact = normalized.replace(" ", "")
    if len(compact) < 4:
        return False
    if re.search(r"(.)\1{5,}", compact):
        return True
    if re.fullmatch(r"(?:[A-Za-z]-?){6,}", normalized):
        return True
    if normalized.count("-") >= 4 and len(set(compact.lower())) <= 4:
        return True
    return False


def make_segment_id(start_ms: int, end_ms: int) -> str:
    return f"seg-{round(start_ms / 100)}-{round(end_ms / 100)}"


def build_dictation_state_event(state: str, detail: str | None = None) -> dict[str, Any]:
    event: dict[str, Any] = {
        "type": "dictation_state",
        "state": state,
    }
    if detail:
        event["detail"] = detail
    return event


def build_dictation_final_event(
    session_id: str,
    transcript_parts: list[str],
    started_at_ms: int,
    ended_at_ms: int,
    convert_s2t: bool = False,
    opencc_s2t: OpenCC | None = None,
    rewrite_mode: str = "disabled",
    source_lang: str = "auto",
    output_style: str = "polished",
    dictionary_enabled: bool = False,
    dictionary_text: str = "",
    max_rewrite_expansion_ratio: float = 1.3,
    local_llm_model: str = "",
    local_llm_runner: str = "",
) -> dict[str, Any]:
    transcript = normalize_text(" ".join(transcript_parts))
    if convert_s2t and opencc_s2t is not None and transcript:
        transcript = opencc_s2t.convert(transcript)
    dictionary_entries = parse_dictation_dictionary(dictionary_text) if dictionary_enabled else []
    dictionary_result = apply_dictation_dictionary(transcript, dictionary_entries) if dictionary_entries else transcript
    final_text = dictionary_result
    rewrite_backend = "disabled"
    rewrite_applied = False
    fallback_reason: str | None = None
    protected_terms = [canonical for _, canonical in dictionary_entries]
    if rewrite_mode != "disabled":
        rules_result = RulesRewriteProvider().rewrite(
            transcript,
            dictionary_result,
            source_lang,
            output_style,
            max_rewrite_expansion_ratio,
            protected_terms,
            local_model="",
            local_runner="",
        )
        final_text = rules_result.text
        rewrite_backend = rules_result.backend
        rewrite_applied = rules_result.applied
        fallback_reason = rules_result.fallback_reason

        provider = get_dictation_rewrite_provider(rewrite_mode)
        if provider is not None and provider.backend != "rules":
            provider_result = provider.rewrite(
                transcript,
                final_text,
                source_lang,
                output_style,
                max_rewrite_expansion_ratio,
                protected_terms,
                local_model=local_llm_model,
                local_runner=local_llm_runner,
            )
            rewrite_backend = provider_result.backend
            if provider_result.applied:
                final_text = provider_result.text
                rewrite_applied = True
                fallback_reason = provider_result.fallback_reason
            elif fallback_reason is None:
                fallback_reason = provider_result.fallback_reason

    return {
        "type": "dictation_final",
        "sessionId": session_id,
        "literalTranscript": transcript,
        "dictionaryText": dictionary_result,
        "finalText": final_text,
        "rewriteBackend": rewrite_backend,
        "rewriteApplied": rewrite_applied,
        **({"fallbackReason": fallback_reason} if fallback_reason else {}),
        "chunkCount": len(transcript_parts),
        "startedAtMs": started_at_ms,
        "endedAtMs": ended_at_ms,
        "latencyMs": max(0, ended_at_ms - started_at_ms),
    }


def parse_sensevoice_lang(lang_tag: str) -> str:
    """Extract language code from SenseVoice tag like '<|zh|>' -> 'zh'"""
    if lang_tag and lang_tag.startswith("<|") and lang_tag.endswith("|>"):
        return lang_tag[2:-2]
    return lang_tag or ""


def list_audio_devices() -> list[dict[str, Any]]:
    devices: list[dict[str, Any]] = []
    for index, device in enumerate(sd.query_devices()):
        max_inputs = int(device.get("max_input_channels", 0))
        max_outputs = int(device.get("max_output_channels", 0))
        if max_inputs <= 0 and max_outputs <= 0:
            continue
        name = str(device.get("name", ""))
        if max_inputs > 0 and max_outputs > 0:
            kind = "duplex"
            ch_label = f"{max_inputs}in/{max_outputs}out"
        elif max_inputs > 0:
            kind = "input"
            ch_label = f"{max_inputs}ch"
        else:
            kind = "output"
            ch_label = f"{max_outputs}ch"
        devices.append(
            {
                "id": name,
                "index": index,
                "name": name,
                "label": f"{name} ({ch_label})",
                "kind": kind,
                "maxInputChannels": max_inputs,
                "maxOutputChannels": max_outputs,
                "defaultSampleRate": int(device.get("default_samplerate", SAMPLE_RATE)),
            }
        )
    return devices


def resolve_device(device_id: str, require_input: bool = True) -> int | None:
    devices = sd.query_devices()
    channel_key = "max_input_channels" if require_input else "max_output_channels"

    # Try exact numeric index first
    if device_id.isdigit():
        index = int(device_id)
        if 0 <= index < len(devices) and int(devices[index].get(channel_key, 0)) > 0:
            return index

    # Try name substring match
    lowered = device_id.lower()
    for index, device in enumerate(devices):
        if int(device.get(channel_key, 0)) <= 0:
            continue
        name = str(device.get("name", ""))
        if name == device_id:
            return index
    for index, device in enumerate(devices):
        if int(device.get(channel_key, 0)) <= 0:
            continue
        name = str(device.get("name", "")).lower()
        if lowered in name:
            return index

    # Fallback: system default input/output device
    try:
        default_key = "default_input_device" if require_input else "default_output_device"
        hostapi = sd.query_hostapis(0)
        default_index = int(hostapi.get(default_key, -1))
        if default_index >= 0 and int(devices[default_index].get(channel_key, 0)) > 0:
            emit({"type": "error", "code": "device_fallback", "message": f"Device '{device_id}' not found, using default device", "recoverable": True})
            return default_index
    except Exception:
        pass

    return None


class TranslationProvider:
    def translate(self, text: str, source_lang: str, target_lang: str) -> str:
        raise NotImplementedError

    def translate_many(self, texts: list[str], source_lang: str, target_lang: str) -> list[str]:
        return [self.translate(text, source_lang, target_lang) for text in texts]


class GoogleTranslationProvider(TranslationProvider):
    def __init__(self) -> None:
        self.opencc = OpenCC("s2t")
        self.cache: dict[tuple[str, str, str], str] = {}

    def translate(self, text: str, source_lang: str, target_lang: str) -> str:
        normalized = normalize_text(text)
        if not normalized:
            return ""
        cache_key = (normalized.lower(), source_lang, target_lang.lower())
        cached = self.cache.get(cache_key)
        if cached is not None:
            return cached
        src = "auto" if source_lang in {"auto", ""} else source_lang
        tgt_google = "zh-TW" if target_lang.lower() in {"zh-tw", "zh-hant"} else target_lang
        for attempt in range(3):
            try:
                translator = GoogleTranslator(source=src, target=tgt_google)
                translated = translator.translate(normalized).strip()
                if target_lang.lower() in {"zh-tw", "zh-hant"}:
                    translated = self.opencc.convert(translated)
                self.cache[cache_key] = translated
                return translated
            except Exception as err:
                print(f"[translate] attempt {attempt+1}/3 failed ({src}→{tgt_google}): {err}", file=sys.stderr)
                if attempt < 2:
                    time.sleep(0.5 * (attempt + 1))
        return ""

    def translate_many(self, texts: list[str], source_lang: str, target_lang: str) -> list[str]:
        normalized_items = [normalize_text(text) for text in texts]
        results = [""] * len(normalized_items)
        missing_indexes: list[int] = []

        for index, item in enumerate(normalized_items):
            if not item:
                continue
            cache_key = (item.lower(), source_lang, target_lang.lower())
            cached = self.cache.get(cache_key)
            if cached is not None:
                results[index] = cached
            else:
                missing_indexes.append(index)

        if not missing_indexes:
            return results

        # Batch translate via newline-separated input
        src = "auto" if source_lang in {"auto", ""} else source_lang
        tgt_google = "zh-TW" if target_lang.lower() in {"zh-tw", "zh-hant"} else target_lang
        batch_input = "\n".join(normalized_items[index] for index in missing_indexes)
        try:
            translator = GoogleTranslator(source=src, target=tgt_google)
            translated_batch = translator.translate(batch_input).strip()
            if target_lang.lower() in {"zh-tw", "zh-hant"}:
                translated_batch = self.opencc.convert(translated_batch)
            split_batch = [part.strip() for part in translated_batch.splitlines() if part.strip()]
            if len(split_batch) == len(missing_indexes):
                for offset, index in enumerate(missing_indexes):
                    results[index] = split_batch[offset]
                    cache_key = (normalized_items[index].lower(), source_lang, target_lang.lower())
                    self.cache[cache_key] = split_batch[offset]
                return results
        except Exception as err:
            print(f"[translate_many] batch failed ({src}→{tgt_google}): {err}", file=sys.stderr)

        # Fallback: translate one by one
        for index in missing_indexes:
            results[index] = self.translate(normalized_items[index], source_lang, target_lang)
        return results


class FallbackTranslator(GoogleTranslationProvider):
    pass


@dataclass
class SessionConfig:
    mode: str
    session_id: str
    device_id: str
    output_device_id: str
    source_lang: str
    target_lang: str
    stt_model: str
    translate_model: str
    chunk_ms: int
    partial_stable_ms: int
    dictation_rewrite_mode: str = "disabled"
    dictation_dictionary_enabled: bool = False
    dictation_cloud_enhancement_enabled: bool = False
    dictation_output_style: str = "literal"
    dictation_dictionary_text: str = ""
    dictation_max_rewrite_expansion_ratio: float = 1.3
    dictation_local_llm_model: str = ""
    dictation_local_llm_runner: str = ""


@dataclass
class DictationRewriteResult:
    text: str
    backend: str
    applied: bool
    fallback_reason: str | None = None


def parse_dictation_dictionary(dictionary_text: str) -> list[tuple[str, str]]:
    entries: list[tuple[str, str]] = []
    for raw_line in dictionary_text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=>" not in line:
            continue
        spoken, canonical = (part.strip() for part in line.split("=>", 1))
        spoken_normalized = normalize_text(spoken)
        canonical_normalized = normalize_text(canonical)
        if not spoken_normalized or not canonical_normalized:
            continue
        entries.append((spoken_normalized, canonical_normalized))
    entries.sort(key=lambda item: len(item[0]), reverse=True)
    return entries


def apply_dictation_dictionary(text: str, dictionary_entries: list[tuple[str, str]]) -> str:
    result = normalize_text(text)
    if not result:
        return ""
    for spoken, canonical in dictionary_entries:
        pattern = re.compile(rf"(?<!\w){re.escape(spoken)}(?!\w)", re.IGNORECASE)
        result = pattern.sub(canonical, result)
    return normalize_text(result)


def apply_dictation_rules_rewrite(text: str) -> str:
    rewritten = normalize_text(text)
    if not rewritten:
        return ""
    filler_patterns = [
        r"\b(?:um|uh|erm|hmm|mm)\b",
        r"\b(?:那個|就是|嗯|呃|啊)\b",
    ]
    for pattern in filler_patterns:
        rewritten = re.sub(pattern, " ", rewritten, flags=re.IGNORECASE)
    rewritten = re.sub(r"\b(\w+)(?:\s+\1\b)+", r"\1", rewritten, flags=re.IGNORECASE)
    rewritten = re.sub(r"\s+([,.;:!?，。！？；：])", r"\1", rewritten)
    rewritten = re.sub(r"([,.;:!?，。！？；：]){2,}", r"\1", rewritten)
    rewritten = re.sub(r"\s+", " ", rewritten).strip(" ,.;:!?，。！？；：")
    return normalize_text(rewritten)


def should_accept_rewrite(
    base_text: str,
    rewritten_text: str,
    max_expansion_ratio: float,
    protected_terms: list[str],
) -> tuple[bool, str | None]:
    if not rewritten_text:
        return False, "rewrite_empty"
    base_compact = normalize_text(base_text)
    rewritten_compact = normalize_text(rewritten_text)
    if not base_compact:
        return False, "rewrite_empty"
    if len(rewritten_compact) > max(1, math.ceil(len(base_compact) * max_expansion_ratio)):
        return False, "rewrite_expanded_too_much"
    rewritten_lower = rewritten_compact.lower()
    for term in protected_terms:
        if term and term.lower() not in rewritten_lower:
            return False, "rewrite_dropped_dictionary_term"
    return True, None


def build_local_llm_rewrite_prompt(
    literal_transcript: str,
    dictionary_text: str,
    source_lang: str,
    output_style: str,
    protected_terms: list[str],
) -> str:
    language_label = {
        "zh": "Traditional Chinese",
        "zh-tw": "Traditional Chinese",
        "zh-hant": "Traditional Chinese",
        "en": "English",
        "ja": "Japanese",
        "ko": "Korean",
        "auto": "match input language",
        "": "match input language",
    }.get(source_lang.lower(), source_lang or "match input language")
    style_label = "polished written text" if output_style == "polished" else "literal transcript"
    protected_block = "\n".join(f"- {term}" for term in protected_terms) if protected_terms else "- None"
    return (
        "You are a deterministic dictation cleanup engine.\n"
        "Rewrite the text for direct insertion into another app.\n"
        f"Target language: {language_label}.\n"
        f"Output style: {style_label}.\n"
        "Strict rules:\n"
        "1. Keep the original meaning exactly.\n"
        "2. Do not add facts, explanations, or missing context.\n"
        "3. Do not expand fragments into complete ideas.\n"
        "4. Preserve protected terms exactly.\n"
        "5. Only fix punctuation, spacing, fillers, and obvious spoken-form phrasing.\n"
        "6. Return only the rewritten text.\n"
        "Protected terms:\n"
        f"{protected_block}\n"
        "Literal transcript:\n"
        f"{literal_transcript}\n"
        "Dictionary-corrected text:\n"
        f"{dictionary_text}"
    )


def get_local_llm_python_bin() -> str:
    env_python = os.environ.get("BICAPTION_LOCAL_LLM_PYTHON", "").strip()
    if env_python:
        return env_python
    executable_name = os.path.basename(sys.executable).lower()
    if executable_name.startswith("python"):
        return sys.executable
    project_python = os.path.join(os.path.dirname(SCRIPT_DIR), ".venv", "bin", "python")
    if os.path.exists(project_python):
        return project_python
    for candidate in ["/opt/homebrew/bin/python3", "/usr/bin/python3", "python3"]:
        if candidate == "python3" or os.path.exists(candidate):
            return candidate
    return sys.executable


class DictationRewriteProvider:
    backend = "disabled"

    def rewrite(
        self,
        literal_transcript: str,
        text: str,
        source_lang: str,
        output_style: str,
        max_expansion_ratio: float,
        protected_terms: list[str],
        local_model: str = "",
        local_runner: str = "",
    ) -> DictationRewriteResult:
        return DictationRewriteResult(text=text, backend=self.backend, applied=False)


class RulesRewriteProvider(DictationRewriteProvider):
    backend = "rules"

    def rewrite(
        self,
        literal_transcript: str,
        text: str,
        source_lang: str,
        output_style: str,
        max_expansion_ratio: float,
        protected_terms: list[str],
        local_model: str = "",
        local_runner: str = "",
    ) -> DictationRewriteResult:
        candidate = apply_dictation_rules_rewrite(text)
        accepted, fallback_reason = should_accept_rewrite(
            text,
            candidate,
            max_expansion_ratio,
            protected_terms,
        )
        if not accepted:
            return DictationRewriteResult(
                text=text,
                backend=self.backend,
                applied=False,
                fallback_reason=fallback_reason,
            )
        return DictationRewriteResult(
            text=candidate,
            backend=self.backend,
            applied=candidate != text,
        )


class UnavailableRewriteProvider(DictationRewriteProvider):
    def __init__(self, backend: str, fallback_reason: str) -> None:
        self.backend = backend
        self.fallback_reason = fallback_reason

    def rewrite(
        self,
        literal_transcript: str,
        text: str,
        source_lang: str,
        output_style: str,
        max_expansion_ratio: float,
        protected_terms: list[str],
        local_model: str = "",
        local_runner: str = "",
    ) -> DictationRewriteResult:
        return DictationRewriteResult(
            text=text,
            backend=self.backend,
            applied=False,
            fallback_reason=self.fallback_reason,
        )


class LocalLlmRewriteProvider(DictationRewriteProvider):
    backend = "local-llm"

    def __init__(self, script_path: str, timeout_seconds: float = 2.5) -> None:
        self.script_path = script_path
        self.timeout_seconds = timeout_seconds

    def rewrite(
        self,
        literal_transcript: str,
        text: str,
        source_lang: str,
        output_style: str,
        max_expansion_ratio: float,
        protected_terms: list[str],
        local_model: str = "",
        local_runner: str = "",
    ) -> DictationRewriteResult:
        if not os.path.exists(self.script_path):
            return DictationRewriteResult(
                text=text,
                backend=self.backend,
                applied=False,
                fallback_reason="local_llm_provider_missing",
            )
        prompt = build_local_llm_rewrite_prompt(
            literal_transcript=literal_transcript,
            dictionary_text=text,
            source_lang=source_lang,
            output_style=output_style,
            protected_terms=protected_terms,
        )
        payload = {
            "prompt": prompt,
            "literalTranscript": literal_transcript,
            "dictionaryText": text,
            "sourceLang": source_lang,
            "outputStyle": output_style,
            "protectedTerms": protected_terms,
            "model": local_model,
            "runner": local_runner,
        }
        try:
            result = subprocess.run(
                [get_local_llm_python_bin(), self.script_path],
                input=json.dumps(payload, ensure_ascii=False),
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return DictationRewriteResult(
                text=text,
                backend=self.backend,
                applied=False,
                fallback_reason="local_llm_timeout",
            )
        except Exception:
            return DictationRewriteResult(
                text=text,
                backend=self.backend,
                applied=False,
                fallback_reason="local_llm_provider_error",
            )

        if result.returncode != 0:
            stderr = result.stderr.strip().lower()
            if "dependency" in stderr:
                reason = "local_llm_dependency_missing"
            elif "model" in stderr:
                reason = "local_llm_model_missing"
            else:
                reason = "local_llm_provider_error"
            return DictationRewriteResult(
                text=text,
                backend=self.backend,
                applied=False,
                fallback_reason=reason,
            )

        try:
            response = json.loads(result.stdout.strip() or "{}")
        except json.JSONDecodeError:
            return DictationRewriteResult(
                text=text,
                backend=self.backend,
                applied=False,
                fallback_reason="local_llm_invalid_response",
            )

        candidate = normalize_text(str(response.get("text", "")))
        accepted, fallback_reason = should_accept_rewrite(
            text,
            candidate,
            max_expansion_ratio,
            protected_terms,
        )
        if not accepted:
            return DictationRewriteResult(
                text=text,
                backend=self.backend,
                applied=False,
                fallback_reason=fallback_reason,
            )
        return DictationRewriteResult(
            text=candidate,
            backend=self.backend,
            applied=candidate != text,
        )


def get_dictation_rewrite_provider(rewrite_mode: str) -> DictationRewriteProvider | None:
    if rewrite_mode == "rules":
        return RulesRewriteProvider()
    if rewrite_mode == "rules-and-cloud":
        return UnavailableRewriteProvider("cloud-llm", "cloud_rewrite_unavailable")
    if rewrite_mode == "rules-and-local-llm":
        return LocalLlmRewriteProvider(LOCAL_LLM_REWRITE_BIN)
    return None


@dataclass
class TranscriptChunk:
    mode: str
    session_id: str
    segment_id: str
    source_text: str
    started_at_ms: int
    ended_at_ms: int
    confidence: float
    detected_lang: str = ""


class AudioCapture:
    def __init__(self, device_id: str, chunk_ms: int, output_device_id: str | None = None) -> None:
        self.device_id = device_id
        self.device_index = resolve_device(device_id, require_input=True)
        if self.device_index is None:
            raise RuntimeError(f"Audio input device not found: {device_id}")
        self.output_device_id = output_device_id
        self.output_device_index: int | None = None
        if output_device_id and output_device_id not in {"", "none", "disabled"}:
            self.output_device_index = resolve_device(output_device_id, require_input=True)
        self.chunk_ms = max(200, chunk_ms)
        self.queue: queue.Queue[np.ndarray] = queue.Queue()
        self.output_queue: queue.Queue[np.ndarray] = queue.Queue()
        self.level = 0.0
        self.stream: sd.InputStream | None = None
        self.output_stream: sd.InputStream | None = None

    def _make_callback(self, target_queue: queue.Queue[np.ndarray], is_primary: bool = True):
        def callback(indata: np.ndarray, frames: int, _time_info: Any, status: sd.CallbackFlags) -> None:
            if status:
                emit({"type": "error", "code": "audio_callback_status", "message": str(status), "recoverable": True})
            mono = np.copy(indata[:, 0])
            if is_primary:
                self.level = max(0.0, min(1.0, math.sqrt(float(np.mean(np.abs(mono))) * 8)))
            target_queue.put(mono)
        return callback

    def start(self) -> None:
        # Use a small fixed blocksize for low-latency audio callbacks.
        # Previously tied to chunk_ms, but that created 200ms+ buffers.
        # 1024 samples = 64ms at 16kHz — matches Apple's recommended tap size.
        blocksize = 1024
        self.stream = sd.InputStream(
            samplerate=SAMPLE_RATE, channels=CHANNELS, dtype="float32",
            device=self.device_index, callback=self._make_callback(self.queue, is_primary=True),
            blocksize=blocksize,
        )
        self.stream.start()
        if self.output_device_index is not None:
            self.output_stream = sd.InputStream(
                samplerate=SAMPLE_RATE, channels=CHANNELS, dtype="float32",
                device=self.output_device_index, callback=self._make_callback(self.output_queue, is_primary=False),
                blocksize=blocksize,
            )
            self.output_stream.start()

    def stop(self) -> None:
        for s in [self.stream, self.output_stream]:
            if s is not None:
                s.stop()
                s.close()
        self.stream = None
        self.output_stream = None

    def _drain_queue(self, q: queue.Queue[np.ndarray]) -> np.ndarray:
        chunks: list[np.ndarray] = []
        while True:
            try:
                chunks.append(q.get_nowait())
            except queue.Empty:
                break
        if not chunks:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(chunks).astype(np.float32)

    def drain(self) -> np.ndarray:
        primary = self._drain_queue(self.queue)
        if self.output_device_index is None:
            return primary
        secondary = self._drain_queue(self.output_queue)
        if primary.size == 0 and secondary.size == 0:
            return np.zeros(0, dtype=np.float32)
        if primary.size == 0:
            return secondary
        if secondary.size == 0:
            return primary
        max_len = max(primary.size, secondary.size)
        if primary.size < max_len:
            primary = np.pad(primary, (0, max_len - primary.size))
        if secondary.size < max_len:
            secondary = np.pad(secondary, (0, max_len - secondary.size))
        return np.clip(primary + secondary, -1.0, 1.0).astype(np.float32)


MAX_SPEECH_SECONDS = 10.0  # Force segment split for multi-speaker scenarios
MIN_SPEECH_SAMPLES = int(SAMPLE_RATE * 0.3)  # Ignore segments shorter than 0.3s


class SenseVoiceTranscriber:
    """VAD + SenseVoice offline recognizer for near-realtime transcription."""

    def __init__(self) -> None:
        self.recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=os.path.join(SENSEVOICE_MODEL_DIR, "model.int8.onnx"),
            tokens=os.path.join(SENSEVOICE_MODEL_DIR, "tokens.txt"),
            num_threads=2,
            use_itn=True,
            language="",  # auto-detect
            debug=False,
        )
        vad_config = sherpa_onnx.VadModelConfig()
        vad_config.silero_vad.model = SILERO_VAD_MODEL
        vad_config.silero_vad.min_silence_duration = 0.3
        vad_config.silero_vad.min_speech_duration = 0.1
        vad_config.silero_vad.max_speech_duration = MAX_SPEECH_SECONDS
        vad_config.silero_vad.threshold = 0.25
        vad_config.sample_rate = SAMPLE_RATE
        self.vad = sherpa_onnx.VoiceActivityDetector(vad_config, buffer_size_in_seconds=60)
        self.vad_window = 512  # Silero VAD window for 16kHz
        self._vad_buf = np.array([], dtype=np.float32)
        self.finalized_ids: set[str] = set()
        self._segment_counter = 0

    def _recognize(self, audio: np.ndarray) -> tuple[str, str]:
        """Run SenseVoice on an audio segment, return (text, lang)."""
        stream = self.recognizer.create_stream()
        stream.accept_waveform(SAMPLE_RATE, audio)
        self.recognizer.decode_stream(stream)
        result = stream.result
        text = normalize_text(result.text)
        lang = parse_sensevoice_lang(result.lang)
        return text, lang

    def _process_vad_queue(self, base_time_ms: int) -> list[TranscriptChunk]:
        """Process all completed speech segments from VAD queue."""
        results: list[TranscriptChunk] = []
        while not self.vad.empty():
            speech = self.vad.front
            speech_samples = np.array(speech.samples, dtype=np.float32)
            self.vad.pop()

            if len(speech_samples) < MIN_SPEECH_SAMPLES:
                continue

            text, lang = self._recognize(speech_samples)
            if not text or len(text.replace(" ", "")) < 2:
                continue

            self._segment_counter += 1
            duration_ms = int(len(speech_samples) / SAMPLE_RATE * 1000)
            results.append(TranscriptChunk(
                mode=_emit_context["mode"],
                session_id=_emit_context["sessionId"],
                segment_id=f"seg-{self._segment_counter}",
                source_text=text,
                started_at_ms=base_time_ms,
                ended_at_ms=base_time_ms + duration_ms,
                confidence=0.0,
                detected_lang=lang,
            ))
        return results

    def feed_audio(self, samples: np.ndarray, base_time_ms: int) -> list[TranscriptChunk]:
        """Feed audio samples and return any completed speech segments."""
        if samples.size == 0:
            return []

        self._vad_buf = np.concatenate([self._vad_buf, samples.reshape(-1)])

        # Feed VAD in window-sized chunks
        while len(self._vad_buf) >= self.vad_window:
            chunk = self._vad_buf[:self.vad_window]
            self._vad_buf = self._vad_buf[self.vad_window:]
            self.vad.accept_waveform(chunk)

        return self._process_vad_queue(base_time_ms)

    def flush(self, base_time_ms: int) -> list[TranscriptChunk]:
        if self._vad_buf.size > 0:
            padded = np.pad(self._vad_buf, (0, max(0, self.vad_window - self._vad_buf.size % self.vad_window) % self.vad_window))
            while padded.size > 0:
                chunk = padded[:self.vad_window]
                padded = padded[self.vad_window:]
                self.vad.accept_waveform(chunk)
            self._vad_buf = np.zeros(0, dtype=np.float32)
        silence_windows = int(math.ceil(0.35 * SAMPLE_RATE / self.vad_window))
        for _ in range(max(1, silence_windows)):
            self.vad.accept_waveform(np.zeros(self.vad_window, dtype=np.float32))
        return self._process_vad_queue(base_time_ms)

    def transcribe_buffer(self, audio: np.ndarray, base_time_ms: int) -> list[TranscriptChunk]:
        if audio.size < MIN_SPEECH_SAMPLES:
            return []
        text, lang = self._recognize(audio.astype(np.float32))
        if not text or len(text.replace(" ", "")) < 2:
            return []
        self._segment_counter += 1
        duration_ms = int(audio.size / SAMPLE_RATE * 1000)
        return [TranscriptChunk(
            mode=_emit_context["mode"],
            session_id=_emit_context["sessionId"],
            segment_id=f"seg-{self._segment_counter}",
            source_text=text,
            started_at_ms=base_time_ms,
            ended_at_ms=base_time_ms + duration_ms,
            confidence=0.0,
            detected_lang=lang,
        )]


class WhisperTinyEnTranscriber:
    """VAD + Whisper tiny.en offline recognizer optimized for English."""

    def __init__(self) -> None:
        self.recognizer = sherpa_onnx.OfflineRecognizer.from_whisper(
            encoder=os.path.join(WHISPER_TINY_EN_MODEL_DIR, "tiny.en-encoder.int8.onnx"),
            decoder=os.path.join(WHISPER_TINY_EN_MODEL_DIR, "tiny.en-decoder.int8.onnx"),
            tokens=os.path.join(WHISPER_TINY_EN_MODEL_DIR, "tiny.en-tokens.txt"),
            language="en",
            task="transcribe",
            num_threads=2,
            debug=False,
        )
        vad_config = sherpa_onnx.VadModelConfig()
        vad_config.silero_vad.model = SILERO_VAD_MODEL
        vad_config.silero_vad.min_silence_duration = 0.3
        vad_config.silero_vad.min_speech_duration = 0.1
        vad_config.silero_vad.max_speech_duration = MAX_SPEECH_SECONDS
        vad_config.silero_vad.threshold = 0.25
        vad_config.sample_rate = SAMPLE_RATE
        self.vad = sherpa_onnx.VoiceActivityDetector(vad_config, buffer_size_in_seconds=60)
        self.vad_window = 512
        self._vad_buf = np.array([], dtype=np.float32)
        self.finalized_ids: set[str] = set()
        self._segment_counter = 0

    def _recognize(self, audio: np.ndarray) -> tuple[str, str]:
        stream = self.recognizer.create_stream()
        stream.accept_waveform(SAMPLE_RATE, audio)
        self.recognizer.decode_stream(stream)
        text = normalize_text(stream.result.text)
        return text, "en"

    def _process_vad_queue(self, base_time_ms: int) -> list[TranscriptChunk]:
        results: list[TranscriptChunk] = []
        while not self.vad.empty():
            speech = self.vad.front
            speech_samples = np.array(speech.samples, dtype=np.float32)
            self.vad.pop()

            if len(speech_samples) < MIN_SPEECH_SAMPLES:
                continue

            text, lang = self._recognize(speech_samples)
            if not text or len(text.replace(" ", "")) < 2:
                continue

            self._segment_counter += 1
            duration_ms = int(len(speech_samples) / SAMPLE_RATE * 1000)
            results.append(TranscriptChunk(
                mode=_emit_context["mode"],
                session_id=_emit_context["sessionId"],
                segment_id=f"seg-{self._segment_counter}",
                source_text=text,
                started_at_ms=base_time_ms,
                ended_at_ms=base_time_ms + duration_ms,
                confidence=0.0,
                detected_lang=lang,
            ))
        return results

    def feed_audio(self, samples: np.ndarray, base_time_ms: int) -> list[TranscriptChunk]:
        if samples.size == 0:
            return []

        self._vad_buf = np.concatenate([self._vad_buf, samples.reshape(-1)])

        while len(self._vad_buf) >= self.vad_window:
            chunk = self._vad_buf[:self.vad_window]
            self._vad_buf = self._vad_buf[self.vad_window:]
            self.vad.accept_waveform(chunk)

        return self._process_vad_queue(base_time_ms)

    def flush(self, base_time_ms: int) -> list[TranscriptChunk]:
        if self._vad_buf.size > 0:
            padded = np.pad(self._vad_buf, (0, max(0, self.vad_window - self._vad_buf.size % self.vad_window) % self.vad_window))
            while padded.size > 0:
                chunk = padded[:self.vad_window]
                padded = padded[self.vad_window:]
                self.vad.accept_waveform(chunk)
            self._vad_buf = np.zeros(0, dtype=np.float32)
        silence_windows = int(math.ceil(0.35 * SAMPLE_RATE / self.vad_window))
        for _ in range(max(1, silence_windows)):
            self.vad.accept_waveform(np.zeros(self.vad_window, dtype=np.float32))
        return self._process_vad_queue(base_time_ms)

    def transcribe_buffer(self, audio: np.ndarray, base_time_ms: int) -> list[TranscriptChunk]:
        if audio.size < MIN_SPEECH_SAMPLES:
            return []
        text, lang = self._recognize(audio.astype(np.float32))
        if not text or len(text.replace(" ", "")) < 2:
            return []
        self._segment_counter += 1
        duration_ms = int(audio.size / SAMPLE_RATE * 1000)
        return [TranscriptChunk(
            mode=_emit_context["mode"],
            session_id=_emit_context["sessionId"],
            segment_id=f"seg-{self._segment_counter}",
            source_text=text,
            started_at_ms=base_time_ms,
            ended_at_ms=base_time_ms + duration_ms,
            confidence=0.0,
            detected_lang=lang,
        )]


class WhisperSmallTranscriber:
    """VAD + Whisper small multilingual recognizer for ja/ko and other languages."""

    def __init__(self, language: str = "") -> None:
        self.recognizer = sherpa_onnx.OfflineRecognizer.from_whisper(
            encoder=os.path.join(WHISPER_SMALL_MODEL_DIR, "small-encoder.int8.onnx"),
            decoder=os.path.join(WHISPER_SMALL_MODEL_DIR, "small-decoder.int8.onnx"),
            tokens=os.path.join(WHISPER_SMALL_MODEL_DIR, "small-tokens.txt"),
            language=language or "",
            task="transcribe",
            num_threads=2,
            debug=False,
        )
        self._language = language
        vad_config = sherpa_onnx.VadModelConfig()
        vad_config.silero_vad.model = SILERO_VAD_MODEL
        vad_config.silero_vad.min_silence_duration = 0.3
        vad_config.silero_vad.min_speech_duration = 0.1
        vad_config.silero_vad.max_speech_duration = MAX_SPEECH_SECONDS
        vad_config.silero_vad.threshold = 0.25
        vad_config.sample_rate = SAMPLE_RATE
        self.vad = sherpa_onnx.VoiceActivityDetector(vad_config, buffer_size_in_seconds=60)
        self.vad_window = 512
        self._vad_buf = np.array([], dtype=np.float32)
        self.finalized_ids: set[str] = set()
        self._segment_counter = 0

    def _recognize(self, audio: np.ndarray) -> tuple[str, str]:
        stream = self.recognizer.create_stream()
        stream.accept_waveform(SAMPLE_RATE, audio)
        self.recognizer.decode_stream(stream)
        text = normalize_text(stream.result.text)
        lang = self._language or "auto"
        return text, lang

    def _process_vad_queue(self, base_time_ms: int) -> list[TranscriptChunk]:
        results: list[TranscriptChunk] = []
        while not self.vad.empty():
            speech = self.vad.front
            speech_samples = np.array(speech.samples, dtype=np.float32)
            self.vad.pop()

            if len(speech_samples) < MIN_SPEECH_SAMPLES:
                continue

            text, lang = self._recognize(speech_samples)
            if not text or len(text.replace(" ", "")) < 2:
                continue

            self._segment_counter += 1
            duration_ms = int(len(speech_samples) / SAMPLE_RATE * 1000)
            results.append(TranscriptChunk(
                mode=_emit_context["mode"],
                session_id=_emit_context["sessionId"],
                segment_id=f"seg-{self._segment_counter}",
                source_text=text,
                started_at_ms=base_time_ms,
                ended_at_ms=base_time_ms + duration_ms,
                confidence=0.0,
                detected_lang=lang,
            ))
        return results

    def feed_audio(self, samples: np.ndarray, base_time_ms: int) -> list[TranscriptChunk]:
        if samples.size == 0:
            return []

        self._vad_buf = np.concatenate([self._vad_buf, samples.reshape(-1)])

        while len(self._vad_buf) >= self.vad_window:
            chunk = self._vad_buf[:self.vad_window]
            self._vad_buf = self._vad_buf[self.vad_window:]
            self.vad.accept_waveform(chunk)

        return self._process_vad_queue(base_time_ms)

    def flush(self, base_time_ms: int) -> list[TranscriptChunk]:
        if self._vad_buf.size > 0:
            padded = np.pad(self._vad_buf, (0, max(0, self.vad_window - self._vad_buf.size % self.vad_window) % self.vad_window))
            while padded.size > 0:
                chunk = padded[:self.vad_window]
                padded = padded[self.vad_window:]
                self.vad.accept_waveform(chunk)
            self._vad_buf = np.zeros(0, dtype=np.float32)
        silence_windows = int(math.ceil(0.35 * SAMPLE_RATE / self.vad_window))
        for _ in range(max(1, silence_windows)):
            self.vad.accept_waveform(np.zeros(self.vad_window, dtype=np.float32))
        return self._process_vad_queue(base_time_ms)

    def transcribe_buffer(self, audio: np.ndarray, base_time_ms: int) -> list[TranscriptChunk]:
        if audio.size < MIN_SPEECH_SAMPLES:
            return []
        text, lang = self._recognize(audio.astype(np.float32))
        if not text or len(text.replace(" ", "")) < 2:
            return []
        self._segment_counter += 1
        duration_ms = int(audio.size / SAMPLE_RATE * 1000)
        return [TranscriptChunk(
            mode=_emit_context["mode"],
            session_id=_emit_context["sessionId"],
            segment_id=f"seg-{self._segment_counter}",
            source_text=text,
            started_at_ms=base_time_ms,
            ended_at_ms=base_time_ms + duration_ms,
            confidence=0.0,
            detected_lang=lang,
        )]


class ZipformerKoreanTranscriber:
    """VAD + Zipformer transducer optimized for Korean."""

    def __init__(self) -> None:
        self.recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=os.path.join(ZIPFORMER_KOREAN_MODEL_DIR, "encoder-epoch-99-avg-1.int8.onnx"),
            decoder=os.path.join(ZIPFORMER_KOREAN_MODEL_DIR, "decoder-epoch-99-avg-1.onnx"),
            joiner=os.path.join(ZIPFORMER_KOREAN_MODEL_DIR, "joiner-epoch-99-avg-1.int8.onnx"),
            tokens=os.path.join(ZIPFORMER_KOREAN_MODEL_DIR, "tokens.txt"),
            num_threads=2,
            debug=False,
        )
        vad_config = sherpa_onnx.VadModelConfig()
        vad_config.silero_vad.model = SILERO_VAD_MODEL
        vad_config.silero_vad.min_silence_duration = 0.3
        vad_config.silero_vad.min_speech_duration = 0.1
        vad_config.silero_vad.max_speech_duration = MAX_SPEECH_SECONDS
        vad_config.silero_vad.threshold = 0.25
        vad_config.sample_rate = SAMPLE_RATE
        self.vad = sherpa_onnx.VoiceActivityDetector(vad_config, buffer_size_in_seconds=60)
        self.vad_window = 512
        self._vad_buf = np.array([], dtype=np.float32)
        self.finalized_ids: set[str] = set()
        self._segment_counter = 0

    def _recognize(self, audio: np.ndarray) -> tuple[str, str]:
        stream = self.recognizer.create_stream()
        stream.accept_waveform(SAMPLE_RATE, audio)
        self.recognizer.decode_stream(stream)
        text = normalize_text(stream.result.text)
        return text, "ko"

    def _process_vad_queue(self, base_time_ms: int) -> list[TranscriptChunk]:
        results: list[TranscriptChunk] = []
        while not self.vad.empty():
            speech = self.vad.front
            speech_samples = np.array(speech.samples, dtype=np.float32)
            self.vad.pop()

            if len(speech_samples) < MIN_SPEECH_SAMPLES:
                continue

            text, lang = self._recognize(speech_samples)
            if not text or len(text.replace(" ", "")) < 2:
                continue

            self._segment_counter += 1
            duration_ms = int(len(speech_samples) / SAMPLE_RATE * 1000)
            results.append(TranscriptChunk(
                mode=_emit_context["mode"],
                session_id=_emit_context["sessionId"],
                segment_id=f"seg-{self._segment_counter}",
                source_text=text,
                started_at_ms=base_time_ms,
                ended_at_ms=base_time_ms + duration_ms,
                confidence=0.0,
                detected_lang=lang,
            ))
        return results

    def feed_audio(self, samples: np.ndarray, base_time_ms: int) -> list[TranscriptChunk]:
        if samples.size == 0:
            return []

        self._vad_buf = np.concatenate([self._vad_buf, samples.reshape(-1)])

        while len(self._vad_buf) >= self.vad_window:
            chunk = self._vad_buf[:self.vad_window]
            self._vad_buf = self._vad_buf[self.vad_window:]
            self.vad.accept_waveform(chunk)

        return self._process_vad_queue(base_time_ms)

    def flush(self, base_time_ms: int) -> list[TranscriptChunk]:
        if self._vad_buf.size > 0:
            padded = np.pad(self._vad_buf, (0, max(0, self.vad_window - self._vad_buf.size % self.vad_window) % self.vad_window))
            while padded.size > 0:
                chunk = padded[:self.vad_window]
                padded = padded[self.vad_window:]
                self.vad.accept_waveform(chunk)
            self._vad_buf = np.zeros(0, dtype=np.float32)
        silence_windows = int(math.ceil(0.35 * SAMPLE_RATE / self.vad_window))
        for _ in range(max(1, silence_windows)):
            self.vad.accept_waveform(np.zeros(self.vad_window, dtype=np.float32))
        return self._process_vad_queue(base_time_ms)

    def transcribe_buffer(self, audio: np.ndarray, base_time_ms: int) -> list[TranscriptChunk]:
        if audio.size < MIN_SPEECH_SAMPLES:
            return []
        text, lang = self._recognize(audio.astype(np.float32))
        if not text or len(text.replace(" ", "")) < 2:
            return []
        self._segment_counter += 1
        duration_ms = int(audio.size / SAMPLE_RATE * 1000)
        return [TranscriptChunk(
            mode=_emit_context["mode"],
            session_id=_emit_context["sessionId"],
            segment_id=f"seg-{self._segment_counter}",
            source_text=text,
            started_at_ms=base_time_ms,
            ended_at_ms=base_time_ms + duration_ms,
            confidence=0.0,
            detected_lang=lang,
        )]


class AppleSttTranscriber:
    """Apple SFSpeechRecognizer via compiled Swift binary.

    Receives PCM float32 16 kHz mono from AudioCapture via stdin,
    outputs JSON lines on stdout matching the sidecar event protocol.
    """

    # Map source language codes to Apple locale identifiers
    LOCALE_MAP: dict[str, str] = {
        "en": "en-US", "zh": "zh-CN", "zh-TW": "zh-TW", "ja": "ja-JP",
        "ko": "ko-KR", "fr": "fr-FR", "de": "de-DE", "es": "es-ES",
        "it": "it-IT", "pt": "pt-BR", "ru": "ru-RU", "th": "th-TH",
        "vi": "vi-VN", "id": "id-ID", "ms": "ms-MY", "ar": "ar-SA",
        "hi": "hi-IN", "auto": "en-US",
    }

    # Minimum word count before a delta can be promoted to final.
    MIN_PROMOTE_WORDS = 7
    # Short deltas (below MIN_PROMOTE_WORDS) wait this long instead.
    SHORT_DELTA_STABLE_MS = 900
    # Sentence-ending punctuation triggers immediate promote regardless of
    # word count (the speaker finished a thought).
    SENTENCE_END_RE = re.compile(r'[.!?。！？]$')
    # How many trailing words Apple is allowed to modify in-place.
    # Earlier words are "frozen" (we keep our longer version).
    UNLOCK_TAIL_WORDS = 3
    # Number of recent promoted texts to keep for deduplication.
    DEDUP_HISTORY = 10

    def __init__(self, source_lang: str = "en", partial_stable_ms: int = 600) -> None:
        self.partial_stable_ms = partial_stable_ms
        self.locale = self.LOCALE_MAP.get(source_lang, source_lang)
        self.detected_lang = source_lang if source_lang != "auto" else "en"
        self.finalized_ids: set[str] = set()
        self._segment_counter = 0
        self._proc: subprocess.Popen | None = None
        self._results: queue.Queue[dict[str, Any]] = queue.Queue()
        self._reader_thread: threading.Thread | None = None
        self._last_partial_text = ""
        self._last_partial_change_ms = 0
        # Promote offset — advances when chunks are promoted for save/translate.
        self._promoted_len = 0
        self._promoted_text = ""
        # Display offset — only resets on 55s task restart.  Keeps the
        # overlay showing continuous text independent of promote cycles.
        self._display_offset = 0
        self._display_offset_text = ""
        # Display stabilization: track the longest displayed delta so that
        # Apple's retroactive word deletions don't cause text to vanish.
        self._last_stable_display: str = ""
        # Recent promoted texts for deduplication (prevents re-emitting
        # already-promoted content when offset calculation drifts).
        self._recent_promoted: list[str] = []

    def _find_promoted_offset(self, cumulative: str, for_display: bool = False) -> int:
        """Find where new (unpromoted) text begins in the cumulative string.

        Apple's SFSpeechRecognizer retroactively edits earlier text (adding
        punctuation, correcting words), so a simple character offset drifts.
        We try the stored offset first, then fall back to finding the last
        few words of the promoted text in the cumulative string.

        The returned offset is always snapped to a word boundary (the next
        space character) so that delta text never starts mid-word.

        for_display: when True (overlay partial), prefer returning 0 on
            failure (show everything) rather than clamped offset (show nothing).
            For promote-to-final, we prefer the clamped offset to avoid
            duplicating already-promoted text.
        """
        if self._promoted_len == 0:
            return 0

        # If cumulative is much shorter than what we promoted, Apple likely
        # restarted its recognition task and the final event hasn't arrived
        # yet.  Treat this as a fresh start — show everything.
        if len(cumulative) < self._promoted_len * 0.5:
            return 0

        raw_offset = -1

        # Fast path: offset still valid (cumulative text wasn't retroactively edited)
        if self._promoted_len <= len(cumulative):
            prefix = cumulative[:self._promoted_len]
            if self._promoted_text and prefix.rstrip().endswith(self._promoted_text.rstrip()[-8:]):
                raw_offset = self._promoted_len

        # Slow path: find the last few words of promoted text in cumulative
        if raw_offset < 0 and self._promoted_text:
            words = self._promoted_text.rstrip().split()
            for anchor_len in (3, 2, 1):
                if len(words) < anchor_len:
                    continue
                anchor = " ".join(words[-anchor_len:])
                idx = cumulative.rfind(anchor)
                if idx >= 0:
                    raw_offset = idx + len(anchor)
                    break

        if raw_offset < 0:
            # Anchor not found — promoted text was heavily rewritten.
            if for_display:
                return 0
            return min(self._promoted_len, len(cumulative))

        # Snap to word boundary: if we landed mid-word, scan forward to
        # the next whitespace so delta never starts with a partial word
        # like "rst" or "ersation".
        if raw_offset < len(cumulative) and raw_offset > 0 and cumulative[raw_offset - 1] != ' ':
            # Check if the character at offset is not a space — we're mid-word
            if cumulative[raw_offset] not in (' ', ',', '.', '!', '?'):
                next_space = cumulative.find(' ', raw_offset)
                if next_space >= 0:
                    raw_offset = next_space + 1
                else:
                    raw_offset = len(cumulative)

        return raw_offset

    @staticmethod
    def _find_promoted_offset_with(cumulative: str, stored_offset: int, stored_text: str) -> int | None:
        """Re-align a stored offset against a (possibly edited) cumulative string.

        Returns the corrected offset, or None if alignment fails completely.
        """
        if stored_offset == 0:
            return 0
        if len(cumulative) < stored_offset * 0.5:
            return 0
        # Fast check
        if stored_offset <= len(cumulative):
            prefix = cumulative[:stored_offset]
            if stored_text and prefix.rstrip().endswith(stored_text.rstrip()[-8:]):
                return stored_offset
        # Anchor search
        if stored_text:
            words = stored_text.rstrip().split()
            for anchor_len in (3, 2, 1):
                if len(words) < anchor_len:
                    continue
                anchor = " ".join(words[-anchor_len:])
                idx = cumulative.rfind(anchor)
                if idx >= 0:
                    off = idx + len(anchor)
                    # Snap to word boundary
                    if off < len(cumulative) and off > 0 and cumulative[off - 1] != ' ':
                        if cumulative[off] not in (' ', ',', '.', '!', '?'):
                            ns = cumulative.find(' ', off)
                            off = ns + 1 if ns >= 0 else len(cumulative)
                    return off
        return None

    def _is_duplicate(self, text: str) -> bool:
        """Check if text substantially overlaps with recently promoted chunks."""
        if not self._recent_promoted:
            return False
        new_words = set(normalize_text(text).lower().split())
        if not new_words:
            return False
        for prev in self._recent_promoted:
            prev_words = set(normalize_text(prev).lower().split())
            if not prev_words:
                continue
            overlap = len(new_words & prev_words)
            # If >60% of the new text's words already appeared in a recent
            # promoted chunk, treat it as a duplicate.
            if overlap / len(new_words) > 0.6:
                return True
        return False

    def _record_promoted(self, text: str) -> None:
        """Record promoted text for deduplication."""
        self._recent_promoted.append(text)
        if len(self._recent_promoted) > self.DEDUP_HISTORY:
            self._recent_promoted.pop(0)

    @staticmethod
    def _clean_leading_fragment(delta: str) -> str:
        """Strip leading punctuation or partial-word fragments from delta.

        After word-boundary snapping, the main remaining issue is leading
        punctuation like ", but it's actually" — strip leading commas/periods
        that clearly belong to the previous promoted chunk.
        """
        if not delta:
            return delta
        # Strip leading punctuation + whitespace (e.g. ", but..." → "but...")
        cleaned = delta.lstrip(' ,;:')
        return cleaned if cleaned else delta

    def _stabilize_display_text(self, raw_delta: str) -> str:
        """Prevent Apple's retroactive edits from deleting displayed words.

        Strategy: words only accumulate, never disappear.  If Apple's new
        partial has fewer words than what we last displayed, keep the old
        (longer) prefix and only accept Apple's corrections on the last
        UNLOCK_TAIL_WORDS words.

        This mimics Apple Live Caption where words appear and stay put.
        """
        if not raw_delta:
            return self._last_stable_display or ""

        new_words = raw_delta.split()
        old_words = self._last_stable_display.split() if self._last_stable_display else []

        if len(new_words) >= len(old_words):
            # Same or more words — accept Apple's full version
            self._last_stable_display = raw_delta
        else:
            # Apple shortened text — keep our longer prefix, accept Apple's
            # corrections only on the trailing UNLOCK_TAIL_WORDS.
            keep = max(0, len(old_words) - self.UNLOCK_TAIL_WORDS)
            tail_from_apple = new_words[-self.UNLOCK_TAIL_WORDS:] if new_words else []
            stabilized = old_words[:keep] + tail_from_apple
            self._last_stable_display = " ".join(stabilized)

        return self._last_stable_display

    def _reset_display_stable(self) -> None:
        """Reset display stabilization (called on task restart or promote)."""
        self._last_stable_display = ""

    def start(self) -> None:
        if not os.path.isfile(APPLE_STT_BIN):
            raise RuntimeError(
                f"Apple STT binary not found at {APPLE_STT_BIN}. "
                "Run: bash scripts/build-apple-stt.sh"
            )
        self._proc = subprocess.Popen(
            [APPLE_STT_BIN, "--locale", self.locale],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        self._reader_thread = threading.Thread(target=self._read_stdout, daemon=True)
        self._reader_thread.start()
        stderr_thread = threading.Thread(target=self._read_stderr, daemon=True)
        stderr_thread.start()
        # Wait for "ready" event (up to 5 seconds)
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            try:
                event = self._results.get(timeout=0.1)
                if event.get("type") == "ready":
                    break
                # Put non-ready events back
                self._results.put(event)
            except queue.Empty:
                continue

    def stop(self) -> None:
        proc = self._proc
        self._proc = None
        if proc and proc.poll() is None:
            # Close stdin to signal EOF and let apple-stt flush its final partial.
            if proc.stdin:
                try:
                    proc.stdin.close()
                except OSError:
                    pass
            try:
                proc.wait(timeout=1.2)
            except subprocess.TimeoutExpired:
                proc.terminate()
                try:
                    proc.wait(timeout=1.5)
                except subprocess.TimeoutExpired:
                    proc.kill()

    def _read_stdout(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        for raw_line in self._proc.stdout:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                event = json.loads(line)
                self._results.put(event)
            except json.JSONDecodeError:
                pass

    def _read_stderr(self) -> None:
        assert self._proc is not None and self._proc.stderr is not None
        for raw_line in self._proc.stderr:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if line:
                emit({"type": "error", "code": "apple_stt_stderr", "message": line, "recoverable": True})

    def feed_audio(self, samples: np.ndarray, base_time_ms: int) -> list[TranscriptChunk]:
        """Feed PCM float32 audio to the binary's stdin and drain results."""
        if self._proc is not None and self._proc.stdin is not None and samples.size > 0:
            try:
                self._proc.stdin.write(samples.astype(np.float32).tobytes())
                self._proc.stdin.flush()
            except (OSError, BrokenPipeError):
                emit({"type": "error", "code": "apple_stt_pipe", "message": "Apple STT stdin pipe broken", "recoverable": False})

        # Drain results from stdout reader
        results: list[TranscriptChunk] = []
        latest_partial_text = ""
        while True:
            try:
                event = self._results.get_nowait()
            except queue.Empty:
                break
            event_type = event.get("type", "")
            if event_type == "final":
                # Binary restarted its recognition task (55s limit).
                # Don't use the binary's final text directly — it's the full
                # cumulative text which we've already promoted in pieces.
                # Instead, force-promote any remaining unstable partial delta.
                if self._last_partial_text:
                    offset = self._find_promoted_offset(self._last_partial_text, for_display=False)
                    delta = self._clean_leading_fragment(self._last_partial_text[offset:].lstrip())
                    if delta and len(delta.replace(" ", "")) >= 2 and not self._is_duplicate(delta):
                        self._segment_counter += 1
                        seg_id = f"apple-seg-{self._segment_counter}"
                        results.append(TranscriptChunk(
                            mode=_emit_context["mode"],
                            session_id=_emit_context["sessionId"],
                            segment_id=seg_id,
                            source_text=delta,
                            started_at_ms=base_time_ms,
                            ended_at_ms=now_ms(),
                            confidence=float(event.get("confidence", 0.0)),
                            detected_lang=self.detected_lang,
                        ))
                        self._record_promoted(delta)
                # Reset for new recognition task (also clear dedup history
                # since the new task starts fresh cumulative text).
                self._promoted_len = 0
                self._promoted_text = ""
                self._display_offset = 0
                self._display_offset_text = ""
                self._reset_display_stable()
                self._recent_promoted.clear()
                self._last_partial_text = ""
                self._last_partial_change_ms = 0
                # Discard any partials from the OLD task that were queued
                # before this final — they'd replay with _promoted_len=0.
                latest_partial_text = ""
            elif event_type == "partial":
                latest_partial_text = normalize_text(event.get("text", ""))
            elif event_type == "error":
                emit({
                    "type": "error",
                    "code": event.get("code", "apple_stt_error"),
                    "message": event.get("message", "Unknown Apple STT error"),
                    "recoverable": event.get("recoverable", True),
                })

        # Track partial text changes for stabilization.
        # SFSpeechRecognizer partials are cumulative — each partial contains
        # the full text from the start of the recognition task.
        if latest_partial_text:
            if latest_partial_text != self._last_partial_text:
                self._last_partial_text = latest_partial_text
                self._last_partial_change_ms = now_ms()
            # Overlay uses _display_offset (not _promoted_len) so that promote
            # cycles don't cause the visible text to vanish.  Display offset
            # only resets on 55s task restart.
            display_off = self._display_offset
            if self._display_offset_text:
                # Re-align display offset if Apple retroactively edited text
                tmp = self._find_promoted_offset_with(
                    latest_partial_text, self._display_offset, self._display_offset_text)
                if tmp is not None:
                    display_off = tmp
            raw_delta = self._clean_leading_fragment(latest_partial_text[display_off:].lstrip())
            delta = self._stabilize_display_text(raw_delta)
            if delta and _emit_context["mode"] == "subtitle":
                next_id = f"apple-seg-{self._segment_counter + 1}"
                emit({
                    "type": "partial_caption",
                    "mode": _emit_context["mode"],
                    "sessionId": _emit_context["sessionId"],
                    "segmentId": next_id,
                    "sourceText": delta,
                    "startedAtMs": base_time_ms,
                    "updatedAtMs": now_ms(),
                })

        # Promote stable partial → final for translation.
        if (
            self._last_partial_text
            and self._last_partial_change_ms > 0
        ):
            full_text = self._last_partial_text
            offset = self._find_promoted_offset(full_text, for_display=False)
            delta = full_text[offset:].lstrip()
            delta = self._clean_leading_fragment(delta)
            delta_words = count_words(delta) if delta else 0
            stable_ms = now_ms() - self._last_partial_change_ms

            # Determine if we should promote now.
            # Three conditions can trigger promotion:
            # 1. Enough words (≥MIN_PROMOTE_WORDS) and stable long enough
            # 2. Sentence boundary detected (period/question mark) and stable
            # 3. Short fragment waited extra long (SHORT_DELTA_STABLE_MS)
            has_sentence_end = bool(self.SENTENCE_END_RE.search(delta)) if delta else False
            enough_words = delta_words >= self.MIN_PROMOTE_WORDS

            should_promote = False
            if enough_words and stable_ms >= self.partial_stable_ms:
                should_promote = True
            elif has_sentence_end and delta_words >= 2 and stable_ms >= self.partial_stable_ms:
                # Sentence boundary — promote even if below MIN_PROMOTE_WORDS
                should_promote = True
            elif stable_ms >= self.SHORT_DELTA_STABLE_MS and delta_words >= 1:
                # Long silence fallback — promote whatever we have
                should_promote = True

            if should_promote and delta and len(delta.replace(" ", "")) >= 2:
                if not self._is_duplicate(delta):
                    self._segment_counter += 1
                    seg_id = f"apple-seg-{self._segment_counter}"
                    results.append(TranscriptChunk(
                        mode=_emit_context["mode"],
                        session_id=_emit_context["sessionId"],
                        segment_id=seg_id,
                        source_text=delta,
                        started_at_ms=base_time_ms,
                        ended_at_ms=now_ms(),
                        confidence=0.0,
                        detected_lang=self.detected_lang,
                    ))
                    self._record_promoted(delta)
                self._promoted_len = len(full_text)
                self._promoted_text = full_text
                self._display_offset = len(full_text)
                self._display_offset_text = full_text
                self._reset_display_stable()
                self._last_partial_text = ""
                self._last_partial_change_ms = 0

        return results


class SidecarApp:
    def __init__(self) -> None:
        self.active = False
        self.thread: threading.Thread | None = None
        self.stop_event = threading.Event()
        self.config: SessionConfig | None = None
        self.capture: AudioCapture | None = None
        self.transcriber: SenseVoiceTranscriber | WhisperTinyEnTranscriber | WhisperSmallTranscriber | ZipformerKoreanTranscriber | AppleSttTranscriber | None = None
        self.translator: TranslationProvider | None = None
        self.opencc_s2t = OpenCC("s2t")
        self.dictation_parts: list[str] = []
        self.dictation_started_at_ms = 0
        self.dictation_last_update_ms = 0
        self.dictation_max_input_level = 0.0
        self.dictation_audio_buffer: list[np.ndarray] = []
        self.translation_queue: queue.Queue[tuple[TranscriptChunk, SessionConfig]] = queue.Queue()
        self.translation_worker = threading.Thread(target=self._translation_loop, daemon=True)
        self.translation_worker.start()

    def run(self) -> int:
        emit({"type": "session_state", "state": "idle"})
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                emit({"type": "error", "code": "invalid_json", "message": "Command must be valid JSON", "recoverable": True})
                continue

            command = message.get("command")
            payload = message.get("payload", {})
            if command == "start_session":
                self.start_session(payload)
            elif command == "stop_session":
                self.stop_session()
            elif command == "ping":
                emit({"type": "metrics", "inputLevel": 0, "processingLagMs": 0, "queueDepth": 0})
            else:
                emit({"type": "error", "code": "unknown_command", "message": f"Unsupported command: {command}", "recoverable": True})
        self.stop_session()
        return 0

    def start_session(self, payload: dict[str, Any]) -> None:
        trace_debug(f"start_session enter active={self.active} payload_session={payload.get('sessionId', '')}")
        if self.active:
            trace_debug("start_session detected existing active session; stopping first")
            self.stop_session()

        self.config = SessionConfig(
            mode=str(payload.get("mode", "subtitle")),
            session_id=str(payload.get("sessionId", f"session-{now_ms()}")),
            device_id=str(payload.get("deviceId", "blackhole")),
            output_device_id=str(payload.get("outputDeviceId", "")),
            source_lang=str(payload.get("sourceLang", "auto")),
            target_lang=str(payload.get("targetLang", "zh-TW")),
            stt_model=str(payload.get("sttModel", "sensevoice")),
            translate_model=str(payload.get("translateModel", "google")),
            chunk_ms=int(payload.get("chunkMs", 400)),
            partial_stable_ms=int(payload.get("partialStableMs", 500)),
            dictation_rewrite_mode=str(payload.get("dictationRewriteMode", "disabled")),
            dictation_dictionary_enabled=bool(payload.get("dictationDictionaryEnabled", False)),
            dictation_cloud_enhancement_enabled=bool(payload.get("dictationCloudEnhancementEnabled", False)),
            dictation_output_style=str(payload.get("dictationOutputStyle", "literal")),
            dictation_dictionary_text=str(payload.get("dictationDictionaryText", "")),
            dictation_max_rewrite_expansion_ratio=float(payload.get("dictationMaxRewriteExpansionRatio", 1.3)),
            dictation_local_llm_model=str(payload.get("dictationLocalLlmModel", "")),
            dictation_local_llm_runner=str(payload.get("dictationLocalLlmRunner", "")),
        )
        set_emit_context(self.config.mode, self.config.session_id)
        if self.config.mode == "dictation":
            self.dictation_parts = []
            self.dictation_started_at_ms = now_ms()
            self.dictation_last_update_ms = self.dictation_started_at_ms
            self.dictation_max_input_level = 0.0
            self.dictation_audio_buffer = []
            emit(build_dictation_state_event("recording", "Dictation session started"))
            trace_debug(f"dictation recording session={self.config.session_id}")
        self.stop_event.clear()
        self.active = True
        emit({"type": "session_state", "state": "connecting", "detail": f"Connecting to {self.config.device_id}"})

        try:
            self.capture = AudioCapture(self.config.device_id, self.config.chunk_ms, self.config.output_device_id)
            self.capture.start()
            if self.config.stt_model == "apple-stt":
                emit({"type": "session_state", "state": "connecting", "detail": "Starting Apple Speech Recognition..."})
                transcriber = AppleSttTranscriber(
                    source_lang=self.config.source_lang,
                    partial_stable_ms=self.config.partial_stable_ms,
                )
                transcriber.start()
                self.transcriber = transcriber
            elif self.config.stt_model == "whisper-tiny-en":
                emit({"type": "session_state", "state": "connecting", "detail": "Loading Whisper tiny.en model..."})
                self.transcriber = WhisperTinyEnTranscriber()
            elif self.config.stt_model == "whisper-small":
                lang = self.config.source_lang if self.config.source_lang != "auto" else ""
                emit({"type": "session_state", "state": "connecting", "detail": "Loading Whisper small model..."})
                self.transcriber = WhisperSmallTranscriber(language=lang)
            elif self.config.stt_model == "zipformer-ko":
                emit({"type": "session_state", "state": "connecting", "detail": "Loading Zipformer Korean model..."})
                self.transcriber = ZipformerKoreanTranscriber()
            else:
                emit({"type": "session_state", "state": "connecting", "detail": "Loading SenseVoice model..."})
                self.transcriber = SenseVoiceTranscriber()
            if self.config.translate_model in {"disabled", "off", "none"}:
                self.translator = None
            else:
                try:
                    self.translator = GoogleTranslationProvider()
                except Exception as error:
                    emit({"type": "error", "code": "translation_provider_fallback", "message": str(error), "recoverable": True})
                    self.translator = None
        except Exception as error:
            emit({"type": "error", "code": "session_start_failed", "message": str(error), "recoverable": True})
            self.active = False
            self.capture = None
            self.transcriber = None
            self.translator = None
            emit({"type": "session_state", "state": "error", "detail": str(error)})
            return

        self.thread = threading.Thread(target=self._stream_loop, daemon=True)
        self.thread.start()
        trace_debug(f"start_session exit session={self.config.session_id} mode={self.config.mode}")

    def stop_session(self) -> None:
        trace_debug(f"stop_session enter active={self.active} session={self.config.session_id if self.config else 'none'}")
        self.stop_event.set()
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=1.5)
        self.thread = None
        if self.config is not None and self.config.mode == "dictation" and self.transcriber is not None:
            flush = getattr(self.transcriber, "flush", None)
            if callable(flush):
                flush_base_ms = self.dictation_last_update_ms or self.dictation_started_at_ms or now_ms()
                try:
                    flushed_chunks = flush(flush_base_ms)
                    for chunk in flushed_chunks:
                        self._emit_final_chunk(chunk)
                    trace_debug(
                        f"dictation flush emitted chunks={len(flushed_chunks)} session={self.config.session_id} "
                        f"max_input_level={self.dictation_max_input_level:.4f}"
                    )
                except Exception as error:
                    trace_debug(f"dictation flush failed session={self.config.session_id} error={error}")
            if not self.dictation_parts and self.dictation_max_input_level >= 0.08:
                transcribe_buffer = getattr(self.transcriber, "transcribe_buffer", None)
                if callable(transcribe_buffer) and self.dictation_audio_buffer:
                    batch_base_ms = self.dictation_started_at_ms or now_ms()
                    try:
                        buffered_audio = np.concatenate(self.dictation_audio_buffer).astype(np.float32)
                        fallback_chunks = transcribe_buffer(buffered_audio, batch_base_ms)
                        for chunk in fallback_chunks:
                            self._emit_final_chunk(chunk)
                        trace_debug(
                            f"dictation batch fallback emitted chunks={len(fallback_chunks)} session={self.config.session_id} "
                            f"samples={buffered_audio.size} max_input_level={self.dictation_max_input_level:.4f}"
                        )
                    except Exception as error:
                        trace_debug(f"dictation batch fallback failed session={self.config.session_id} error={error}")
        if self.capture is not None:
            self.capture.stop()
            self.capture = None
        if isinstance(self.transcriber, AppleSttTranscriber):
            self.transcriber.stop()
        self.transcriber = None
        if self.active:
            self.active = False
            emit({"type": "session_state", "state": "stopped"})
            trace_debug(f"emitted session_state stopped session={self.config.session_id if self.config else 'none'}")
        if self.config is not None and self.config.mode == "dictation":
            self.dictation_last_update_ms = max(self.dictation_last_update_ms, now_ms())
            emit(build_dictation_state_event("stopped", "Dictation session stopped"))
            trace_debug(f"emitted dictation_state stopped session={self.config.session_id}")
            emit(
                build_dictation_final_event(
                    self.config.session_id,
                    self.dictation_parts,
                    self.dictation_started_at_ms or self.dictation_last_update_ms,
                    self.dictation_last_update_ms,
                    convert_s2t=self.config.target_lang.lower() in {"zh-tw", "zh-hant"},
                    opencc_s2t=self.opencc_s2t,
                    rewrite_mode=self.config.dictation_rewrite_mode,
                    source_lang=self.config.source_lang,
                    output_style=self.config.dictation_output_style,
                    dictionary_enabled=self.config.dictation_dictionary_enabled,
                    dictionary_text=self.config.dictation_dictionary_text,
                    max_rewrite_expansion_ratio=self.config.dictation_max_rewrite_expansion_ratio,
                    local_llm_model=self.config.dictation_local_llm_model,
                    local_llm_runner=self.config.dictation_local_llm_runner,
                )
            )
            trace_debug(f"emitted dictation_final session={self.config.session_id} parts={len(self.dictation_parts)}")
        emit({"type": "session_stopped_ack"})
        trace_debug(f"emitted session_stopped_ack session={self.config.session_id if self.config else 'none'}")

    def _should_translate(self, chunk: TranscriptChunk) -> bool:
        if self.translator is None or self.config is None:
            return False
        if self.config.translate_model in {"disabled", "off", "none"}:
            return False
        return True

    def _convert_s2t(self, text: str) -> str:
        return self.opencc_s2t.convert(text)

    def _emit_final_chunk(self, chunk: TranscriptChunk) -> None:
        if self.transcriber is not None:
            self.transcriber.finalized_ids.add(chunk.segment_id)
        source_text = chunk.source_text
        if self.config is not None and self.config.mode == "dictation":
            normalized = normalize_text(source_text)
            if normalized:
                self.dictation_parts.append(normalized)
                self.dictation_last_update_ms = now_ms()
                emit(build_dictation_state_event("capturing", f"Buffered {chunk.segment_id}"))
            return
        # Convert simplified Chinese to traditional if needed
        if chunk.detected_lang.lower().startswith("zh") and self.config is not None:
            target = self.config.target_lang.lower()
            if "tw" in target or "hant" in target:
                source_text = self._convert_s2t(source_text)
        print(f"[sidecar] final_caption id={chunk.segment_id} lang={chunk.detected_lang} text={source_text[:60]}", file=sys.stderr)
        emit({
            "type": "final_caption",
            "mode": chunk.mode,
            "sessionId": chunk.session_id,
            "segmentId": chunk.segment_id,
            "sourceText": source_text,
            "translatedText": "",
            "startedAtMs": chunk.started_at_ms,
            "endedAtMs": chunk.ended_at_ms,
            "latencyMs": now_ms() - chunk.started_at_ms,
            "confidence": chunk.confidence,
            "detectedLang": chunk.detected_lang,
        })
        should = self._should_translate(chunk)
        print(f"[sidecar] should_translate={should} translator={self.translator is not None} translate_model={self.config.translate_model if self.config else 'N/A'}", file=sys.stderr)
        if should:
            self.translation_queue.put((chunk, self.config))

    def _stream_loop(self) -> None:
        emit({"type": "session_state", "state": "streaming"})
        assert self.config is not None
        assert self.capture is not None
        assert self.transcriber is not None

        session_start_ms = now_ms()
        total_samples_fed = 0

        while not self.stop_event.is_set():
            time.sleep(0.025)  # 25ms poll interval for lower latency
            incoming = self.capture.drain()

            emit({
                "type": "metrics",
                "inputLevel": self.capture.level,
                "processingLagMs": 0,
                "queueDepth": self.capture.queue.qsize(),
            })
            if self.config.mode == "dictation":
                self.dictation_max_input_level = max(self.dictation_max_input_level, self.capture.level)

            if incoming.size == 0:
                continue
            if self.config.mode == "dictation":
                self.dictation_audio_buffer.append(np.copy(incoming))

            # Calculate base time from total samples fed
            base_time_ms = session_start_ms + int(total_samples_fed / SAMPLE_RATE * 1000)
            total_samples_fed += incoming.size

            # Feed audio to VAD + STT (or pipe to Apple STT subprocess)
            started_at = now_ms()
            chunks = self.transcriber.feed_audio(incoming, base_time_ms)
            inference_ms = now_ms() - started_at

            for chunk in chunks:
                self._emit_final_chunk(chunk)

            if inference_ms > 0:
                emit({
                    "type": "metrics",
                    "inputLevel": self.capture.level,
                    "processingLagMs": inference_ms,
                    "queueDepth": self.capture.queue.qsize(),
                })

    def _translation_loop(self) -> None:
        while True:
            chunk, config = self.translation_queue.get()
            if self.translator is None:
                continue
            try:
                batch = [(chunk, config)]
                batch_started_at = time.monotonic()
                while len(batch) < 3:
                    wait_seconds = TRANSLATION_BATCH_WINDOW_MS / 1000
                    if batch and count_words(batch[-1][0].source_text) <= SHORT_SEGMENT_WORDS:
                        wait_seconds = 0.34
                    remaining = wait_seconds - (time.monotonic() - batch_started_at)
                    if remaining <= 0:
                        break
                    try:
                        next_chunk, next_config = self.translation_queue.get(timeout=remaining)
                    except queue.Empty:
                        break
                    same_langs = (
                        next_config.source_lang == config.source_lang
                        and next_config.target_lang == config.target_lang
                    )
                    nearby = next_chunk.started_at_ms - batch[-1][0].ended_at_ms <= 1400
                    if same_langs and nearby:
                        batch.append((next_chunk, next_config))
                        continue
                    self.translation_queue.put((next_chunk, next_config))
                    break

                # Use detected language from transcription when available,
                # so Apple STT (detected_lang="en") translates en→zh-TW
                # even when config.source_lang is "zh" (default).
                effective_source = batch[0][0].detected_lang or config.source_lang
                if effective_source in {"", "auto"}:
                    effective_source = "auto"
                texts = [item[0].source_text for item in batch]
                print(f"[translate] {effective_source}→{config.target_lang} texts={texts}", file=sys.stderr)
                translated_items = self.translator.translate_many(
                    texts,
                    effective_source,
                    config.target_lang,
                )
                print(f"[translate] results={translated_items}", file=sys.stderr)
                for index, (translated_chunk, _) in enumerate(batch):
                    translated = translated_items[index] if index < len(translated_items) else ""
                    emit({
                        "type": "final_caption",
                        "mode": translated_chunk.mode,
                        "sessionId": translated_chunk.session_id,
                        "segmentId": translated_chunk.segment_id,
                        "sourceText": translated_chunk.source_text,
                        "translatedText": translated,
                        "startedAtMs": translated_chunk.started_at_ms,
                        "endedAtMs": translated_chunk.ended_at_ms,
                        "latencyMs": now_ms() - translated_chunk.started_at_ms,
                        "confidence": translated_chunk.confidence,
                    })
            except Exception as error:
                emit({
                    "type": "error",
                    "mode": config.mode,
                    "sessionId": config.session_id,
                    "code": "translation_failed",
                    "message": str(error),
                    "recoverable": True,
                })


def _apply_model_dir(model_dir: str) -> None:
    global MODEL_BASE_DIR, SENSEVOICE_MODEL_DIR, WHISPER_TINY_EN_MODEL_DIR
    global WHISPER_SMALL_MODEL_DIR, ZIPFORMER_KOREAN_MODEL_DIR, SILERO_VAD_MODEL
    MODEL_BASE_DIR = model_dir
    SENSEVOICE_MODEL_DIR = os.path.join(model_dir, "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17")
    WHISPER_TINY_EN_MODEL_DIR = os.path.join(model_dir, "sherpa-onnx-whisper-tiny.en")
    WHISPER_SMALL_MODEL_DIR = os.path.join(model_dir, "sherpa-onnx-whisper-small")
    ZIPFORMER_KOREAN_MODEL_DIR = os.path.join(model_dir, "sherpa-onnx-zipformer-korean-2024-06-24")
    SILERO_VAD_MODEL = os.path.join(model_dir, "silero_vad.onnx")


def cli() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--list-devices", action="store_true")
    parser.add_argument("--model-dir", type=str, default=None)
    args = parser.parse_args()

    if args.model_dir:
        _apply_model_dir(args.model_dir)

    if args.list_devices:
        sys.stdout.write(json.dumps(list_audio_devices(), ensure_ascii=False) + "\n")
        return 0

    return SidecarApp().run()


if __name__ == "__main__":
    raise SystemExit(cli())

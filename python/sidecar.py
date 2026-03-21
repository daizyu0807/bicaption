#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import importlib
import json
import math
import multiprocessing
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import wave
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
MOONSHINE_CACHE_DIR = os.path.join(MODEL_BASE_DIR, "moonshine_voice")
MLX_WHISPER_MODEL = os.environ.get("BICAPTION_MLX_WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
DEFAULT_EMIT_CONTEXT = {
    "mode": "subtitle",
    "sessionId": "bootstrap",
}
_emit_context = dict(DEFAULT_EMIT_CONTEXT)
TRACE_PATH = os.environ.get("BICAPTION_TRACE_PATH", "").strip()
LOCAL_SPEAKER_PROFILE_ID = "meeting-local-speaker"
LOCAL_SPEAKER_MIN_ENROLL_SECONDS = 5.0
LOCAL_SPEAKER_MATCH_THRESHOLD = 0.82
LOCAL_SPEAKER_MIN_RUNTIME_SPEECH_RATIO = 0.2
LOCAL_SPEAKER_MIN_ENROLL_SPEECH_RATIO = 0.5
LOCAL_SPEAKER_MIN_PEAK_LEVEL = 0.02
LOCAL_SPEAKER_MIN_RMS_LEVEL = 0.008
FALLBACK_FFMPEG_DIRS = (
    "/opt/homebrew/bin",
    "/usr/local/bin",
)


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


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def build_child_process_env() -> dict[str, str]:
    env = os.environ.copy()
    path_entries: list[str] = []
    current_path = env.get("PATH", "")
    if current_path:
        path_entries.extend([entry for entry in current_path.split(os.pathsep) if entry])

    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path:
        ffmpeg_dir = os.path.dirname(ffmpeg_path)
        if ffmpeg_dir:
            path_entries.insert(0, ffmpeg_dir)

    for fallback_dir in FALLBACK_FFMPEG_DIRS:
        if os.path.isdir(fallback_dir):
            path_entries.append(fallback_dir)

    deduped_path_entries: list[str] = []
    seen: set[str] = set()
    for entry in path_entries:
        if entry not in seen:
            deduped_path_entries.append(entry)
            seen.add(entry)

    env["PATH"] = os.pathsep.join(deduped_path_entries)
    return env


@dataclass
class SpeakerAudioQuality:
    valid: bool
    peak_level: float
    rms_level: float
    speech_ratio: float
    frame_count: int


@dataclass
class MeetingSpeakerMatchStats:
    attempted: int = 0
    verified: int = 0
    unverified: int = 0
    skipped_low_quality: int = 0
    skipped_fingerprint_unavailable: int = 0
    skipped_no_reference: int = 0
    confidence_sum: float = 0.0
    confidence_max: float = 0.0


def summarize_meeting_match_stats(stats: MeetingSpeakerMatchStats) -> str:
    average_confidence = stats.confidence_sum / stats.attempted if stats.attempted > 0 else 0.0
    return (
        "meeting speaker summary "
        f"attempted={stats.attempted} "
        f"verified={stats.verified} "
        f"unverified={stats.unverified} "
        f"skipped_low_quality={stats.skipped_low_quality} "
        f"skipped_fingerprint_unavailable={stats.skipped_fingerprint_unavailable} "
        f"skipped_no_reference={stats.skipped_no_reference} "
        f"avg_confidence={average_confidence:.3f} "
        f"max_confidence={stats.confidence_max:.3f}"
    )


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


def normalize_moonshine_lang(source_lang: str) -> str | None:
    normalized = source_lang.lower()
    if normalized in {"en", "english"}:
        return "en"
    if normalized in {"zh", "zh-cn", "zh-tw", "zh-hant", "chinese"}:
        return "zh"
    if normalized in {"ja", "japanese"}:
        return "ja"
    if normalized in {"ko", "korean"}:
        return "ko"
    if normalized == "auto":
        return None
    return None


def normalize_mlx_whisper_lang(source_lang: str) -> str | None:
    normalized = source_lang.lower()
    if normalized in {"", "auto"}:
        return None
    if normalized in {"zh-tw", "zh-hant"}:
        return "zh"
    return normalized


def assess_speaker_audio(
    audio: np.ndarray,
    min_speech_ratio: float = LOCAL_SPEAKER_MIN_RUNTIME_SPEECH_RATIO,
) -> SpeakerAudioQuality:
    if audio.size < int(SAMPLE_RATE * 0.8):
        return SpeakerAudioQuality(False, 0.0, 0.0, 0.0, 0)
    samples = np.asarray(audio, dtype=np.float32)
    peak_level = float(np.max(np.abs(samples))) if samples.size else 0.0
    rms_level = float(np.sqrt(np.mean(np.square(samples)))) if samples.size else 0.0
    if peak_level < LOCAL_SPEAKER_MIN_PEAK_LEVEL or rms_level < LOCAL_SPEAKER_MIN_RMS_LEVEL:
        return SpeakerAudioQuality(False, peak_level, rms_level, 0.0, 0)
    frame_size = 512
    hop_size = 256
    if samples.size < frame_size:
        samples = np.pad(samples, (0, frame_size - samples.size))
    frame_rms: list[float] = []
    for start in range(0, max(1, samples.size - frame_size + 1), hop_size):
        frame = samples[start:start + frame_size]
        if frame.size < frame_size:
            frame = np.pad(frame, (0, frame_size - frame.size))
        frame_rms.append(float(np.sqrt(np.mean(np.square(frame)))))
    if not frame_rms:
        return SpeakerAudioQuality(False, peak_level, rms_level, 0.0, 0)
    frame_rms_np = np.asarray(frame_rms, dtype=np.float32)
    noise_floor = float(np.percentile(frame_rms_np, 20))
    speech_threshold = max(LOCAL_SPEAKER_MIN_RMS_LEVEL, noise_floor * 2.5, rms_level * 0.6)
    speech_ratio = float(np.mean(frame_rms_np >= speech_threshold))
    return SpeakerAudioQuality(
        speech_ratio >= min_speech_ratio,
        peak_level,
        rms_level,
        speech_ratio,
        int(frame_rms_np.size),
    )


def build_speaker_fingerprint(
    audio: np.ndarray,
    min_speech_ratio: float = LOCAL_SPEAKER_MIN_RUNTIME_SPEECH_RATIO,
) -> list[float] | None:
    if audio.size < int(SAMPLE_RATE * 0.8):
        return None
    samples = np.asarray(audio, dtype=np.float32)
    quality = assess_speaker_audio(samples, min_speech_ratio=min_speech_ratio)
    if not quality.valid:
        return None
    peak = quality.peak_level
    samples = samples / peak
    frame_size = 1024
    hop_size = 512
    if samples.size < frame_size:
        samples = np.pad(samples, (0, frame_size - samples.size))
    frame_count = 1 + max(0, (samples.size - frame_size) // hop_size)
    if frame_count <= 0:
        return None
    window = np.hanning(frame_size).astype(np.float32)
    band_edges_hz = [80, 180, 320, 500, 720, 1000, 1400, 1900, 2500, 3200, 4000]
    band_sums = np.zeros(len(band_edges_hz) - 1, dtype=np.float32)
    freq_bins = np.fft.rfftfreq(frame_size, d=1.0 / SAMPLE_RATE)
    for index in range(frame_count):
        start = index * hop_size
        frame = samples[start:start + frame_size]
        if frame.size < frame_size:
            frame = np.pad(frame, (0, frame_size - frame.size))
        spectrum = np.abs(np.fft.rfft(frame * window)).astype(np.float32)
        if not np.any(spectrum):
            continue
        for band_index, (low_hz, high_hz) in enumerate(zip(band_edges_hz[:-1], band_edges_hz[1:])):
            mask = (freq_bins >= low_hz) & (freq_bins < high_hz)
            if np.any(mask):
                band_sums[band_index] += float(np.mean(spectrum[mask]))
    if not np.any(band_sums):
        return None
    features = np.log1p(band_sums)
    features -= float(np.mean(features))
    norm = float(np.linalg.norm(features))
    if norm <= 1e-8:
        return None
    normalized = features / norm
    return [round(float(item), 6) for item in normalized.tolist()]


def serialize_speaker_fingerprint(features: list[float]) -> str:
    payload = json.dumps({"v": 1, "bands": features}, separators=(",", ":")).encode("utf-8")
    return base64.b64encode(payload).decode("ascii")


def parse_speaker_fingerprint(payload: str) -> list[float] | None:
    normalized = payload.strip()
    if not normalized:
        return None
    try:
        decoded = base64.b64decode(normalized.encode("ascii"))
        parsed = json.loads(decoded.decode("utf-8"))
    except Exception:
        return None
    bands = parsed.get("bands")
    if not isinstance(bands, list) or not bands:
        return None
    try:
        return [float(item) for item in bands]
    except (TypeError, ValueError):
        return None


def compare_speaker_fingerprints(reference: list[float] | None, candidate: list[float] | None) -> float:
    if not reference or not candidate or len(reference) != len(candidate):
        return 0.0
    ref = np.asarray(reference, dtype=np.float32)
    cand = np.asarray(candidate, dtype=np.float32)
    ref_norm = float(np.linalg.norm(ref))
    cand_norm = float(np.linalg.norm(cand))
    if ref_norm <= 1e-8 or cand_norm <= 1e-8:
        return 0.0
    similarity = float(np.dot(ref, cand) / (ref_norm * cand_norm))
    return clamp(similarity, 0.0, 1.0)


def enroll_local_speaker(device_id: str, duration_sec: float) -> dict[str, Any]:
    effective_duration = max(LOCAL_SPEAKER_MIN_ENROLL_SECONDS, duration_sec)
    capture = AudioCapture(device_id, 400)
    chunks: list[np.ndarray] = []
    started_at_ms = now_ms()
    try:
        capture.start()
        deadline = time.monotonic() + effective_duration
        while time.monotonic() < deadline:
            time.sleep(0.05)
            drained = capture.drain_primary()
            if drained.size > 0:
                chunks.append(np.copy(drained))
    finally:
        capture.stop()
    if not chunks:
        raise RuntimeError("No microphone audio was captured during enrollment.")
    audio = np.concatenate(chunks).astype(np.float32)
    quality = assess_speaker_audio(audio, min_speech_ratio=LOCAL_SPEAKER_MIN_ENROLL_SPEECH_RATIO)
    if not quality.valid:
        raise RuntimeError(
            "Enrollment audio did not contain enough clear speech. "
            f"speech_ratio={quality.speech_ratio:.2f} rms={quality.rms_level:.4f} peak={quality.peak_level:.4f}"
        )
    fingerprint_features = build_speaker_fingerprint(audio, min_speech_ratio=LOCAL_SPEAKER_MIN_ENROLL_SPEECH_RATIO)
    if fingerprint_features is None:
        raise RuntimeError("Enrollment audio was too short or too quiet to build a speaker fingerprint.")
    return {
        "profileId": LOCAL_SPEAKER_PROFILE_ID,
        "fingerprint": serialize_speaker_fingerprint(fingerprint_features),
        "sampleDurationMs": int(round(audio.size / SAMPLE_RATE * 1000)),
        "enrolledAtMs": started_at_ms,
        "speechRatio": round(quality.speech_ratio, 3),
        "qualityScore": round(clamp((quality.speech_ratio * 0.7) + min(1.0, quality.rms_level / 0.03) * 0.3, 0.0, 1.0), 3),
    }


def should_attempt_dictation_batch_fallback(
    stt_model: str,
    dictation_parts: list[str],
    max_input_level: float,
    buffered_sample_count: int,
) -> bool:
    if dictation_parts or buffered_sample_count <= 0:
        return False
    if stt_model == "whisper-mlx":
        return buffered_sample_count >= MIN_SPEECH_SAMPLES
    return max_input_level >= 0.08


def build_dictation_state_event(state: str, detail: str | None = None) -> dict[str, Any]:
    event: dict[str, Any] = {
        "type": "dictation_state",
        "state": state,
    }
    if detail:
        event["detail"] = detail
    return event


def should_merge_dictation_fragment(previous: str, current: str) -> bool:
    previous_words = count_words(previous)
    current_words = count_words(current)
    if previous_words <= 0 or current_words <= 0:
        return False

    previous_ends_sentence = previous.rstrip().endswith((".", "!", "?", "。", "！", "？"))
    current_starts_lower = current[:1].islower()

    if current_words <= 4:
        return True
    if previous_words <= 2:
        return True
    if current_starts_lower and not previous_ends_sentence:
        return True
    if previous_words <= 6 and current_words <= 6 and not previous_ends_sentence:
        return True
    return False


def append_dictation_fragment(transcript_parts: list[str], fragment: str) -> list[str]:
    normalized = normalize_text(fragment)
    if not normalized:
        return transcript_parts
    if not transcript_parts:
        transcript_parts.append(normalized)
        return transcript_parts

    if should_merge_dictation_fragment(transcript_parts[-1], normalized):
        transcript_parts[-1] = normalize_text(f"{transcript_parts[-1]} {normalized}")
    else:
        transcript_parts.append(normalized)
    return transcript_parts


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
    normalized_parts: list[str] = []
    for part in transcript_parts:
        append_dictation_fragment(normalized_parts, part)

    transcript = normalize_text(" ".join(normalized_parts))
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
        "chunkCount": len(normalized_parts),
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
    meeting_source_mode: str = "dual"
    meeting_speaker_labels_enabled: bool = True
    meeting_local_speaker_verification_enabled: bool = False
    meeting_local_speaker_profile_id: str = ""
    meeting_local_speaker_fingerprint: str = ""
    meeting_notes_prompt: str = ""
    meeting_save_transcript: bool = True
    meeting_transcript_directory: str = ""


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
    deterministic_replacements = [
        ("罪字", "贅字"),
        ("標底符號", "標點符號"),
    ]
    for source, target in deterministic_replacements:
        rewritten = rewritten.replace(source, target)
    filler_patterns = [
        r"\b(?:um|uh|erm|hmm|mm)\b",
        r"(?:(?<=^)|(?<=[\s，。！？；：,]))(?:那個|就是|嗯|呃|啊|哎|欸|誒|唉|哈|啦|咧|喔|哦)(?=$|(?=[\s，。！？；：,]))",
        r"(?:那個|就是|嗯|呃|啊|哎|欸|誒|唉|哈|啦|咧|喔|哦)(?=[，。！？；：,]?$)",
    ]
    for pattern in filler_patterns:
        rewritten = re.sub(pattern, " ", rewritten, flags=re.IGNORECASE)
    rewritten = re.sub(r"\b(\w+)(?:\s+\1\b)+", r"\1", rewritten, flags=re.IGNORECASE)
    rewritten = re.sub(r"(.)\1{2,}", r"\1\1", rewritten)
    rewritten = re.sub(r"([。！？；：])\s*([，；：])", r"\1 ", rewritten)
    rewritten = re.sub(r"([。！？])\s*([^。！？；：，,\s])", r"\1 \2", rewritten)
    rewritten = re.sub(r"([。！？；：，])\s+([\u4e00-\u9fff])", r"\1\2", rewritten)
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
        "5. Remove fillers, hesitation sounds, and spoken tics when they do not carry meaning.\n"
        "6. Fix obvious speech-recognition mistakes, including homophone or near-sound errors, when the surrounding context makes the intended wording clear.\n"
        "7. Prefer the most natural and fluent wording that matches what the speaker clearly meant.\n"
        "8. Improve sentence breaks conservatively so the result reads naturally.\n"
        "9. Use punctuation that matches the target language.\n"
        "10. For Traditional Chinese, prefer full-width punctuation such as ， 。 ： ； ？ ！\n"
        "11. Return only the rewritten text.\n"
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

    def __init__(self, script_path: str, timeout_seconds: float = 8.0) -> None:
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


def get_streaming_transcriber(config: SessionConfig, announce: bool = True):
    if config.stt_model == "whisper-mlx":
        if announce:
            emit({"type": "session_state", "state": "connecting", "detail": "Preparing MLX Whisper batch provider..."})
        return MlxWhisperBatchTranscriber(source_lang=config.source_lang)
    if config.stt_model == "moonshine":
        if announce:
            emit({"type": "session_state", "state": "connecting", "detail": "Preparing Moonshine streaming provider..."})
        try:
            return MoonshineTranscriber(source_lang=config.source_lang, update_interval_ms=config.partial_stable_ms)
        except Exception as error:
            emit({
                "type": "error",
                "code": "moonshine_fallback",
                "message": f"Moonshine unavailable for this session, falling back to SenseVoice: {error}",
                "recoverable": True,
            })
            if announce:
                emit({"type": "session_state", "state": "connecting", "detail": "Falling back to SenseVoice..."})
            return SenseVoiceTranscriber()
    if config.stt_model == "apple-stt":
        if announce:
            emit({"type": "session_state", "state": "connecting", "detail": "Starting Apple Speech Recognition..."})
        transcriber = AppleSttTranscriber(
            source_lang=config.source_lang,
            partial_stable_ms=config.partial_stable_ms,
        )
        transcriber.start()
        return transcriber
    if config.stt_model == "whisper-tiny-en":
        if announce:
            emit({"type": "session_state", "state": "connecting", "detail": "Loading Whisper tiny.en model..."})
        return WhisperTinyEnTranscriber()
    if config.stt_model == "whisper-small":
        lang = config.source_lang if config.source_lang != "auto" else ""
        if announce:
            emit({"type": "session_state", "state": "connecting", "detail": "Loading Whisper small model..."})
        return WhisperSmallTranscriber(language=lang)
    if config.stt_model == "zipformer-ko":
        if announce:
            emit({"type": "session_state", "state": "connecting", "detail": "Loading Zipformer Korean model..."})
        return ZipformerKoreanTranscriber()
    if announce:
        emit({"type": "session_state", "state": "connecting", "detail": "Loading SenseVoice model..."})
    return SenseVoiceTranscriber()


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


@dataclass
class MeetingChunk:
    chunk: TranscriptChunk
    source: str
    turn_id: str
    speaker_id: str
    speaker_label: str
    speaker_kind: str = "source-default"
    speaker_profile_id: str = ""
    speaker_match_confidence: float = 0.0


class MlxWhisperBatchTranscriber:
    """Batch-only dictation transcriber backed by MLX Whisper."""

    _probe_result: bool | None = None

    def __init__(self, source_lang: str = "auto") -> None:
        self.finalized_ids: set[str] = set()
        self._segment_counter = 0
        self._source_lang = normalize_mlx_whisper_lang(source_lang)

    def feed_audio(self, samples: np.ndarray, base_time_ms: int) -> list[TranscriptChunk]:
        return []

    def flush(self, base_time_ms: int) -> list[TranscriptChunk]:
        return []

    def stop(self) -> None:
        return

    @classmethod
    def _probe_runtime_ready(cls) -> bool:
        if cls._probe_result is not None:
            return cls._probe_result
        try:
            result = subprocess.run(
                [sys.executable, "--mlx-whisper-probe"],
                capture_output=True,
                text=True,
                timeout=8,
                check=False,
                env=build_child_process_env(),
            )
            cls._probe_result = result.returncode == 0 and "READY" in result.stdout
            trace_debug(
                "mlx whisper probe "
                f"returncode={result.returncode} "
                f"stdout={result.stdout.strip()!r} "
                f"stderr={result.stderr.strip()[:240]!r}"
            )
        except Exception as exc:
            cls._probe_result = False
            trace_debug(f"mlx whisper probe exception={exc}")
        return cls._probe_result

    def transcribe_buffer(self, audio: np.ndarray, base_time_ms: int) -> list[TranscriptChunk]:
        if audio.size < MIN_SPEECH_SAMPLES:
            return []
        if not self._probe_runtime_ready():
            raise RuntimeError("dependency missing: MLX runtime probe failed")

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
            temp_path = handle.name
        try:
            pcm16 = np.clip(audio, -1.0, 1.0)
            pcm16 = (pcm16 * 32767).astype(np.int16)
            with wave.open(temp_path, "wb") as wav_file:
                wav_file.setnchannels(CHANNELS)
                wav_file.setsampwidth(2)
                wav_file.setframerate(SAMPLE_RATE)
                wav_file.writeframes(pcm16.tobytes())
            command = [sys.executable, "--mlx-whisper-transcribe", "--audio-path", temp_path]
            if self._source_lang:
                command.extend(["--source-lang", self._source_lang])
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
                env=build_child_process_env(),
            )
            if result.returncode != 0:
                stderr = result.stderr.strip() or result.stdout.strip()
                raise RuntimeError(f"MLX worker failed: {stderr or f'exit {result.returncode}'}")
            payload = json.loads(result.stdout)
            text = normalize_text(str(payload.get("text", "")))
            detected_lang = normalize_text(str(payload.get("language", self._source_lang or "")))
        finally:
            try:
                os.unlink(temp_path)
            except OSError:
                pass

        if not text or len(text.replace(" ", "")) < 2:
            return []

        self._segment_counter += 1
        duration_ms = int(audio.size / SAMPLE_RATE * 1000)
        return [TranscriptChunk(
            mode=_emit_context["mode"],
            session_id=_emit_context["sessionId"],
            segment_id=f"mlx-whisper-{self._segment_counter}",
            source_text=text,
            started_at_ms=base_time_ms,
            ended_at_ms=base_time_ms + duration_ms,
            confidence=0.0,
            detected_lang=detected_lang,
        )]


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
        primary = self.drain_primary()
        if self.output_device_index is None:
            return primary
        secondary = self.drain_output()
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

    def drain_primary(self) -> np.ndarray:
        return self._drain_queue(self.queue)

    def drain_output(self) -> np.ndarray:
        if self.output_device_index is None:
            return np.zeros(0, dtype=np.float32)
        return self._drain_queue(self.output_queue)


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


class MoonshineTranscriber:
    """Live Moonshine streaming transcriber with project-local model cache."""

    def __init__(self, source_lang: str = "auto", update_interval_ms: int = 500) -> None:
        moonshine_lang = normalize_moonshine_lang(source_lang)
        if moonshine_lang is None:
            raise RuntimeError("Moonshine requires an explicit supported source language (en / zh / ja / ko).")

        os.environ.setdefault("MOONSHINE_VOICE_CACHE", MOONSHINE_CACHE_DIR)
        moonshine_voice = importlib.import_module("moonshine_voice")
        transcriber_mod = importlib.import_module("moonshine_voice.transcriber")

        ModelArch = moonshine_voice.ModelArch
        get_model_for_language = moonshine_voice.get_model_for_language
        self._line_completed_type = transcriber_mod.LineCompleted
        self._line_updated_type = transcriber_mod.LineUpdated
        self._line_text_changed_type = transcriber_mod.LineTextChanged
        self._transcriber_cls = transcriber_mod.Transcriber

        preferred_arch = ModelArch.SMALL_STREAMING if moonshine_lang == "en" else ModelArch.BASE
        model_path, model_arch = get_model_for_language(moonshine_lang, preferred_arch)
        self._detected_lang = moonshine_lang
        self._session_base_ms = now_ms()
        self._queued_chunks: list[TranscriptChunk] = []
        self._seen_completed_line_ids: set[int] = set()
        self._last_partial_by_line_id: dict[int, str] = {}
        self.finalized_ids: set[str] = set()

        update_interval = max(0.2, update_interval_ms / 1000.0)
        self._transcriber = self._transcriber_cls(
            model_path=str(model_path),
            model_arch=model_arch,
            update_interval=update_interval,
        )
        self._stream = self._transcriber.create_stream(update_interval=update_interval)
        self._stream.add_listener(self._on_event)
        self._stream.start()

    def _line_to_chunk(self, line: Any) -> TranscriptChunk:
        started_at_ms = self._session_base_ms + int(float(line.start_time) * 1000)
        ended_at_ms = started_at_ms + int(float(line.duration) * 1000)
        segment_id = f"moonshine-{line.line_id}"
        return TranscriptChunk(
            mode=_emit_context["mode"],
            session_id=_emit_context["sessionId"],
            segment_id=segment_id,
            source_text=normalize_text(str(line.text)),
            started_at_ms=started_at_ms,
            ended_at_ms=ended_at_ms,
            confidence=0.0,
            detected_lang=self._detected_lang,
        )

    def _on_event(self, event: Any) -> None:
        if isinstance(event, self._line_completed_type):
            line = event.line
            if line.line_id in self._seen_completed_line_ids:
                return
            self._seen_completed_line_ids.add(line.line_id)
            self._last_partial_by_line_id.pop(int(line.line_id), None)
            chunk = self._line_to_chunk(line)
            if chunk.source_text:
                self._queued_chunks.append(chunk)
            return

        if isinstance(event, self._line_updated_type) or isinstance(event, self._line_text_changed_type):
            line = getattr(event, "line", None)
            if line is None:
                return
            line_id = int(line.line_id)
            if line_id in self._seen_completed_line_ids:
                return
            text = normalize_text(str(line.text))
            if not text:
                return
            if self._last_partial_by_line_id.get(line_id) == text:
                return
            self._last_partial_by_line_id[line_id] = text
            if _emit_context["mode"] == "subtitle":
                emit({
                    "type": "partial_caption",
                    "mode": _emit_context["mode"],
                    "sessionId": _emit_context["sessionId"],
                    "segmentId": f"moonshine-{line_id}",
                    "sourceText": text,
                    "startedAtMs": self._session_base_ms + int(float(line.start_time) * 1000),
                    "updatedAtMs": now_ms(),
                })

    def _drain_chunks(self) -> list[TranscriptChunk]:
        if not self._queued_chunks:
            return []
        chunks = self._queued_chunks
        self._queued_chunks = []
        return chunks

    def feed_audio(self, samples: np.ndarray, base_time_ms: int) -> list[TranscriptChunk]:
        if samples.size == 0:
            return []
        self._stream.add_audio(samples.astype(np.float32).tolist(), sample_rate=SAMPLE_RATE)
        return self._drain_chunks()

    def flush(self, base_time_ms: int) -> list[TranscriptChunk]:
        try:
            self._stream.stop()
        except Exception:
            pass
        return self._drain_chunks()

    def stop(self) -> None:
        try:
            self._stream.close()
        except Exception:
            pass

    def transcribe_buffer(self, audio: np.ndarray, base_time_ms: int) -> list[TranscriptChunk]:
        temp_stream = self._transcriber.create_stream(update_interval=9999)
        local_chunks: list[TranscriptChunk] = []

        def listener(event: Any) -> None:
            if isinstance(event, self._line_completed_type):
                line = event.line
                chunk = TranscriptChunk(
                    mode=_emit_context["mode"],
                    session_id=_emit_context["sessionId"],
                    segment_id=f"moonshine-{line.line_id}",
                    source_text=normalize_text(str(line.text)),
                    started_at_ms=base_time_ms + int(float(line.start_time) * 1000),
                    ended_at_ms=base_time_ms + int((float(line.start_time) + float(line.duration)) * 1000),
                    confidence=0.0,
                    detected_lang=self._detected_lang,
                )
                if chunk.source_text:
                    local_chunks.append(chunk)

        temp_stream.add_listener(listener)
        temp_stream.start()
        temp_stream.add_audio(audio.astype(np.float32).tolist(), sample_rate=SAMPLE_RATE)
        try:
            temp_stream.stop()
        finally:
            temp_stream.close()
        return local_chunks


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

    def flush(self, base_time_ms: int) -> list[TranscriptChunk]:
        return self.feed_audio(np.zeros(0, dtype=np.float32), base_time_ms)

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
        is_dictation_mode = _emit_context["mode"] == "dictation"
        while True:
            try:
                event = self._results.get_nowait()
            except queue.Empty:
                break
            event_type = event.get("type", "")
            if event_type == "final":
                final_text = normalize_text(event.get("text", ""))
                trace_debug(
                    f"apple_stt_raw_final session={_emit_context['sessionId']} "
                    f"words={count_words(final_text)} text={final_text[:120]!r}"
                )
                if is_dictation_mode and final_text and len(final_text.replace(" ", "")) >= 2:
                    if not self._is_duplicate(final_text):
                        self._segment_counter += 1
                        seg_id = f"apple-seg-{self._segment_counter}"
                        results.append(TranscriptChunk(
                            mode=_emit_context["mode"],
                            session_id=_emit_context["sessionId"],
                            segment_id=seg_id,
                            source_text=final_text,
                            started_at_ms=base_time_ms,
                            ended_at_ms=now_ms(),
                            confidence=float(event.get("confidence", 0.0)),
                            detected_lang=self.detected_lang,
                        ))
                        self._record_promoted(final_text)
                    self._last_partial_text = ""
                    self._last_partial_change_ms = 0
                # Binary restarted its recognition task (55s limit).
                # Don't use the binary's final text directly — it's the full
                # cumulative text which we've already promoted in pieces.
                # Instead, force-promote any remaining unstable partial delta.
                elif self._last_partial_text:
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
                trace_debug(
                    f"apple_stt_raw_partial session={_emit_context['sessionId']} "
                    f"words={count_words(latest_partial_text)} text={latest_partial_text[:120]!r}"
                )
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
            if is_dictation_mode and self._proc is None:
                final_text = self._last_partial_text
                if final_text and len(final_text.replace(" ", "")) >= 2 and not self._is_duplicate(final_text):
                    self._segment_counter += 1
                    seg_id = f"apple-seg-{self._segment_counter}"
                    results.append(TranscriptChunk(
                        mode=_emit_context["mode"],
                        session_id=_emit_context["sessionId"],
                        segment_id=seg_id,
                        source_text=final_text,
                        started_at_ms=base_time_ms,
                        ended_at_ms=now_ms(),
                        confidence=0.0,
                        detected_lang=self.detected_lang,
                    ))
                    self._record_promoted(final_text)
                self._last_partial_text = ""
                self._last_partial_change_ms = 0
                return results
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
            not is_dictation_mode
            and
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
        self.transcriber: SenseVoiceTranscriber | MoonshineTranscriber | WhisperTinyEnTranscriber | WhisperSmallTranscriber | ZipformerKoreanTranscriber | AppleSttTranscriber | None = None
        self.translator: TranslationProvider | None = None
        self.opencc_s2t = OpenCC("s2t")
        self.dictation_parts: list[str] = []
        self.dictation_started_at_ms = 0
        self.dictation_last_update_ms = 0
        self.dictation_max_input_level = 0.0
        self.dictation_audio_buffer: list[np.ndarray] = []
        self.translation_queue: queue.Queue[tuple[TranscriptChunk | MeetingChunk, SessionConfig]] = queue.Queue()
        self.meeting_mic_transcriber: SenseVoiceTranscriber | MoonshineTranscriber | WhisperTinyEnTranscriber | WhisperSmallTranscriber | ZipformerKoreanTranscriber | AppleSttTranscriber | None = None
        self.meeting_system_transcriber: SenseVoiceTranscriber | MoonshineTranscriber | WhisperTinyEnTranscriber | WhisperSmallTranscriber | ZipformerKoreanTranscriber | AppleSttTranscriber | None = None
        self.meeting_samples_fed = {"microphone": 0, "system": 0}
        self.meeting_turn_counter = 0
        self.meeting_last_turn_id = ""
        self.meeting_last_turn_source = ""
        self.meeting_last_turn_end_ms = 0
        self.meeting_local_speaker_reference: list[float] | None = None
        self.meeting_match_stats = MeetingSpeakerMatchStats()
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
            meeting_source_mode=str(payload.get("meetingSourceMode", "dual")),
            meeting_speaker_labels_enabled=bool(payload.get("meetingSpeakerLabelsEnabled", True)),
            meeting_local_speaker_verification_enabled=bool(payload.get("meetingLocalSpeakerVerificationEnabled", False)),
            meeting_local_speaker_profile_id=str(payload.get("meetingLocalSpeakerProfileId", "")),
            meeting_local_speaker_fingerprint=str(payload.get("meetingLocalSpeakerFingerprint", "")),
            meeting_notes_prompt=str(payload.get("meetingNotesPrompt", "")),
            meeting_save_transcript=bool(payload.get("meetingSaveTranscript", True)),
            meeting_transcript_directory=str(payload.get("meetingTranscriptDirectory", "")),
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
        if self.config.mode == "meeting":
            self.meeting_samples_fed = {"microphone": 0, "system": 0}
            self.meeting_turn_counter = 0
            self.meeting_last_turn_id = ""
            self.meeting_last_turn_source = ""
            self.meeting_last_turn_end_ms = 0
            self.meeting_local_speaker_reference = parse_speaker_fingerprint(self.config.meeting_local_speaker_fingerprint)
            self.meeting_match_stats = MeetingSpeakerMatchStats()
        self.stop_event.clear()
        self.active = True
        emit({"type": "session_state", "state": "connecting", "detail": f"Connecting to {self.config.device_id}"})

        try:
            self.capture = AudioCapture(self.config.device_id, self.config.chunk_ms, self.config.output_device_id)
            self.capture.start()
            if self.config.mode == "meeting":
                self.transcriber = None
                if self.config.meeting_source_mode in {"microphone", "dual"}:
                    self.meeting_mic_transcriber = get_streaming_transcriber(self.config, announce=False)
                if self.config.meeting_source_mode in {"system-audio", "dual"}:
                    self.meeting_system_transcriber = get_streaming_transcriber(self.config, announce=False)
            else:
                self.transcriber = get_streaming_transcriber(self.config)
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
            self.meeting_mic_transcriber = None
            self.meeting_system_transcriber = None
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
        if self.config is not None and self.config.mode == "meeting":
            self._flush_meeting_transcribers()
        elif self.config is not None and self.config.mode != "dictation" and self.transcriber is not None:
            flush = getattr(self.transcriber, "flush", None)
            if callable(flush):
                try:
                    for chunk in flush(now_ms()):
                        self._emit_final_chunk(chunk)
                except Exception as error:
                    trace_debug(f"stream flush failed session={self.config.session_id} error={error}")
        if self.config is not None and self.config.mode == "dictation" and self.transcriber is not None:
            if isinstance(self.transcriber, AppleSttTranscriber):
                self.transcriber.stop()
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
            buffered_audio = None
            if self.dictation_audio_buffer:
                buffered_audio = np.concatenate(self.dictation_audio_buffer).astype(np.float32)
            should_attempt_batch = should_attempt_dictation_batch_fallback(
                self.config.stt_model,
                self.dictation_parts,
                self.dictation_max_input_level,
                0 if buffered_audio is None else buffered_audio.size,
            )
            if should_attempt_batch:
                transcribe_buffer = getattr(self.transcriber, "transcribe_buffer", None)
                if callable(transcribe_buffer) and buffered_audio is not None:
                    batch_base_ms = self.dictation_started_at_ms or now_ms()
                    try:
                        fallback_chunks = transcribe_buffer(buffered_audio, batch_base_ms)
                        for chunk in fallback_chunks:
                            self._emit_final_chunk(chunk)
                        trace_debug(
                            f"dictation batch fallback emitted chunks={len(fallback_chunks)} session={self.config.session_id} "
                            f"samples={buffered_audio.size} max_input_level={self.dictation_max_input_level:.4f}"
                        )
                    except Exception as error:
                        trace_debug(f"dictation batch fallback failed session={self.config.session_id} error={error}")
                        emit({
                            "type": "error",
                            "code": "dictation_batch_transcription_failed",
                            "message": str(error),
                            "recoverable": True,
                        })
        if self.capture is not None:
            self.capture.stop()
            self.capture = None
        if isinstance(self.transcriber, AppleSttTranscriber) or isinstance(self.transcriber, MoonshineTranscriber):
            self.transcriber.stop()
        self.transcriber = None
        self._stop_transcriber(self.meeting_mic_transcriber)
        self._stop_transcriber(self.meeting_system_transcriber)
        self.meeting_mic_transcriber = None
        self.meeting_system_transcriber = None
        if self.config is not None and self.config.mode == "meeting":
            trace_debug(f"{summarize_meeting_match_stats(self.meeting_match_stats)} session={self.config.session_id}")
        if self.active:
            self.active = False
            emit({"type": "session_state", "state": "stopped"})
            trace_debug(f"emitted session_state stopped session={self.config.session_id if self.config else 'none'}")
        if self.config is not None and self.config.mode == "dictation":
            self.dictation_last_update_ms = max(self.dictation_last_update_ms, now_ms())
            emit(build_dictation_state_event("processing", "Finalizing dictation output"))
            trace_debug(f"emitted dictation_state processing session={self.config.session_id}")
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

    def _stop_transcriber(self, transcriber: Any) -> None:
        if transcriber is None:
            return
        stop = getattr(transcriber, "stop", None)
        if callable(stop):
            try:
                stop()
            except Exception as error:
                trace_debug(f"transcriber stop failed error={error}")

    def _build_meeting_label(self, source: str) -> tuple[str, str]:
        if source == "microphone":
            return "microphone", "我方"
        return "system", "遠端"

    def _record_meeting_match_skip(self, reason: str) -> None:
        if reason == "low_quality":
            self.meeting_match_stats.skipped_low_quality += 1
        elif reason == "fingerprint_unavailable":
            self.meeting_match_stats.skipped_fingerprint_unavailable += 1
        elif reason == "no_reference":
            self.meeting_match_stats.skipped_no_reference += 1

    def _record_meeting_match_result(self, confidence: float, verified: bool) -> None:
        self.meeting_match_stats.attempted += 1
        self.meeting_match_stats.confidence_sum += confidence
        self.meeting_match_stats.confidence_max = max(self.meeting_match_stats.confidence_max, confidence)
        if verified:
            self.meeting_match_stats.verified += 1
        else:
            self.meeting_match_stats.unverified += 1

    def _classify_meeting_speaker(self, source: str, audio: np.ndarray) -> tuple[str, str, float]:
        if self.config is None or source != "microphone":
            return "remote-default" if source == "system" else "source-default", "", 0.0
        if not self.config.meeting_local_speaker_verification_enabled:
            return "source-default", "", 0.0
        reference = self.meeting_local_speaker_reference
        if reference is None:
            self._record_meeting_match_skip("no_reference")
            return "unverified-local", "", 0.0
        quality = assess_speaker_audio(audio, min_speech_ratio=LOCAL_SPEAKER_MIN_RUNTIME_SPEECH_RATIO)
        if not quality.valid:
            self._record_meeting_match_skip("low_quality")
            trace_debug(
                f"meeting speaker match skipped session={self.config.session_id} "
                f"reason=low_speech_quality speech_ratio={quality.speech_ratio:.2f} "
                f"rms={quality.rms_level:.4f} peak={quality.peak_level:.4f}"
            )
            return "source-default", self.config.meeting_local_speaker_profile_id, 0.0
        candidate = build_speaker_fingerprint(audio, min_speech_ratio=LOCAL_SPEAKER_MIN_RUNTIME_SPEECH_RATIO)
        if candidate is None:
            self._record_meeting_match_skip("fingerprint_unavailable")
            trace_debug(f"meeting speaker match skipped session={self.config.session_id} reason=fingerprint_unavailable")
            return "source-default", self.config.meeting_local_speaker_profile_id, 0.0
        confidence = compare_speaker_fingerprints(reference, candidate)
        verified = confidence >= LOCAL_SPEAKER_MATCH_THRESHOLD
        self._record_meeting_match_result(confidence, verified)
        trace_debug(
            f"meeting speaker match session={self.config.session_id} confidence={confidence:.3f} "
            f"threshold={LOCAL_SPEAKER_MATCH_THRESHOLD:.2f} speech_ratio={quality.speech_ratio:.2f}"
        )
        if verified:
            return "verified-local", self.config.meeting_local_speaker_profile_id, confidence
        return "unverified-local", self.config.meeting_local_speaker_profile_id, confidence

    def _assign_meeting_turn_id(self, source: str, chunk: TranscriptChunk) -> str:
        same_source = self.meeting_last_turn_source == source
        close_enough = (chunk.started_at_ms - self.meeting_last_turn_end_ms) <= 1800
        if self.meeting_last_turn_id and same_source and close_enough:
            self.meeting_last_turn_end_ms = max(self.meeting_last_turn_end_ms, chunk.ended_at_ms)
            return self.meeting_last_turn_id
        self.meeting_turn_counter += 1
        next_turn_id = f"turn-{self.meeting_turn_counter}"
        self.meeting_last_turn_id = next_turn_id
        self.meeting_last_turn_source = source
        self.meeting_last_turn_end_ms = chunk.ended_at_ms
        return next_turn_id

    def _emit_meeting_chunk(self, meeting_chunk: MeetingChunk, translated_text: str = "") -> None:
        source_text = meeting_chunk.chunk.source_text
        if meeting_chunk.chunk.detected_lang.lower().startswith("zh") and self.config is not None:
            target = self.config.target_lang.lower()
            if "tw" in target or "hant" in target:
                source_text = self._convert_s2t(source_text)
            if translated_text:
                translated_text = self._convert_s2t(translated_text)
        emit({
            "type": "meeting_caption",
            "segmentId": meeting_chunk.chunk.segment_id,
            "turnId": meeting_chunk.turn_id,
            "speakerId": meeting_chunk.speaker_id,
            "speakerLabel": meeting_chunk.speaker_label if self.config and self.config.meeting_speaker_labels_enabled else "",
            "speakerKind": meeting_chunk.speaker_kind,
            "speakerProfileId": meeting_chunk.speaker_profile_id,
            "speakerMatchConfidence": meeting_chunk.speaker_match_confidence,
            "source": meeting_chunk.source,
            "sourceLang": meeting_chunk.chunk.detected_lang,
            "targetLang": self.config.target_lang if self.config is not None else "",
            "text": source_text,
            "translatedText": translated_text,
            "tsStartMs": meeting_chunk.chunk.started_at_ms,
            "tsEndMs": meeting_chunk.chunk.ended_at_ms,
        })

    def _emit_chunk_from_source(self, chunk: TranscriptChunk, source: str, audio: np.ndarray | None = None) -> None:
        speaker_id, speaker_label = self._build_meeting_label(source)
        turn_id = self._assign_meeting_turn_id(source, chunk)
        speaker_kind = "remote-default"
        speaker_profile_id = ""
        speaker_match_confidence = 0.0
        if source == "microphone":
            speaker_kind, speaker_profile_id, speaker_match_confidence = self._classify_meeting_speaker(
                source,
                audio if audio is not None else np.zeros(0, dtype=np.float32),
            )
        meeting_chunk = MeetingChunk(
            chunk=chunk,
            source=source,
            turn_id=turn_id,
            speaker_id=speaker_id,
            speaker_label=speaker_label,
            speaker_kind=speaker_kind,
            speaker_profile_id=speaker_profile_id,
            speaker_match_confidence=speaker_match_confidence,
        )
        self._emit_meeting_chunk(meeting_chunk)
        if self._should_translate(chunk) and self.config is not None:
            self.translation_queue.put((meeting_chunk, self.config))

    def _flush_meeting_transcribers(self) -> None:
        for source, transcriber in (("microphone", self.meeting_mic_transcriber), ("system", self.meeting_system_transcriber)):
            if transcriber is None:
                continue
            flush = getattr(transcriber, "flush", None)
            if not callable(flush):
                continue
            try:
                base_time_ms = now_ms()
                for chunk in flush(base_time_ms):
                    self._emit_chunk_from_source(chunk, source)
            except Exception as error:
                trace_debug(f"meeting flush failed source={source} session={self.config.session_id if self.config else 'none'} error={error}")

    def _emit_final_chunk(self, chunk: TranscriptChunk) -> None:
        if self.transcriber is not None:
            self.transcriber.finalized_ids.add(chunk.segment_id)
        source_text = chunk.source_text
        if self.config is not None and self.config.mode == "dictation":
            normalized = normalize_text(source_text)
            if normalized:
                append_dictation_fragment(self.dictation_parts, normalized)
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

    def _run_meeting_stream_loop(self) -> None:
        emit({"type": "session_state", "state": "streaming"})
        assert self.config is not None
        assert self.capture is not None

        session_start_ms = now_ms()

        while not self.stop_event.is_set():
            time.sleep(0.025)
            incoming_mic = self.capture.drain_primary() if self.config.meeting_source_mode in {"microphone", "dual"} else np.zeros(0, dtype=np.float32)
            incoming_system = self.capture.drain_output() if self.config.meeting_source_mode == "dual" else np.zeros(0, dtype=np.float32)
            if self.config.meeting_source_mode == "system-audio":
                incoming_system = self.capture.drain_primary()

            emit({
                "type": "metrics",
                "inputLevel": self.capture.level,
                "processingLagMs": 0,
                "queueDepth": self.capture.queue.qsize(),
            })

            for source, incoming, transcriber in (
                ("microphone", incoming_mic, self.meeting_mic_transcriber),
                ("system", incoming_system, self.meeting_system_transcriber),
            ):
                if transcriber is None or incoming.size == 0:
                    continue
                base_time_ms = session_start_ms + int(self.meeting_samples_fed[source] / SAMPLE_RATE * 1000)
                self.meeting_samples_fed[source] += incoming.size
                started_at = now_ms()
                chunks = transcriber.feed_audio(incoming, base_time_ms)
                inference_ms = now_ms() - started_at
                for chunk in chunks:
                    self._emit_chunk_from_source(chunk, source, incoming)
                if inference_ms > 0:
                    emit({
                        "type": "metrics",
                        "inputLevel": self.capture.level,
                        "processingLagMs": inference_ms,
                        "queueDepth": self.capture.queue.qsize(),
                    })

    def _stream_loop(self) -> None:
        assert self.config is not None
        if self.config.mode == "meeting":
            self._run_meeting_stream_loop()
            return

        emit({"type": "session_state", "state": "streaming"})
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
                    last_chunk = batch[-1][0].chunk if isinstance(batch[-1][0], MeetingChunk) else batch[-1][0]
                    if batch and count_words(last_chunk.source_text) <= SHORT_SEGMENT_WORDS:
                        wait_seconds = 0.34
                    remaining = wait_seconds - (time.monotonic() - batch_started_at)
                    if remaining <= 0:
                        break
                    try:
                        next_chunk, next_config = self.translation_queue.get(timeout=remaining)
                    except queue.Empty:
                        break
                    current_chunk = next_chunk.chunk if isinstance(next_chunk, MeetingChunk) else next_chunk
                    batch_last_chunk = batch[-1][0].chunk if isinstance(batch[-1][0], MeetingChunk) else batch[-1][0]
                    same_langs = (
                        next_config.source_lang == config.source_lang
                        and next_config.target_lang == config.target_lang
                    )
                    nearby = current_chunk.started_at_ms - batch_last_chunk.ended_at_ms <= 1400
                    if same_langs and nearby:
                        batch.append((next_chunk, next_config))
                        continue
                    self.translation_queue.put((next_chunk, next_config))
                    break

                # Use detected language from transcription when available,
                # so Apple STT (detected_lang="en") translates en→zh-TW
                # even when config.source_lang is "zh" (default).
                first_chunk = batch[0][0].chunk if isinstance(batch[0][0], MeetingChunk) else batch[0][0]
                effective_source = first_chunk.detected_lang or config.source_lang
                if effective_source in {"", "auto"}:
                    effective_source = "auto"
                texts = [(item[0].chunk if isinstance(item[0], MeetingChunk) else item[0]).source_text for item in batch]
                print(f"[translate] {effective_source}→{config.target_lang} texts={texts}", file=sys.stderr)
                translated_items = self.translator.translate_many(
                    texts,
                    effective_source,
                    config.target_lang,
                )
                print(f"[translate] results={translated_items}", file=sys.stderr)
                for index, (translated_chunk, _) in enumerate(batch):
                    translated = translated_items[index] if index < len(translated_items) else ""
                    if isinstance(translated_chunk, MeetingChunk):
                        self._emit_meeting_chunk(translated_chunk, translated)
                    else:
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


def run_mlx_whisper_probe() -> int:
    import mlx.core as mx  # type: ignore

    mx.random.key(0)
    sys.stdout.write("READY\n")
    return 0


def run_mlx_whisper_transcribe(audio_path: str, source_lang: str | None) -> int:
    import mlx_whisper  # type: ignore

    kwargs: dict[str, Any] = {"path_or_hf_repo": MLX_WHISPER_MODEL}
    normalized_source = normalize_mlx_whisper_lang(source_lang or "auto")
    if normalized_source:
        kwargs["language"] = normalized_source
    result = mlx_whisper.transcribe(audio_path, **kwargs)
    sys.stdout.write(
        json.dumps(
            {
                "text": str(result.get("text", "")),
                "language": str(result.get("language", normalized_source or "")),
            },
            ensure_ascii=False,
        )
    )
    return 0


def cli() -> int:
    multiprocessing.freeze_support()
    parser = argparse.ArgumentParser()
    parser.add_argument("--list-devices", action="store_true")
    parser.add_argument("--enroll-speaker", action="store_true")
    parser.add_argument("--mlx-whisper-probe", action="store_true")
    parser.add_argument("--mlx-whisper-transcribe", action="store_true")
    parser.add_argument("--audio-path", type=str, default="")
    parser.add_argument("--source-lang", type=str, default="")
    parser.add_argument("--device-id", type=str, default="")
    parser.add_argument("--duration-sec", type=float, default=8.0)
    parser.add_argument("--model-dir", type=str, default=None)
    args = parser.parse_args()

    if args.model_dir:
        _apply_model_dir(args.model_dir)

    if args.list_devices:
        sys.stdout.write(json.dumps(list_audio_devices(), ensure_ascii=False) + "\n")
        return 0

    if args.enroll_speaker:
        if not args.device_id:
            raise RuntimeError("--device-id is required for --enroll-speaker")
        result = enroll_local_speaker(args.device_id, args.duration_sec)
        sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
        return 0

    if args.mlx_whisper_probe:
        return run_mlx_whisper_probe()

    if args.mlx_whisper_transcribe:
        if not args.audio_path:
            raise RuntimeError("--audio-path is required for --mlx-whisper-transcribe")
        return run_mlx_whisper_transcribe(args.audio_path, args.source_lang)

    return SidecarApp().run()


if __name__ == "__main__":
    raise SystemExit(cli())

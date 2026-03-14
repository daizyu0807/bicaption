#!/usr/bin/env python3
from __future__ import annotations

import argparse
import collections
import json
import math
import os
import queue
import re
import sys
import threading
import time
from dataclasses import dataclass
from typing import Any

os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
os.environ.setdefault("HF_HUB_VERBOSITY", "error")

import numpy as np
import sounddevice as sd
from deep_translator import GoogleTranslator
from faster_whisper import WhisperModel
from opencc import OpenCC

SAMPLE_RATE = 16_000
CHANNELS = 1
MAX_BUFFER_SECONDS = 4.5
INFERENCE_WINDOW_SECONDS = 3.0
FINALIZE_OVERLAP_MS = 450
SILENCE_GATE = 0.003
MAX_COMPRESSION_RATIO = 8.0
MIN_AVG_LOGPROB = -4.0
MAX_NO_SPEECH_PROB = 1.0
TRANSLATION_BATCH_WINDOW_MS = 220
SHORT_SEGMENT_WORDS = 4
PARTIAL_EMIT_MIN_INTERVAL_MS = 140
PARTIAL_STABILITY_HITS = 1
SILENCE_FINALIZE_MS = 480
TRANSCRIBE_INTERVAL_MS = 180
MAX_PHRASE_DURATION_MS = 2600


def emit(event: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def now_ms() -> int:
    return int(time.time() * 1000)


def normalize_text(text: str) -> str:
    return " ".join(text.strip().split())


def count_words(text: str) -> int:
    return len([token for token in re.split(r"\s+", normalize_text(text)) if token])


def make_segment_id(start_ms: int, end_ms: int) -> str:
    return f"seg-{round(start_ms / 100)}-{round(end_ms / 100)}"


def looks_like_garbage_text(text: str) -> bool:
    normalized = normalize_text(text)
    if not normalized:
      return True

    collapsed = normalized.replace(" ", "")
    if len(collapsed) < 2:
        return True

    counts = collections.Counter(collapsed)
    most_common_ratio = counts.most_common(1)[0][1] / len(collapsed)
    if most_common_ratio > 0.72:
        return True

    pairs = [collapsed[index:index + 2] for index in range(max(0, len(collapsed) - 1))]
    if pairs:
        pair_ratio = collections.Counter(pairs).most_common(1)[0][1] / len(pairs)
        if pair_ratio > 0.62:
            return True

    meaningful_chars = sum(ch.isalpha() or "\u4e00" <= ch <= "\u9fff" for ch in normalized)
    if meaningful_chars / len(normalized) < 0.28:
        return True

    return False


def list_audio_devices() -> list[dict[str, Any]]:
    devices: list[dict[str, Any]] = []
    for index, device in enumerate(sd.query_devices()):
        max_inputs = int(device.get("max_input_channels", 0))
        if max_inputs <= 0:
            continue
        devices.append(
            {
                "id": str(index),
                "name": str(device.get("name", "")),
                "label": f"{device.get('name', '')} ({max_inputs}ch)",
                "defaultSampleRate": int(device.get("default_samplerate", SAMPLE_RATE)),
            }
        )
    return devices


def resolve_device(device_id: str) -> int | None:
    devices = sd.query_devices()
    if device_id.isdigit():
        index = int(device_id)
        if 0 <= index < len(devices) and int(devices[index].get("max_input_channels", 0)) > 0:
            return index

    lowered = device_id.lower()
    for index, device in enumerate(devices):
        if int(device.get("max_input_channels", 0)) <= 0:
            continue
        name = str(device.get("name", "")).lower()
        if lowered in name:
            return index
    return None


class TranslationProvider:
    def translate(self, text: str, source_lang: str, target_lang: str) -> str:
        raise NotImplementedError

    def translate_many(self, texts: list[str], source_lang: str, target_lang: str) -> list[str]:
        return [self.translate(text, source_lang, target_lang) for text in texts]


class FallbackTranslator(TranslationProvider):
    GLOSSARY = {
        "hello": "你好",
        "everyone": "各位",
        "meeting": "會議",
        "project": "專案",
        "today": "今天",
        "thank you": "謝謝",
        "status": "狀態",
        "audio": "音訊",
        "blackhole": "BlackHole",
    }

    def translate(self, text: str, _source_lang: str, _target_lang: str) -> str:
        normalized = normalize_text(text)
        if not normalized:
            return ""
        result = normalized
        for source, target in self.GLOSSARY.items():
            result = result.replace(source, target).replace(source.title(), target)
        return result


class MarianTranslator(TranslationProvider):
    def __init__(self, source_lang: str = "en", target_lang: str = "zh-CN") -> None:
        self.source_lang = source_lang
        self.target_lang = target_lang
        self.translator = GoogleTranslator(source=source_lang, target=target_lang)
        self.opencc = OpenCC("s2t")
        self.cache: dict[tuple[str, str, str], str] = {}

    def translate(self, text: str, _source_lang: str, target_lang: str) -> str:
        normalized = normalize_text(text)
        if not normalized:
            return ""
        cache_key = (normalized.lower(), self.source_lang, target_lang.lower())
        cached = self.cache.get(cache_key)
        if cached is not None:
            return cached
        translated = self.translator.translate(normalized).strip()
        if target_lang.lower() in {"zh-tw", "zh-hant", "traditional-chinese"}:
            translated = self.opencc.convert(translated)
        self.cache[cache_key] = translated
        return translated

    def translate_many(self, texts: list[str], source_lang: str, target_lang: str) -> list[str]:
        normalized_items = [normalize_text(text) for text in texts]
        results = [""] * len(normalized_items)
        missing_indexes: list[int] = []
        cache_keys: list[tuple[str, str, str]] = []

        for index, item in enumerate(normalized_items):
            cache_key = (item.lower(), source_lang, target_lang.lower())
            cache_keys.append(cache_key)
            if not item:
                continue
            cached = self.cache.get(cache_key)
            if cached is not None:
                results[index] = cached
            else:
                missing_indexes.append(index)

        if not missing_indexes:
            return results

        batch_input = "\n".join(normalized_items[index] for index in missing_indexes)
        if batch_input:
            translated_batch = self.translator.translate(batch_input).strip()
            if target_lang.lower() in {"zh-tw", "zh-hant", "traditional-chinese"}:
                translated_batch = self.opencc.convert(translated_batch)
            split_batch = [part.strip() for part in translated_batch.splitlines() if part.strip()]
            if len(split_batch) == len(missing_indexes):
                for offset, index in enumerate(missing_indexes):
                    results[index] = split_batch[offset]
                    self.cache[cache_keys[index]] = split_batch[offset]
                return results

        for index in missing_indexes:
            results[index] = self.translate(normalized_items[index], source_lang, target_lang)
        return results


def create_translation_provider(name: str) -> TranslationProvider:
    if name in {"disabled", "off", "none"}:
        raise RuntimeError("translation disabled")
    if name in {"google", "marian-en-zh", "opus-mt-en-zh", "real-local"}:
        return MarianTranslator("en", "zh-CN")
    return FallbackTranslator()


@dataclass
class SessionConfig:
    device_id: str
    source_lang: str
    target_lang: str
    stt_model: str
    translate_model: str
    chunk_ms: int
    beam_size: int = 1
    best_of: int = 1
    vad_filter: bool = False
    condition_on_prev: bool = False


@dataclass
class TranscriptChunk:
    segment_id: str
    source_text: str
    started_at_ms: int
    ended_at_ms: int
    confidence: float


class AudioCapture:
    def __init__(self, device_id: str, chunk_ms: int) -> None:
        self.device_id = device_id
        self.device_index = resolve_device(device_id)
        if self.device_index is None:
            raise RuntimeError(f"Audio input device not found: {device_id}")
        self.chunk_ms = max(400, chunk_ms)
        self.queue: queue.Queue[np.ndarray] = queue.Queue()
        self.level = 0.0
        self.stream: sd.InputStream | None = None

    def start(self) -> None:
        def callback(indata: np.ndarray, frames: int, _time_info: Any, status: sd.CallbackFlags) -> None:
            if status:
                emit(
                    {
                        "type": "error",
                        "code": "audio_callback_status",
                        "message": str(status),
                        "recoverable": True,
                    }
                )
            mono = np.copy(indata[:, 0])
            self.level = max(0.0, min(1.0, math.sqrt(float(np.mean(np.abs(mono))) * 8)))
            self.queue.put(mono)

        self.stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            dtype="float32",
            device=self.device_index,
            callback=callback,
            blocksize=max(512, int(SAMPLE_RATE * self.chunk_ms / 4000)),
        )
        self.stream.start()

    def stop(self) -> None:
        if self.stream is not None:
            self.stream.stop()
            self.stream.close()
            self.stream = None

    def drain(self) -> np.ndarray:
        chunks: list[np.ndarray] = []
        while True:
            try:
                chunks.append(self.queue.get_nowait())
            except queue.Empty:
                break
        if not chunks:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(chunks).astype(np.float32)


class StreamingTranscriber:
    def __init__(self, model_name: str, language: str, config: SessionConfig) -> None:
        resolved_model_name = model_name
        if language.lower().startswith("en") and model_name in {"tiny", "base", "small", "medium"}:
            resolved_model_name = f"{model_name}.en"
        self.model = WhisperModel(resolved_model_name, device="auto", compute_type="int8")
        self.beam_size = config.beam_size
        self.best_of = config.best_of
        self.vad_filter = config.vad_filter
        self.condition_on_prev = config.condition_on_prev
        self.finalized_ids: set[str] = set()
        self.partial_id: str | None = None

    def transcribe_window(self, audio_window: np.ndarray, absolute_start_ms: int, language: str) -> list[TranscriptChunk]:
        if audio_window.size == 0:
            return []

        segments, _ = self.model.transcribe(
            audio_window,
            language=language or None,
            vad_filter=self.vad_filter,
            beam_size=self.beam_size,
            best_of=self.best_of,
            temperature=0,
            condition_on_previous_text=self.condition_on_prev,
            word_timestamps=False,
        )

        chunks: list[TranscriptChunk] = []
        for segment in segments:
            text = normalize_text(segment.text)
            if not text:
                continue
            avg_logprob = float(getattr(segment, "avg_logprob", -0.7) or -0.7)
            compression_ratio = float(getattr(segment, "compression_ratio", 1.0) or 1.0)
            no_speech_prob = float(getattr(segment, "no_speech_prob", 0.0) or 0.0)
            is_low_quality = (
                avg_logprob < MIN_AVG_LOGPROB
                or compression_ratio > MAX_COMPRESSION_RATIO
                or no_speech_prob > MAX_NO_SPEECH_PROB
            )
            if is_low_quality and looks_like_garbage_text(text):
                continue
            started_at_ms = absolute_start_ms + int(segment.start * 1000)
            ended_at_ms = absolute_start_ms + int(segment.end * 1000)
            segment_id = make_segment_id(started_at_ms, ended_at_ms)
            chunks.append(
                TranscriptChunk(
                    segment_id=segment_id,
                    source_text=text,
                    started_at_ms=started_at_ms,
                    ended_at_ms=ended_at_ms,
                    confidence=avg_logprob,
                )
            )
        return chunks


class SidecarApp:
    def __init__(self) -> None:
        self.active = False
        self.thread: threading.Thread | None = None
        self.stop_event = threading.Event()
        self.config: SessionConfig | None = None
        self.capture: AudioCapture | None = None
        self.transcriber: StreamingTranscriber | None = None
        self.translator: TranslationProvider | None = None
        self.buffer = np.zeros(0, dtype=np.float32)
        self.buffer_started_at_ms = now_ms()
        self.last_voice_at_ms = 0
        self.pending_partial: TranscriptChunk | None = None
        self.last_partial_text = ""
        self.last_partial_emit_ms = 0
        self.last_transcribe_at_ms = 0
        self.partial_stability_hits = 0
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
        if self.active:
            self.stop_session()

        self.config = SessionConfig(
            device_id=str(payload.get("deviceId", "blackhole")),
            source_lang=str(payload.get("sourceLang", "en")),
            target_lang=str(payload.get("targetLang", "zh-TW")),
            stt_model=str(payload.get("sttModel", "tiny")),
            translate_model=str(payload.get("translateModel", "marian-en-zh")),
            chunk_ms=int(payload.get("chunkMs", 900)),
            beam_size=int(payload.get("beamSize", 1)),
            best_of=int(payload.get("bestOf", 1)),
            vad_filter=bool(payload.get("vadFilter", False)),
            condition_on_prev=bool(payload.get("conditionOnPrev", False)),
        )
        self.stop_event.clear()
        self.active = True
        emit({"type": "session_state", "state": "connecting", "detail": f"Connecting to {self.config.device_id}"})

        try:
            self.capture = AudioCapture(self.config.device_id, self.config.chunk_ms)
            self.capture.start()
            self.transcriber = StreamingTranscriber(self.config.stt_model, self.config.source_lang, self.config)
            if self.config.translate_model in {"disabled", "off", "none"} or self.config.target_lang == self.config.source_lang:
                self.translator = None
            else:
                try:
                    self.translator = create_translation_provider(self.config.translate_model)
                except Exception as error:
                    emit(
                        {
                            "type": "error",
                            "code": "translation_provider_fallback",
                            "message": f"Falling back to glossary translator: {error}",
                            "recoverable": True,
                        }
                    )
                    self.translator = FallbackTranslator()
        except Exception as error:
            emit({"type": "error", "code": "session_start_failed", "message": str(error), "recoverable": True})
            self.active = False
            self.capture = None
            self.transcriber = None
            self.translator = None
            emit({"type": "session_state", "state": "error", "detail": str(error)})
            return

        self.buffer = np.zeros(0, dtype=np.float32)
        self.buffer_started_at_ms = now_ms()
        self.last_voice_at_ms = 0
        self.pending_partial = None
        self.last_partial_text = ""
        self.last_partial_emit_ms = 0
        self.last_transcribe_at_ms = 0
        self.partial_stability_hits = 0
        self.thread = threading.Thread(target=self._stream_loop, daemon=True)
        self.thread.start()

    def stop_session(self) -> None:
        self.stop_event.set()
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=1.5)
        self.thread = None
        if self.capture is not None:
            self.capture.stop()
            self.capture = None
        if self.active:
            self.active = False
            emit({"type": "session_state", "state": "stopped"})

    def _trim_buffer_before(self, cutoff_ms: int) -> None:
        if cutoff_ms <= self.buffer_started_at_ms or self.buffer.size == 0:
            return
        trim_ms = max(0, cutoff_ms - self.buffer_started_at_ms)
        trim_samples = min(self.buffer.size, int(trim_ms / 1000 * SAMPLE_RATE))
        if trim_samples <= 0:
            return
        self.buffer = self.buffer[trim_samples:]
        self.buffer_started_at_ms += int(trim_samples / SAMPLE_RATE * 1000)

    def _reset_partial_state(self) -> None:
        self.pending_partial = None
        self.last_partial_text = ""
        self.partial_stability_hits = 0

    def _clear_phrase_buffer(self) -> None:
        self.buffer = np.zeros(0, dtype=np.float32)
        self.buffer_started_at_ms = now_ms()
        self.last_transcribe_at_ms = 0
        self._reset_partial_state()

    def _emit_final_chunk(self, chunk: TranscriptChunk) -> None:
        if self.transcriber is not None:
            self.transcriber.finalized_ids.add(chunk.segment_id)
        emit(
            {
                "type": "final_caption",
                "segmentId": chunk.segment_id,
                "sourceText": chunk.source_text,
                "translatedText": "",
                "startedAtMs": chunk.started_at_ms,
                "endedAtMs": chunk.ended_at_ms,
                "latencyMs": now_ms() - chunk.started_at_ms,
                "confidence": chunk.confidence,
            }
        )
        if self.translator is not None and self.config is not None:
            self.translation_queue.put((chunk, self.config))

    def _transcribe_latest_chunk(self, audio_window: np.ndarray, absolute_start_ms: int) -> TranscriptChunk | None:
        assert self.config is not None
        assert self.transcriber is not None
        chunks = self.transcriber.transcribe_window(audio_window, absolute_start_ms, self.config.source_lang)
        if not chunks:
            return None
        return chunks[-1]

    def _maybe_emit_partial(self, chunk: TranscriptChunk) -> None:
        text = normalize_text(chunk.source_text)
        if not text:
            return
        if text == self.last_partial_text:
            self.partial_stability_hits += 1
        else:
            previous_words = count_words(self.last_partial_text)
            next_words = count_words(text)
            if self.last_partial_text and text.startswith(self.last_partial_text) and next_words >= previous_words:
                self.partial_stability_hits = max(1, self.partial_stability_hits)
            else:
                self.partial_stability_hits = 0
            self.last_partial_text = text
        self.pending_partial = chunk
        enough_time_elapsed = now_ms() - self.last_partial_emit_ms >= PARTIAL_EMIT_MIN_INTERVAL_MS
        long_enough = count_words(text) >= 1
        if self.partial_stability_hits < PARTIAL_STABILITY_HITS or not enough_time_elapsed or not long_enough:
            return
        self.last_partial_emit_ms = now_ms()
        emit(
            {
                "type": "partial_caption",
                "segmentId": chunk.segment_id,
                "sourceText": text,
                "startedAtMs": chunk.started_at_ms,
                "updatedAtMs": self.last_partial_emit_ms,
            }
        )

    def _stream_loop(self) -> None:
        emit({"type": "session_state", "state": "streaming"})
        assert self.config is not None
        assert self.capture is not None
        assert self.transcriber is not None

        min_inference_samples = int(SAMPLE_RATE * max(0.45, self.config.chunk_ms / 1000))
        max_phrase_samples = int(SAMPLE_RATE * MAX_BUFFER_SECONDS)
        inference_window_samples = int(SAMPLE_RATE * INFERENCE_WINDOW_SECONDS)

        while not self.stop_event.is_set():
            time.sleep(max(0.08, self.config.chunk_ms / 5000))
            incoming = self.capture.drain()
            if incoming.size == 0:
                if self.pending_partial is not None and now_ms() - self.last_voice_at_ms >= SILENCE_FINALIZE_MS:
                    self._emit_final_chunk(self.pending_partial)
                    self._clear_phrase_buffer()
                emit(
                    {
                        "type": "metrics",
                        "inputLevel": self.capture.level,
                        "processingLagMs": 0,
                        "queueDepth": self.capture.queue.qsize(),
                    }
                )
                continue

            incoming_level = float(np.mean(np.abs(incoming)))
            if self.buffer.size == 0:
                self.buffer_started_at_ms = now_ms() - int(len(incoming) / SAMPLE_RATE * 1000)

            if incoming_level >= SILENCE_GATE:
                self.last_voice_at_ms = now_ms()

            self.buffer = np.concatenate([self.buffer, incoming])
            if self.buffer.size > max_phrase_samples:
                trim_samples = self.buffer.size - max_phrase_samples
                self.buffer = self.buffer[trim_samples:]
                self.buffer_started_at_ms += int(trim_samples / SAMPLE_RATE * 1000)

            if incoming_level < SILENCE_GATE:
                if self.pending_partial is not None and now_ms() - self.last_voice_at_ms >= SILENCE_FINALIZE_MS:
                    self._emit_final_chunk(self.pending_partial)
                    self._clear_phrase_buffer()
                emit(
                    {
                        "type": "metrics",
                        "inputLevel": self.capture.level,
                        "processingLagMs": 0,
                        "queueDepth": self.capture.queue.qsize(),
                    }
                )
                continue

            emit(
                {
                    "type": "metrics",
                    "inputLevel": self.capture.level,
                    "processingLagMs": 0,
                    "queueDepth": self.capture.queue.qsize(),
                }
            )

            if self.buffer.size < min_inference_samples:
                continue

            if now_ms() - self.last_transcribe_at_ms < TRANSCRIBE_INTERVAL_MS:
                continue

            window = self.buffer[-inference_window_samples:]
            window_start_ms = self.buffer_started_at_ms + int((self.buffer.size - window.size) / SAMPLE_RATE * 1000)
            started_at = now_ms()
            try:
                latest_chunk = self._transcribe_latest_chunk(window, window_start_ms)
            except Exception as error:
                emit({"type": "error", "code": "transcription_failed", "message": str(error), "recoverable": True})
                continue
            self.last_transcribe_at_ms = now_ms()

            if latest_chunk is not None:
                self.transcriber.partial_id = latest_chunk.segment_id
                self._maybe_emit_partial(latest_chunk)
                if latest_chunk.ended_at_ms - latest_chunk.started_at_ms >= MAX_PHRASE_DURATION_MS:
                    self._emit_final_chunk(latest_chunk)
                    self._clear_phrase_buffer()

            emit(
                {
                    "type": "metrics",
                    "inputLevel": self.capture.level,
                    "processingLagMs": now_ms() - started_at,
                    "queueDepth": self.capture.queue.qsize(),
                }
            )

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

                translated_items = self.translator.translate_many(
                    [item[0].source_text for item in batch],
                    config.source_lang,
                    config.target_lang,
                )
                for index, (translated_chunk, _) in enumerate(batch):
                    translated = translated_items[index] if index < len(translated_items) else ""
                    emit(
                        {
                            "type": "final_caption",
                            "segmentId": translated_chunk.segment_id,
                            "sourceText": translated_chunk.source_text,
                            "translatedText": translated,
                            "startedAtMs": translated_chunk.started_at_ms,
                            "endedAtMs": translated_chunk.ended_at_ms,
                            "latencyMs": now_ms() - translated_chunk.started_at_ms,
                            "confidence": translated_chunk.confidence,
                        }
                    )
            except Exception as error:
                emit({"type": "error", "code": "translation_failed", "message": str(error), "recoverable": True})


def cli() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--list-devices", action="store_true")
    args = parser.parse_args()

    if args.list_devices:
        sys.stdout.write(json.dumps(list_audio_devices(), ensure_ascii=False) + "\n")
        return 0

    return SidecarApp().run()


if __name__ == "__main__":
    raise SystemExit(cli())

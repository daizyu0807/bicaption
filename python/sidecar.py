#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import queue
import sys
import threading
import time
from dataclasses import dataclass
from typing import Any

import numpy as np
import sounddevice as sd
from deep_translator import GoogleTranslator
from faster_whisper import WhisperModel
from opencc import OpenCC

SAMPLE_RATE = 16_000
CHANNELS = 1
MAX_BUFFER_SECONDS = 12
INFERENCE_WINDOW_SECONDS = 8
FINALIZE_OVERLAP_MS = 1800


def emit(event: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def now_ms() -> int:
    return int(time.time() * 1000)


def normalize_text(text: str) -> str:
    return " ".join(text.strip().split())


def make_segment_id(start_ms: int, end_ms: int) -> str:
    return f"seg-{round(start_ms / 100)}-{round(end_ms / 100)}"


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

    def translate(self, text: str, _source_lang: str, target_lang: str) -> str:
        normalized = normalize_text(text)
        if not normalized:
            return ""
        translated = self.translator.translate(normalized).strip()
        if target_lang.lower() in {"zh-tw", "zh-hant", "traditional-chinese"}:
            return self.opencc.convert(translated)
        return translated


def create_translation_provider(name: str) -> TranslationProvider:
    if name in {"marian-en-zh", "opus-mt-en-zh", "real-local"}:
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
    def __init__(self, model_name: str) -> None:
        self.model = WhisperModel(model_name, device="auto", compute_type="int8")
        self.finalized_ids: set[str] = set()
        self.partial_id: str | None = None

    def transcribe_window(self, audio_window: np.ndarray, absolute_start_ms: int, language: str) -> list[TranscriptChunk]:
        if audio_window.size == 0:
            return []

        segments, _ = self.model.transcribe(
            audio_window,
            language=language or None,
            vad_filter=True,
            beam_size=1,
            best_of=1,
            temperature=0,
            condition_on_previous_text=False,
            word_timestamps=False,
        )

        chunks: list[TranscriptChunk] = []
        for segment in segments:
            text = normalize_text(segment.text)
            if not text:
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
                    confidence=float(getattr(segment, "avg_logprob", -0.7) or -0.7),
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
            stt_model=str(payload.get("sttModel", "small")),
            translate_model=str(payload.get("translateModel", "marian-en-zh")),
            chunk_ms=int(payload.get("chunkMs", 1800)),
        )
        self.stop_event.clear()
        self.active = True
        emit({"type": "session_state", "state": "connecting", "detail": f"Connecting to {self.config.device_id}"})

        try:
            self.capture = AudioCapture(self.config.device_id, self.config.chunk_ms)
            self.capture.start()
            self.transcriber = StreamingTranscriber(self.config.stt_model)
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

    def _stream_loop(self) -> None:
        emit({"type": "session_state", "state": "streaming"})
        assert self.config is not None
        assert self.capture is not None
        assert self.transcriber is not None
        assert self.translator is not None

        min_inference_samples = int(SAMPLE_RATE * max(0.8, self.config.chunk_ms / 1000))
        max_buffer_samples = SAMPLE_RATE * MAX_BUFFER_SECONDS
        inference_window_samples = SAMPLE_RATE * INFERENCE_WINDOW_SECONDS

        while not self.stop_event.is_set():
            time.sleep(max(0.15, self.config.chunk_ms / 3000))
            incoming = self.capture.drain()
            if incoming.size == 0:
                emit(
                    {
                        "type": "metrics",
                        "inputLevel": self.capture.level,
                        "processingLagMs": 0,
                        "queueDepth": self.capture.queue.qsize(),
                    }
                )
                continue

            if self.buffer.size == 0:
                self.buffer_started_at_ms = now_ms() - int(len(incoming) / SAMPLE_RATE * 1000)

            self.buffer = np.concatenate([self.buffer, incoming])
            if self.buffer.size > max_buffer_samples:
                trim_samples = self.buffer.size - max_buffer_samples
                self.buffer = self.buffer[trim_samples:]
                self.buffer_started_at_ms += int(trim_samples / SAMPLE_RATE * 1000)

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

            window = self.buffer[-inference_window_samples:]
            window_start_ms = self.buffer_started_at_ms + int((self.buffer.size - window.size) / SAMPLE_RATE * 1000)
            started_at = now_ms()
            try:
                chunks = self.transcriber.transcribe_window(window, window_start_ms, self.config.source_lang)
            except Exception as error:
                emit({"type": "error", "code": "transcription_failed", "message": str(error), "recoverable": True})
                continue

            stable_threshold_ms = now_ms() - FINALIZE_OVERLAP_MS
            partials: list[TranscriptChunk] = []
            finals: list[TranscriptChunk] = []

            for chunk in chunks:
                if chunk.ended_at_ms <= stable_threshold_ms:
                    if chunk.segment_id not in self.transcriber.finalized_ids:
                        finals.append(chunk)
                        self.transcriber.finalized_ids.add(chunk.segment_id)
                else:
                    partials.append(chunk)

            for chunk in finals:
                try:
                    translated = self.translator.translate(chunk.source_text, self.config.source_lang, self.config.target_lang)
                except Exception as error:
                    translated = ""
                    emit({"type": "error", "code": "translation_failed", "message": str(error), "recoverable": True})
                emit(
                    {
                        "type": "final_caption",
                        "segmentId": chunk.segment_id,
                        "sourceText": chunk.source_text,
                        "translatedText": translated,
                        "startedAtMs": chunk.started_at_ms,
                        "endedAtMs": chunk.ended_at_ms,
                        "latencyMs": now_ms() - chunk.started_at_ms,
                        "confidence": chunk.confidence,
                    }
                )

            if partials:
                source_text = normalize_text(" ".join(chunk.source_text for chunk in partials))
                last = partials[-1]
                self.transcriber.partial_id = last.segment_id
                emit(
                    {
                        "type": "partial_caption",
                        "segmentId": last.segment_id,
                        "sourceText": source_text,
                        "startedAtMs": partials[0].started_at_ms,
                        "updatedAtMs": now_ms(),
                    }
                )

            emit(
                {
                    "type": "metrics",
                    "inputLevel": self.capture.level,
                    "processingLagMs": now_ms() - started_at,
                    "queueDepth": self.capture.queue.qsize(),
                }
            )


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

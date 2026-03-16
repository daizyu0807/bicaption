#!/usr/bin/env python3
from __future__ import annotations

import argparse
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
SENSEVOICE_MODEL_DIR = os.path.join(SCRIPT_DIR, "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17")
WHISPER_TINY_EN_MODEL_DIR = os.path.join(SCRIPT_DIR, "sherpa-onnx-whisper-tiny.en")
WHISPER_SMALL_MODEL_DIR = os.path.join(SCRIPT_DIR, "sherpa-onnx-whisper-small")
ZIPFORMER_KOREAN_MODEL_DIR = os.path.join(SCRIPT_DIR, "sherpa-onnx-zipformer-korean-2024-06-24")
SILERO_VAD_MODEL = os.path.join(SCRIPT_DIR, "silero_vad.onnx")


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
                "id": str(index),
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
            except Exception:
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
        except Exception:
            pass

        # Fallback: translate one by one
        for index in missing_indexes:
            results[index] = self.translate(normalized_items[index], source_lang, target_lang)
        return results


@dataclass
class SessionConfig:
    device_id: str
    output_device_id: str
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
        self.chunk_ms = max(400, chunk_ms)
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
        blocksize = max(512, int(SAMPLE_RATE * self.chunk_ms / 4000))
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


class SidecarApp:
    def __init__(self) -> None:
        self.active = False
        self.thread: threading.Thread | None = None
        self.stop_event = threading.Event()
        self.config: SessionConfig | None = None
        self.capture: AudioCapture | None = None
        self.transcriber: SenseVoiceTranscriber | None = None
        self.translator: TranslationProvider | None = None
        self.opencc_s2t = OpenCC("s2t")
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
            output_device_id=str(payload.get("outputDeviceId", "")),
            source_lang=str(payload.get("sourceLang", "auto")),
            target_lang=str(payload.get("targetLang", "zh-TW")),
            stt_model=str(payload.get("sttModel", "sensevoice")),
            translate_model=str(payload.get("translateModel", "google")),
            chunk_ms=int(payload.get("chunkMs", 800)),
        )
        self.stop_event.clear()
        self.active = True
        emit({"type": "session_state", "state": "connecting", "detail": f"Connecting to {self.config.device_id}"})

        try:
            self.capture = AudioCapture(self.config.device_id, self.config.chunk_ms, self.config.output_device_id)
            self.capture.start()
            if self.config.stt_model == "whisper-tiny-en":
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

    def _should_translate(self, chunk: TranscriptChunk) -> bool:
        return self.translator is not None and self.config is not None

    def _convert_s2t(self, text: str) -> str:
        return self.opencc_s2t.convert(text)

    def _emit_final_chunk(self, chunk: TranscriptChunk) -> None:
        if self.transcriber is not None:
            self.transcriber.finalized_ids.add(chunk.segment_id)
        source_text = chunk.source_text
        # Convert simplified Chinese to traditional if needed
        if chunk.detected_lang.lower().startswith("zh") and self.config is not None:
            target = self.config.target_lang.lower()
            if "tw" in target or "hant" in target:
                source_text = self._convert_s2t(source_text)
        emit({
            "type": "final_caption",
            "segmentId": chunk.segment_id,
            "sourceText": source_text,
            "translatedText": "",
            "startedAtMs": chunk.started_at_ms,
            "endedAtMs": chunk.ended_at_ms,
            "latencyMs": now_ms() - chunk.started_at_ms,
            "confidence": chunk.confidence,
            "detectedLang": chunk.detected_lang,
        })
        if self._should_translate(chunk):
            self.translation_queue.put((chunk, self.config))

    def _stream_loop(self) -> None:
        emit({"type": "session_state", "state": "streaming"})
        assert self.config is not None
        assert self.capture is not None
        assert self.transcriber is not None

        session_start_ms = now_ms()
        total_samples_fed = 0

        while not self.stop_event.is_set():
            time.sleep(0.05)  # 50ms poll interval
            incoming = self.capture.drain()

            emit({
                "type": "metrics",
                "inputLevel": self.capture.level,
                "processingLagMs": 0,
                "queueDepth": self.capture.queue.qsize(),
            })

            if incoming.size == 0:
                continue

            # Calculate base time from total samples fed
            base_time_ms = session_start_ms + int(total_samples_fed / SAMPLE_RATE * 1000)
            total_samples_fed += incoming.size

            # Feed audio to VAD + SenseVoice
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

                translated_items = self.translator.translate_many(
                    [item[0].source_text for item in batch],
                    config.source_lang,
                    config.target_lang,
                )
                for index, (translated_chunk, _) in enumerate(batch):
                    translated = translated_items[index] if index < len(translated_items) else ""
                    emit({
                        "type": "final_caption",
                        "segmentId": translated_chunk.segment_id,
                        "sourceText": translated_chunk.source_text,
                        "translatedText": translated,
                        "startedAtMs": translated_chunk.started_at_ms,
                        "endedAtMs": translated_chunk.ended_at_ms,
                        "latencyMs": now_ms() - translated_chunk.started_at_ms,
                        "confidence": translated_chunk.confidence,
                    })
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

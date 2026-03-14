#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import sys
import threading
import time
from dataclasses import dataclass
from typing import Any

try:
    import numpy as np
except ImportError:  # pragma: no cover
    np = None

try:
    import sounddevice as sd
except ImportError:  # pragma: no cover
    sd = None


def emit(event: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


class SimpleLocalTranslateProvider:
    GLOSSARY = {
        "hello": "你好",
        "everyone": "各位",
        "meeting": "會議",
        "project": "專案",
        "today": "今天",
        "thank you": "謝謝",
        "status": "狀態",
        "audio": "音訊",
    }

    def translate(self, text: str, _source_lang: str, _target_lang: str) -> str:
        normalized = text.strip()
        if not normalized:
            return ""
        lowered = normalized.lower()
        if lowered in self.GLOSSARY:
            return self.GLOSSARY[lowered]
        translated = normalized
        for source, target in self.GLOSSARY.items():
            translated = translated.replace(source, target).replace(source.title(), target)
        return translated


class SimulatedTranscriptionProvider:
    def __init__(self) -> None:
        self.samples = [
            "Hello everyone",
            "Today we review the project status",
            "Audio routing uses BlackHole",
        ]
        self.index = 0

    def next_partial(self) -> str:
        sample = self.samples[self.index % len(self.samples)]
        midpoint = max(1, len(sample) // 2)
        return sample[:midpoint]

    def next_final(self) -> str:
        sample = self.samples[self.index % len(self.samples)]
        self.index += 1
        return sample


@dataclass
class SessionConfig:
    device_id: str
    source_lang: str
    target_lang: str
    stt_model: str
    translate_model: str
    chunk_ms: int


class SidecarApp:
    def __init__(self) -> None:
        self.active = False
        self.thread: threading.Thread | None = None
        self.stop_event = threading.Event()
        self.config: SessionConfig | None = None
        self.translator = SimpleLocalTranslateProvider()
        self.simulated = SimulatedTranscriptionProvider()

    def run(self) -> int:
        emit({"type": "session_state", "state": "idle"})
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                emit({
                    "type": "error",
                    "code": "invalid_json",
                    "message": "Command must be valid JSON",
                    "recoverable": True,
                })
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
                emit({
                    "type": "error",
                    "code": "unknown_command",
                    "message": f"Unsupported command: {command}",
                    "recoverable": True,
                })
        self.stop_session()
        return 0

    def start_session(self, payload: dict[str, Any]) -> None:
        if self.active:
            self.stop_session()

        self.config = SessionConfig(
            device_id=str(payload.get("deviceId", "default")),
            source_lang=str(payload.get("sourceLang", "en")),
            target_lang=str(payload.get("targetLang", "zh-TW")),
            stt_model=str(payload.get("sttModel", "small")),
            translate_model=str(payload.get("translateModel", "simple-local")),
            chunk_ms=int(payload.get("chunkMs", 1200)),
        )

        self.stop_event.clear()
        self.active = True
        emit({"type": "session_state", "state": "connecting", "detail": f"Connecting to {self.config.device_id}"})
        self.thread = threading.Thread(target=self._stream_loop, daemon=True)
        self.thread.start()

    def stop_session(self) -> None:
        self.stop_event.set()
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=1.0)
        self.thread = None
        if self.active:
            self.active = False
            emit({"type": "session_state", "state": "stopped"})

    def _stream_loop(self) -> None:
        emit({"type": "session_state", "state": "streaming"})
        segment_index = 0
        while not self.stop_event.is_set():
            started = int(time.time() * 1000)
            level = self._read_input_level()
            partial = self.simulated.next_partial()
            emit({
                "type": "partial_caption",
                "segmentId": f"seg-{segment_index}",
                "sourceText": partial,
                "startedAtMs": started,
                "updatedAtMs": int(time.time() * 1000),
            })
            emit({
                "type": "metrics",
                "inputLevel": level,
                "processingLagMs": max(80, self.config.chunk_ms / 4 if self.config else 300),
                "queueDepth": 0,
            })
            time.sleep(max(0.3, (self.config.chunk_ms if self.config else 1200) / 1000))
            final_text = self.simulated.next_final()
            translated_text = self.translator.translate(
                final_text,
                self.config.source_lang if self.config else "en",
                self.config.target_lang if self.config else "zh-TW",
            )
            emit({
                "type": "final_caption",
                "segmentId": f"seg-{segment_index}",
                "sourceText": final_text,
                "translatedText": translated_text,
                "startedAtMs": started,
                "endedAtMs": int(time.time() * 1000),
                "latencyMs": int(time.time() * 1000) - started,
                "confidence": 0.65,
            })
            segment_index += 1

    def _read_input_level(self) -> float:
        if sd is None or np is None or not self.config:
            return 0.2 + (self.simulated.index % 5) * 0.1

        try:
            devices = sd.query_devices()
            device_index = None
            for index, device in enumerate(devices):
                name = str(device.get("name", "")).lower()
                if self.config.device_id.lower() in name:
                    device_index = index
                    break
            if device_index is None:
                return 0.15

            recording = sd.rec(
                frames=max(128, int(16000 * min(0.4, self.config.chunk_ms / 1000))),
                samplerate=16000,
                channels=1,
                dtype="float32",
                device=device_index,
                blocking=True,
            )
            amplitude = float(np.mean(np.abs(recording)))
            return max(0.0, min(1.0, math.sqrt(amplitude * 8)))
        except Exception as error:
            emit({
                "type": "error",
                "code": "audio_probe_failed",
                "message": str(error),
                "recoverable": True,
            })
            return 0.1


def main() -> int:
    return SidecarApp().run()


if __name__ == "__main__":
    raise SystemExit(main())

# Realtime Bilingual Subtitles

Realtime bilingual subtitle overlay for macOS. Captures system audio (via BlackHole) or microphone input, transcribes with [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) (sherpa-onnx), and shows bilingual captions in a transparent always-on-top overlay.

## Features

- Local STT using SenseVoice — fast, no cloud dependency, auto language detection (zh/en/ja/ko/yue)
- Google Translate for bilingual captions (source → target)
- Transparent, resizable overlay window
- Silero VAD for natural speech segmentation
- Optional subtitle log saving
- Settings UI for device selection, language pair, opacity, and font scale

## Requirements

- macOS (Apple Silicon recommended)
- Node.js 20+
- Python 3.9+
- [BlackHole](https://existential.audio/blackhole/) (for system audio capture, optional)

## Setup

```bash
# 1. Install Node dependencies
npm install

# 2. Create Python venv and install dependencies
python3 -m venv .venv
source .venv/bin/activate
pip install -r python/requirements.txt

# 3. Download STT models (~230 MB)
bash scripts/download-models.sh
```

## Run

```bash
npm run dev
```

This starts both the Electron app and the Python sidecar. Select your input device in the settings window and click "Start".

## Audio Setup (System Audio)

To capture system audio from meetings or videos:

1. Install [BlackHole](https://existential.audio/blackhole/) (2ch is enough)
2. Open **Audio MIDI Setup** → create a **Multi-Output Device** combining your speakers + BlackHole
3. Set your system output to the Multi-Output Device
4. In the app, select BlackHole as the input device

## Stack

- **Electron + React** — UI (settings window + overlay)
- **Python sidecar** — audio capture, VAD, STT, translation
- **sherpa-onnx + SenseVoice** — local speech-to-text (non-autoregressive, ~67ms for 3s audio)
- **Silero VAD** — voice activity detection for natural segmentation
- **Google Translate** — bilingual translation (via `deep-translator`)

## Build

```bash
npm run build
npm run type-check
```

## License

MIT

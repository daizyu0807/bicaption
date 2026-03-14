# Realtime Bilingual Subtitles

macOS desktop MVP for showing bilingual subtitles from BlackHole-routed audio.

## Stack

- Electron + React UI
- Python sidecar for audio probe, simulated STT stream, and local translation stub
- BlackHole as the default audio input target

## Run

```bash
npm install
python3 -m venv .venv
source .venv/bin/activate
pip install -r python/requirements.txt
npm run dev
```

## Current MVP state

- Settings window and transparent overlay window
- IPC bridge between Electron and Python sidecar
- Simulated partial/final caption stream
- Local translation provider interface with a simple built-in glossary translator

## Verification

```bash
npm run type-check
npm run build
python3 -m unittest discover -s python/tests
```

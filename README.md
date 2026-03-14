# Realtime Bilingual Subtitles

macOS desktop MVP for showing bilingual subtitles from BlackHole-routed audio.

## Stack

- Electron + React UI
- Python sidecar for real audio ingest, chunked `faster-whisper` STT, and local translation
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
- Real audio device enumeration via `sounddevice`
- Chunked local transcription with `faster-whisper`
- Google Translate-backed English-to-Chinese translation with fallback translator

## Notes

- Translation currently depends on outbound internet access from the Python sidecar.
- For best results, set your meeting app output to a Multi-Output Device that includes BlackHole, then select BlackHole in the app.

## Verification

```bash
npm run type-check
npm run build
python3 -m unittest discover -s python/tests
```

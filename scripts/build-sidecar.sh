#!/usr/bin/env bash
# Build the Python sidecar into a standalone macOS binary using PyInstaller.
# Output: python/dist/bicaption-sidecar  (single-file executable)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/.."
PYTHON_DIR="$PROJECT_ROOT/python"
VENV_PYTHON="$PROJECT_ROOT/.venv/bin/python"

if [ ! -f "$VENV_PYTHON" ]; then
  echo "[build-sidecar] ERROR: .venv not found. Run: python3 -m venv .venv && source .venv/bin/activate && pip install -r python/requirements.txt"
  exit 1
fi

# Ensure PyInstaller is installed
"$VENV_PYTHON" -c "import PyInstaller" 2>/dev/null || {
  echo "[build-sidecar] Installing PyInstaller..."
  "$VENV_PYTHON" -m pip install pyinstaller
}

echo "[build-sidecar] Building sidecar binary..."

# Collect sherpa_onnx shared libraries
SHERPA_COLLECT=$("$VENV_PYTHON" -c "
import os, sherpa_onnx
pkg_dir = os.path.dirname(sherpa_onnx.__file__)
libs = [f for f in os.listdir(pkg_dir) if f.endswith(('.dylib', '.so'))]
for lib in libs:
    print(f'--add-binary={os.path.join(pkg_dir, lib)}:sherpa_onnx')
" 2>/dev/null || true)

# Also collect the native _sherpa_onnx module
SHERPA_NATIVE=$("$VENV_PYTHON" -c "
import os, sherpa_onnx
pkg_dir = os.path.dirname(sherpa_onnx.__file__)
for root, dirs, files in os.walk(pkg_dir):
    for f in files:
        if f.endswith(('.so', '.dylib', '.pyd')):
            rel = os.path.relpath(root, os.path.dirname(pkg_dir))
            print(f'--add-binary={os.path.join(root, f)}:{rel}')
" 2>/dev/null || true)

cd "$PYTHON_DIR"

# Ensure apple-stt binary exists
APPLE_STT="$PYTHON_DIR/apple-stt"
APPLE_STT_FLAG=""
if [ -f "$APPLE_STT" ]; then
  APPLE_STT_FLAG="--add-binary=$APPLE_STT:."
  echo "[build-sidecar] Including apple-stt binary"
else
  echo "[build-sidecar] WARNING: apple-stt not found, SFSpeechRecognizer won't work in packaged build"
fi

"$VENV_PYTHON" -m PyInstaller \
  --onedir \
  --name bicaption-sidecar \
  --distpath dist \
  --workpath build \
  --specpath build \
  --noconfirm \
  --strip \
  --noupx \
  --target-arch arm64 \
  --hidden-import sherpa_onnx \
  --hidden-import numpy \
  --hidden-import sounddevice \
  --hidden-import deep_translator \
  --hidden-import opencc \
  --hidden-import _sounddevice_data \
  --collect-all sherpa_onnx \
  --collect-all _sounddevice_data \
  $SHERPA_COLLECT \
  $SHERPA_NATIVE \
  $APPLE_STT_FLAG \
  sidecar.py

BINARY="$PYTHON_DIR/dist/bicaption-sidecar/bicaption-sidecar"
if [ -f "$BINARY" ]; then
  echo "[build-sidecar] Success: $BINARY"
  du -sh "$PYTHON_DIR/dist/bicaption-sidecar/"
else
  echo "[build-sidecar] ERROR: Binary not found at $BINARY"
  exit 1
fi

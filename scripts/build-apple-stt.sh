#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SWIFT_SRC="$PROJECT_ROOT/swift/apple-stt.swift"
OUTPUT="$PROJECT_ROOT/python/apple-stt"
MODULE_CACHE_DIR="${TMPDIR:-/tmp}/bicaption-swift-module-cache"

SDK_PATH="$(xcrun --show-sdk-path)"
if [[ "${SDK_PATH}" == *"/CommandLineTools/SDKs/MacOSX.sdk" ]]; then
  if [[ -d "/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk" ]]; then
    SDK_PATH="/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk"
  fi
fi

mkdir -p "$MODULE_CACHE_DIR"

echo "Compiling apple-stt..."
swiftc -O \
  -target arm64-apple-macos13 \
  -sdk "$SDK_PATH" \
  -module-cache-path "$MODULE_CACHE_DIR" \
  -o "$OUTPUT" \
  "$SWIFT_SRC" \
  -framework Speech \
  -framework AVFoundation \
  -framework ScreenCaptureKit \
  -framework CoreMedia

echo "Built: $OUTPUT"

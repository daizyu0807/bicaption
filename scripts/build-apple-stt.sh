#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SWIFT_SRC="$PROJECT_ROOT/swift/apple-stt.swift"
OUTPUT="$PROJECT_ROOT/python/apple-stt"

echo "Compiling apple-stt..."
swiftc -O \
  -target arm64-apple-macos13 \
  -o "$OUTPUT" \
  "$SWIFT_SRC" \
  -framework Speech \
  -framework AVFoundation \
  -framework ScreenCaptureKit \
  -framework CoreMedia

echo "Built: $OUTPUT"

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SWIFT_SRC="$PROJECT_ROOT/swift/global-hotkey.swift"
OUTPUT="$PROJECT_ROOT/python/global-hotkey"

echo "Compiling global-hotkey..."
mkdir -p /tmp/clang-module-cache
SDKROOT="$(xcrun --show-sdk-path)"
xcrun swiftc \
  -module-cache-path /tmp/clang-module-cache \
  -sdk "$SDKROOT" \
  -O \
  -target arm64-apple-macos13 \
  -o "$OUTPUT" \
  "$SWIFT_SRC" \
  -framework ApplicationServices \
  -framework Foundation

echo "Built: $OUTPUT"

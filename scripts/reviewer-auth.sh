#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage:
  bash scripts/reviewer-auth.sh                # check all reviewers
  bash scripts/reviewer-auth.sh codex          # login Codex if needed
  bash scripts/reviewer-auth.sh claude gemini  # login selected reviewers if needed
  bash scripts/reviewer-auth.sh --check        # status only, no login flow

Supported reviewers:
  codex
  claude
  gemini
EOF
  exit 0
fi

CHECK_ONLY=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=1
  shift
fi

trim() {
  printf '%s' "$1" | awk '{$1=$1; print}'
}

status_codex() {
  if ! command -v codex >/dev/null 2>&1; then
    echo "missing|Codex CLI not installed"
    return
  fi

  local output
  output="$(codex login status 2>&1 || true)"
  output="$(printf '%s\n' "$output" | rg -v '^WARNING: proceeding, even though we could not update PATH:' || true)"
  if printf '%s' "$output" | rg -q "Logged in"; then
    echo "ready|$(trim "$output")"
    return
  fi
  echo "auth|$(trim "$output")"
}

status_claude() {
  if ! command -v claude >/dev/null 2>&1; then
    echo "missing|Claude CLI not installed"
    return
  fi

  local output
  output="$(claude auth status 2>&1 || true)"
  if printf '%s' "$output" | rg -q '"loggedIn"[[:space:]]*:[[:space:]]*true'; then
    echo "ready|$(trim "$output")"
    return
  fi
  if printf '%s' "$output" | rg -q '"loggedIn"[[:space:]]*:[[:space:]]*false'; then
    echo "auth|$(trim "$output")"
    return
  fi
  echo "unknown|$(trim "$output")"
}

status_gemini() {
  if ! command -v gemini >/dev/null 2>&1; then
    echo "missing|Gemini CLI not installed"
    return
  fi

  if [[ -n "${GEMINI_API_KEY:-}" ]]; then
    echo "ready|GEMINI_API_KEY is set"
    return
  fi

  echo "unknown|Gemini CLI installed, but no non-interactive auth status check is configured"
}

get_status() {
  case "$1" in
    codex) status_codex ;;
    claude) status_claude ;;
    gemini) status_gemini ;;
    *)
      echo "unknown|Unsupported reviewer: $1"
      ;;
  esac
}

run_login() {
  case "$1" in
    codex)
      codex login
      ;;
    claude)
      claude auth login
      ;;
    gemini)
      echo "Gemini CLI 通常會在首次執行時進入互動登入，或直接使用 GEMINI_API_KEY。"
      gemini
      ;;
  esac
}

print_status() {
  local reviewer raw state detail
  for reviewer in "$@"; do
    raw="$(get_status "$reviewer")"
    state="${raw%%|*}"
    detail="${raw#*|}"
    printf '%-7s %-8s %s\n' "$reviewer" "$state" "$detail"
  done
}

ensure_supported() {
  local reviewer
  for reviewer in "$@"; do
    case "$reviewer" in
      codex|claude|gemini) ;;
      *)
        echo "Unsupported reviewer: $reviewer" >&2
        exit 1
        ;;
    esac
  done
}

if [[ "$#" -eq 0 ]]; then
  REVIEWERS=(codex claude gemini)
else
  REVIEWERS=("$@")
fi

ensure_supported "${REVIEWERS[@]}"

echo "Reviewer status:"
print_status "${REVIEWERS[@]}"

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  exit 0
fi

for reviewer in "${REVIEWERS[@]}"; do
  raw="$(get_status "$reviewer")"
  state="${raw%%|*}"
  detail="${raw#*|}"

  case "$state" in
    ready)
      echo
      echo "[$reviewer] already ready"
      ;;
    auth)
      echo
      echo "[$reviewer] auth required"
      run_login "$reviewer"
      ;;
    unknown)
      echo
      echo "[$reviewer] status unknown: $detail"
      echo "[$reviewer] opening login flow anyway"
      run_login "$reviewer"
      ;;
    missing)
      echo
      echo "[$reviewer] missing: $detail" >&2
      ;;
  esac
done

echo
echo "Reviewer status after auth:"
print_status "${REVIEWERS[@]}"

#!/bin/bash
# zhongwen — opens a Mandarin Breakdown overlay window for given text.
#   usage: zhongwen.sh [text]        (falls back to the clipboard)
# Ensures the local server is running, then opens a floating chromeless
# Chrome window (or the default browser) at /?q=<urlencoded text>.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${ZH_PORT:-8123}"
BASE="http://localhost:$PORT"

ensure_server() {
  if curl -sf --max-time 1 "$BASE/" >/dev/null 2>&1; then return 0; fi
  echo "starting Mandarin Breakdown server…" >&2
  mkdir -p "$ROOT/data"
  NODE="${ZH_NODE:-$(command -v node || true)}"
  if [ -z "${NODE:-}" ]; then NODE=/opt/homebrew/bin/node; fi
  ( cd "$ROOT" && NO_OPEN=1 nohup "$NODE" server.js >>"$ROOT/data/server.log" 2>&1 & )
  for _ in $(seq 1 40); do
    curl -sf --max-time 1 "$BASE/" >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  echo "server did not start in time — 'tail $ROOT/data/server.log'" >&2
  exit 1
}

open_window() {
  local text="$1"
  local enc url
  enc=$(printf '%s' "$text" | python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.stdin.read()))')
  url="$BASE/?q=$enc"
  local chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  if [ "${ZH_BROWSER:-Chrome}" = "Chrome" ] && [ -x "$chrome" ]; then
    # --app = chromeless floating window; singleton user-data-dir so repeat
    # invocations reuse one Chrome process
    "$chrome" --app="$url" --user-data-dir="$HOME/.cache/zhongwen-chrome" \
      --window-size=520,720 >/dev/null 2>&1 &
    sleep 0.2
  else
    open "$url"
  fi
}

ensure_server
TEXT="${1-}"
if [ -z "$TEXT" ]; then TEXT="$(pbpaste)"; fi
if [ -z "$TEXT" ]; then
  echo "no text given and clipboard is empty" >&2
  exit 1
fi
TEXT="$(printf '%s' "$TEXT" | python3 -c 'import sys; print(sys.stdin.read()[:200])')"
open_window "$TEXT"

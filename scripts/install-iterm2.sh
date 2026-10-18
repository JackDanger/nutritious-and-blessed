#!/bin/bash
# Installs the iTerm2 中文 (zhōngwén) scripts:
#   ~/Library/Application Support/iTerm2/Scripts/zhongwen.py
#     → Scripts menu: analyzes the current selection immediately
#   ~/Library/Application Support/iTerm2/Scripts/AutoLaunch/zhongwen.py
#     → resident daemon that registers a RIGHT-CLICK context menu item
# Prereqs: iTerm2 → Settings → General → Magic → "Enable Python API"
# (iTerm2 then downloads its bundled Python, which includes the iterm2 module).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/Library/Application Support/iTerm2/Scripts"
ENVDIR="$HOME/Library/ApplicationSupport/iTerm2/iterm2env"

mkdir -p "$DEST/AutoLaunch"

APP_ROOT="$ROOT" python3 - "$ROOT/scripts/zhongwen.py" "$DEST/zhongwen.py" "$DEST/AutoLaunch/zhongwen.py" <<'PY'
import os
import pathlib
import sys

src, *dests = (pathlib.Path(p) for p in sys.argv[1:])
text = src.read_text(encoding="utf-8").replace("{{APP_ROOT}}", os.environ["APP_ROOT"])
for dest in dests:
    dest.write_text(text, encoding="utf-8")
    print("installed:", dest)
PY

if [ ! -d "$ENVDIR" ]; then
  cat <<'EOF'

(it looks like iTerm2's Python environment isn't set up yet:)
  1. In iTerm2: Settings → General → Magic → check "Enable Python API".
     iTerm2 downloads its Python environment on first use.
  2. Quit and reopen iTerm2 — the AutoLaunch daemon starts automatically.
  3. Select Chinese text, then right-click → 「中文 (zhōngwén)」.
  (Alternatively run Scripts → zhongwen once; iTerm2 may ask for permission.)
EOF
else
  echo "(iTerm2 Python environment found — restart iTerm2 or run Scripts → zhongwen once to activate)"
fi

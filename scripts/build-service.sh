#!/bin/bash
# Builds & installs the zhongwen macOS service (native right-click integration).
#
# The registered system service 「中文 (zhōngwén)」 receives the selected text
# and opens a floating Mandarin Breakdown window. Works in any app that shows
# the Services submenu — including iTerm2 if it surfaces one, plus a keyboard
# shortcut via System Settings → Keyboard → Keyboard Shortcuts → Services.
#
# Output: ~/Library/Application Support/MandarinBreakdown/zhongwen.app
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_DIR="${ZH_SERVICE_DIR:-$HOME/Library/Application Support/MandarinBreakdown}"
APP="$INSTALL_DIR/zhongwen.app"
LSREGISTER="$(find /System/Library/Frameworks/CoreServices.framework -name lsregister -print -quit 2>/dev/null || true)"

mkdir -p "$APP/Contents/MacOS"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

APP_ROOT="$ROOT" python3 - "$ROOT/scripts/service-main.swift" "$TMP/main.swift" <<'PY'
import os
import pathlib
import sys

src, dst = (pathlib.Path(p) for p in sys.argv[1:])
dst.write_text(
    src.read_text(encoding="utf-8").replace("{{APP_ROOT}}", os.environ["APP_ROOT"]),
    encoding="utf-8",
)
PY

swiftc -O -framework AppKit -o "$APP/Contents/MacOS/zhongwen" "$TMP/main.swift"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>com.nutritious-and-blessed.zhongwen</string>
    <key>CFBundleName</key>
    <string>zhongwen</string>
    <key>CFBundleDisplayName</key>
    <string>zhongwen</string>
    <key>CFBundleExecutable</key>
    <string>zhongwen</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>12.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSServices</key>
    <array>
        <dict>
            <key>NSMenuItem</key>
            <dict>
                <key>default</key>
                <string>中文 (zhōngwén)</string>
            </dict>
            <key>NSMessage</key>
            <string>zhongwen</string>
            <key>NSPortName</key>
            <string>zhongwen</string>
            <key>NSSendTypes</key>
            <array>
                <string>public.utf8-plain-text</string>
            </array>
        </dict>
    </array>
</dict>
</plist>
PLIST

codesign --force -s - "$APP" 2>/dev/null || true

if [ -n "$LSREGISTER" ]; then
  "$LSREGISTER" -f "$APP" || true
fi
/System/Library/CoreServices/pbs -flush 2>/dev/null \
  || /System/Library/CoreServices/pbs -update 2>/dev/null \
  || true

echo "installed: $APP"
cat <<'EOF'
Registering takes effect immediately for most apps, though a log-out/in
sometimes helps; typically:
  - right-click selected text → Services → 「中文 (zhōngwén)」
  - or give it a key: System Settings → Keyboard → Keyboard Shortcuts →
    Services → Text → 「中文 (zhōngwén)」
If iTerm2's own quick menu doesn't show the Services submenu, use the iTerm2
Python-script integration instead (scripts/install-iterm2.sh) — that one puts
the item directly in iTerm2's right-click menu.
EOF

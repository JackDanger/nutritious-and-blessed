#!/usr/bin/env python3
"""中文 (zhōngwén) — iTerm2 integration for Mandarin Breakdown.

One template installs twice:
  Scripts/zhongwen.py            → Scripts menu item. Immediately breaks down
                                   the current selection and exits.
  Scripts/AutoLaunch/zhongwen.py → resident daemon. Registers a right-click
                                   context menu item 「中文 (zhōngwén)」.

Both: read the selection of the session you interacted with (clipboard as
fallback), make sure the local Mandarin Breakdown server is up, and open a
floating chromeless Chrome window with the interactive breakdown.

Edit with care: the installer rewrites {{APP_ROOT}} below.
"""

import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

APP = Path("{{APP_ROOT}}")
PORT = 8123
BASE = f"http://localhost:{PORT}"
CHROME = Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")


def ensure_server() -> None:
    try:
        urllib.request.urlopen(BASE + "/", timeout=0.6).read(16)
        return
    except Exception:
        pass
    (APP / "data").mkdir(exist_ok=True)
    log = open(APP / "data" / "server.log", "ab")
    subprocess.Popen(
        ["/usr/bin/env", "NO_OPEN=1", "node", "server.js"],
        cwd=APP,
        stdout=log,
        stderr=log,
        start_new_session=True,
    )
    for _ in range(40):
        try:
            urllib.request.urlopen(BASE + "/", timeout=0.6).read(16)
            return
        except Exception:
            time.sleep(0.25)


def open_window(text: str) -> None:
    url = BASE + "/?q=" + urllib.parse.quote(text[:200])
    if CHROME.exists():
        subprocess.Popen(
            [
                CHROME,
                "--app=" + url,
                "--user-data-dir=" + str(Path.home() / ".cache" / "zhongwen-chrome"),
                "--window-size=520,720",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    else:
        subprocess.run(["/usr/bin/open", url], check=False)


def current_session(app):
    window = app.current_terminal_window
    if window is not None:
        return window.current_tab.current_session
    for w in app.terminal_windows:
        return w.current_tab.current_session
    return None


import iterm2  # noqa: E402  (iTerm2's bundled Python provides it)

APP_REF = None


@iterm2.ContextMenuProviderRPC
async def zhongwen_item(session_id=iterm2.Reference("id")):
    session = APP_REF.get_session_by_id(session_id) if APP_REF else None
    if session is not None:
        await breakdown_with_session(session)


async def breakdown_with_session(session) -> None:
    selection = await session.async_get_selection()
    text = (await session.async_get_selection_text(selection)).strip()
    if not text:
        try:
            text = subprocess.run(
                ["/usr/bin/pbpaste"], capture_output=True, text=True
            ).stdout.strip()
        except Exception:
            text = ""
    ensure_server()
    open_window(text or "(nothing selected and clipboard is empty)")


def is_daemon() -> bool:
    return Path(sys.argv[0]).parent.name in {"AutoLaunch", "AutoRun"}


async def main(connection) -> None:
    global APP_REF
    APP_REF = await iterm2.async_get_app(connection)
    try:
        await zhongwen_item.async_register(
            connection,
            "中文 (zhōngwén)",
            "com.nutritious-and-blessed.zhongwen",
        )
    except Exception as exc:  # old iTerm2, API off, etc.
        print("context-menu registration failed:", exc, file=sys.stderr)
    if is_daemon():
        await iterm2.async_wait_forever()  # keep the menu item registered
    else:
        session = current_session(APP_REF)
        if session is not None:
            await breakdown_with_session(session)
        else:
            print("no terminal session found", file=sys.stderr)


# iTerm2 runs this with its bundled Python (…/iTerm2/iterm2env/…/python3),
# which includes the iterm2 module.
if is_daemon():
    iterm2.run_forever(main)
else:
    iterm2.run_until_complete(main)

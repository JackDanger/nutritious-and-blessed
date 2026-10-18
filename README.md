# Mandarin Breakdown

A tiny local web app for picking Mandarin text apart: the whole sentence, the words
inside it, the characters inside the words, and the radicals/components inside the
characters. Built for picking the language back up with a year of formal Mandarin
behind you.

## Run it

```sh
npm start
```

First run downloads ~7 MB of open dictionary data (CC-CEDICT, makemeahanzi character
dictionary, a word-frequency list) and starts a server on **http://localhost:8123**
(if that port is busy it walks forward; the actual URL is printed).

Rebuild the data later with `npm run setup`, or force a refresh with `npm run setup:force`.

No dependencies, no build step, no LLM, nothing running on your GPU.

## What it does

- **Whole** — Google Translate's rendering of your text plus the alternate dictionary
  senses Google lists below its main translation.
- **Pieces** — an expandable tree built from longest-match segmentation against
  CC-CEDICT, weighted by word frequency: words → characters → radical + parts, each
  level labeled with text badges and pinyin with tone marks *and* superscript tone
  numerals (`yíng²`) so tones never rely on color.
- **Character panel** — click any character in the results:
  - radical (glyph + English name)
  - components from the character's IDS decomposition (e.g. 营 = ⿱艹⿱冖吕), each with
    its own reading/meaning, and clickable for deeper digging
  - definition and etymology hint
  - words the character shows up in, ranked by real-world frequency
  - **homophone chips** — swap the character for something sounding-alike and instantly
    re-analyze (↺ undo swaps back). This recreates the "swap characters and see what
    else it means" loop without copy-pasting into Google Translate.
- Radical cheat-sheet lives in `public/radicals.json` (also served at `/radicals.json`).
- Recent queries are kept in localStorage.

## iTerm2 / right-click integration (中文 zhōngwén)

Goal: select some Chinese text in iTerm2, right-click (or press a key), and get a
floating interactive breakdown window over your terminal. Three tiers, best first:

1. **Right-click menu item (iTerm2 native).**
   ```sh
   ./scripts/install-iterm2.sh
   ```
   Then enable iTerm2's Python API once: *Settings → General → Magic → Enable Python
   API* (iTerm2 downloads its bundled Python), and restart iTerm2. The daemon at
   `Scripts/AutoLaunch/zhongwen.py` registers a **right-click → 「中文 (zhōngwén)」**
   item that reads your selection and opens the overlay window.
   `Scripts/zhongwen.py` is the same thing as a Scripts-menu one-shot.

   Notes from the field (iTerm2 3.7.6):
   - iTerm2's newer support dir lives at `~/.config/iterm2/AppSupport` (a symlink to
     `~/Library/Application Support/iTerm2`) — the installer writes through it fine.
   - AutoLaunch runs at every iTerm2 start; the item registers on connect.
   - `launch API script named` from AppleScript waits for the script to *exit*, so
     use the menu/one-shot for ad-hoc runs, not the resident daemon.
   - If right-clicks are swallowed by tmux's own menu (mouse reporting enabled),
     hold **⌥ or ⌘** while right-clicking to get iTerm2's menu.

2. **Native macOS service (no iTerm2 API needed, works in any app).**
   ```sh
   scripts/build-service.sh    # builds via swiftc into ~/Library/Application Support
   ```
   Registers system service 「中文 (zhōngwén)」: right-click → Services → (or assign
   it a key in *System Settings → Keyboard → Keyboard Shortcuts → Services*).

3. **Universal fallback.** Selected text, ⌘C, then `scripts/zhongwen.sh` — same
   floating window. `launch` from anywhere; no iTerm2 involvement.

**tmux notes.** The copy-mode bindings in a typical vi-style tmux pipe selections
to `pbcopy` (`y` / `Enter`), so this one-liner pairs well with the CLI tier:

```tmux
bind-key Z run-shell -b "~/www/nutritious-and-blessed/scripts/zhongwen.sh"
```

Select with the mouse in copy-mode → `y` → `prefix + Z` → floating breakdown.

All three make sure the local server is running (spawning it headless if needed)
and open a chromeless Chrome `--app` window (`http://localhost:8123/?q=…`, which
auto-analyzes on load) floating above your work. Toggle knobs: `ZH_PORT`,
`ZH_BROWSER` (set to something else for `open` in the default browser). Without
Chrome the plain default browser is used.

## Files

```
server.js               HTTP server + 2 JSON APIs + Google translate proxy
scripts/build-data.mjs  downloads & compiles the open datasets into data/
scripts/zhongwen.sh     universal launcher: server bootstrap + floating window
scripts/zhongwen.py     iTerm2 script (context-menu daemon + menu one-shot)
scripts/install-iterm2.sh         installs the iTerm2 scripts
scripts/service-main.swift        native service app source
scripts/build-service.sh          builds & registers the macOS service
public/                 index.html, app.js, style.css, radicals.json (frontend)
data/                   generated on first run, gitignored
```

APIs:

- `GET /api/analyze?q=…` → `{ translation, googleSenses, segments[], fullPinyin, … }`
- `GET /api/char?c=…` → `{ pinyin, definition, etymology, radical, components[], related[], homophones[] }`

## Data sources (licenses)

- [CC-CEDICT](https://www.mdbg.net/chinese/dictionary?page=cc-cedict) — words, pinyin,
  glosses. License: CC BY-SA 4.0.
- [makemeahanzi](https://github.com/skishore/makemeahanzi) — per-character definitions,
  pinyin, decomposition (IDS), radicals, etymology. Data licensed under the
  Arphic Public License.
- [FrequencyWords](https://github.com/hermitdave/FrequencyWords) (OpenSubtitles-derived)
  — word frequencies used for ranking and segmentation weighting.
- Google Translate — free `translate_a/single` endpoint, called server-side only.
  No API key. If the request fails, everything else still works offline.

## Privacy

Translation requests send your text to `translate.googleapis.com` (that's the design).
Everything else — segmentation, radicals, related words — is local.

Sanity check with the folder's namesake: `营养丰富打折` analyzes into
营养 (yíngyǎng, nutrition) + 丰富 (fēngfù, plentiful) + 打折 (dǎzhé, discount) —
a fair bit more useful than "nutritious and blessed".

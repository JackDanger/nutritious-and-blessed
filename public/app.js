'use strict';

const $ = (id) => document.getElementById(id);
const form = $('analyze-form');
const input = $('input');
const undoBtn = $('btn-undo');
const statusEl = $('status');
const recentEl = $('recent');
const wholeEl = $('whole');
const segEl = $('segments');
const introEl = $('intro');
const errorEl = $('error');
const panelEl = $('panel');

let currentQuery = '';
const undoStack = [];      // previous queries before a character swap
const panelStack = [];     // panel views for back-navigation
const RECENT_KEY = 'mb_recent';

// ---------------------------------------------------------------- helpers
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function show(msg) {
  errorEl.textContent = msg || '';
  errorEl.classList.toggle('hidden', !msg);
}

const INPUT_DEBOUNCE_MS = 400;
let analyzeTimer = null;
let analyzeToken = 0;       // invalidates in-flight responses once typing resumes

function clearOutput() {
  introEl.classList.remove('hidden');
  wholeEl.classList.add('hidden');
  segEl.classList.add('hidden');
  closePanel();
}

async function api(path) {
  const res = await fetch(path);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// ---------------------------------------------------------------- pinyin
const TONE_MARKS = {
  'ā': 1, 'á': 2, 'ǎ': 3, 'à': 4,
  'ē': 1, 'é': 2, 'ě': 3, 'è': 4,
  'ī': 1, 'í': 2, 'ǐ': 3, 'ì': 4,
  'ō': 1, 'ó': 2, 'ǒ': 3, 'ò': 4,
  'ū': 1, 'ú': 2, 'ǔ': 3, 'ù': 4,
  'ǖ': 1, 'ǘ': 2, 'ǚ': 3, 'ǜ': 4,
};

function toneOf(syllable) {
  for (const ch of syllable) if (TONE_MARKS[ch]) return TONE_MARKS[ch];
  const m = syllable.match(/[0-4]/);
  return m ? Number(m[0]) : 0;
}

function pinyinSpans(p) {
  return p.split(/[\s·]+/).filter(Boolean).map((s) => {
    const t = toneOf(s);
    const span = el('span', `py t${t}`);
    span.appendChild(document.createTextNode(s));
    // tone numerals carry meaning without relying on color
    const SUP = { 1: '¹', 2: '²', 3: '³', 4: '⁴' };
    if (SUP[t]) span.appendChild(el('sup', 'tnum', SUP[t]));
    return span;
  });
}

// ---------------------------------------------------------------- analysis flow
// Live: the textarea auto-analyzes (debounced). Old responses are dropped when
// the text changed meanwhile (analyzeToken), so results always match the box.
function requestAnalyze(immediate = false) {
  const q = input.value.trim();
  currentQuery = q;
  if (!q) {
    analyzeToken += 1;
    clearTimeout(analyzeTimer);
    clearOutput();
    show('');
    statusEl.textContent = '';
    undoBtn.disabled = true;
    return;
  }
  clearTimeout(analyzeTimer);
  if (immediate) runAnalyze();
  else analyzeTimer = setTimeout(runAnalyze, INPUT_DEBOUNCE_MS);
}

async function runAnalyze() {
  const token = ++analyzeToken;
  const q = input.value.trim();
  if (!q) return;
  currentQuery = q;
  show('');
  statusEl.textContent = '…';
  try {
    const r = await api(`/api/analyze?q=${encodeURIComponent(q)}`);
    if (token !== analyzeToken) return;
    renderAnalysis(r);
    closePanel();
  } catch (e) {
    if (token !== analyzeToken) return;
    show(e.message);
  } finally {
    if (token === analyzeToken) statusEl.textContent = '';
    undoBtn.disabled = undoStack.length === 0;
  }
}

function replaceOccurrence(str, ch, occ, repl) {
  let seen = 0;
  let out = '';
  for (const c of str) {
    if (c === ch) out += seen++ === occ ? repl : c;
    else out += c;
  }
  return out;
}

function swapAndAnalyze(subjectChar, subjectOcc, replacement) {
  undoStack.push(currentQuery);
  input.value = replaceOccurrence(currentQuery, subjectChar, subjectOcc, replacement);
  requestAnalyze(true);
}

function undoSwap() {
  const prev = undoStack.pop();
  if (!prev) return;
  input.value = prev;
  requestAnalyze(true);
}

// ---------------------------------------------------------------- render analysis
function renderAnalysis(r) {
  introEl.classList.add('hidden');
  wholeEl.classList.remove('hidden');
  segEl.classList.remove('hidden');
  wholeEl.innerHTML = '';
  segEl.innerHTML = '';

  // ---- whole sentence
  wholeEl.appendChild(el('div', 'card-title', 'whole'));
  const line = el('div', r.translation ? 'whole-line' : 'whole-line muted');
  line.textContent = r.translation
    || (r.googleError ? 'couldn’t reach Google Translate — the pieces below still work' : '(no translation)');
  wholeEl.appendChild(line);
  if (r.googleSenses?.length) {
    const chips = el('div', 'chips');
    for (const s of r.googleSenses) {
      const chip = el('span', 'chip');
      if (s.pos) chip.appendChild(el('b', 'chip-pos', s.pos));
      chip.appendChild(document.createTextNode(' ' + (s.terms ?? []).join(', ')));
      chips.appendChild(chip);
    }
    wholeEl.appendChild(chips);
  }
  if (r.fullPinyin) {
    const fp = el('div', 'full-py');
    fp.append(...pinyinSpans(r.fullPinyin));
    wholeEl.appendChild(fp);
  }

  // ---- pieces: expandable tree — words → characters → radical + components
  segEl.appendChild(el('div', 'card-title', 'pieces'));
  segEl.appendChild(buildTree(r));
}

// cached character detail fetches (panel + tree share them)
const charCache = new Map();

async function charDetail(ch) {
  let d = charCache.get(ch);
  if (!d) {
    d = await api(`/api/char?c=${encodeURIComponent(ch)}`);
    charCache.set(ch, d);
  }
  return d;
}

function partsRow(detail) {
  const row = el('div', 't-parts');
  if (detail.radical && detail.radical.g) {
    const rad = el('button', 'part-chip rad');
    rad.appendChild(el('span', 'badge', 'radical'));
    rad.appendChild(el('span', 'part-glyph', detail.radical.g));
    rad.appendChild(el('span', 'part-name', `${detail.radical.p ?? ''} ${detail.radical.n ?? ''}`.trim()));
    rad.disabled = true;
    row.appendChild(rad);
  } else {
    row.appendChild(el('span', 'badge only', 'no radical on file'));
  }
  for (const c of detail.components ?? []) {
    if (c.rad) continue; // radical shown above
    const chip = el('button', 'part-chip');
    chip.appendChild(el('span', 'badge', 'part'));
    chip.appendChild(el('span', 'part-glyph', c.g));
    if (c.pinyin || c.name) {
      chip.appendChild(el('span', 'part-name', `${c.pinyin ?? ''} ${c.name ?? ''}`.trim()));
    }
    chip.title = c.g === detail.char ? 'the character itself' : 'click for this component’s full panel';
    chip.addEventListener('click', () => openChar(c.g, 0));
    row.appendChild(chip);
  }
  return row;
}

function buildTree(r) {
  const tree = el('div', 'tree');
  const occCount = new Map(); // occurrence index per char across the whole query

  for (const seg of r.segments) {
    if (seg.kind === 'pass') {
      tree.appendChild(el('div', 't-row pass-row', seg.text));
      continue;
    }
    // word node
    const node = el('div', 'tn');
    const row = el('div', 't-row');
    const caret = el('button', 'caret', '▸');
    caret.title = 'show the characters inside this word';
    row.appendChild(caret);
    const occs = [];
    const hz = el('span', 't-hz');
    for (const ch of seg.text) {
      if (/[A-Za-z0-9]/.test(ch)) {
        hz.appendChild(el('span', 'ch plain', ch));
        continue;
      }
      const occ = occCount.get(ch) ?? 0;
      occCount.set(ch, occ + 1);
      occs.push({ ch, occ });
      const btn = el('button', 'ch', ch);
      btn.title = 'open character panel';
      btn.addEventListener('click', () => openChar(ch, occ));
      hz.appendChild(btn);
    }
    row.appendChild(hz);
    if (seg.pinyin) row.append(...pinyinSpans(seg.pinyin));
    if (seg.unknown) row.appendChild(el('span', 'badge', 'not in dictionary'));
    else if (seg.senses.length) row.appendChild(el('span', 't-gls', seg.senses.slice(0, 3).join(' · ')));
    node.appendChild(row);

    const kids = el('div', 't-kids hidden');
    node.appendChild(kids);
    let expanded = false;
    caret.addEventListener('click', async () => {
      expanded = !expanded;
      caret.textContent = expanded ? '▾' : '▸';
      if (!expanded) { kids.innerHTML = ''; kids.classList.add('hidden'); return; }
      kids.innerHTML = '';
      kids.classList.remove('hidden');
      kids.appendChild(el('div', 't-loading', 'loading parts…'));
      const details = await Promise.all(occs.map(({ ch }) => charDetail(ch).catch(() => null)));
      kids.innerHTML = '';
      occs.forEach(({ ch, occ }, i) => {
        const d = details[i];
        const cn = el('div', 'tn char');
        const crow = el('div', 't-row');
        crow.appendChild(el('button', 'caret stub'));
        const glyph = el('button', 'ch t-char', ch);
        glyph.title = 'open character panel (related words, homophones)';
        glyph.addEventListener('click', () => openChar(ch, occ));
        crow.appendChild(glyph);
        if (d?.pinyin) crow.append(...pinyinSpans(d.pinyin));
        if (d?.definition) crow.appendChild(el('span', 't-gls', d.definition.split(';')[0]));
        if (!d) crow.appendChild(el('span', 'badge', 'no data'));
        cn.appendChild(crow);
        if (d) cn.appendChild(partsRow(d));
        kids.appendChild(cn);
      });
    });
    node.appendChild(kids);
    tree.appendChild(node);
  }
  return tree;
}

// ---------------------------------------------------------------- recent queries
function loadRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}

function pushRecent(q) {
  const list = loadRecent().filter((x) => x !== q);
  list.unshift(q);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 12)));
  renderRecent();
}

function renderRecent() {
  const list = loadRecent();
  recentEl.innerHTML = '';
  if (!list.length) return;
  recentEl.appendChild(el('span', 'chips-label', 'recent:'));
  for (const q of list) {
    const chip = el('button', 'chip small', q);
    chip.addEventListener('click', () => {
      input.value = q;
      requestAnalyze(true);
    });
    recentEl.appendChild(chip);
  }
}

// ---------------------------------------------------------------- character panel
function openChar(ch, occ) {
  panelStack.length = 0;
  panelStack.push({ ch, occ });
  panelEl.classList.remove('hidden');
  panelEl.innerHTML = '';
  panelEl.appendChild(el('div', 'panel-loading', '…'));
  api(`/api/char?c=${encodeURIComponent(ch)}`)
    .then((detail) => {
      detail.occ = occ;
      panelStack[0] = detail;
      renderPanel(detail);
    })
    .catch((e) => {
      panelEl.innerHTML = '';
      panelEl.appendChild(el('div', 'panel-loading', e.message));
    });
}

function closePanel() {
  panelStack.length = 0;
  panelEl.classList.add('hidden');
  panelEl.innerHTML = '';
}

function panelBack() {
  panelStack.pop();
  const top = panelStack[panelStack.length - 1];
  if (top) renderPanel(top);
  else closePanel();
}

function renderPanel(c, occ) {
  panelEl.innerHTML = '';

  // header with back/copy actions
  const head = el('div', 'panel-head');
  if (panelStack.length > 1) {
    const back = el('button', 'btn-mini', '← back');
    back.addEventListener('click', panelBack);
    head.appendChild(back);
  }
  const subject = panelStack[0];
  const subjectOcc = c.occ ?? 0;
  head.appendChild(el('span', 'card-title', 'character'));
  panelEl.appendChild(head);

  panelEl.appendChild(el('div', 'panel-char', c.char));
  if (c.pinyin) {
    const py = el('div', 'panel-py');
    py.append(...pinyinSpans(c.pinyin));
    panelEl.appendChild(py);
  }
  if (c.definition) panelEl.appendChild(el('div', 'panel-def', c.definition));
  if (c.etymology) panelEl.appendChild(el('div', 'panel-ety', c.etymology));

  // radical
  if (c.radical && (c.radical.n || c.radical.p)) {
    const card = el('div', 'subcard');
    card.appendChild(el('div', 'subcard-title', 'radical'));
    const line = el('div', 'rad-line');
    line.appendChild(el('span', 'rad-glyph', c.radical.g));
    line.appendChild(el('span', 'rad-name', `${c.radical.p ?? ''} ${c.radical.n ?? ''}`.trim()));
    card.appendChild(line);
    panelEl.appendChild(card);
  }

  // components
  if (c.components?.length) {
    const card = el('div', 'subcard');
    card.appendChild(el('div', 'subcard-title', 'components'));
    for (const comp of c.components) {
      const row = el('button', 'comp-row');
      if (comp.g === c.char) { row.classList.add('self'); }
      row.appendChild(el('span', 'comp-glyph', comp.g));
      if (comp.pinyin || comp.name) {
        const meta = el('span', 'comp-meta');
        if (comp.pinyin) meta.append(...pinyinSpans(comp.pinyin));
        if (comp.name) meta.appendChild(el('span', 'comp-name', comp.name));
        row.appendChild(meta);
      }
      row.addEventListener('click', () => {
        panelStack.push(null);
        panelEl.innerHTML = '';
        panelEl.appendChild(el('div', 'panel-loading', '…'));
        api(`/api/char?c=${encodeURIComponent(comp.g)}`)
          .then((detail) => { panelStack[panelStack.length - 1] = detail; renderPanel(detail); })
          .catch((e) => { panelBack(); show(e.message); });
      });
      card.appendChild(row);
    }
    panelEl.appendChild(card);
  }

  // related words
  if (c.related?.length) {
    const card = el('div', 'subcard');
    card.appendChild(el('div', 'subcard-title', `in words (${c.related.length})`));
    for (const w of c.related.slice(0, 30)) {
      const row = el('button', 'rel-row');
      const word = el('span', 'rel-word', w.w);
      row.appendChild(word);
      if (w.p) row.append(...pinyinSpans(w.p).map((s) => { s.classList.add('rel-py'); return s; }));
      if (w.s?.length) row.appendChild(el('span', 'rel-gls', w.s[0]));
      row.addEventListener('click', () => {
        undoStack.length = 0;
        input.value = w.w;
        requestAnalyze(true);
      });
      card.appendChild(row);
    }
    panelEl.appendChild(card);
  }

  // homophones for swapping
  if (c.homophones?.length && subject) {
    const card = el('div', 'subcard');
    card.appendChild(el('div', 'subcard-title', `swap ${c.char} for… (same sound)`));
    const chips = el('div', 'chips');
    for (const h of c.homophones) {
      const chip = el('button', 'chip swap', h.c);
      if (h.p) chip.title = h.p + (h.s?.length ? ` — ${h.s.slice(0, 2).join('; ')}` : '');
      chip.addEventListener('click', () => {
        swapAndAnalyze(c.char, subjectOcc, h.c);
      });
      chips.appendChild(chip);
    }
    card.appendChild(chips);
    panelEl.appendChild(card);
  }
}

// ---------------------------------------------------------------- wire up
form.addEventListener('submit', (e) => {
  e.preventDefault();
  undoStack.length = 0;
  const q = input.value.trim();
  if (q) pushRecent(q);   // recents record committed queries, not typing
  requestAnalyze(true);
});
input.addEventListener('input', () => {
  undoStack.length = 0;   // swap history is stale once the text changes
  requestAnalyze(false);
});
input.addEventListener('keydown', (e) => {
  // textarea: plain Enter is a newline; ⌘/Ctrl-Enter forces an immediate analysis
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    undoStack.length = 0;
    requestAnalyze(true);
  }
});
undoBtn.addEventListener('click', undoSwap);
renderRecent();

// deep link: …/?q=… — used by the zhongwen launcher after it makes sure the
// server is up
{
  const initialQ = new URLSearchParams(location.search).get('q');
  if (initialQ) {
    input.value = initialQ;
    requestAnalyze(true);
  }
}

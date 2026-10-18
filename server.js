// Mandarin Breakdown — local server.
// Serves the frontend, the two JSON APIs, and proxies Google's free translate endpoint.
// Zero dependencies: node:http + fs + fetch (Node 18+).
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const PUB = path.join(ROOT, 'public');
const BASE_PORT = Number(process.env.PORT ?? 8123);

// ---------------------------------------------------------------- pinyin helpers
const isCJK = (ch) => /[\u2E80-\u2EFF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/.test(ch);

function toneless(p) {
  return (p || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[0-9: ]/g, '')
    .trim();
}


// ---------------------------------------------------------------- data
let CEDICT;      // word -> { t, p, e:[senses], f:freq }
let CHARINFO;    // char -> { p, d, r, c, e }
let CHARWORDS;   // char -> [[word, freq], ...] freq-ranked
const TLESS = new Map(); // toneless pinyin -> [{c,f}] (homophones), built at boot

function mustExist(file) {
  if (!fs.existsSync(path.join(DATA, file))) {
    console.error(`missing ${file} — run: npm run setup`);
    process.exit(1);
  }
}

function radixRows() {
  return JSON.parse(fs.readFileSync(path.join(PUB, 'radicals.json'), 'utf8')).radicals;
}

function buildRadMap() {
  const map = new Map();
  for (const row of radixRows()) {
    map.set(row.g, row);
    for (const v of row.v ?? []) map.set(v, row);
  }
  return map;
}

function buildHomophones() {
  const groups = new Map();
  for (const [w, e] of Object.entries(CEDICT)) {
    if (w.length !== 1 || !isCJK(w) || !e?.p) continue;
    if (e.a) continue;       // traditional spelling alias — skip
    if (!e.f) continue;      // zero-frequency variant — skip
    const key = toneless(e.p);
    if (!key) continue;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = new Map()));
    const f = e.f || 0;
    if ((list.get(w) ?? -1) < f) list.set(w, f);
  }
  const out = new Map();
  for (const [key, list] of groups) {
    out.set(key, [...list.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([c, f]) => ({ c, f })));
  }
  return out;
}

mustExist('cedict.json');
mustExist('char-info.json');
mustExist('char-words.json');
CEDICT = JSON.parse(fs.readFileSync(path.join(DATA, 'cedict.json'), 'utf8'));
CHARINFO = JSON.parse(fs.readFileSync(path.join(DATA, 'char-info.json'), 'utf8'));
CHARWORDS = JSON.parse(fs.readFileSync(path.join(DATA, 'char-words.json'), 'utf8'));
const RADMAP = buildRadMap();
const HOMOPHONES = buildHomophones();

// ---------------------------------------------------------------- segmentation
const MAX_WORD_LEN = 10;
const UNKNOWN_COST = 2.5; // per unknown single char; any known short word beats it
const FREQ_WEIGHT = 0.01; // tiny tiebreaker among equal-segment-count paths

function segmentRun(text) {
  const n = text.length;
  const cost = new Float64Array(n + 1).fill(NaN); // dp accumulated cost
  const prev = new Int32Array(n + 1).fill(-1);
  cost[0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let len = 1; len <= Math.min(i, MAX_WORD_LEN); len++) {
      const e = CEDICT[text.slice(i - len, i)];
      if (!e) continue;
      const c = 1 - FREQ_WEIGHT * Math.log10((e.f || 0) + 10);
      const tot = cost[i - len] + c;
      if (Number.isNaN(cost[i]) || tot < cost[i]) {
        cost[i] = tot;
        prev[i] = i - len;
      }
    }
    // single unknown/known char fallback (always costlier than a dictionary word)
    const un = cost[i - 1] + UNKNOWN_COST;
    if (Number.isNaN(cost[i]) || un < cost[i]) {
      cost[i] = un;
      prev[i] = i - 1;
    }
  }
  const parts = [];
  for (let i = n; i > 0;) {
    parts.unshift(text.slice(prev[i], i));
    i = prev[i];
  }
  return parts;
}

function splitRuns(text) {
  const runs = [];
  let cur = '';
  let curCjk = null;
  for (const ch of text) {
    const cjk = isCJK(ch);
    if (curCjk === null || cjk === curCjk) { cur += ch; curCjk = cjk; }
    else { runs.push({ text: cur, cjk: curCjk }); cur = ch; curCjk = cjk; }
  }
  if (cur) runs.push({ text: cur, cjk: curCjk });
  return runs;
}

// ---------------------------------------------------------------- google translate
const GT_URL = process.env.GT_URL || 'https://translate.googleapis.com/translate_a/single';
const tCache = new Map();
const T_CACHE_MAX = 400;

async function googleTranslate(q) {
  const hit = tCache.get(q);
  if (hit) return hit;
  const url = `${GT_URL}?client=gtx&sl=zh-CN&tl=en&dt=t&dt=bd&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`translate: HTTP ${res.status}`);
  const j = await res.json();
  const tr = (j?.[0] ?? []).filter((x) => typeof x?.[0] === 'string').map((x) => x[0]).join('');
  const dict = Array.isArray(j?.[1])
    ? j[1].filter((b) => Array.isArray(b)).map((b) => ({ pos: b[0] ?? '', terms: (b[1] ?? []).slice(0, 8) }))
    : null;
  if (tCache.size > T_CACHE_MAX) tCache.delete(tCache.keys().next().value);
  tCache.set(q, { tr, dict });
  return { tr, dict };
}

// ---------------------------------------------------------------- analysis
async function analyze(q) {
  if (!q || q.length > 200) return { error: 'empty or too long (max 200 chars)' };
  let translation = null, googleSenses = null, googleError = false;
  try { ({ tr: translation, dict: googleSenses } = await googleTranslate(q)); }
  catch { googleError = true; }

  const segments = [];
  for (const run of splitRuns(q)) {
    if (!run.cjk) {
      segments.push({ text: run.text, kind: 'pass' });
      continue;
    }
    for (const part of segmentRun(run.text)) {
      const entry = CEDICT[part];
      let pinyin = entry?.p ?? null;
      let senses = entry?.e ?? [];
      if (!senses.length) {
        const info = CHARINFO[part];
        if (info?.d) senses = [info.d];
      }
      segments.push({
        text: part,
        pinyin,
        senses,
        unknown: !entry && part.length === 1 && !senses.length,
      });
    }
  }
  const fullPinyin = segments.filter((s) => s.pinyin).map((s) => s.pinyin).join('·');
  return { input: q, translation, googleSenses, googleError, segments, fullPinyin };
}

// ---------------------------------------------------------------- char panel
function charDetail(c) {
  if (!c || c.length !== 1 || !isCJK(c)) return { error: 'need exactly one CJK character' };
  const info = CHARINFO[c] ?? {};
  const entry = CEDICT[c] ?? null;

  const pinyin = info.p || (entry?.p ?? null);
  const definition = info?.d || (entry?.e ?? []).join('; ') || null;
  const radicalRow = RADMAP.get(info.r ?? '') ?? null;

  const comps = [];
  for (const ch of info.c ?? '') {
    if (isCJK(ch) && ch !== c && !comps.includes(ch)) comps.push(ch);
  }
  const components = comps.slice(0, 12).map((g) => {
    const row = RADMAP.get(g);
    const ge = CEDICT[g] ?? null;
    return {
      g,
      pinyin: row?.p ?? ge?.p ?? CHARINFO[g]?.p ?? null,
      name: row?.n ?? ge?.e?.[0] ?? CHARINFO[g]?.d ?? null,
      rad: !!(row && radicalRow && row === radicalRow),
    };
  });

  const related = (CHARWORDS[c] ?? [])
    .slice(0, 60)
    .map(([w]) => {
      const e = CEDICT[w];
      return { w, p: e?.p ?? null, s: e?.e ?? [] };
    });

  const homophones = (function () {
    if (!pinyin) return [];
    const bucket = HOMOPHONES.get(toneless(pinyin)) ?? [];
    return bucket
      .filter((x) => x.c !== c)
      .slice(0, 24)
      .map((x) => {
        const e2 = CEDICT[x.c] ?? null;
        return { c: x.c, p: e2?.p ?? CHARINFO[x.c]?.p ?? null, s: e2?.e ?? [] };
      });
  })();

  return { char: c, pinyin, definition, etymology: info.e ?? null, radical: radicalRow, components, related, homophones };
}

// ---------------------------------------------------------------- http
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const STATIC_FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/style.css': 'style.css',
  '/radicals.json': 'radicals.json',
};

async function handler(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const send = (code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  try {
    if (u.pathname === '/api/analyze') {
      const q = u.searchParams.get('q') ?? '';
      return send(200, JSON.stringify(await analyze(q)));
    }
    if (u.pathname === '/api/char') {
      const c = u.searchParams.get('c') ?? '';
      return send(200, JSON.stringify(charDetail(c)));
    }
    const file = STATIC_FILES[u.pathname];
    if (file && req.method === 'GET') {
      const buf = await fs.promises.readFile(path.join(PUB, file));
      return send(200, buf, MIME[path.extname(file)] ?? 'application/octet-stream');
    }
    return send(404, JSON.stringify({ error: 'not found' }));
  } catch (err) {
    return send(500, JSON.stringify({ error: err.message }));
  }
}

let server;
function start(port) {
  server = http.createServer(handler);
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < BASE_PORT + 20) {
      server.close();
      start(port + 1);
      return;
    }
    console.error(err);
    process.exit(1);
  });
  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  Mandarin Breakdown → ${url}\n  data: ${DATA}\n  (Ctrl-C to stop)\n`);
    if (process.platform === 'darwin' && !process.env.NO_OPEN) exec(`open ${url}`);
  });
}

start(BASE_PORT);

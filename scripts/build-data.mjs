// Downloads the three open datasets and compiles them into data/*.json.
// CC-CEDICT is required; the other two are optional (app degrades gracefully).
// Run: npm run setup      (npm run setup:force to rebuild)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });

const FORCE = process.argv.includes('--force');
const done = (f) => fs.existsSync(path.join(DATA, f));

const SOURCES = {
  cedict: 'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz',
  hanzi: 'https://cdn.jsdelivr.net/gh/skishore/makemeahanzi@master/dictionary.txt',
  freq: 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/zh_cn/zh_cn_50k.txt',
};

async function download(name, url) {
  const t0 = Date.now();
  process.stdout.write(`downloading ${name} ... `);
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`${(buf.length / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return buf;
}

// ---------------- frequency ----------------
function parseFreq(text) {
  const freq = {};
  for (const line of text.split('\n')) {
    const parts = line.trim().split(' ');
    if (parts.length !== 2) continue;
    const n = parseInt(parts[1], 10);
    if (!Number.isFinite(n)) continue;
    freq[parts[0]] = n;
  }
  return freq;
}

// ---------------- CC-CEDICT ----------------
function parseCedictRows(text) {
  const rows = [];
  const re = /^(\S+)\s+(\S+)\s+\[([^\]]+)\]\s+\/(.*)\/\s*$/u;
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = line.match(re);
    if (!m) continue;
    rows.push({ trad: m[1], simp: m[2], pinyin: m[3], senses: m[4].split('/').filter(Boolean) });
  }
  return rows;
}

// CC-CEDICT pinyin is numbered ("ying2"); convert to tone marks for display.
const MARKS = {
  a: 'āáǎà',
  e: 'ēéěè',
  i: 'īíǐì',
  o: 'ōóǒò',
  u: 'ūúǔù',
  v: 'ǖǘǚǜ',
  ü: 'ǖǘǚǜ',
};

function markSyllable(syll) {
  const m = syll.match(/[0-5]$/);
  if (!m) return syll; // already tone-marked
  const tone = Number(m[0]);
  const base = syll.slice(0, -1).replace(/u:/g, 'ü');
  if (tone === 5) return base;
  let pos = -1;
  if (base.includes('a')) pos = base.indexOf('a');
  else if (base.includes('o')) pos = base.indexOf('o');
  else if (base.includes('e')) pos = base.indexOf('e');
  else {
    const iu = base.indexOf('iu');
    const ui = base.indexOf('ui');
    if (iu !== -1) pos = iu; // "liu4" → mark the i
    else if (ui !== -1) pos = ui + 1; // "gui4" → mark the i
    else {
      for (let i = base.length - 1; i >= 0; i--) {
        if ('iuü'.includes(base[i])) { pos = i; break; }
      }
    }
  }
  if (pos < 0) return syll;
  return base.slice(0, pos) + MARKS[base[pos]][tone - 1] + base.slice(pos + 1);
}

function markedPinyin(p) {
  return p.split(' ').map(markSyllable).join(' ');
}

function buildFromCedict(freq) {
  const rows = parseCedictRows(
    zlib.gunzipSync(fs.readFileSync(path.join(DATA, 'cedict.txt.gz'))).toString('utf8'),
  );

  const entries = {};
  for (const row of rows) {
    const f = freq[row.simp] || 0;
    if (!entries[row.simp]) {
      entries[row.simp] = { t: row.trad, p: markedPinyin(row.pinyin), e: row.senses, f };
    } else {
      // polyphonic homographs: merge senses, keep first reading
      const cur = entries[row.simp];
      for (const s of row.senses) if (!cur.e.includes(s)) cur.e.push(s);
    }
    if (row.trad !== row.simp && !entries[row.trad]) {
      // traditional spelling alias — flagged so runtime treats it as non-primary
      entries[row.trad] = { t: row.trad, p: entries[row.simp].p, e: entries[row.simp].e, f: entries[row.simp].f, a: 1 };
    }
  }
  fs.writeFileSync(path.join(DATA, 'cedict.json'), JSON.stringify(entries));

  // char -> words containing it
  const isCJK = (ch) => /[\u3400-\u4DBF\u4E00-\u9FFF]/.test(ch);
  const byChar = new Map();
  for (const row of rows) {
    for (const ch of row.simp) {
      if (!isCJK(ch)) continue;
      let list = byChar.get(ch);
      if (!list) byChar.set(ch, (list = new Map()));
      list.set(row.simp, freq[row.simp] || 0);
    }
  }
  const charWords = {};
  for (const [ch, words] of byChar) {
    charWords[ch] = [...words.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
      .slice(0, 200)
      .map(([w, f]) => [w, f]);
  }
  fs.writeFileSync(path.join(DATA, 'char-words.json'), JSON.stringify(charWords));
  console.log(`cedict: ${rows.length} entries, ${Object.keys(charWords).length} chars indexed`);
}

// ---------------- character info ----------------
function buildCharInfo() {
  const text = fs.readFileSync(path.join(DATA, 'hanzi-dict.txt'), 'utf8');
  const info = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row.character) continue;
    const evo = row.etymology ? `${row.etymology.type || ''}${row.etymology.hint ? `: ${row.etymology.hint}` : ''}` : '';
    info[row.character] = {
      p: Array.isArray(row.pinyin) ? row.pinyin[0] || '' : '',
      d: row.definition || '',
      r: row.radical || '',
      c: row.decomposition || '',
      e: evo || undefined,
    };
  }
  fs.writeFileSync(path.join(DATA, 'char-info.json'), JSON.stringify(info));
  console.log(`hanzi: ${Object.keys(info).length} chars written`);
}

async function main() {
  const t0 = Date.now();

  // frequency list — needed before cedict baking
  if (done('freq.json') && !FORCE) {
    console.log('freq.json already built');
  } else {
    const text = (await download('word frequency', SOURCES.freq)).toString('utf8');
    fs.writeFileSync(path.join(DATA, 'freq.json'), JSON.stringify(parseFreq(text)));
    console.log('freq.json written');
  }
  const freq = JSON.parse(fs.readFileSync(path.join(DATA, 'freq.json'), 'utf8'));

  // cedict (+ char-words)
  if (done('cedict.json') && done('char-words.json') && !FORCE) {
    console.log('cedict data already built');
  } else {
    const gz = await download('CC-CEDICT', SOURCES.cedict);
    fs.writeFileSync(path.join(DATA, 'cedict.txt.gz'), gz);
    buildFromCedict(freq);
  }

  // character info
  if (done('char-info.json') && !FORCE) {
    console.log('char info already built');
  } else {
    const buf = await download('makemeahanzi dictionary', SOURCES.hanzi);
    fs.writeFileSync(path.join(DATA, 'hanzi-dict.txt'), buf);
    buildCharInfo();
  }

  console.log(`data build complete in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${DATA}`);
}

try {
  await main();
} catch (err) {
  console.error(`data build failed: ${err.message}`);
  if (!done('cedict.json') || !done('char-info.json')) {
    console.error('required dataset missing — re-run: npm run setup');
    process.exit(1);
  }
}

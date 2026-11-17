/* ═══════════════════════════════════════════
   dict.js — 离线词库 + 在线词典 + 翻译
   ═══════════════════════════════════════════ */

const OFFLINE_URL = 'data/dict.tsv';

/* ───────── 离线词库（ECDICT 高频子集） ───────── */
let offlineMap = null;
let offlinePromise = null;

export function offlineLoaded() { return !!offlineMap; }
export function offlineCount() { return offlineMap ? offlineMap.size : 0; }

export function loadOffline() {
  if (offlineMap) return Promise.resolve(offlineMap);
  if (offlinePromise) return offlinePromise;
  offlinePromise = (async () => {
    const res = await fetch(OFFLINE_URL, { cache: 'force-cache' });
    if (!res.ok) throw new Error('离线词典加载失败 ' + res.status);
    const text = await res.text();
    const map = new Map();
    let i = 0, n = text.length;
    while (i < n) {
      let nl = text.indexOf('\n', i);
      if (nl === -1) nl = n;
      const t1 = text.indexOf('\t', i);
      if (t1 !== -1 && t1 < nl) {
        const t2 = text.indexOf('\t', t1 + 1);
        const word = text.slice(i, t1);
        if (t2 !== -1 && t2 < nl) {
          map.set(word, [text.slice(t1 + 1, t2), text.slice(t2 + 1, nl)]);
        } else {
          map.set(word, ['', text.slice(t1 + 1, nl)]);
        }
      }
      i = nl + 1;
    }
    offlineMap = map;
    return map;
  })().catch(e => { offlinePromise = null; throw e; });
  return offlinePromise;
}

/* 只有「整条释义就是形态说明、本身没有意思」的条目才需要回原形补齐。
   要区分两种情况：
     spilled → 「spill的过去式和过去分词」            ← 没有实义，必须补
     companies → 「公司, 企业；伙伴（company的复数形式）」← 本身有意思，再补就啰嗦了 */
const POS_HEAD = /^(n|vt|vi|v|a|adj|adv|ad|prep|conj|pron|num|art|int|aux|abbr|pl)\.\s?/i;
const FORM_ONLY = new RegExp(
  "^[a-z'’\\-]+\\s*的\\s*(过去式|过去分词|现在分词|复数|比较级|最高级|第三人称单数|动名词)" +
  "(\\s*(和|或|、)\\s*(过去式|过去分词|现在分词|复数|比较级|最高级))?\\s*(形式)?\\s*$", "i");
const isFormOnly = cn => FORM_ONLY.test(String(cn || '').replace(POS_HEAD, "").trim());

/* 词形还原：处理常见的屈折变化 */
function lemmaCandidates(w) {
  const out = [];
  const add = x => { if (x && x.length > 1 && !out.includes(x)) out.push(x); };
  if (/ies$/.test(w) && w.length > 4) add(w.slice(0, -3) + 'y');
  if (/ves$/.test(w) && w.length > 4) add(w.slice(0, -3) + 'f'), add(w.slice(0, -3) + 'fe');
  if (/es$/.test(w) && w.length > 3) { add(w.slice(0, -2)); add(w.slice(0, -1)); }
  if (/s$/.test(w) && !/ss$/.test(w)) add(w.slice(0, -1));
  if (/ied$/.test(w) && w.length > 4) add(w.slice(0, -3) + 'y');
  if (/ed$/.test(w) && w.length > 3) {
    add(w.slice(0, -2)); add(w.slice(0, -1));
    if (w.length > 4 && w[w.length - 3] === w[w.length - 4]) add(w.slice(0, -3));
  }
  if (/ing$/.test(w) && w.length > 4) {
    add(w.slice(0, -3)); add(w.slice(0, -3) + 'e');
    if (w.length > 5 && w[w.length - 4] === w[w.length - 5]) add(w.slice(0, -4));
  }
  if (/ally$/.test(w)) add(w.slice(0, -4));
  if (/ly$/.test(w) && w.length > 4) { add(w.slice(0, -2)); add(w.slice(0, -2) + 'e'); }
  if (/est$/.test(w) && w.length > 5) { add(w.slice(0, -3)); add(w.slice(0, -2)); }
  if (/er$/.test(w) && w.length > 4) { add(w.slice(0, -2)); add(w.slice(0, -1)); }
  if (/or$/.test(w) && w.length > 4) add(w.slice(0, -2) + 'e');
  return out;
}

export function normalizeWord(raw) {
  return String(raw || '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/^[^A-Za-z]+/, '')
    .replace(/[^A-Za-z'-]+$/, '')
    .replace(/-+$/, '')
    .toLowerCase()
    .trim();
}

/** 查离线词库，返回 {word, ipa, cn, stemmed, base?} */
export function lookupOffline(raw) {
  const w = normalizeWord(raw);
  if (!w || !offlineMap) return null;
  const hit = (k) => offlineMap.get(k);
  let v = hit(w), form = w, stemmed = false;
  if (!v) {
    for (const c of lemmaCandidates(w)) {
      v = hit(c);
      if (v) { form = c; stemmed = true; break; }
    }
  }
  if (!v) return null;
  const rec = { word: w, lemma: form, ipa: v[0] || '', cn: v[1] || '', stemmed };
  /* 词库把屈折变化也单独立了条目，但释义只写「spill的过去式和过去分词」这类形态说明，
     音标往往还空着——这种条目本身等于没说，得回原形词条把意思取出来一起显示。 */
  if (!stemmed && isFormOnly(rec.cn)) {
    for (const c of lemmaCandidates(w)) {
      const b = hit(c);
      if (b && b[1]) { rec.base = { word: c, ipa: b[0] || '', cn: b[1] || '' }; break; }
    }
  }
  return rec;
}

/** 模糊前缀建议（拼写接近时给个提示） */
export function suggestOffline(raw, limit = 6) {
  const w = normalizeWord(raw);
  if (!w || !offlineMap || w.length < 4) return [];
  const out = [];
  const head = w.slice(0, Math.max(3, w.length - 2));
  for (const [k, v] of offlineMap) {
    if (k !== w && k.startsWith(head)) { out.push({ word: k, cn: v[1] }); if (out.length >= limit) break; }
  }
  return out;
}

/* ───────── 在线词典：多源自动降级 ─────────
   不同网络环境下各源可达性差别很大，所以按顺序试，谁通用谁；
   全部不通也不影响使用——离线词典已经覆盖音标和中文释义。      */

const onlineCache = new Map();

async function getJSON(url, ms = 5500) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/* 源 1：Free Dictionary API —— 数据最全（音标 / 发音音频 / 例句） */
function srcDictionaryApi(w) {
  return 'https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(w);
}
function shapeDictionaryApi(data) {
  if (!Array.isArray(data) || !data.length) return null;
  let ipa = '', audio = '';
  const meanings = [];
  for (const e of data) {
    if (!ipa && e.phonetic) ipa = e.phonetic;
    for (const p of (e.phonetics || [])) {
      if (!ipa && p.text) ipa = p.text;
      if (!audio && p.audio) audio = p.audio;
    }
    for (const m of (e.meanings || [])) {
      const defs = [];
      for (const d of (m.definitions || []).slice(0, 4)) {
        if (!d.definition) continue;
        defs.push({ def: d.definition, example: d.example || '' });
      }
      if (defs.length) meanings.push({ pos: m.partOfSpeech || '', defs });
    }
  }
  if (!meanings.length && !ipa) return null;
  return { word: data[0].word || '', ipa, audio, meanings, lemma: '' };
}

/* 源 2：Wiktionary REST —— 全球可达性最好，给英文释义和例句（无音标） */
function srcWiktionary(w) {
  return 'https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(w);
}
function shapeWiktionary(data) {
  if (!data || !data.en) return null;
  const meanings = [];
  for (const g of data.en) {
    const defs = [];
    for (const d of (g.definitions || [])) {
      const text = String(d.definition || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const ex = (d.parsedExamples || [])[0];
      defs.push({ def: text, example: ex ? String(ex.example || '').replace(/<[^>]+>/g, '').trim() : '' });
      if (defs.length >= 3) break;
    }
    if (defs.length) meanings.push({ pos: (g.partOfSpeech || '').toLowerCase(), defs });
    if (meanings.length >= 3) break;
  }
  if (!meanings.length) return null;
  return { word: '', ipa: '', audio: '', meanings, lemma: '' };
}

const PROVIDERS = [
  { id: 'dictionaryapi', url: srcDictionaryApi, shape: shapeDictionaryApi },
  { id: 'wiktionary', url: srcWiktionary, shape: shapeWiktionary },
];

const DEADLINE = 10000;   // 在线查询总时长上限，超了就先用离线结果

export function lookupOnline(raw) {
  const w = normalizeWord(raw);
  const base = w.replace(/[^a-z'-]/g, '');
  if (!base) return Promise.resolve(null);
  if (onlineCache.has(base)) return onlineCache.get(base);

  const job = (async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return null;
    const started = Date.now();
    const cands = [base, ...lemmaCandidates(base).slice(0, 1)];
    for (const p of PROVIDERS) {
      for (const c of cands) {
        if (Date.now() - started > DEADLINE) return null;
        const s = p.shape(await getJSON(p.url(c)));
        if (s) {
          if (c !== base) s.lemma = c;
          s.source = p.id;
          return s;
        }
      }
    }
    return null;
  })();

  onlineCache.set(base, job);
  job.then(r => { if (!r) onlineCache.delete(base); });   // 失败不留缓存，联网后可重试
  return job;
}

/* ───────── 整句 / 整段翻译（MyMemory） ───────── */
const trCache = new Map();

/** 免费翻译额度是否已用完（用完就不要再打请求了，省得刷一堆失败） */
let _quotaOut = false;
export const quotaExhausted = () => _quotaOut;

/* MyMemory 匿名额度很小（约 5 千词/天）。在 de= 里填一个真实邮箱可提到约 5 万词/天。
   这是官方文档写明的提额方式，不是我们编的。 */
let _email = '';
export function setTranslateEmail(e) { _email = String(e || '').trim(); }
const deParam = () => (_email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(_email) ? _email : 'reading@local.app');

export async function translate(text, timeout = 12000) {
  const src = String(text || '').replace(/\s+/g, ' ').trim();
  if (!src) return '';
  if (trCache.has(src)) return trCache.get(src);
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return '';
  const chunks = splitChunks(src, 460);
  const out = [];
  for (const c of chunks) out.push(await oneChunk(c, timeout));
  const res = out.join('').trim();
  if (res) trCache.set(src, res);
  return res;
}

async function oneChunk(chunk, timeout) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    const url = 'https://api.mymemory.translated.net/get?q=' +
      encodeURIComponent(chunk) + '&langpair=en|zh-CN&de=' + encodeURIComponent(deParam());
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return '';
    const d = await r.json();
    if (d && d.quotaFinished) { _quotaOut = true; return ''; }
    const st = d.responseStatus;
    if (st && Number(st) >= 400) return '';
    const txt = (d.responseData && d.responseData.translatedText) || '';
    if (/MYMEMORY WARNING|USED ALL AVAILABLE FREE TRANSLATIONS|PLEASE SELECT TWO DISTINCT LANGUAGES/i.test(txt)) {
      if (/MYMEMORY WARNING|USED ALL AVAILABLE/i.test(txt)) _quotaOut = true;
      return '';
    }
    return txt;
  } catch {
    return '';
  }
}

function splitChunks(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const parts = text.split(/(?<=[.!?;])\s+/);
  const out = [];
  let cur = '';
  for (const p of parts) {
    if (cur && (cur + ' ' + p).length > maxLen) { out.push(cur); cur = p; }
    else cur = cur ? cur + ' ' + p : p;
  }
  if (cur) out.push(cur);
  // 兜底：仍超长的硬切
  const flat = [];
  for (const s of out) {
    if (s.length <= maxLen) { flat.push(s); continue; }
    for (let i = 0; i < s.length; i += maxLen) flat.push(s.slice(i, i + maxLen));
  }
  return flat;
}

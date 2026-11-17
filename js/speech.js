/* ═══════════════════════════════════════════
   speech.js — 整段朗读（点段落就听）

   两条实现上的取舍，都是 iOS 逼出来的：
   1) **一句一个 utterance**，不整段丢给引擎。iOS Safari 对长文本有截断，
      整段朗读读一半会自己停；拆成句子串起来才稳，也顺便能做「读到哪高亮到哪」。
   2) **暂停 = 取消 + 记住位置**，而不是 speechSynthesis.pause()。
      iOS 上 pause() 之后 resume() 经常接不上，重读当前句反而一定出声。
   ═══════════════════════════════════════════ */

const $ = (s, r = document) => r.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const Spk = {
  on: false, paused: false, i: -1, units: [],
  rate: 1, voice: null, voices: [], mode: 'pdf',
};

let toastFn = () => { };
let onStateChange = null;

export function speechInit({ toast } = {}) {
  if (toast) toastFn = toast;
  Spk.rate = Number(localStorage.getItem('rd.rate') || 1);
  loadVoices();
  if (typeof speechSynthesis !== 'undefined') {
    speechSynthesis.onvoiceschanged = loadVoices;
  }
  bindBar();
  buildBar();
}

function loadVoices() {
  if (typeof speechSynthesis === 'undefined') return;
  const all = speechSynthesis.getVoices() || [];
  Spk.voices = all.filter(v => /^en/i.test(v.lang || ''));
  if (!Spk.voice) Spk.voice = pickVoice();
}

/* 优先挑一个离线、口音正的英文语音：Siri 的声音质量最好 */
function pickVoice() {
  const vs = Spk.voices;
  if (!vs.length) return null;
  const score = v => {
    let s = 0;
    if (/en-US/i.test(v.lang)) s += 4;
    if (/en-GB/i.test(v.lang)) s += 3;
    if (v.localService) s += 2;
    if (/siri/i.test(v.name)) s += 3;
    if (/compact|premium|enhanced/i.test(v.name)) s += 2;
    return s;
  };
  return [...vs].sort((a, b) => score(b) - score(a))[0] || null;
}

export function speechSetMode(mode) { Spk.mode = mode; }
export function speechOnState(fn) { onStateChange = fn; }

/* ═══════════ 朗读单元：一句 = 一个单元 ═══════════ */

/* 取元素里第一个「正文」文本节点。
   段落开头插的那个朗读小喇叭也是文本（🔊），必须绕开，
   否则朗读单元和高亮都会从喇叭开始算，位置全错。 */
function firstText(el) {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      return n.parentElement && n.parentElement.closest('.spk-p')
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    }
  });
  return w.nextNode();
}

/** 文本模式：每个 <p> 就是一段 */
function txtBlocks() {
  const body = $('.txt-body');
  if (!body) return [];
  const out = [];
  for (const p of body.children) {
    const t = firstText(p);
    if (!t || !t.data.trim()) continue;
    out.push({ host: p.closest('.txt-wrap') || body, items: [{ node: t, text: t.data }] });
  }
  return out;
}

/** PDF：把文字层的 span 先聚成行、再按行距聚成段。
    顺序要按「人眼读的顺序」——从上到下、从左到右。 */
function pdfBlocks() {
  const pages = [...document.querySelectorAll('.pdf-page')];
  const out = [];
  for (const pageEl of pages) {
    const layer = pageEl.querySelector('.textLayer');
    if (!layer) continue;
    const spans = [...layer.querySelectorAll('span')]
      .filter(s => s.textContent && s.textContent.trim() && firstText(s));
    if (!spans.length) continue;
    const hb = pageEl.getBoundingClientRect();

    const rows = [];
    for (const el of spans) {
      const r = el.getBoundingClientRect();
      if (!r.height) continue;
      const top = r.top - hb.top, left = r.left - hb.left, h = r.height;
      let row = rows.find(x => Math.abs(x.top - top) <= Math.max(2, h * 0.45));
      if (!row) { row = { top, h, items: [] }; rows.push(row); }
      row.h = Math.max(row.h, h);
      row.items.push({ el, left });
    }
    if (!rows.length) continue;
    rows.sort((a, b) => a.top - b.top);

    let cur = null, prev = null;
    const flush = () => {
      if (cur && cur.items.length) out.push({ host: pageEl, items: cur.items });
      cur = null;
    };
    for (const row of rows) {
      row.items.sort((a, b) => a.left - b.left);
      const gap = prev ? row.top - prev.top : 0;
      if (!cur || gap > prev.h * 1.45 || gap < -prev.h * 0.5) { flush(); cur = { items: [] }; }
      for (const it of row.items) {
        const t = firstText(it.el);
        if (t && t.data) cur.items.push({ node: t, text: t.data });
      }
      prev = row;
    }
    flush();
  }
  return out;
}

/** 扫描件：直接吃 OCR 的段落（有文字层的优先，不重复） */
function ocrBlocks(ocrPages) {
  const out = [];
  for (const [page, data] of [...ocrPages].sort((a, b) => a[0] - b[0])) {
    for (const p of (data.paras || [])) {
      const t = String(p.text || '').trim();
      if (t.length > 1) out.push({ host: null, page, plain: t });
    }
  }
  return out;
}

function splitSentences(text) {
  const out = [];
  const re = /[^.!?]+[.!?]+["')\]]?|[^.!?]+$/g;
  let m;
  while ((m = re.exec(text))) {
    let s = m[0].replace(/^\s+/, '');
    if (!s.trim()) continue;
    const from = m.index + (m[0].length - s.length);
    /* 单句过长再按逗号切，避免一次喂给引擎太多 */
    if (s.length > 260) {
      const subs = s.split(/(?<=[,;:])\s+/);
      let pos = from;
      for (const sub of subs) {
        out.push({ text: sub, s: pos, e: pos + sub.length });
        pos += sub.length + 1;
      }
    } else {
      out.push({ text: s, s: from, e: from + s.length });
    }
  }
  return out.length ? out : [{ text, s: 0, e: text.length }];
}

/** 把 block（一串连续的文本节点）切成句子单元，并记住每句覆盖到哪些节点 */
function blockToUnits(block) {
  const flat = [];
  let text = '';
  for (const it of block.items) {
    flat.push({ node: it.node, s: text.length, e: text.length + it.text.length });
    text += it.text;
  }
  const units = [];
  for (const sen of splitSentences(text)) {
    const ranges = [];
    for (const f of flat) {
      const a = Math.max(sen.s, f.s), b = Math.min(sen.e, f.e);
      if (b > a) ranges.push({ node: f.node, s: a - f.s, e: b - f.s });
    }
    if (!ranges.length) continue;
    units.push({ text: sen.text.trim(), ranges, host: block.host, page: block.page || 0 });
  }
  return units;
}

export function buildUnits(ocrPages) {
  let blocks = Spk.mode === 'pdf' ? pdfBlocks() : txtBlocks();
  if (Spk.mode === 'pdf' && (!blocks.length) && ocrPages && ocrPages.size) {
    /* 扫描件：没有文字层就用 OCR 的段落（整句高亮退化为整段，不加高亮） */
    const plain = [];
    // 注意字段名是 plain，不是 text —— 取错的话整段会变成字符串 "undefined"，引擎就会念这个词
    for (const b of ocrBlocks(ocrPages)) {
      for (const s of splitSentences(b.plain)) plain.push({ text: s.text.trim(), ranges: [], host: null, page: b.page });
    }
    return plain.filter(u => u.text);
  }
  const units = [];
  for (const b of blocks) {
    if (b.plain) {
      for (const s of splitSentences(b.plain)) units.push({ text: s.text.trim(), ranges: [], host: null, page: b.page });
      continue;
    }
    for (const u of blockToUnits(b)) units.push(u);
  }
  return units.filter(u => u.text && u.text.length > 1);
}

/* ═══════════ 高亮 ═══════════ */
function rectsOf(u) {
  const out = [];
  for (const r of u.ranges || []) {
    try {
      const rg = document.createRange();
      rg.setStart(r.node, clamp(r.s, 0, r.node.data.length));
      rg.setEnd(r.node, clamp(r.e, 0, r.node.data.length));
      for (const rc of rg.getClientRects()) if (rc.width > 0.5 && rc.height > 0.5) out.push(rc);
    } catch { }
  }
  return out;
}

function clearSpkHl() {
  document.querySelectorAll('.spk-hl').forEach(x => x.remove());
}

function paintUnit(u) {
  clearSpkHl();
  if (!u || !u.host || !u.host.isConnected) return;
  let hl = u.host.querySelector('.hl-layer');
  if (!hl) { hl = document.createElement('div'); hl.className = 'hl-layer'; u.host.appendChild(hl); }
  const hb = u.host.getBoundingClientRect();
  for (const rc of rectsOf(u)) {
    const d = document.createElement('div');
    d.className = 'spk-hl';
    d.style.cssText = `left:${rc.left - hb.left}px;top:${rc.top - hb.top}px;`
      + `width:${rc.width}px;height:${rc.height}px`;
    hl.appendChild(d);
  }
  scrollToUnit(u);
}

function scrollToUnit(u) {
  const rc = rectsOf(u)[0];
  const sc = $('#readerScroll');
  if (!rc || !sc) return;
  const cy = rc.top + rc.height / 2;
  const target = sc.scrollTop + cy - sc.clientHeight * 0.42;
  if (Math.abs(target - sc.scrollTop) > 24) sc.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
}

/* ═══════════ 播放控制 ═══════════ */
let curUtt = null;

function alive(u) {
  if (!u) return false;
  if (!u.ranges || !u.ranges.length) return true;              // OCR 段落，没有 DOM 也能读
  return !!u.host && u.host.isConnected && u.ranges.some(r => r.node && r.node.isConnected);
}

/* iOS 的语音引擎会整体假死：speak() 不报错、事件也不来，就是不出声。
   对策：speak 前先 resume() 踢一脚；650ms 后还没 onstart 就取消重试一次。 */
function speakWithRetry(utt) {
  try { speechSynthesis.resume(); } catch { }
  try { speechSynthesis.speak(utt); }
  catch { toastFn('朗读没能启动'); stop(); return; }
  setTimeout(() => {
    if (!utt.__fired && curUtt === utt && Spk.on && !Spk.paused) {
      try { speechSynthesis.cancel(); } catch { }
      try { speechSynthesis.speak(utt); } catch { }
    }
  }, 650);
}

function play(i) {
  if (typeof speechSynthesis === 'undefined') { toastFn('这个浏览器不支持朗读'); stop(); return; }
  const u = Spk.units[i];
  if (!u) { stop(); return; }
  Spk.i = i;
  paintUnit(u);
  const t = $('#spkText'); if (t) t.textContent = u.text;
  const utt = new SpeechSynthesisUtterance(u.text);
  utt.rate = clamp(Spk.rate, 0.5, 2);
  utt.lang = (Spk.voice && Spk.voice.lang) || 'en-US';
  if (Spk.voice) utt.voice = Spk.voice;
  utt.pitch = 1;
  utt.__fired = false;
  curUtt = utt;
  utt.onstart = () => { utt.__fired = true; };
  utt.onend = () => { if (Spk.on && !Spk.paused && curUtt === utt) next(); };
  utt.onerror = () => { if (Spk.on && curUtt === utt) next(); };
  speakWithRetry(utt);
  syncBar();
}

function next() {
  if (!Spk.on) return;
  let i = Spk.i + 1;
  while (i < Spk.units.length && !alive(Spk.units[i])) i++;
  if (i >= Spk.units.length) { toastFn('这一篇读完了'); stop(); return; }
  play(i);
}
function prev() {
  if (!Spk.on) return;
  let i = Spk.i - 1;
  while (i > 0 && !alive(Spk.units[i])) i--;
  play(Math.max(0, i));
}

/** 从当前可见位置开始读 */
export function speechStart(ocrPages, fromHost) {
  Spk.units = buildUnits(ocrPages);
  if (!Spk.units.length) { toastFn('没找到可以朗读的文字'); return false; }
  let start = 0;
  if (fromHost) {
    const j = Spk.units.findIndex(u => u.host === fromHost);
    if (j >= 0) start = j;
  } else {
    const sc = $('#readerScroll');
    const mid = sc ? sc.scrollTop + sc.clientHeight * 0.35 : 0;
    for (let i = 0; i < Spk.units.length; i++) {
      const u = Spk.units[i];
      if (u.host && u.host.isConnected && u.host.offsetTop >= mid - 40) { start = i; break; }
    }
  }
  Spk.on = true; Spk.paused = false;
  showBar(true);
  play(start);
  return true;
}

/** 从某个具体单元开始读（段落小喇叭用） */
export function speechStartAt(unitIndex) {
  Spk.on = true; Spk.paused = false;
  showBar(true);
  play(clamp(unitIndex, 0, Math.max(0, Spk.units.length - 1)));
}

export function speechStop() { stop(); }

function stop() {
  Spk.on = false; Spk.paused = false;
  curUtt = null;
  try { speechSynthesis.cancel(); } catch { }
  clearSpkHl();
  showBar(false);
  syncBar();
}

function togglePause() {
  if (!Spk.on) return;
  if (Spk.paused) {
    Spk.paused = false;
    play(Spk.i);                     // 重读当前句：iOS 上比 resume() 可靠
  } else {
    Spk.paused = true;
    try { speechSynthesis.cancel(); } catch { }
  }
  syncBar();
}

/* ═══════════ 控制条 ═══════════ */
function buildBar() {
  if ($('#spkBar')) return;
  const el = document.createElement('div');
  el.className = 'spk-bar';
  el.id = 'spkBar';
  el.innerHTML = `
    <div class="spk-line">
      <span class="spk-badge">朗读中</span>
      <span class="spk-text" id="spkText"></span>
    </div>
    <div class="spk-ctrls">
      <button class="spk-btn" data-a="prev" title="上一句">⏮</button>
      <button class="spk-btn play" data-a="play" title="暂停/继续">⏸</button>
      <button class="spk-btn" data-a="next" title="下一句">⏭</button>
      <button class="spk-btn wide" data-a="slower" title="慢一点">慢</button>
      <span class="spk-rate" id="spkRate">1.0×</span>
      <button class="spk-btn wide" data-a="faster" title="快一点">快</button>
      <button class="spk-btn wide" data-a="voice" title="换一个发音">发音</button>
      <button class="spk-btn stop" data-a="stop" title="停止">✕</button>
    </div>`;
  document.body.appendChild(el);
}

function bindBar() {
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('.spk-btn');
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'stop') stop();
    else if (a === 'play') togglePause();
    else if (a === 'next') { if (Spk.on) { Spk.paused = false; next(); } }
    else if (a === 'prev') { if (Spk.on) { Spk.paused = false; prev(); } }
    else if (a === 'slower' || a === 'faster') {
      Spk.rate = clamp(Spk.rate + (a === 'faster' ? 0.1 : -0.1), 0.5, 1.8);
      try { localStorage.setItem('rd.rate', String(Math.round(Spk.rate * 10) / 10)); } catch { }
      if (Spk.on && !Spk.paused) play(Spk.i);        // 立刻按新语速重读当前句
      syncBar();
    }
    else if (a === 'voice') cycleVoice();
  });
}

function cycleVoice() {
  loadVoices();
  if (!Spk.voices.length) { toastFn('这台设备没有可用的英文语音，需在「设置 → 辅助功能 → 朗读内容」里下载'); return; }
  const i = Spk.voices.indexOf(Spk.voice);
  Spk.voice = Spk.voices[(i + 1) % Spk.voices.length];
  toastFn('发音：' + Spk.voice.name + '（' + Spk.voice.lang + '）', 2600);
  if (Spk.on && !Spk.paused) play(Spk.i);
}

function showBar(on) {
  const el = $('#spkBar');
  if (el) el.classList.toggle('show', !!on);
  document.body.classList.toggle('spk-on', !!on);
  if (onModeChangeHook) onModeChangeHook(!!on);
}
let onModeChangeHook = null;
export function speechOnToggle(fn) { onModeChangeHook = fn; }

function syncBar() {
  const b = $('#spkBar'); if (!b) return;
  const p = b.querySelector('[data-a="play"]');
  if (p) p.textContent = Spk.paused ? '▶' : '⏸';
  const r = $('#spkRate'); if (r) r.textContent = Spk.rate.toFixed(1) + '×';
  if (onStateChange) onStateChange(Spk.on);
}

/* ═══════════ 段落小喇叭（文本 / Word） ═══════════ */
/** 在每段旁边插一个喇叭，点了就从这段开始读 */
export function attachParaSpeakers(bodyEl, ocrPages) {
  if (!bodyEl) return;
  bodyEl.querySelectorAll('.spk-p').forEach(x => x.remove());
  const units = buildUnits(ocrPages);
  Spk.units = units;
  const byNode = new Map();
  units.forEach((u, i) => {
    const n = u.ranges && u.ranges[0] && u.ranges[0].node;
    if (n && !byNode.has(n)) byNode.set(n, i);
  });
  /* 喇叭刻意不塞进 <p> 里面：段落的 DOM 结构要保持原样，
     不然谁再用 p.firstChild 去取正文（取词、高亮定位）都会踩空。
     改成绝对定位浮在段落右上角。 */
  bodyEl.style.position = 'relative';
  for (const p of [...bodyEl.children]) {
    if (p.classList.contains('spk-p')) continue;
    const t = firstText(p);
    if (!t || !t.data.trim()) continue;
    const i = byNode.get(t);
    if (i == null) continue;
    const btn = document.createElement('button');
    btn.className = 'spk-p';
    btn.title = '朗读这一段';
    btn.textContent = '🔊';
    btn.style.top = (p.offsetTop + 2) + 'px';
    btn.addEventListener('click', e => {
      e.stopPropagation();
      speechStartAt(i);
    });
    bodyEl.appendChild(btn);
  }
  return units.length;
}

export function speechOn() { return Spk.on; }

/* ═══════════════════════════════════════════
   ink.js — 手写标注：Apple Pencil 勾画 / 划词高亮 / 手写便签

   三件事落在同一个「宿主」(host) 上，宿主有三种：
     .pdf-page  PDF 的每一页
     .txt-wrap  TXT / Word 的整篇
     .tpara     全文翻译视图里的每一个对照段落

   两个容易踩的坑，先写在这里：
   1) 涂写层平时必须 pointer-events:none —— 它盖在文字层上面，
      一旦能吃事件，点词查词就全哑了。只有进入「笔模式」才打开。
   2) 笔迹一律存**相对坐标**（0~1）。页面会缩放、旋转、重排，
      存绝对像素的话再打开就是一屏错位的乱线。
   3) 译文视图可能有几百个 .tpara。一块块铺 canvas 会把 iPad 的
      canvas 内存吃光（iOS 有总量上限），所以那里的宿主是**懒挂载**
      的：只有视口附近的段落真正拿到画布，滚远了就把画布摘掉、
      笔迹数据留在内存里。见文件末尾 inkWatchRange()。
   ═══════════════════════════════════════════ */
import { blobPut, blobGet, blobDel } from './store.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* 一句话保持选择器统一：加新宿主类型只改这一行 */
const HOST_SEL = '.pdf-page,.txt-wrap,.tpara';

/* ── 状态 ── */
export const Ink = {
  docId: null,
  mode: 'off',                 // off | pen | marker | eraser | note
  color: '#c0392b',
  width: 2,                    // 钢笔线宽（css px，会按页面宽度折算）
  markerWidth: 18,
  palmReject: true,            // 见过 Pencil 之后忽略手指（防手掌误触）
  sawPen: false,
  hosts: new Map(),            // hostEl -> { key, canvas, notes, data }
};
let onModeChange = null;
let toastFn = () => { };

/* ── 尺寸跟随 ──
   宿主宽度会变（转屏、分屏、PDF 重新渲染、改字号），
   光靠 window.resize 不够：PDF 重渲染是异步的，回调跑的时候新宽度还没落地。
   用 ResizeObserver 盯着每个宿主，尺寸一变就把画布和高亮一起重排。 */
let ro = null;
function watchSize(hostEl) {
  if (typeof ResizeObserver === 'undefined') return;
  if (!ro) {
    ro = new ResizeObserver(entries => {
      for (const en of entries) {
        const host = en.target;
        if (!Ink.hosts.has(host)) continue;
        const w = host.clientWidth, h = host.clientHeight;
        if (!w || !h) continue;
        const rec = Ink.hosts.get(host);
        if (rec.w === w && rec.h === h) continue;      // 宽度没真的变，别白重画
        rec.w = w; rec.h = h;
        sizeCanvas(host);
        paintMarks(host);
      }
    });
  }
  ro.observe(hostEl);
}
function unwatchSize(hostEl) { try { ro && ro.unobserve(hostEl); } catch { } }

export function inkActive() { return Ink.mode !== 'off'; }

/* ── 提示（沿用页面里那个 toast 元素，避免两套浮层） ── */
function say(msg, ms) {
  try { toastFn(msg, ms); } catch { }
}

/* ═══════════ 初始化 ═══════════ */
let tapCb = null;                 // 批注模式「轻点查词」回调（app.js 注入）

export function inkInit({ toast, onTap } = {}) {
  if (toast) toastFn = toast;
  if (onTap) tapCb = onTap;
  buildToolbarEvents();
}

/* 双指捏合缩放得优先于书写：捏合一开始，进行中的笔画立即作废 */
export function inkCancelStroke() {
  if (drawing) { const h = drawing.host; drawing = null; redraw(h); }
  tapWatch = null;
}

/** 打开一篇文档时调用：清掉上一篇的宿主，记下新的 docId */
export function inkOpenDoc(docId) {
  Ink.docId = docId;
  Ink.hosts.clear();
  setMode('off', { force: true, silent: true });
}

/* ═══════════ 宿主挂载 ═══════════ */

/**
 * 给一个「可涂写的区域」装上涂写层，并读出已存的笔迹。
 * @param hostEl  .pdf-page 或 .txt-wrap
 * @param pageKey PDF 传页码，文本传 'txt'
 */
export function inkAttach(hostEl, pageKey) {
  if (!hostEl || !Ink.docId) return;
  const key = `ink:${Ink.docId}:${pageKey}`;

  /* 已经登记过：画布可能正挂着，也可能被懒挂载摘掉了（滚到视口外） */
  const old = Ink.hosts.get(hostEl);
  if (old) {
    if (old.mounted) { redraw(hostEl); return old; }
    restoreCanvas(old);
    sizeCanvas(hostEl);
    old.w = hostEl.clientWidth; old.h = hostEl.clientHeight;
    watchSize(hostEl);
    redraw(hostEl); paintMarks(hostEl);
    return old;
  }

  const cv = document.createElement('canvas');
  cv.className = 'ink-layer';
  cv.dataset.ink = '1';
  const notes = document.createElement('div');
  notes.className = 'ink-notes';
  hostEl.append(cv, notes);

  const rec = { key, host: hostEl, canvas: cv, notes, data: null, dirty: false, saveT: null, w: 0, h: 0, mounted: true };
  Ink.hosts.set(hostEl, rec);

  sizeCanvas(hostEl);
  rec.w = hostEl.clientWidth; rec.h = hostEl.clientHeight;
  watchSize(hostEl);
  /* 读存档是异步的：读完必须把高亮也重画一遍，
     否则页面刚渲染时那一帧是空的，用户会以为批注丢了。 */
  blobGet(key).then(d => {
    if (Ink.hosts.get(hostEl) !== rec) return;      // 已经翻篇了
    rec.data = normalize(d);
    if (!rec.mounted) return;   // 画布暂时摘着（没进视口），等滚回来一起画
    redraw(hostEl);
    paintMarks(hostEl);
  }).catch(() => { rec.data = normalize(null); });

  return rec;
}

/* ── 画布摘挂：只有 mount 状态才占 canvas，data 一直在内存里 ── */
function restoreCanvas(rec) {
  rec.host.append(rec.canvas, rec.notes);
  rec.mounted = true;
}
function parkHost(hostEl) {
  const rec = Ink.hosts.get(hostEl);
  if (!rec || !rec.mounted) return;
  closeNoteEditor();
  rec.canvas.remove(); rec.notes.remove();
  rec.mounted = false;
  unwatchSize(hostEl);
}

export function inkDetachAll() {
  for (const [host, rec] of Ink.hosts) {
    unwatchSize(host);
    rec.canvas.remove(); rec.notes.remove(); Ink.hosts.delete(host);
  }
}
/* 彻底丢掉某个容器里的宿主（译文视图重建 / 退出时调用）。
   不清记录会泄漏：DOM 早就换了，Map 却还攥着旧节点。 */
export function inkPurge(rootEl) {
  if (!rootEl) return;
  for (const [host, rec] of [...Ink.hosts]) {
    if (!rootEl.contains(host)) continue;
    unwatchSize(host);
    rec.canvas.remove(); rec.notes.remove();
    Ink.hosts.delete(host);
  }
}

function normalize(d) {
  const o = (d && typeof d === 'object') ? d : {};
  return {
    v: 1,
    strokes: Array.isArray(o.strokes) ? o.strokes : [],
    notes: Array.isArray(o.notes) ? o.notes : [],
    marks: Array.isArray(o.marks) ? o.marks : [],
  };
}

/* ── 画布尺寸：跟着宿主走，按 dpr 出图 ── */
function sizeCanvas(hostEl) {
  const rec = Ink.hosts.get(hostEl); if (!rec) return;
  const w = hostEl.clientWidth, h = hostEl.clientHeight;
  if (!w || !h) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cv = rec.canvas;
  cv.style.width = w + 'px';
  cv.style.height = h + 'px';
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  rec.dpr = dpr;
  redraw(hostEl);
}

export function inkResizeAll() {
  for (const host of Ink.hosts.keys()) sizeCanvas(host);
  replayAllMarks();
}

/* ═══════════ 绘制 ═══════════ */
function ctxOf(hostEl, forDraw) {
  const rec = Ink.hosts.get(hostEl); if (!rec) return null;
  const ctx = rec.canvas.getContext('2d');
  ctx.setTransform(rec.dpr || 1, 0, 0, rec.dpr || 1, 0, 0);
  return ctx;
}

/** 把一条（相对坐标的）笔画画到画布上 */
function drawStroke(ctx, st, wCss, hCss) {
  const p = st.p;
  if (!p || p.length < 2) return;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = st.c || '#c0392b';
  ctx.globalAlpha = st.t === 'marker' ? 0.3 : 1;
  ctx.lineWidth = st.w || 2;
  ctx.beginPath();
  ctx.moveTo(p[0] * wCss, p[1] * hCss);
  if (p.length === 2) {
    ctx.lineTo(p[2] * wCss, p[3] * hCss);
  } else {
    for (let i = 2; i < p.length - 2; i += 2) {
      const x0 = p[i - 2] * wCss, y0 = p[i - 1] * hCss;
      const x1 = p[i] * wCss, y1 = p[i + 1] * hCss;
      ctx.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
    }
    ctx.lineTo(p[p.length - 2] * wCss, p[p.length - 1] * hCss);
  }
  ctx.stroke();
  ctx.restore();
}

function redraw(hostEl) {
  const rec = Ink.hosts.get(hostEl); if (!rec) return;
  const w = hostEl.clientWidth, h = hostEl.clientHeight;
  if (!w || !h) return;
  const ctx = rec.canvas.getContext('2d');
  ctx.setTransform(rec.dpr || 1, 0, 0, rec.dpr || 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const d = rec.data || normalize(null);
  for (const st of d.strokes) drawStroke(ctx, st, w, h);
  renderNotes(hostEl);
}

function renderNotes(hostEl) {
  const rec = Ink.hosts.get(hostEl); if (!rec) return;
  const d = rec.data || normalize(null);
  rec.notes.innerHTML = '';
  for (const n of d.notes) {
    const el = document.createElement('div');
    el.className = 'ink-note';
    el.style.left = (n.x * 100) + '%';
    el.style.top = (n.y * 100) + '%';
    el.innerHTML = `<span class="ink-note-pin">✎</span><span class="ink-note-txt"></span>`;
    el.querySelector('.ink-note-txt').textContent = n.text || '';
    el.addEventListener('pointerdown', ev => {
      ev.stopPropagation();
      if (Ink.mode === 'eraser') { removeNote(hostEl, n); return; }
      openNoteEditor(hostEl, n);
    });
    rec.notes.appendChild(el);
  }
}

/* ═══════════ 落笔 ═══════════ */
let drawing = null;
let tapWatch = null;              // 手掌防误触拒掉的手指：仍保留「点一下查词」的机会

function hostOfEvent(e) {
  let el = e.target;
  if (el && el.classList && el.classList.contains('ink-layer')) return el.parentElement;
  const host = el && el.closest ? el.closest(HOST_SEL) : null;
  return host;
}

function bindDraw() {
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('pointerup', onUp, true);
  document.addEventListener('pointercancel', onUp, true);
}
let bound = false;

function onDown(e) {
  if (Ink.mode === 'off') return;
  /* 便签和高亮块自己带处理逻辑，别被涂写层抢先吃掉 */
  if (e.target && e.target.closest && e.target.closest('.ink-note,.hl-mark')) return;
  const host = hostOfEvent(e);
  if (!host || !Ink.hosts.has(host)) return;

  /* 手掌误触：用过 Pencil 之后，手指就不参与书写了。
     但手指「点一下」仍可用来查词 —— 手掌按压时间长、且必然移动，过不了点词判定 */
  if (e.pointerType === 'pen') Ink.sawPen = true;
  if (Ink.palmReject && Ink.sawPen && e.pointerType === 'touch') {
    tapWatch = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), d: 0 };
    return;
  }

  const rec = Ink.hosts.get(host);
  const rect = host.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  if (Ink.mode === 'note') {
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    openNoteEditor(host, null, x, y);
    e.preventDefault(); e.stopPropagation();
    return;
  }

  const px = e.clientX, py = e.clientY;
  const nx = (px - rect.left) / rect.width, ny = (py - rect.top) / rect.height;

  if (Ink.mode === 'eraser') {
    const hit = eraseAt(host, nx, ny, rect);
    if (hit) { save(host); redraw(host); }
    e.preventDefault(); e.stopPropagation();
    return;
  }

  drawing = {
    host, rec, pointerId: e.pointerId,
    t0: performance.now(), x0: e.clientX, y0: e.clientY,
    stroke: { t: Ink.mode === 'marker' ? 'marker' : 'pen', c: Ink.color, w: currentWidth(host), p: [nx, ny] },
    w: rect.width, h: rect.height, ctx: ctxOf(host),
  };
  try { e.target.setPointerCapture?.(e.pointerId); } catch { }
  e.preventDefault(); e.stopPropagation();
}

function currentWidth(host) {
  const base = Ink.mode === 'marker' ? Ink.markerWidth : Ink.width;
  /* 页面被放大时线也跟着粗一点，视觉上才一致 */
  const k = clamp((host.clientWidth || 700) / 700, 0.7, 2);
  return base * k;
}

function onMove(e) {
  /* 被拒笔画（防误触的手指）只追踪位移，供松手时判断是不是「点一下」 */
  if (tapWatch && e.pointerId === tapWatch.id) {
    tapWatch.d = Math.max(tapWatch.d, Math.hypot(e.clientX - tapWatch.x, e.clientY - tapWatch.y));
    return;
  }
  if (!drawing || e.pointerId !== drawing.pointerId) return;
  const rect = drawing.host.getBoundingClientRect();
  const nx = (e.clientX - rect.left) / rect.width;
  const ny = (e.clientY - rect.top) / rect.height;
  const p = drawing.stroke.p;
  const lx = p[p.length - 2], ly = p[p.length - 1];
  if (Math.hypot(nx - lx, ny - ly) < 0.0012) return;      // 抖动的点丢掉
  /* 压感：Apple Pencil 给得到 pressure，手指/鼠标恒为 0.5 */
  if (e.pointerType === 'pen' && e.pressure > 0 && drawing.stroke.t === 'pen') {
    drawing.stroke.w = currentWidth(drawing.host) * (0.55 + e.pressure * 0.9);
  }
  p.push(nx, ny);
  /* 增量画：只补最后一小段。整页重绘在松手时做一次，
     否则笔画一多，每帧重画上百笔会明显发涩。 */
  const ctx = drawing.ctx;
  if (ctx) {
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = drawing.stroke.c;
    ctx.globalAlpha = drawing.stroke.t === 'marker' ? 0.3 : 1;
    ctx.lineWidth = drawing.stroke.w;
    ctx.beginPath();
    ctx.moveTo(lx * drawing.w, ly * drawing.h);
    ctx.lineTo(nx * drawing.w, ny * drawing.h);
    ctx.stroke();
    ctx.restore();
  }
  e.preventDefault(); e.stopPropagation();
}

function onUp(e) {
  /* 查词：批注模式下的「轻点」（不是书写）也出单词卡片 —— 边批注边查 */
  if (tapWatch && (e.pointerId == null || e.pointerId === tapWatch.id)) {
    const w = tapWatch; tapWatch = null;
    if (performance.now() - w.t < 450 && w.d < 12 && tapCb) { try { tapCb(w.x, w.y); } catch { } }
  }
  if (!drawing || (e.pointerId != null && e.pointerId !== drawing.pointerId)) return;
  const { host, rec, stroke, t0, x0, y0 } = drawing;
  drawing = null;
  if (!stroke.p || stroke.p.length < 4) {
    redraw(host);
    if (t0 && performance.now() - t0 < 450 && tapCb) { try { tapCb(x0, y0); } catch { } }
    return;
  }
  rec.data = rec.data || normalize(null);
  rec.data.strokes.push(stroke);
  redraw(host);
  save(host);
}

function eraseAt(host, nx, ny, rect) {
  const rec = Ink.hosts.get(host); if (!rec) return false;
  const d = rec.data || normalize(null);
  const tol = 14 / Math.max(1, rect.width);        // 14px 的容差，换算成相对值
  const tolY = 14 / Math.max(1, rect.height);
  for (let i = d.strokes.length - 1; i >= 0; i--) {
    const p = d.strokes[i].p;
    for (let j = 0; j < p.length; j += 2) {
      if (Math.abs(p[j] - nx) <= tol && Math.abs(p[j + 1] - ny) <= tolY) {
        d.strokes.splice(i, 1);
        return true;
      }
    }
  }
  return false;
}

function removeNote(host, n) {
  const rec = Ink.hosts.get(host); if (!rec) return;
  const d = rec.data || normalize(null);
  const i = d.notes.indexOf(n);
  if (i >= 0) { d.notes.splice(i, 1); save(host); redraw(host); say('便签已删除'); }
}

/* ═══════════ 便签（用 Pencil 手写，iPad 会自动转成文字） ═══════════ */
let noteEditor = null;

function openNoteEditor(host, existing, x, y) {
  closeNoteEditor();
  const rec = Ink.hosts.get(host); if (!rec) return;
  const d = rec.data || normalize(null);

  const box = document.createElement('div');
  box.className = 'note-editor';
  box.innerHTML = `
    <div class="ne-title">${existing ? '编辑便签' : '写点什么'}</div>
    <textarea class="ne-input" rows="3" placeholder="直接用笔在这个框里写，iPad 会把手写转成文字">${existing ? escText(existing.text) : ''}</textarea>
    <div class="ne-hint">用 Apple Pencil 在框内手写即可；也可以直接打字。</div>
    <div class="ne-btns">
      ${existing ? '<button class="mini-btn danger" data-act="del">删除</button>' : ''}
      <button class="mini-btn" data-act="cancel">取消</button>
      <button class="mini-btn primary" data-act="ok">保存</button>
    </div>`;
  document.body.appendChild(box);
  noteEditor = box;
  const ta = box.querySelector('.ne-input');
  setTimeout(() => ta.focus(), 60);

  box.addEventListener('click', ev => {
    const b = ev.target.closest('button[data-act]'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'cancel') { closeNoteEditor(); return; }
    if (act === 'del') { closeNoteEditor(); if (existing) removeNote(host, existing); return; }
    const text = ta.value.trim();
    if (!text) { closeNoteEditor(); return; }
    if (existing) existing.text = text;
    else d.notes.push({ x: x ?? 0.06, y: y ?? 0.06, text, t: Date.now() });
    closeNoteEditor();
    save(host); redraw(host);
  });
}
function closeNoteEditor() { if (noteEditor) { noteEditor.remove(); noteEditor = null; } }
const escText = s => String(s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

/* ═══════════ 划词高亮 ═══════════ */

/**
 * 一次 Selection → 稳定的引用
 *   PDF：  记 span 序号             { k:'s' }
 *   文本： 记段落序号 + 字符偏移     { k:'p' }
 *   译文： 同上，但作用域是单个 .tpara 里的英/中两个 <p>  { k:'p', scope:'tpara' }
 */
function refFromRange(range, host) {
  const layer = host.querySelector('.textLayer');
  if (layer) {
    const spans = [...layer.querySelectorAll('span')];
    const a = nodeRef(range.startContainer, range.startOffset, spans);
    const b = nodeRef(range.endContainer, range.endOffset, spans);
    if (!a || !b) return null;
    return { k: 's', a, b };
  }
  /* 译文段落：英、中各是一个 <p>，没有外层 .txt-body 把它们包起来，
     所以「段落列表」直接从 .tpara 里取，并记下 scope 供复原时认路。 */
  if (host.classList.contains('tpara')) {
    const ps = [...host.querySelectorAll('p')];
    const a = paraRef(range.startContainer, range.startOffset, ps);
    const b = paraRef(range.endContainer, range.endOffset, ps);
    if (!a || !b) return null;
    return { k: 'p', scope: 'tpara', a, b };
  }
  const body = host.querySelector('.txt-body');
  if (!body) return null;
  const kids = [...body.children];
  const a = paraRef(range.startContainer, range.startOffset, kids);
  const b = paraRef(range.endContainer, range.endOffset, kids);
  if (!a || !b) return null;
  return { k: 'p', a, b };
}

function nodeRef(node, off, spans) {
  let n = node, o = off;
  if (n && n.nodeType === 1) {
    let k = n.childNodes[o];
    if (k && k.nodeType === 3) { n = k; o = 0; }
    else {
      k = n.childNodes[o - 1];
      if (k && k.nodeType === 3) { n = k; o = k.data.length; }
      else { const t = firstText(n); if (!t) return null; n = t; o = off > 0 ? t.data.length : 0; }
    }
  }
  if (!n || n.nodeType !== 3) return null;
  const sp = n.parentElement && n.parentElement.closest('span');
  if (!sp) return null;
  const i = spans.indexOf(sp);
  if (i < 0) return null;
  return [i, clamp(o, 0, n.data.length)];
}

function paraRef(node, off, kids) {
  let n = node, o = off;
  if (n && n.nodeType === 1) { const k = n.childNodes[o] || n.childNodes[o - 1] || n.firstChild; if (!k) return null; n = k; o = 0; }
  if (!n || n.nodeType !== 3) return null;
  const p = n.parentElement && n.parentElement.closest('p');
  if (!p) return null;
  const i = kids.indexOf(p);
  if (i < 0) return null;
  return [i, clamp(o, 0, n.data.length)];
}

/** 引用 → 真实 Range（页面重排 / 重新渲染后都靠它复原） */
function rangeFromRef(ref, host) {
  try {
    if (ref.k === 's') {
      const spans = [...host.querySelectorAll('.textLayer span')];
      const A = spans[ref.a[0]], B = spans[ref.b[0]];
      if (!A || !B) return null;
      const ta = firstText(A), tb = firstText(B);
      if (!ta || !tb) return null;
      const r = document.createRange();
      r.setStart(ta, clamp(ref.a[1], 0, ta.data.length));
      r.setEnd(tb, clamp(ref.b[1], 0, tb.data.length));
      return r;
    }
    const kids = ref.scope === 'tpara'
      ? [...host.querySelectorAll('p')]
      : [...host.querySelectorAll('.txt-body > *')];
    const A = kids[ref.a[0]], B = kids[ref.b[0]];
    if (!A || !B) return null;
    const ta = firstText(A), tb = firstText(B);
    if (!ta || !tb) return null;
    const r = document.createRange();
    r.setStart(ta, clamp(ref.a[1], 0, ta.data.length));
    r.setEnd(tb, clamp(ref.b[1], 0, tb.data.length));
    return r;
  } catch { return null; }
}
/* 取元素里第一个「正文」文本节点 —— 要跳过段落里那个朗读小喇叭 */
function firstText(el) {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      return n.parentElement && n.parentElement.closest('.spk-p')
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    }
  });
  return w.nextNode();
}

/** 供 app.js 的选区浮条调用：给当前选区加一条高亮 */
export function inkMarkSelection(color) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount < 1 || !sel.toString().trim()) return false;
  /* anchorNode 常常是文本节点，它没有 closest()——先回到父元素再找宿主 */
  let node = sel.anchorNode;
  if (node && node.nodeType === 3) node = node.parentElement;
  const host = node && node.closest ? node.closest(HOST_SEL) : null;
  if (!host || !Ink.hosts.has(host)) return false;
  const ref = refFromRange(sel.getRangeAt(0), host);
  if (!ref) return false;
  const rec = Ink.hosts.get(host);
  rec.data = rec.data || normalize(null);
  rec.data.marks.push({ ref, c: color || '#f2c14e', t: Date.now() });
  save(host);
  paintMarks(host);
  return true;
}

/** 重画某个宿主上的高亮块 */
export function paintMarks(host) {
  if (!host || !Ink.hosts.has(host)) return;
  const rec = Ink.hosts.get(host);
  const d = rec.data || normalize(null);
  let hl = host.querySelector('.hl-layer');
  if (!hl) { hl = document.createElement('div'); hl.className = 'hl-layer'; host.appendChild(hl); }
  [...hl.querySelectorAll('.hl-mark')].forEach(x => x.remove());
  const hb = host.getBoundingClientRect();
  for (const m of d.marks) {
    const r = rangeFromRef(m.ref, host);
    if (!r) continue;
    let rects;
    try { rects = [...r.getClientRects()]; } catch { continue; }
    for (const rc of rects) {
      if (rc.width < 1 || rc.height < 1) continue;
      const el = document.createElement('div');
      el.className = 'hl-mark';
      el.style.cssText = `left:${rc.left - hb.left}px;top:${rc.top - hb.top}px;`
        + `width:${rc.width}px;height:${rc.height}px;background:${m.c}`;
      el.addEventListener('pointerdown', ev => {
        if (!inkActive()) return;                 // 阅读模式下不拦事件，别影响点词
        ev.stopPropagation();
        askMark(host, m);
      });
      hl.appendChild(el);
    }
  }
}

function askMark(host, m) {
  const box = document.createElement('div');
  box.className = 'note-editor small';
  box.innerHTML = `<div class="ne-title">这条高亮</div>
    <div class="ne-hint">换颜色，或者去掉它。</div>
    <div class="ne-btns">
      <button class="mini-btn danger" data-act="del">删除</button>
      <button class="mini-btn" data-act="cancel">关闭</button>
      <button class="mini-btn primary" data-act="ok">换色</button>
    </div>`;
  document.body.appendChild(box);
  box.addEventListener('click', ev => {
    const b = ev.target.closest('button[data-act]'); if (!b) return;
    const rec = Ink.hosts.get(host); const d = rec.data || normalize(null);
    const i = d.marks.indexOf(m);
    if (b.dataset.act === 'del') { if (i >= 0) d.marks.splice(i, 1); save(host); paintMarks(host); }
    else if (b.dataset.act === 'ok') {
      const seq = ['#f2c14e', '#8fd18a', '#9ec7f0', '#e9a3bd'];
      const cur = seq.indexOf(m.c);
      m.c = seq[(cur + 1) % seq.length];
      save(host); paintMarks(host);
    }
    box.remove();
  });
}

export function replayAllMarks() {
  for (const host of Ink.hosts.keys()) paintMarks(host);
}

/* ═══════════ 存取 ═══════════ */
function save(host) {
  const rec = Ink.hosts.get(host); if (!rec) return;
  clearTimeout(rec.saveT);
  rec.saveT = setTimeout(() => { blobPut(rec.key, rec.data).catch(() => { }); }, 500);
}

/** 撤销最后一项：优先撤「正在看的」那一页 / 那一段 */
export function inkUndo() {
  const unit = () => transViewOn() ? '这一段' : '这一页';
  let target = null;
  for (const [host, rec] of Ink.hosts) {
    if (rec.data && rec.data.strokes.length) { target = host; break; }
  }
  /* 优先撤销「正在看的」那一页 / 那一段 */
  const vis = visibleHost();
  if (vis && Ink.hosts.get(vis)?.data?.strokes.length) target = vis;
  if (!target) { say(unit() + '还没有笔迹'); return; }
  const rec = Ink.hosts.get(target);
  rec.data.strokes.pop();
  save(target); redraw(target);
  say('已撤销一笔');
}

export function inkClearPage() {
  const host = visibleHost();
  if (!host) return;
  const isPara = host.classList.contains('tpara');
  const rec = Ink.hosts.get(host);
  rec.data = normalize(null);
  blobPut(rec.key, rec.data).catch(() => { });
  redraw(host); paintMarks(host);
  say(isPara ? '这一段的批注已清除' : '这一页的批注已清除');
}

/* 当前是不是站在全文翻译视图里（决定提示词说「页」还是「段」） */
function transViewOn() { return !!$('#trans')?.classList.contains('active'); }

export async function inkClearDoc(docId) {
  if (!docId) return;
  const { blobKeys } = await import('./store.js');
  const keys = (await blobKeys()).filter(k => typeof k === 'string' && k.startsWith('ink:' + docId + ':'));
  for (const k of keys) await blobDel(k);
  for (const [host, rec] of Ink.hosts) {
    if (rec.key.startsWith('ink:' + docId + ':')) { rec.data = normalize(null); redraw(host); paintMarks(host); }
  }
}

export function inkCount(docId) {
  let n = 0;
  for (const rec of Ink.hosts.values()) if (rec.data) n += (rec.data.strokes?.length || 0) + (rec.data.notes?.length || 0) + (rec.data.marks?.length || 0);
  return n;
}

function visibleHost() {
  /* 当前在哪个视图，就从哪个滚动容器里量 —— 阅读页和全文翻译页各有一个 */
  const sc = transViewOn() ? $('#transScroll') : $('#readerScroll');
  if (!sc) return null;
  const mid = sc.scrollTop + sc.clientHeight / 2;
  let best = null, bd = Infinity;
  for (const host of Ink.hosts.keys()) {
    const d = Math.abs(host.offsetTop + host.offsetHeight / 2 - mid);
    if (d < bd) { bd = d; best = host; }
  }
  return best;
}

/* ═══════════ 模式与工具条 ═══════════ */
export function inkSetMode(m) { setMode(m, { force: true }); }

function setMode(m, opt) {
  opt = opt || {};
  if (!opt.force && Ink.mode === m) m = 'off';   // 再点一次同一个工具 = 收起
  const silent = !!opt.silent;
  Ink.mode = m || 'off';
  document.body.classList.toggle('ink-on', inkActive());
  document.body.dataset.inkMode = Ink.mode;
  if (!bound) { bindDraw(); bound = true; }
  const tb = $('#inkBar');
  if (tb) {
    tb.classList.toggle('show', inkActive());
    [...tb.querySelectorAll('[data-tool]')].forEach(b => b.classList.toggle('on', b.dataset.tool === Ink.mode));
  }
  $$('.ink-toggle').forEach(b => b.classList.toggle('on', inkActive()));
  if (inkActive()) {
    /* 进笔模式：把已渲染页面的尺寸再量一遍，避免旋转后画布错位 */
    for (const host of Ink.hosts.keys()) sizeCanvas(host);
    if (!silent) say(m === 'note' ? '在页面上点一下，就能用笔写批注' : m === 'eraser' ? '点笔迹即可擦掉' : '可以在页面上直接写了', 2200);
  } else {
    closeNoteEditor();
  }
  if (onModeChange) onModeChange(Ink.mode);
}

export function inkOnModeChange(fn) { onModeChange = fn; }

function buildToolbarEvents() {
  const tb = $('#inkBar');
  if (!tb) return;
  tb.addEventListener('click', e => {
    const b = e.target.closest('[data-tool]');
    if (b) { setMode(b.dataset.tool); return; }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'undo') inkUndo();
    if (a.dataset.act === 'clear') inkClearPage();
    if (a.dataset.act === 'exit') setMode('off');
  });
  $('#inkColors')?.addEventListener('click', e => {
    const b = e.target.closest('[data-color]'); if (!b) return;
    Ink.color = b.dataset.color;
    setMode('pen', { force: true });
    [...$('#inkColors').children].forEach(x => x.classList.toggle('on', x === b));
  });
  $('#inkWidth')?.addEventListener('input', e => { Ink.width = Number(e.target.value); });
  $('#inkWidth')?.addEventListener('change', e => { Ink.width = Number(e.target.value); });
  $$('.ink-toggle').forEach(b => b.addEventListener('click', () => setMode(inkActive() ? 'off' : 'pen')));
}

/* ═══════════ 译文视图：整片宿主的懒挂载 ═══════════
   全文翻译可能有几百个 .tpara。每个都长期挂着一块 canvas，会把 iPad 的
   canvas 总量撑爆（iOS 有上限，超了的表现往往是整页突然变空白）。
   所以这里只用 IntersectionObserver 给「视口附近」的段落画布：
   进来了 inkAttach 挂画布，滚远了 parkHost 摘画布，笔迹数据留在内存里，
   再滚回来就地重画，用户看不出差别。 */
let rangeIO = null;
let rangeKeyFn = null;

/**
 * @param rootEl     装着一堆 .tpara 的容器
 * @param scrollerEl 它们的滚动容器（给 IO 当 root）
 * @param keyFn      .tpara → 存档 key 后缀（一般是段落序号）
 */
export function inkWatchRange(rootEl, scrollerEl, keyFn) {
  inkStopRange();
  if (!rootEl || !Ink.docId) return;
  rangeKeyFn = keyFn;
  const items = $$('.tpara', rootEl);
  if (!('IntersectionObserver' in window)) { items.forEach(el => inkAttach(el, keyFn(el))); return; }
  rangeIO = new IntersectionObserver(entries => {
    for (const en of entries) {
      const el = en.target;
      if (en.isIntersecting) inkAttach(el, rangeKeyFn(el));
      else parkHost(el);
    }
  }, { root: scrollerEl || null, rootMargin: '1200px 0px' });
  items.forEach(el => rangeIO.observe(el));
}

export function inkStopRange() {
  if (rangeIO) { rangeIO.disconnect(); rangeIO = null; }
  rangeKeyFn = null;
}

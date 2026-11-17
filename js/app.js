/* ═══════════════════════════════════════════
   app.js — 英语阅读器主逻辑
   ═══════════════════════════════════════════ */
import * as pdfjs from './vendor/pdf.min.mjs';
import {
  loadOffline, lookupOffline, lookupOnline, translate, normalizeWord,
  offlineLoaded, offlineCount, suggestOffline, quotaExhausted, setTranslateEmail
} from './dict.js';
import { ocrImage, hitWord, ocrQuality, terminate as ocrTerminate } from './ocr.js';
import { extractPdfParas, ocrParasToText, splitLong } from './extract.js';
import { extractDocxText } from './docx.js';
import { polishCN, TERM_COUNT } from './polish.js';
import {
  store, storageBroken, stGet, stSet,
  blobPut, blobGet, blobDel, blobKeys, blobDelPrefix, withTimeout,
  K_SET, K_DOCS, K_VOCAB
} from './store.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

/* ── 版本自检 ──────────────────────────────
   页面（index.html）是「网络优先」，脚本却是 Service Worker 的「缓存优先」，
   两者可能不同步：浏览器拿到的是新页面 + 上一版的 app.js。
   这时候功能会莫名其妙地少一块（比如刚加的图片导入「没这个功能」）。
   做法：三个地方的版本号必须一致，不一致就重新加载一次把缓存对齐。
   每个版本只重载一次，所以不会来回刷。 */
const APP_VER = 'rd-v1.7.2';
(() => {
  const htmlVer = document.querySelector('meta[name="rd-ver"]')?.content || '';
  if (!htmlVer || htmlVer === APP_VER) return;
  window.__verMismatch = `页面 ${htmlVer} / 脚本 ${APP_VER}`;
  try {
    if (localStorage.getItem('rd.ver.reloaded') === htmlVer) return;  // 这个版本已经重载过
    localStorage.setItem('rd.ver.reloaded', htmlVer);
    location.reload();
  } catch { }
})();

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cn2line = s => String(s || '').replace(/\r/g, '').replace(/\n+/g, '；').replace(/；+$/, '');

import {
  Ink, inkInit, inkOpenDoc, inkAttach, inkDetachAll, inkActive, inkResizeAll,
  inkMarkSelection, paintMarks, inkClearDoc, inkCount, inkOnModeChange, inkCancelStroke,
  inkWatchRange, inkStopRange, inkPurge, inkSetMode
} from './ink.js';
import {
  Spk, speechInit, speechSetMode, speechStart, speechStop, speechOn,
  attachParaSpeakers, speechOnToggle
} from './speech.js';

const settings = Object.assign({ theme: 'paper', zoom: 1, audio: true, autoStar: false, transEmail: '', polish: 'std', terms: true }, stGet(K_SET, {}));

/* 翻译接口给的是机器直译，术语翻错、读着别扭。
   这里在显示前统一过一遍中文润色；缓存里存的仍是原始译文，
   所以在设置里换档位立刻见效，不用重新翻译。 */
const cnView = t => polishCN(t, settings.polish, settings.terms !== false);
let docs = stGet(K_DOCS, []);
let vocab = stGet(K_VOCAB, []);
setTranslateEmail(settings.transEmail);

/* ───────── 通用 UI ───────── */
let toastTimer;
function toast(msg, ms = 2000) {
  const el = $('#toast'); el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
const blocker = (on, text = '处理中…') => { if (text) $('#blockerText').textContent = text; $('#blocker').classList.toggle('show', on); };
const fmtDate = t => { const d = new Date(t), n = new Date(); return d.toDateString() === n.toDateString() ? `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}` : `${d.getMonth() + 1}/${d.getDate()}`; };

/* ───────── 设置界面同步 ───────── */
function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = settings.theme === 'night' ? '#14161a' : settings.theme === 'white' ? '#eceef1' : '#f4efe6';
  $$('#segTheme button').forEach(b => b.classList.toggle('on', b.dataset.theme === settings.theme));
  $$('#segZoom button').forEach(b => b.classList.toggle('on', Math.abs(Number(b.dataset.zoom) - (settings.zoom || 1)) < 0.03));
  $('#swAudio').setAttribute('aria-checked', String(settings.audio));
  $('#swAutoStar').setAttribute('aria-checked', String(settings.autoStar));
  $$('#segPolish button').forEach(b => b.classList.toggle('on', b.dataset.polish === settings.polish));
  $('#swTerms').setAttribute('aria-checked', String(settings.terms !== false));
  const ph = $('#polishHint');
  if (ph && !ph.dataset.init) {
    ph.dataset.init = '1';
    ph.innerHTML += `<br>已内置 ${TERM_COUNT} 条会计／审计／财务术语纠正规则。`;
  }
}

/* ═══════════ 书架 ═══════════ */
function renderLibrary() {
  const list = $('#libList');
  list.innerHTML = '';
  $('#libCount').textContent = docs.length ? docs.length + ' 篇' : '';
  $('#libEmpty').style.display = docs.length ? 'none' : 'block';
  for (const d of docs) {
    const el = document.createElement('div');
    el.className = 'doc-card';
    const pct = Math.round((d.progress || 0) * 100);
    el.innerHTML = `
      <div class="doc-thumb">${d.type === 'pdf' ? 'PDF' : d.type === 'image' ? 'IMG' : d.src === 'docx' ? 'DOC' : 'TXT'}</div>
      <div class="doc-meta">
        <div class="doc-title"></div>
        <div class="doc-sub"><span>${d.type === 'image' ? '图片 · ' : d.pages ? d.pages + ' 页 · ' : ''}已读 ${pct}%</span><span>${fmtDate(d.opened || d.added)}</span></div>
      </div>
      <button class="doc-del" title="删除">✕</button>`;
    el.querySelector('.doc-title').textContent = d.name;
    el.addEventListener('click', e => { if (!e.target.closest('.doc-del')) openDoc(d.id); });
    el.querySelector('.doc-del').addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm(`删除《${d.name}》？`)) return;
      docs = docs.filter(x => x.id !== d.id); stSet(K_DOCS, docs);
      try { await blobDel(d.id); } catch { }
      // 这篇文档留下的所有副产物一起清掉，否则越用越占空间
      for (const pfx of ['ocr:', 'ink:', 'tr:']) {
        try { await blobDelPrefix(pfx + d.id + ':'); } catch { }
      }
      renderLibrary();
    });
    list.appendChild(el);
  }
}

/* ═══════════ 导入 ═══════════ */
async function importOne(f, id, isPdf, meta, readyText) {
  if (isPdf || meta.type === 'image') {
    const buf = await f.arrayBuffer();
    // 先把原始字节存起来 —— pdf.js 会 detach 传入的 ArrayBuffer，
    // 所以必须存原件、把副本交给 pdf.js。
    await blobPut(id, buf);
    if (!isPdf) return;                    // 图片：字节存好就行，页数固定 1
    // pdf.js 会 detach 传进去的 ArrayBuffer，所以存原件、把副本交给它
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
    meta.pages = pdf.numPages;
    try { pdf.destroy(); } catch { }
  } else {
    // readyText 非空时直接用（Word 文档已经抽好文字了），否则当纯文本读
    await blobPut(id, readyText != null ? readyText : await f.text());
  }
}

/* 判断一个文件到底是什么 —— 一律回头看文件头。
   绝不能只看扩展名 / MIME：从微信、QQ、网盘转存或 AirDrop 过来的文件，
   名字和类型经常是错的（实测有「微信文件_2026」+ application/octet-stream）。
   返回 'pdf' | 'txt' | 'zipdoc' | 'office' | 'image' | 'unknown'。 */
async function sniffKind(f) {
  let b = new Uint8Array(0);
  try { b = new Uint8Array(await f.slice(0, 1024).arrayBuffer()); } catch { }
  const at = (...arr) => arr.length <= b.length && arr.every((v, i) => b[i] === v);

  if (at(0x25, 0x50, 0x44, 0x46)) return 'pdf';                                    // %PDF
  if (at(0xFF, 0xD8, 0xFF) || at(0x89, 0x50, 0x4E, 0x47) || at(0x47, 0x49, 0x46, 0x38)
    || at(0x42, 0x4D) || at(0x49, 0x49, 0x2A, 0x00) || at(0x4D, 0x4D, 0x00, 0x2A)) return 'image';
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'image'; // HEIC/HEIF
  if (at(0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1)) return 'office';        // 老 .doc/.xls/.ppt
  if (at(0x50, 0x4B, 0x03, 0x04) || at(0x50, 0x4B, 0x05, 0x06)) return 'zipdoc';  // docx/xlsx/pptx/Pages（zip）

  if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') return 'pdf';
  if (looksLikeText(b)) return 'txt';
  return 'unknown';
}

/* 图片的真实类型：从文件头认，不信扩展名也不信 MIME。
   微信 / 网盘转出来的文件这两样都可能不对，而 <img> 认的是真类型。 */
function imgMime(b) {
  if (b[0] === 0xFF && b[1] === 0xD8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4D) return 'image/bmp';
  if (b[0] === 0x49 && b[1] === 0x49) return 'image/tiff';
  if (b[0] === 0x4D && b[1] === 0x4D) return 'image/tiff';
  if (b[0] === 0x52 && b[1] === 0x49) return 'image/webp';
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'image/heic';
  return '';
}

/* 粗略判断是不是文本：出现 NUL 或成片的非法控制字符就当二进制。
   高位字节（≥0x80）一律放行 —— 那是 UTF-8 或 GBK 的中文。 */
function looksLikeText(b) {
  if (!b.length) return false;
  let bad = 0;
  for (const c of b) {
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32)) bad++;
  }
  return bad / b.length < 0.02;
}

/* 选了个读不了的文件时，必须说清楚它是什么、该怎么办 ——
   让用户对着「点了没反应」猜是最大的错。 */
function unsupportedWhy(kind, name) {
  if (kind === 'zipdoc') return `这不是能直接读的 Word 正文（更可能是 Excel / PPT / Pages 或压缩包）。用对应的 App 打开，选「导出 / 另存为 PDF」再导入`;
  if (kind === 'office') return `这是老版 Office 文档（.doc/.xls/.ppt，不是 PDF）。先另存为 PDF 再导入`;
  const ext = (name.match(/\.[A-Za-z0-9]{1,6}$/) || [''])[0];
  return `这个文件既不是 PDF 也不是 TXT${ext ? '（看起来是 ' + ext + ' 文件）' : ''}，本阅读器读不了`;
}

async function importFiles(files) {
  const all = [...files].filter(Boolean);
  const fail = [];
  // 0 字节的文件单独拎出来说明 —— 多半是下载/传输没完成，不说清楚用户只会以为「点了没反应」
  for (const f of all) {
    if (f.size === 0) fail.push({ name: f.name || '未命名', why: '这个文件是空的（0 字节），可能是下载或传输没完成' });
  }
  const arr = all.filter(f => f.size > 0);
  if (!arr.length) {
    if (fail.length) showImportError(fail); else toast('没拿到文件，请重新选一次', 2600);
    return;
  }
  blocker(true, '正在导入…');
  let ok = 0;
  try {
    for (const f of arr) {
      try {
        const id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        let kind = await sniffKind(f);
        let readyText = null;
        // zip 头的可能是 Word（docx），也可能是 Excel / PPT / Pages，
        // 不猜 —— 直接试着抽正文，抽得出来才算 Word。
        if (kind === 'zipdoc') {
          try {
            const t = await extractDocxText(f);
            if (t && t.trim().length > 20) { kind = 'docx'; readyText = t; }
          } catch (e) { console.warn('不是 Word 文档：', e && e.message); }
        }
        const isImg = kind === 'image';
        if (kind !== 'pdf' && kind !== 'txt' && kind !== 'docx' && !isImg) {
          fail.push({ name: f.name || '未命名', why: unsupportedWhy(kind, f.name || '') });
          continue;
        }
        const isPdf = kind === 'pdf';
        // 图片记下真实类型，<img> 只认这个；扩展名和 MIME 在转存过程中经常是错的
        const mime = isImg ? imgMime(new Uint8Array(await f.slice(0, 12).arrayBuffer())) : '';
        // 能识别格式、但里面一个字都没有的文件，别让它静悄悄进书架
        if (!isPdf && readyText == null) {
          const t = await f.text();
          if (!t || !t.trim()) { fail.push({ name: f.name || '未命名', why: '这个文件里没有文字内容' }); continue; }
          readyText = t;
        }
        const meta = {
          id, name: (f.name || '未命名').replace(/\.(pdf|txt|docx|jpe?g|png|webp|gif|bmp|tiff?|heic)$/i, ''),
          type: isPdf ? 'pdf' : isImg ? 'image' : 'txt', src: kind,   // src 记住原始来源，书架上好区分
          mime, size: f.size, added: Date.now(), progress: 0, lastPage: 1, pages: isImg ? 1 : 0,
        };
        await withTimeout(importOne(f, id, isPdf, meta, readyText), 60000, '解析文件');
        docs.unshift(meta); ok++;
      } catch (e) {
        console.error('import', e);
        fail.push({ name: f.name || '未命名', why: (e && (e.name === 'PasswordException' ? 'PDF 有密码，无法打开'
          : e.name === 'InvalidPDFException' ? '不是有效的 PDF（可能是扫描图片或文件损坏）'
          : e.message || e.name)) });
      }
    }
  } finally {
    blocker(false);                  // 无论如何都要把转圈收掉，绝不能卡住
  }
  stSet(K_DOCS, docs);
  renderLibrary();
  if (ok) {
    // 部分失败时也得让用户知道 —— 否则他会以为全都进来了
    toast(fail.length
      ? `已导入 ${ok} 个，${fail.length} 个没成功：${fail[0].name}（${fail[0].why}）`
      : `已导入 ${ok} 个文献`, fail.length ? 4200 : 1800);
    if (docs[0]) openDoc(docs[0].id);          // 导入完直接打开，省得用户以为「没反应」
  } else {
    showImportError(fail);
  }
}

/* 导入失败时不能不吭声 —— 给一条常驻的可见提示，而不是一闪而过的 toast */
function showImportError(fail) {
  const box = $('#ioError');
  if (!box) { toast('导入失败', 3000); return; }
  const why = fail.map(x => `<b>${esc(x.name)}</b>：${esc(x.why)}`).join('<br>');
  box.innerHTML = `
    <b>没能导入这个文件</b>
    <span>${why}</span>
    <span>${storageBroken() ? '另外：' + esc(store.reason) + '。' : ''}本阅读器支持 PDF、Word（.docx）、图片和 TXT 四种格式。</span>
    <span>${store.embedded ? '你现在是在对话面板里打开的本页，建议复制下面的网址，用浏览器单独打开再试。' : ''}</span>
    <button class="mini-btn" id="ioCopy">复制网址</button>`;
  box.hidden = false;
  $('#ioCopy')?.addEventListener('click', copyUrl);
}

async function copyUrl() {
  try { await navigator.clipboard.writeText(location.href); toast('网址已复制，粘贴到浏览器打开即可'); }
  catch { toast('复制失败，请手动复制地址栏网址', 3000); }
}

/* ═══════════ 阅读器 ═══════════ */
const R = {
  pdf: null, doc: null, mode: 'pdf', pages: [], cur: 1, rendered: new Map(),
  obs: null, txtRoot: null, saveTimer: null, opening: false, openToken: 0,
  layerEmpty: 0, textStats: null, imgUrl: null, imgEl: null,
  ocr: { enabled: false, pages: new Map(), running: new Map(), warned: false }
};

function teardownAll() {
  inkDetachAll();
  speechStop();
  if (R.obs) { R.obs.disconnect(); R.obs = null; }
  if (R.pdf) { try { R.pdf.destroy(); } catch { } }
  if (R.imgUrl) { try { URL.revokeObjectURL(R.imgUrl); } catch { } }
  R.imgUrl = null; R.imgEl = null;
  R.pdf = null; R.rendered.clear(); R.pages = []; R.txtRoot = null;
  R.layerEmpty = 0; R.textStats = null;
  R.ocr.enabled = false; R.ocr.pages.clear(); R.ocr.running.clear();
  const w = $('#pdfWarn'); if (w) w.hidden = true;
  $('#pages').innerHTML = '';
}

/* 抽样算 CJK 字符占比 —— 判断一份文档是不是中文。
   本阅读器是英文阅读器：中文文档点词没意义，翻译成中文更是原地打转。 */
function cjkRatio(text, max = 3000) {
  const s = String(text || '').slice(0, max);
  if (!s.length) return 0;
  const cjk = (s.match(/[一-鿿　-〿]/g) || []).length;
  return cjk / s.length;
}

async function openDoc(id) {
  const meta = docs.find(d => d.id === id);
  if (!meta) return;
  if (R.opening) return;                 // 防重入：重复打开会把页面渲染两遍
  R.opening = true;
  const token = ++R.openToken;
  blocker(true, '正在打开…');
  try {
    teardownAll();
    R.doc = meta;
    inkOpenDoc(meta.id);
    speechSetMode(meta.type === 'pdf' ? 'pdf' : 'txt');
    const data = await blobGet(id);
    if (data == null) {
      blocker(false);
      const box = $('#ioError');
      if (box) {
        box.innerHTML = `<b>读不到这个文档的内容</b>
          <span>它没有被成功存下来${storageBroken() ? '：' + esc(store.reason) : ''}。</span>
          <span>请重新导入一次${store.embedded ? '，并建议复制下面的网址用浏览器单独打开' : ''}。</span>
          <button class="mini-btn" id="ioCopy">复制网址</button>`;
        box.hidden = false;
        $('#ioCopy')?.addEventListener('click', copyUrl);
      } else toast('文件已丢失，请重新导入');
      return;
    }

    $('#docName').textContent = meta.name;
    $('#library').classList.remove('active');
    $('#reader').classList.add('active');
    const host = $('#pages'); host.innerHTML = '';
    const sc = $('#readerScroll'); sc.scrollTop = 0;
    applyCssZoom();                                     // 恢复上次设置的缩放档位

    /* ── 图片 ──
       当「单页扫描件」处理：显示出来 → 直接 OCR → 之后点词、朗读、翻译全走扫描件那套。 */
    if (meta.type === 'image') {
      R.mode = 'image';
      R.ocr.enabled = true;
      speechSetMode('pdf');                // 复用：先试文字层（没有）→ 自动落到 OCR 段落
      const bytes = data instanceof ArrayBuffer ? data : (data.buffer || new Uint8Array(data));
      const url = URL.createObjectURL(new Blob([bytes], { type: meta.mime || '' }));
      R.imgUrl = url;

      const ph = document.createElement('div');
      ph.className = 'pdf-page img-page';
      ph.dataset.page = 1;
      const img = document.createElement('img');
      img.className = 'page-img';
      img.src = url;
      ph.appendChild(img);
      host.appendChild(ph);
      R.pages.push(ph);

      const loaded = await new Promise(res => {
        if (img.complete && img.naturalWidth) return res(true);
        img.onload = () => res(true);
        img.onerror = () => res(false);
        setTimeout(() => res(!!img.naturalWidth), 8000);
      });
      if (!loaded) {
        blocker(false);
        R.imgEl = null;
        toast('这张图片浏览器打不开（可能是 HEIC 等特殊格式）。在相册里截图或导出成 JPG / PNG 再导入', 4200);
        return;
      }
      R.imgEl = img;
      $('#pager').textContent = '图片';
      inkAttach(ph, 1);

      blocker(true, '正在识别图片里的文字…');
      const res = await ensureOcr(1);
      blocker(false);
      toast(res && res.words.length
        ? `识别到 ${res.words.length} 个单词，点任意单词即可查词`
        : '这张图里没识别出英文单词（字太小、太糊，或整张没有英文）', 3400);
      return;
    }

    /* ── 纯文本 ── */
    if (meta.type === 'txt') {
      R.mode = 'txt';
      const wrap = document.createElement('div');
      wrap.className = 'txt-wrap';
      const body = document.createElement('div'); body.className = 'txt-body';
      const hl = document.createElement('div'); hl.className = 'hl-layer';
      for (const p of String(data).split(/\n{2,}/)) if (p.trim()) {
        const el = document.createElement('p'); el.textContent = p.trim(); body.appendChild(el);
      }
      wrap.append(body, hl); host.appendChild(wrap);
      if (cjkRatio(data) > 0.5) toast('这份文档主要是中文——本阅读器为英文阅读设计，点词和翻译成中文都不会有结果', 5200);
      $('#pager').textContent = '文本';
      inkAttach(wrap, 'txt');
      attachParaSpeakers(body, null);      // 每段一个朗读小喇叭
      paintMarks(wrap);
      attachIO();
      setTimeout(() => { sc.scrollTop = (meta.scrollRatio || 0) * Math.max(0, sc.scrollHeight - sc.clientHeight); }, 80);
      blocker(false);
      return;
    }

    /* ── PDF ── */
    R.mode = 'pdf';
    const buf = data instanceof ArrayBuffer ? data : (data.buffer || await data.arrayBuffer());
    R.pdf = await pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
    const n = R.pdf.numPages;
    meta.pages = n; stSet(K_DOCS, docs);

    /* 先探一下这份 PDF 到底有没有「可点的文字」——
       扫描件整页是图片，点词永远不会响应，与其让用户干瞪眼，不如直接说清楚 */
    R.layerEmpty = 0;
    R.textStats = await probeText(R.pdf);
    showPdfWarning(R.textStats);

    const first = await R.pdf.getPage(1);
    const vp0 = first.getViewport({ scale: 1 });
    const ar0 = String(vp0.width / vp0.height);
    for (let i = 1; i <= n; i++) {
      const ph = document.createElement('div');
      ph.className = 'pdf-page rendering';
      ph.dataset.page = i;
      ph.style.width = '100%';
      ph.style.aspectRatio = ar0;
      const no = document.createElement('div'); no.className = 'page-no'; no.textContent = i;
      ph.appendChild(no);
      host.appendChild(ph);
      R.pages.push(ph);
    }
    attachIO();
    hydrateSizes();
    const target = R.pages[Math.min(Math.max(meta.lastPage || 1, 1), n) - 1];
    setTimeout(() => { if (target) sc.scrollTop = Math.max(0, target.offsetTop - 6); }, 140);
    blocker(false);
    toast('点任意单词即可查词', 2600);
  } catch (e) {
    console.error(e); blocker(false);
    toast('打开失败：' + (e.message || e));
  } finally {
    if (token === R.openToken) R.opening = false;
  }
}

/* 抽样探测 PDF 的文字内容：区分「有文字层」和「整页是图片的扫描件」 */
async function probeText(pdf, maxPages = 3) {
  const n = Math.min(pdf.numPages || 1, maxPages);
  const st = { items: 0, latin: 0, cjk: 0 };
  for (let i = 1; i <= n; i++) {
    let tc = null;
    try { tc = await (await pdf.getPage(i)).getTextContent(); } catch { continue; }
    for (const it of (tc.items || [])) {
      const s = String(it.str || '');
      if (!s) continue;
      st.items++;
      st.latin += (s.match(/[A-Za-z\u00C0-\u024F]/g) || []).length;
      st.cjk += (s.match(/[\u4e00-\u9fff]/g) || []).length;
    }
  }
  return st;
}

function showPdfWarning(st) {
  const bar = $('#pdfWarn');
  if (!bar || !st) return;
  let title = '', body = '';
  if (st.latin === 0 && st.cjk === 0) {
    /* 扫描件 —— 自动开启 OCR，让点词照样能用 */
    R.ocr.enabled = true;
    title = '这是扫描件（整页是图片），已自动开启 OCR 识别';
    body = '直接点页面上的英文单词即可。每页第一次点会现场识别几秒'
      + '（第一次使用会下载约 5MB 识别模型，只下一次），识别后会存在本机；'
      + '之后同一页秒出，同一份文件下次打开也不用再识别。识别全在本机进行，文档不外传。';
  } else if (st.latin === 0) {
    title = '这份 PDF 里只有中文，没有英文单词';
    body = '点词查的是英文单词，纯中文内容点了不会有反应。';
  } else if (st.latin < 40) {
    title = '这份 PDF 里真正的英文文字很少，可能大部分是扫描图片';
    body = '只有真正是「文字」的部分能直接点；图片上的字点不动。如果整篇都点不动，可以告诉我，我给它开 OCR。';
  } else {
    return;                    // 正常，不打扰
  }
  $('#pdfWarnTitle').textContent = title;
  $('#pdfWarnBody').textContent = body;
  bar.hidden = false;
}

/* ═══════════ 扫描件 OCR 点词 ═══════════ */

/* tesseract 各阶段的状态 → 中文。
   第一次用扫描件或图片时，光「下载识别模型」就要几 MB；
   不把这句话说出来，用户只会看到转圈，以为卡死了。 */
const OCR_STAGE = {
  'loading tesseract core': '正在加载识别引擎',
  'initializing tesseract': '正在初始化识别引擎',
  'loading language traineddata': '正在下载英文识别模型（第一次会慢一些）',
  'initializing api': '正在启动识别引擎',
  'recognizing text': '正在识别文字',
};

/* 图片 → canvas：太小的放大（OCR 认不清小字），太大的压一压（省时间省内存）。
   大小按「最长边落在 1200~2000」来定。 */
async function imageToCanvas() {
  const img = R.imgEl;
  if (!img || !img.naturalWidth) throw new Error('图片还没加载好');
  const nw = img.naturalWidth, nh = img.naturalHeight;
  /* 小字是 OCR 的头号杀手：拍屏、截图出来的正文常常只有十几像素高，
     放大一档识别率明显更好；大图仍然压到 2400 以内省时间。 */
  const target = Math.min(2400, Math.max(1500, Math.max(nw, nh)));
  const scale = target / Math.max(nw, nh);
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(nw * scale));
  cv.height = Math.max(1, Math.round(nh * scale));
  const ctx = cv.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(img, 0, 0, cv.width, cv.height);
  return { canvas: cv, dpi: 96 };
}

/* 给 OCR 单独渲染一张高分辨率图（比屏幕上的更清晰，识别更准） */
async function renderForOcr(num) {
  const page = await R.pdf.getPage(num);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(1700 / base.width, 3);
  const vp = page.getViewport({ scale });
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(vp.width));
  cv.height = Math.max(1, Math.round(vp.height));
  const ctx = cv.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const dpi = cv.width / (base.width / 72);       // 真实像素密度，交给 tesseract
  return { canvas: cv, dpi };
}

/* OCR 只有英文模型：中文页/花照片会被硬看成乱码英文。识别完立刻体检，
   可疑就明确告知，别让乱码悄悄流进点词和全文翻译。每份文档只提醒一次。 */
function checkOcrQuality(res, num, quiet) {
  if (!res || quiet || R.ocr.warned) return;
  const q = ocrQuality(res.words, res.paras);
  res.q = q;                                  // 给全文翻译用来跳过烂页
  if (!q.ok && res.words.length) {
    R.ocr.warned = true;
    toast(`第 ${num} 页识别出来不太像英文（可能是中文文档，或图片太花），点词和翻译结果会不可靠`, 5200);
  }
}

async function ensureOcr(num, quiet) {
  if (R.ocr.pages.has(num)) return R.ocr.pages.get(num);
  if (R.ocr.running.has(num)) return R.ocr.running.get(num);

  const job = (async () => {
    const key = 'ocr:' + R.doc.id + ':' + num;

    /* ① 先看本机有没有存过 —— 存过就直接用，这是「同一份文件第二次打开秒出」的关键 */
    const cached = await blobGet(key).catch(() => null);
    if (cached && cached.words) {
      R.ocr.pages.set(num, cached);
      checkOcrQuality(cached, num, quiet);
      if (!quiet) toast('这一页用本机缓存，秒出', 1600);
      return cached;
    }

    /* ② 没存过才真的识别 */
    const isImg = R.mode === 'image';
    if (!quiet) blocker(true, isImg ? '正在识别图片里的文字…' : `正在识别第 ${num} 页…`);
    try {
      const { canvas, dpi } = R.mode === 'image'
        ? await imageToCanvas()
        : await renderForOcr(num);
      const res = await ocrImage(canvas, m => {
        if (quiet || !m || !m.status) return;
        const stage = OCR_STAGE[m.status];
        if (!stage) return;
        const pct = (typeof m.progress === 'number' && m.progress > 0)
          ? ` ${Math.round(m.progress * 100)}%` : '';
        const tail = m.status === 'recognizing text' ? (isImg ? '…' : `（第 ${num} 页）…`) : '…';
        blocker(true, stage + tail + pct);
      }, dpi);
      R.ocr.pages.set(num, res);
      checkOcrQuality(res, num, quiet);
      blobPut(key, res).catch(() => { });          // 存起来，下次不用再算
      if (!res.words.length && !quiet) toast(isImg ? '这张图里没识别出英文单词' : '这一页没识别出英文单词，可能字太小或整页是图', 3200);
      return res;
    } catch (e) {
      console.error('ocr', e);
      if (!quiet) {
        const bar = $('#pdfWarn');
        if (bar) {
          $('#pdfWarnTitle').textContent = 'OCR 识别没有成功';
          $('#pdfWarnBody').textContent = '第一次使用 OCR 需要联网下载识别模型（约 5MB）。'
            + '请确认网络正常后，重新点一次页面上的词。' + (e && e.message ? '（' + e.message + '）' : '');
          bar.hidden = false;
        }
      }
      return null;
    } finally {
      if (!quiet) blocker(false);
      R.ocr.running.delete(num);
    }
  })();

  R.ocr.running.set(num, job);
  return job;
}

/* ── 后台预识别：翻到哪页就悄悄把哪页识别掉，用户点的时候就是秒出 ── */
let ocrQueue = [], ocrPumping = false;
function queueOcr(num) {
  if (!R.ocr.enabled || !R.pdf) return;
  if (R.ocr.pages.has(num) || R.ocr.running.has(num) || ocrQueue.includes(num)) return;
  ocrQueue.push(num);
  pumpOcrQueue();
}
async function pumpOcrQueue() {
  if (ocrPumping) return;
  ocrPumping = true;
  try {
    while (ocrQueue.length) {
      const num = ocrQueue.shift();
      if (!R.pdf || !R.ocr.enabled) break;
      if (Math.abs(num - R.cur) > 2) continue;          // 用户已经翻过去了，别浪费算力
      if (R.ocr.pages.has(num) || R.ocr.running.has(num)) continue;
      await ensureOcr(num, true).catch(() => { });      // quiet：不弹遮罩、不弹提示
      await new Promise(r => setTimeout(r, 120));       // 让出主线程，别卡住滑动
    }
  } finally { ocrPumping = false; }
}

function paintOcrHighlight(pageEl, w, kx, ky) {
  let hl = pageEl.querySelector('.hl-layer');
  if (!hl) { hl = document.createElement('div'); hl.className = 'hl-layer'; pageEl.appendChild(hl); }
  clearHighlight(hlHost);
  const d = document.createElement('div');
  d.className = 'hl-rect';
  d.style.cssText = `left:${w.x0 / kx}px;top:${w.y0 / ky}px;`
    + `width:${(w.x1 - w.x0) / kx}px;height:${(w.y1 - w.y0) / ky}px`;
  hl.appendChild(d);
  hlHost = pageEl;
}

async function handleOcrTap(cx, cy, pageEl) {
  const num = Number(pageEl.dataset.page);
  if (!num) return;

  /* 先算好坐标比值，识别完页面尺寸也不会变 */
  const rect0 = pageEl.getBoundingClientRect();
  const first = R.ocr.pages.get(num);
  const page = first || await ensureOcr(num);
  if (!page) return;

  const rect = pageEl.getBoundingClientRect();
  const kx = page.width / rect.width;
  const ky = page.height / rect.height;
  const px = (cx - rect.left) * kx;
  const py = (cy - rect.top) * ky;
  const w = hitWord(page, px, py);
  if (!w) { toast('这个位置没识别到单词，换个地方点点', 2600); return; }

  paintOcrHighlight(pageEl, w, kx, ky);
  const para = page.paras[w.para] || { text: '' };
  openWord(w.text, { sentence: sentenceIn(para.text, w.ce) });
}


async function hydrateSizes() {  const n = R.pdf.numPages;
  for (let i = 2; i <= n; i++) {
    if (!R.pdf || R.mode !== 'pdf') return;
    try {
      const p = await R.pdf.getPage(i);
      const vp = p.getViewport({ scale: 1 });
      const ph = R.pages[i - 1];
      if (ph && ph.dataset.rendered !== '1') ph.style.aspectRatio = String(vp.width / vp.height);
    } catch { }
    if (i % 3 === 0) await new Promise(r => setTimeout(r, 0));
  }
}

function attachIO() {
  if (R.obs) { R.obs.disconnect(); R.obs = null; }
  if (R.mode !== 'pdf') return;
  R.obs = new IntersectionObserver(entries => {
    for (const en of entries) if (en.isIntersecting) renderPage(Number(en.target.dataset.page), en.target);
  }, { root: $('#readerScroll'), rootMargin: '1400px 0px' });
  R.pages.forEach(p => R.obs.observe(p));
}

const pageWidth = () => {
  const w = $('#readerScroll').clientWidth;
  const fit = Math.max(280, w - (w > 780 ? 40 : 6));
  // 宽屏上别把页面拉满 —— 1440px 屏上铺满会一屏只看得到三分之一页
  // 注意：这里永远按基准宽度渲染，缩放交给 #pages 上的 CSS zoom（纯视觉放大，不重排）
  return Math.min(fit, 1040);
};

async function renderPage(num, ph) {
  if (R.rendered.has(num) || !R.pdf) return;
  const token = {}; R.rendered.set(num, token);
  try {
    const page = await R.pdf.getPage(num);
    if (R.rendered.get(num) !== token) return;
    const base = page.getViewport({ scale: 1 });
    const cssW = pageWidth();
    const scale = cssW / base.width;
    const vp = page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    ph.style.aspectRatio = 'auto';
    ph.style.width = vp.width + 'px';
    ph.style.height = vp.height + 'px';
    ph.dataset.rendered = '1';

    let cv = ph.querySelector('canvas');
    if (!cv) { cv = document.createElement('canvas'); ph.insertBefore(cv, ph.firstChild); }
    cv.width = Math.max(1, Math.floor(vp.width * dpr));
    cv.height = Math.max(1, Math.floor(vp.height * dpr));
    const ctx = cv.getContext('2d', { alpha: false });
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    if (R.rendered.get(num) !== token) return;

    ph.querySelector('.textLayer')?.remove();
    const tl = document.createElement('div');
    tl.className = 'textLayer';
    tl.style.setProperty('--scale-factor', String(scale));
    ph.appendChild(tl);
    const tc = await page.getTextContent();
    const layer = new pdfjs.TextLayer({ textContentSource: tc, container: tl, viewport: vp });
    await layer.render();
    if (R.rendered.get(num) !== token) { tl.remove(); return; }

    /* 文字层铺出来是空的 —— 说明这个 PDF 的文字编码比较特殊，
       页面看着正常但点不了词，必须让用户知道原因 */
    if (!tl.querySelector('span')) {
      tl.classList.add('empty');          // 让点击穿透到画布（扫描件走 OCR）
      R.layerEmpty = (R.layerEmpty || 0) + 1;
      if (R.layerEmpty === 2 && R.textStats && R.textStats.latin >= 40) {
        const bar = $('#pdfWarn');
        if (bar && bar.hidden) {
          $('#pdfWarnTitle').textContent = '这一页的文字层没能生成，点词会没反应';
          $('#pdfWarnBody').textContent = '这个 PDF 的文字编码比较特殊（部分中文期刊导出的 PDF 会这样），当前浏览器没能把它铺成可点的文字。阅读本身不受影响。';
          bar.hidden = false;
        }
      }
    }

    if (!ph.querySelector('.hl-layer')) { const hl = document.createElement('div'); hl.className = 'hl-layer'; ph.appendChild(hl); }
    ph.classList.remove('rendering');
    /* 页面刚渲染出来：装上涂写层，并把这篇文档在这页上的高亮重画一遍 */
    inkAttach(ph, num);
    paintMarks(ph);
    token.done = true;
  } catch (e) {
    if (e && e.name !== 'RenderingCancelledException') console.warn('render page', num, e);
    ph.classList.remove('rendering');
    ph.dataset.rendered = '';
    R.rendered.delete(num);
  }
}

function prunePages(center) {
  if (R.mode !== 'pdf') return;
  if (speechOn()) return;                  // 正在朗读：别把还没读到的页面回收掉
  for (const [num, tok] of [...R.rendered]) {
    if (Math.abs(num - center) <= 6 || !tok.done) continue;
    const ph = R.pages[num - 1]; if (!ph) continue;
    ph.querySelector('canvas')?.remove();
    ph.querySelector('.textLayer')?.remove();
    ph.querySelector('.hl-layer')?.remove();
    ph.classList.add('rendering');
    ph.dataset.rendered = '';
    R.rendered.delete(num);
  }
}

/* ── 滚动 → 页码 / 进度 ── */
function currentPageIndex() {
  if (R.mode !== 'pdf' || !R.pages.length) return 1;
  const top = $('#readerScroll').scrollTop + 6;
  for (let i = 0; i < R.pages.length; i++) {
    if (R.pages[i].offsetTop + R.pages[i].offsetHeight * 0.35 > top) return i + 1;
  }
  return R.pages.length;
}

let scrollTick = null;
$('#readerScroll').addEventListener('scroll', () => {
  if (!R.doc || scrollTick) return;
  scrollTick = requestAnimationFrame(() => {
    scrollTick = null;
    const sc = $('#readerScroll'), top = sc.scrollTop;
    if (R.mode === 'pdf' && R.pages.length) {
      const idx = currentPageIndex();
      R.cur = idx;
      $('#pager').textContent = `${idx} / ${R.pages.length}`;
      $('#progressBar').style.width = (R.pages.length > 1 ? ((idx - 1) / (R.pages.length - 1)) * 100 : 0) + '%';
      if (idx % 4 === 0) prunePages(idx);
      queueOcr(idx);                       // 扫描件：后台把当前页识别掉
    } else {
      $('#progressBar').style.width = (top / Math.max(1, sc.scrollHeight - sc.clientHeight) * 100) + '%';
    }
    clearTimeout(R.saveTimer);
    R.saveTimer = setTimeout(persistProgress, 420);
  });
}, { passive: true });

function persistProgress() {
  if (!R.doc) return;
  const d = docs.find(x => x.id === R.doc.id); if (!d) return;
  const sc = $('#readerScroll');
  if (R.mode === 'pdf' && R.pages.length) {
    R.cur = currentPageIndex();          // 不复用可能过期的 R.cur
    d.lastPage = R.cur;
    d.progress = R.pages.length > 1 ? (R.cur - 1) / (R.pages.length - 1) : 0;
  } else {
    d.scrollRatio = sc.scrollTop / Math.max(1, sc.scrollHeight - sc.clientHeight);
    d.progress = d.scrollRatio;
  }
  d.opened = Date.now();
  stSet(K_DOCS, docs);
}

/* ═══════════ 取词 ═══════════ */
const WORD_RE = /[A-Za-z\u00C0-\u024F]/;
const CONN_RE = /['\u2019\-]/;
const isWC = c => !!c && (WORD_RE.test(c) || CONN_RE.test(c));

function caretAt(x, y) {
  let node = null, off = 0;
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (r) { node = r.startContainer; off = r.startOffset; }
  } else if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (p) { node = p.offsetNode; off = p.offset; }
  }
  if (!node) return null;
  if (node.nodeType === 1) {
    const kid = node.childNodes[off] || node.childNodes[off - 1];
    if (kid && kid.nodeType === 3) { const wasNext = node.childNodes[off] === kid; node = kid; off = wasNext ? 0 : node.data.length; }
    else return null;
  }
  return node.nodeType === 3 ? { node, off } : null;
}
const firstText = el => { for (const n of el.childNodes) { if (n.nodeType === 3) return n; if (n.nodeType === 1) { const t = firstText(n); if (t) return t; } } return null; };
const lastText = el => { for (let i = el.childNodes.length - 1; i >= 0; i--) { const n = el.childNodes[i]; if (n.nodeType === 3) return n; if (n.nodeType === 1) { const t = lastText(n); if (t) return t; } } return null; };

/* 判断两个文本节点是否在同一视觉行内 —— 防止把上一行行尾和下一行行首粘成一个词 */
function nodeRect(n) {
  const el = n.parentElement;
  if (el && el !== document.body && el !== document.documentElement) {
    const r = el.getBoundingClientRect();
    if (r.height > 0) return r;
  }
  const r = document.createRange();
  try { r.selectNodeContents(n); return r.getBoundingClientRect(); } catch { return null; }
}
function sameLine(a, b) {
  const ra = nodeRect(a), rb = nodeRect(b);
  if (!ra || !rb || !ra.height || !rb.height) return true;
  const h = Math.max(ra.height, rb.height);
  if (Math.abs((ra.top + ra.height / 2) - (rb.top + rb.height / 2)) > h * 0.55) return false;
  const gap = ra.left <= rb.left ? rb.left - ra.right : ra.left - rb.right;
  return gap <= h * 1.1;
}
function stepNode(node, dir) {
  let p = node;
  while (p) {
    let s = dir > 0 ? p.nextSibling : p.previousSibling;
    while (s) {
      if (s.nodeType === 3) return s;
      if (s.nodeType === 1) { const t = dir > 0 ? firstText(s) : lastText(s); if (t) return t; }
      s = dir > 0 ? s.nextSibling : s.previousSibling;
    }
    p = p.parentNode;
    if (!p || p.tagName === 'BODY' || p.classList?.contains('textLayer') || p.classList?.contains('txt-body')) return null;
  }
  return null;
}

function wordAtPoint(x, y, root) {
  const hit = caretAt(x, y);
  if (!hit || !root.contains(hit.node)) return null;
  const node = hit.node, d = node.data;
  let s = hit.off, e = hit.off;
  if (s > 0 && isWC(d[s - 1])) s--;
  else if (isWC(d[e])) e++;
  else return null;
  while (s > 0 && isWC(d[s - 1])) s--;
  while (e < d.length && isWC(d[e])) e++;
  if (s === e) return null;

  let startNode = node, startOff = s, endNode = node, endOff = e;
  let guard = 0;
  while (startOff === 0 && guard++ < 8) {
    const prev = stepNode(startNode, -1);
    if (!prev || !prev.data || !isWC(prev.data[prev.data.length - 1])) break;
    if (!sameLine(startNode, prev)) break;
    let k = prev.data.length;
    while (k > 0 && isWC(prev.data[k - 1])) k--;
    startNode = prev; startOff = k;
    if (k > 0) break;
  }
  guard = 0;
  while (endOff === endNode.data.length && guard++ < 8) {
    const nx = stepNode(endNode, 1);
    if (!nx || !nx.data || !isWC(nx.data[0])) break;
    if (!sameLine(endNode, nx)) break;
    let k = 0;
    while (k < nx.data.length && isWC(nx.data[k])) k++;
    endNode = nx; endOff = k;
    if (k < nx.data.length) break;
  }

  const range = document.createRange();
  try { range.setStart(startNode, startOff); range.setEnd(endNode, endOff); } catch { return null; }
  let raw = range.toString().replace(/[\u2018\u2019]/g, "'");
  if (!/[A-Za-z]/.test(raw)) return null;
  return { raw, range, startNode, startOff, endNode, endOff, endsSpan: endOff === endNode.data.length };
}

/** 跨行断词还原：analy- / sis → analysis */
function healHyphen(info) {
  if (!info.raw.endsWith('-') || !info.endsSpan) return info;
  const nx = stepNode(info.endNode, 1);
  if (!nx || !nx.data) return info;
  const m = /^[A-Za-z]{2,}/.exec(nx.data);
  if (!m) return info;
  const joined = info.raw.slice(0, -1) + m[0];
  if (!lookupOffline(joined)) return info;
  const r = document.createRange();
  try { r.setStart(info.startNode, info.startOff); r.setEnd(nx, m[0].length); } catch { return info; }
  return Object.assign({}, info, { raw: joined, range: r, endNode: nx, endOff: m[0].length, healed: true });
}
/* 高亮 */
let hlHost = null;
function clearHighlight(host) {
  (host || hlHost)?.querySelectorAll('.hl-rect').forEach(e => e.remove());
  if (!host || host === hlHost) hlHost = null;
}
function paintHighlight(range, hostEl) {
  clearHighlight(hlHost);
  const hl = hostEl?.querySelector('.hl-layer');
  if (!hl) return;
  const base = hostEl.getBoundingClientRect();
  for (const r of [...range.getClientRects()].slice(0, 4)) {
    if (r.width < 0.6 || r.height < 1) continue;
    const d = document.createElement('div');
    d.className = 'hl-rect';
    d.style.cssText = `left:${r.left - base.left}px;top:${r.top - base.top}px;width:${r.width}px;height:${r.height}px`;
    hl.appendChild(d);
  }
  hlHost = hostEl;
}

/* 取整句（限定搜索范围，避免把整页当成一句） */
const NOISE_RE = /^(page\s*)?\d+(\s*(of|\/|-)\s*\d+)?[.\s]*$/i;
const isNoiseNode = s => !s.trim() || NOISE_RE.test(s) || /^[\s\-–—.,·•|]+$/.test(s);

function sentenceAround(info, container) {
  const marks = []; let text = '';
  const walk = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walk.nextNode())) {
    if (isNoiseNode(n.data)) continue;                       // 跳过页码、页脚标记等噪音
    if (text && !/[\s\-–—/(]$/.test(text) && !/^[\s,.;:!?%)\]}]/.test(n.data)) text += ' ';
    marks.push({ node: n, start: text.length });
    text += n.data;
  }
  const mi = marks.findIndex(m => m.node === info.endNode);
  if (mi < 0) return '';
  return sentenceIn(text, marks[mi].start + info.endOff);
}

/** 从一段纯文本里，取 pos 位置所属的那一句（文字层模式和 OCR 模式共用） */
function sentenceIn(text, pos) {
  const B = 300, F = 380;
  /* 两个判定必须锚定（$/^）。否则正则在窗口中间就命中，
     句子两端会各被吃掉一两个字符：Materiality → ateriality、error. → erro。 */
  const END_RE = /[.!?]["')\]]?\s$/;
  const START_RE = /^[.!?]["')\]]?(?:\s|$)/;

  let a = pos;
  const lo = Math.max(0, pos - B);
  while (a > lo && !END_RE.test(text.slice(Math.max(0, a - 4), a))) a--;
  const hitStart = a > lo;

  let b = pos;
  const hi = Math.min(text.length, pos + F);
  while (b < hi && !START_RE.test(text.slice(b, b + 4))) b++;
  const hitEnd = b < hi;
  if (b < hi) b = Math.min(text.length, b + 1);

  let raw = text.slice(a, b);
  const rel = pos - a;

  // 两侧都没找到句末标点 → 不是可识别的句子，退化成词附近的小窗口
  if (!hitStart && !hitEnd) {
    const s0 = Math.max(0, rel - 130), e0 = Math.min(raw.length, rel + 150);
    let frag = raw.slice(s0, e0);
    if (s0 > 0) frag = frag.replace(/^\S+\s*/, '');
    if (e0 < raw.length) frag = frag.replace(/\s*\S+$/, '');
    raw = frag;
  }

  let out = raw.replace(/\s+/g, ' ').trim().replace(/^["'(\[\-–—\s]+/, '');
  if (out.length < 6) return '';
  if (out.length > 400) {
    const cut = out.slice(0, 400);
    const k = Math.max(cut.lastIndexOf('; '), cut.lastIndexOf(', '), cut.lastIndexOf(' '));
    out = (k > 180 ? cut.slice(0, k) : cut).trim();
  }
  return out;
}

/* ═══════════ 查词卡片 ═══════════ */
const wc = $('#wordCard');
let curWord = null, curCtx = null, curData = null, onlineFull = new Map(), lastAudio = '';
const showCard = () => wc.classList.add('open');
function hideCard() { wc.classList.remove('open'); curWord = null; curCtx = null; curData = null; clearHighlight(); }
/* 收藏比对统一按小写来：句首的 "Materiality" 和句中的 "materiality" 是同一个词，
   不然生词本里会躺着两条一样的。存的时候保留原样，看着舒服。 */
const wKey = w => String(w || '').trim().toLowerCase();
const isStarred = w => vocab.some(v => wKey(v.w) === wKey(w));

/* 从中文释义开头抽出词性标签，如 "n. …" / "vt. …" */
const POS_RE = /^(n|vt|vi|v|a|adj|adv|ad|prep|conj|pron|num|art|int|aux|abbr|pl)\.\s?/;
function posOf(cn) {
  const m = POS_RE.exec(String(cn || '').trim());
  if (!m) return '';
  const raw = m[1];
  const map = { a: 'adj.', ad: 'adv.', pl: 'n.(复数)' };
  return map[raw] || raw + '.';
}
const stripPos = cn => String(cn || '').replace(POS_RE, '');

/* 变形词点进来只看到「spill的过去式和过去分词」，等于没说意思。
   原形词条的释义既然查得到，就直接列在下面，不用再让他点一次原形。 */
function formRow(off) {
  const b = off && off.base;
  if (!b) return '';
  const ipa = b.ipa ? ` <span class="wc-base-ipa">${esc(b.ipa)}</span>` : '';
  return `<div class="wc-base"><span class="wc-base-tag">原形</span><b>${esc(b.word)}</b>${ipa}` +
    `<div class="wc-base-cn">${esc(cn2line(stripPos(b.cn)))}</div></div>`;
}

function setSrc(t) { const b = $('#wcSrc'); b.textContent = t; b.classList.add('show'); }
function loadingRow(msg) { return `<div class="wc-loading"><div class="spinner" style="width:15px;height:15px;border-width:2px"></div>${esc(msg)}</div>`; }

async function openWord(raw, ctx) {
  const w = normalizeWord(raw);
  if (!w || w.length < 2) return;
  curWord = w; curCtx = ctx || null; curData = null; lastAudio = '';

  $('#wcWord').textContent = w;
  $('#wcIpa').textContent = ''; $('#wcPos').textContent = '';
  $('#wcSrc').classList.remove('show');
  $('#wcBody').innerHTML = loadingRow('查询中…');
  $('#wcMore').style.display = 'none';
  $('#wcSentence').style.display = ctx && ctx.sentence ? '' : 'none';
  syncStar(); showCard();

  const off = offlineLoaded() ? lookupOffline(w) : null;
  if (off) {
    const ipa = off.ipa || (off.base && off.base.ipa) || '';   // 变形条目常没音标，用原形的顶上
    curData = { w, ipa, cn: off.cn || '', lemma: off.lemma || '', base: off.base || null };
    $('#wcIpa').textContent = ipa;
    const p = posOf(off.cn);
    if (p) $('#wcPos').textContent = p;
    else if (off.stemmed) $('#wcPos').textContent = `原形 ${off.lemma}`;
    $('#wcBody').innerHTML = `<div class="wc-cn">${esc(cn2line(stripPos(off.cn)))}</div>` + formRow(off);
    setSrc('内置词典');
    if (settings.autoStar) autoStar();
  }

  const online = await lookupOnline(w).catch(() => null);
  if (curWord !== w) return;

  if (online) {
    onlineFull.set(w, online);
    if (online.ipa) $('#wcIpa').textContent = online.ipa;
    if (online.audio) lastAudio = online.audio;
    if (!$('#wcPos').textContent && online.meanings[0]?.pos) $('#wcPos').textContent = online.meanings[0].pos;
    const cn = curData?.cn || '';
    const base = curData?.base || null;            // 在线分支会重建正文，原形那段要一起带过来
    curData = { w, ipa: $('#wcIpa').textContent, cn, audio: online.audio || '', base };
    let h = cn ? `<div class="wc-cn">${esc(cn2line(stripPos(cn)))}</div>` : '';
    h += formRow({ base });
    if (online.lemma && online.lemma !== w && !cn) h += `<p class="muted" style="margin-top:4px">原形：${esc(online.lemma)}</p>`;
    const total = online.meanings.reduce((a, m) => a + m.defs.length, 0);
    for (const g of online.meanings.slice(0, 2)) {
      h += `<div class="wc-group"><h4>${esc(g.pos || '释义')}</h4>`;
      for (const d of g.defs.slice(0, 2)) {
        h += `<p class="wc-def">${esc(d.def)}</p>`;
        if (d.example) h += `<p class="wc-ex">${esc(d.example)}</p>`;
      }
      h += '</div>';
    }
    $('#wcBody').innerHTML = h;
    setSrc(online.source === 'wiktionary' ? 'Wiktionary' : '在线词典');
    $('#wcMore').style.display = total > 2 ? '' : 'none';
  } else if (!off) {
    const sug = offlineLoaded() ? suggestOffline(w) : [];
    $('#wcBody').innerHTML =
      `<div class="wc-cn" style="font-size:15px;color:var(--dim)">没有查到这个词。</div>` +
      (sug.length ? `<div class="wc-group"><h4>你是不是想查</h4>${sug.map(s => `<p class="wc-def"><b class="sug" data-w="${esc(s.word)}">${esc(s.word)}</b> ${esc(cn2line(s.cn).slice(0, 36))}</p>`).join('')}</div>` : '') +
      `<p class="muted" style="margin-top:8px">可能是人名、专有名词或生僻变形。</p>`;
    $('#wcBody').querySelectorAll('.sug').forEach(b => b.addEventListener('click', () => openWord(b.dataset.w, ctx)));
    setSrc('未找到');
    if (!navigator.onLine) toast('当前离线，正在使用内置词典');
  } else if (settings.autoStar) {
    autoStar();
  }
  syncStar();
}

function autoStar() {
  if (!curData || !curData.w) return;
  if (isStarred(curData.w)) return;
  vocab.unshift({ w: curData.w, ipa: curData.ipa || '', cn: cn2line(curData.cn), doc: R.doc?.name || '', t: Date.now() });
  stSet(K_VOCAB, vocab);
}

function syncStar() {
  const on = curWord && isStarred(curWord);
  const b = $('#wcStar');
  b.classList.toggle('on', !!on);
  b.textContent = on ? '★' : '☆';
}

function renderAllMeanings(w) {
  const data = onlineFull.get(w); if (!data) return;
  let h = curData?.cn ? `<div class="wc-cn">${esc(cn2line(curData.cn))}</div>` : '';
  for (const g of data.meanings) {
    h += `<div class="wc-group"><h4>${esc(g.pos || '释义')}</h4>`;
    for (const d of g.defs) {
      h += `<p class="wc-def">${esc(d.def)}</p>`;
      if (d.example) h += `<p class="wc-ex">${esc(d.example)}</p>`;
    }
    h += '</div>';
  }
  $('#wcBody').innerHTML = h;
  $('#wcMore').style.display = 'none';
}

/* ═══════════ 发音 ═══════════ */
/* 真人发音的源不稳定：dictionaryapi.dev 的 media 目录从 2026-10 起全站返回 502，
   而代码原先只认它一个来源，源一挂就直接落到本地朗读——听感变差很多。
   改成音源链：① 在线词典给的真人音 ② 上一个成功的真人音 ③ 有道发音 ④ 本地 TTS。
   前三级逐个试，都失败才用本地，同时保证任何一层接住都不会出两次声。 */
let audioEl = null;
function speakSources(w) {
  const list = [];
  const a = curData?.audio;
  if (a) list.push(a);
  if (lastAudio && lastAudio !== a) list.push(lastAudio);
  list.push('https://dict.youdao.com/dictvoice?type=2&audio=' + encodeURIComponent(w));
  return list;
}
function speak() {
  const w = curWord || curData?.w;
  if (!w) return;
  const list = settings.audio ? speakSources(w) : [];
  let i = 0;
  const tryNext = () => {
    if (i >= list.length) { tts(w); return; }      // 音源全挂 → 本地朗读
    const url = list[i++];
    let settled = false, playing = false;
    try {
      audioEl?.pause();
      const el = new Audio();
      audioEl = el;
      el.src = url;
      const giveUp = () => {
        if (settled) return; settled = true;
        try { el.pause(); } catch { }
        tryNext();
      };
      el.addEventListener('error', giveUp);
      el.addEventListener('playing', () => { playing = true; });
      const pr = el.play();
      if (pr && pr.catch) pr.catch(giveUp);
      setTimeout(() => { if (!settled && !playing) giveUp(); }, 2500);
    } catch { giveUp(); }
  };
  tryNext();
}
function tts(w) {
  try {
    if (!window.speechSynthesis) return toast('这台设备不支持朗读');
    const u = new SpeechSynthesisUtterance(w);
    u.lang = 'en-US'; u.rate = 0.92;
    speechSynthesis.resume();            // iOS / 桌面引擎整体假死时先踢醒
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  } catch { }
}
/* Edge / Chrome 标签页挂后台再回来后，第一次 speak 经常静默。
   首次点击页面时先喂一个无声空 utterance 把引擎暖起来。 */
window.addEventListener('pointerdown', () => {
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  } catch { }
}, { once: true });

/* ═══════════ 生词本 ═══════════ */
function toggleStar() {
  if (!curWord) return;
  const i = vocab.findIndex(v => wKey(v.w) === wKey(curWord));
  if (i >= 0) { vocab.splice(i, 1); stSet(K_VOCAB, vocab); toast('已从生词本移除'); }
  else {
    vocab.unshift({ w: curWord, ipa: (curData?.ipa || $('#wcIpa').textContent || ''), cn: cn2line(curData?.cn || $('#wcBody .wc-cn')?.textContent || ''), doc: R.doc?.name || '', t: Date.now() });
    stSet(K_VOCAB, vocab); toast('已加入生词本');
  }
  syncStar(); renderVocab();
}

function renderVocab() {
  const q = $('#vocabSearch').value.trim().toLowerCase();
  const list = q ? vocab.filter(v => v.w.includes(q) || (v.cn || '').toLowerCase().includes(q)) : vocab;
  $('#vocabCount').textContent = vocab.length;
  const box = $('#vocabList');
  box.innerHTML = list.length ? '' : `<div class="empty">${vocab.length ? '没有匹配的词' : '还没有收藏生词。查词时点卡片右上角的 ☆ 即可收藏。'}</div>`;
  for (const v of list) {
    const el = document.createElement('div');
    el.className = 'v-item';
    el.innerHTML = `<div class="v-main">
        <div class="v-word">${esc(v.w)}<span class="v-ipa">${esc(v.ipa || '')}</span></div>
        <div class="v-cn">${esc(cn2line(v.cn))}</div>
        ${v.doc ? `<div class="v-src">来自《${esc(v.doc)}》 · ${fmtDate(v.t)}</div>` : ''}
      </div>
      <div class="v-act"><button class="v-spk" title="发音">🔊</button><button class="v-del" title="删除">✕</button></div>`;
    el.querySelector('.v-spk').addEventListener('click', () => tts(v.w));
    el.querySelector('.v-del').addEventListener('click', () => { vocab = vocab.filter(x => x !== v); stSet(K_VOCAB, vocab); renderVocab(); syncStar(); });
    box.appendChild(el);
  }
}

function download(name, text, mime) {
  const blob = new Blob(['\ufeff' + text], { type: mime || 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
function exportCSV() {
  if (!vocab.length) return toast('生词本是空的');
  const q = s => '"' + String(s == null ? '' : s).replace(/"/g, '""').replace(/\n/g, '；') + '"';
  const rows = [['单词', '音标', '中文释义', '来源', '收藏时间'].join(',')];
  for (const v of vocab) rows.push([q(v.w), q(v.ipa), q(cn2line(v.cn)), q(v.doc), q(new Date(v.t).toLocaleString('zh-CN'))].join(','));
  download('生词本-' + new Date().toISOString().slice(0, 10) + '.csv', rows.join('\r\n'));
  toast('已导出 CSV（在「文件–下载」里）', 2600);
}
function exportAnki() {
  if (!vocab.length) return toast('生词本是空的');
  download('生词本-Anki-' + new Date().toISOString().slice(0, 10) + '.txt',
    vocab.map(v => [v.w, v.ipa || '', cn2line(v.cn), v.doc || ''].join('\t')).join('\n'),
    'text/tab-separated-values;charset=utf-8');
  toast('已导出 Anki（制表符分隔）', 2600);
}

/* ═══════════ 点词交互 ═══════════ */
let tapStart = null;
const scrollEl = $('#readerScroll');

/* 阅读区和全文翻译区共用同一套「点词」手势 */
function attachTapHandlers(el) {
  if (!el) return;
  el.addEventListener('pointerdown', e => { tapStart = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId }; }, true);
  el.addEventListener('pointerup', e => {
    const s = tapStart; tapStart = null;
    if (!s) return;
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > 12 || Date.now() - s.t > 700) return;
    if (e.target.closest('button,a')) return;
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 1) return;
    const x = e.clientX, y = e.clientY, tgt = e.target;
    setTimeout(() => handleTap(x, y, tgt), 0);
  }, true);
  el.addEventListener('pointercancel', () => { tapStart = null; }, true);
  el.addEventListener('click', e => {
    if (e.target.closest('.textLayer') || e.target.closest('.txt-body')) return;
    if (e.target.closest('.pdf-page')) return;      // 页面区域交给点词逻辑，别把刚打开的卡片关掉
    hideCard();
  });
}
attachTapHandlers(scrollEl);
attachTapHandlers($('#transScroll'));

function handleTap(x, y, tgt) {
  if (inkActive()) return;                 // 笔模式下只写不查，别互相打架（笔模式查词走 ink 的轻点回调）
  const tlEl = tgt.closest('.textLayer');
  /* 空文字层是个铺满整页、z-index 更高的 div，它会吃掉点击 ——
     必须要求它真的里面有 span，否则当作不存在。 */
  const tl = tlEl && tlEl.querySelector('span') ? tlEl : null;
  const tb = tgt.closest('.txt-body');
  let root = tl || tb;
  let hostEl = tl ? tl.closest('.pdf-page') : (tb ? tb.parentElement : null);

  if (!root) {
    /* 手指没那么准，或这一页没有文字层：
       只要这页有可点的文字层就按最近的字处理；是扫描件就走 OCR。 */
    const pageEl = tgt.closest('.pdf-page');
    const layer = pageEl && pageEl.querySelector('.textLayer');
    if (layer && layer.querySelector('span')) { root = layer; hostEl = pageEl; }
    else if (pageEl && R.ocr.enabled) { return handleOcrTap(x, y, pageEl); }
    else return;
  }

  const info = wordAtPoint(x, y, root);
  if (!info) return;
  const healed = healHyphen(info);
  const ctx = { sentence: sentenceAround(healed, root) };
  paintHighlight(healed.range, hostEl);
  openWord(healed.raw, ctx);
}

/* 批注模式下「轻点」查词：墨水层把字盖住了，按坐标反查宿主再取词 */
function lookupAtPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  /* 墨水层 canvas 盖在文字层正上方，caretRangeFromPoint 会直接命中画布取不到字。
     取词瞬间把它临时隐身（visibility 不触发重排），取完立刻恢复。 */
  let hidden = null;
  if (el && el.classList && el.classList.contains('ink-layer')) {
    hidden = el; el.style.visibility = 'hidden';
  }
  try {
    const host = el && el.closest ? el.closest('.pdf-page,.txt-wrap,.tpara') : null;
    if (!host) return;
    const tl = host.querySelector('.textLayer');
    /* 译文段落里 .txt-body 就是那段英文；英文被隐藏时退到中文那一段（取不到词也无害） */
    let root = (tl && tl.querySelector('span')) ? tl : host.querySelector('.txt-body');
    if (!root && host.classList.contains('tpara')) root = host.querySelector('.tp-cn');
    if (!root) {
      if (R.ocr.enabled && !host.classList.contains('tpara')) return handleOcrTap(x, y, host);
      return;
    }
    const info = wordAtPoint(x, y, root);
    if (!info) return;
    const healed = healHyphen(info);
    const ctx = { sentence: sentenceAround(healed, root) };
    paintHighlight(healed.range, host);
    openWord(healed.raw, ctx);
  } finally {
    if (hidden) hidden.style.visibility = '';
  }
}

/* 关闭卡片的点击逻辑已并入 attachTapHandlers */

/* 选区翻译浮条 */
const selbar = $('#selBar');
let selText = '', selTimer = null;
document.addEventListener('selectionchange', () => {
  clearTimeout(selTimer);
  selTimer = setTimeout(() => {
    const sel = window.getSelection();
    const t = sel && sel.toString().trim();
    /* 阅读页和全文翻译页都放行：浮条上的「翻译选中 / 复制 / 四色高亮」是通用的 */
    const anch = sel && sel.anchorNode;
    const inText = anch && ($('#reader').contains(anch) || $('#trans').contains(anch));
    if (!t || t.length < 2 || !sel.rangeCount || !inText) { selbar.classList.remove('show'); return; }
    selText = t.slice(0, 1200);
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (!r || (!r.width && !r.height)) { selbar.classList.remove('show'); return; }
    selbar.style.left = Math.min(Math.max(r.left + r.width / 2, 100), window.innerWidth - 100) + 'px';
    selbar.style.top = Math.max(r.top - 8, 64) + 'px';
    selbar.classList.add('show');
  }, 240);
});
$('#selTranslate').addEventListener('click', async () => {
  if (!selText) return;
  selbar.classList.remove('show');
  const t = selText;
  curWord = null; curData = null; curCtx = null; lastAudio = '';
  $('#wcWord').textContent = '整段翻译';
  $('#wcIpa').textContent = ''; $('#wcPos').textContent = '';
  $('#wcSrc').classList.remove('show');
  $('#wcSentence').style.display = 'none'; $('#wcMore').style.display = 'none';
  syncStar(); showCard();
  $('#wcBody').innerHTML = `<p class="wc-ex" style="border-color:var(--line);padding-left:0;color:var(--dim)">${esc(t)}</p><div class="wc-group"><h4>中文</h4>${loadingRow('翻译中…')}</div>`;
  const cn = await translate(t);
  $('#wcBody').innerHTML = `<p class="wc-ex" style="border-color:var(--line);padding-left:0;color:var(--dim)">${esc(t)}</p><div class="wc-group"><h4>中文</h4><div class="wc-cn" style="font-size:15.5px">${esc(cnView(cn) || '翻译失败，请检查网络')}</div></div>`;
});
$('#selCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(selText); toast('已复制'); } catch { toast('复制失败，请长按手动复制'); }
  selbar.classList.remove('show');
});
document.addEventListener('pointerdown', e => {
  if (selbar.classList.contains('show') && !e.target.closest('#selBar')) selbar.classList.remove('show');
}, true);

/* ═══════════ 面板与按钮 ═══════════ */
const openVocab = () => { renderVocab(); $('#vocabPanel').classList.add('open'); };
const closeVocab = () => $('#vocabPanel').classList.remove('open');
$('#btnVocabLib').addEventListener('click', openVocab);
$('#btnVocabReader').addEventListener('click', openVocab);
$('#vocabClose').addEventListener('click', closeVocab);
$('#vocabPanel').addEventListener('click', e => { if (e.target.id === 'vocabPanel') closeVocab(); });
$('#vocabSearch').addEventListener('input', renderVocab);
$('#vocabExportCsv').addEventListener('click', exportCSV);
$('#vocabExportAnki').addEventListener('click', exportAnki);
$('#vocabClear').addEventListener('click', () => {
  if (!vocab.length) return;
  if (confirm(`确定清空全部 ${vocab.length} 个生词？建议先导出备份。`)) { vocab = []; stSet(K_VOCAB, vocab); renderVocab(); syncStar(); }
});

const openSet = () => {
  refreshDictState(); refreshDiag(); refreshOcrState(); refreshInkState(); refreshSpkState();
  const rn = $('#spkRateNow'); if (rn) rn.textContent = Spk.rate.toFixed(1) + '×';
  const em = $('#transEmail'); if (em) em.value = settings.transEmail || '';
  $('#settingsPanel').classList.add('open');
};
$('#transEmail')?.addEventListener('change', e => {
  settings.transEmail = e.target.value.trim();
  stSet(K_SET, settings);
  setTranslateEmail(settings.transEmail);
  toast(settings.transEmail ? '已保存，翻译额度会按这个邮箱计算' : '已清空邮箱', 2600);
});
const closeSet = () => $('#settingsPanel').classList.remove('open');
$('#btnSettings').addEventListener('click', openSet);
$('#btnReaderMenu').addEventListener('click', openSet);
$('#settingsClose').addEventListener('click', closeSet);
$('#settingsPanel').addEventListener('click', e => { if (e.target.id === 'settingsPanel') closeSet(); });
$('#segTheme').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; settings.theme = b.dataset.theme; stSet(K_SET, settings); applyTheme(); });
/* ── 缩放：纯视觉的 CSS zoom，永不重排重绘 ──
   #pages 整体放大缩小（PDF 画布是位图，放大会略糊但响应零延迟；
   纯文本/图片同样生效）。档位 50%–400%，随手势任意取值。 */
function applyCssZoom() {
  const box = $('#pages'); if (!box) return;
  box.style.zoom = String(settings.zoom || 1);
  inkResizeAll();
}

function setZoom(z, quiet) {
  settings.zoom = Math.round(Math.min(4, Math.max(0.5, z)) * 100) / 100;
  stSet(K_SET, settings); applyTheme(); applyCssZoom();
  if (!quiet) toast(`缩放 ${Math.round(settings.zoom * 100)}%`, 1000);
}

$('#segZoom').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const z = Number(b.dataset.zoom); if (z === settings.zoom) return;
  setZoom(z);
});

/* ═══════════ 双指捏合缩放 ═══════════
   三条路按平台择优：
   · iPad Safari  —— gesturestart/change/end 是系统原生捏合，跟手程度最好；
   · 桌面触控板   —— ctrl+滚轮（捏合手势在触控板上就映射成这个）；
   · 其他触屏     —— pointer 事件自己算两指距离。
   手势期间直接改 #pages 的 CSS zoom（所见即所得），松手才落档存档。 */
let gBase = 0;                                          // Safari 捏合的起始倍率

function pinchZoomTo(z) {
  const box = $('#pages'); if (!box) return;
  box.style.zoom = String(Math.min(4, Math.max(0.5, z)));
}
function pinchFinish() {
  const z = parseFloat($('#pages')?.style.zoom) || settings.zoom || 1;
  setZoom(z);
}

/* —— iPad Safari 原生捏合 —— */
document.addEventListener('gesturestart', e => {
  e.preventDefault();                                 // 拦掉系统整页缩放，归我们自己管
  gBase = parseFloat($('#pages')?.style.zoom) || settings.zoom || 1;
  inkCancelStroke();                                  // 捏合优先，进行中的笔画作废
}, { passive: false });
document.addEventListener('gesturechange', e => {
  e.preventDefault();
  if (!gBase) return;
  pinchZoomTo(gBase * (e.scale || 1));
}, { passive: false });
document.addEventListener('gestureend', e => {
  e.preventDefault();
  if (!gBase) return;
  gBase = 0;
  pinchFinish();
}, { passive: false });

/* —— 桌面触控板捏合（ctrl+滚轮）—— */
$('#readerScroll').addEventListener('wheel', e => {
  if (!e.ctrlKey) return;                             // 普通滚轮照常滚动
  e.preventDefault();
  setZoom((settings.zoom || 1) * (e.deltaY < 0 ? 1.09 : 0.92));
}, { passive: false });

/* —— 通用 pointer 双指（非 Safari 的触屏兜底）——
   监听挂在 window 捕获阶段：墨水层在 document 捕获阶段会 stopPropagation，
   挂晚了收不到落在画布上的手指。Safari 原生捏合进行中（gBase 非零）时让路。 */
const pinch = { ptrs: new Map(), base: 0, active: false };
window.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' || gBase) return;
  if (!(e.target.closest && e.target.closest('#readerScroll'))) return;
  pinch.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch.ptrs.size === 2) {
    const [a, b] = [...pinch.ptrs.values()];
    pinch.base = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    pinch.active = true;
    inkCancelStroke();                                // 捏合优先，进行中的笔画作废
  }
}, true);
window.addEventListener('pointermove', e => {
  if (!pinch.ptrs.has(e.pointerId) || gBase) return;  // Safari 原生捏合进行中，让路
  pinch.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch.ptrs.size === 2 && pinch.base) {
    const [a, b] = [...pinch.ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const z0 = parseFloat($('#pages')?.style.zoom) || settings.zoom || 1;
    pinchZoomTo(z0 * (d / pinch.base));
    pinch.base = d;                                   // 每帧以当前距离为基准，增量跟手
    e.preventDefault(); e.stopPropagation();
  }
}, true);
const pinchEnd = e => {
  if (!pinch.ptrs.has(e.pointerId)) return;
  pinch.ptrs.delete(e.pointerId);
  if (pinch.ptrs.size < 2 && pinch.active) {
    pinch.active = false; pinch.base = 0;
    if (!gBase) pinchFinish();                        // 已由 Safari 原生捏合收尾的不再重复
  }
};
window.addEventListener('pointerup', pinchEnd, true);
window.addEventListener('pointercancel', pinchEnd, true);
$('#swAudio').addEventListener('click', () => { settings.audio = !settings.audio; stSet(K_SET, settings); applyTheme(); });
$('#swAutoStar').addEventListener('click', () => { settings.autoStar = !settings.autoStar; stSet(K_SET, settings); applyTheme(); });
$('#segPolish').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  settings.polish = b.dataset.polish; stSet(K_SET, settings); applyTheme(); repaintTrans();
  toast('译文已按「' + b.textContent + '」重排', 1800);
});
$('#swTerms').addEventListener('click', () => {
  settings.terms = !settings.terms; stSet(K_SET, settings); applyTheme(); repaintTrans();
  toast(settings.terms ? '已开启术语纠正' : '已关闭术语纠正', 1800);
});

$('#wcClose').addEventListener('click', hideCard);
$('#wcSpeak').addEventListener('click', speak);
$('#wcStar').addEventListener('click', toggleStar);
$('#wcMore').addEventListener('click', () => { if (curWord) renderAllMeanings(curWord); });
$('#wcSentence').addEventListener('click', async () => {
  if (!curCtx || !curCtx.sentence) return toast('没能定位到整句');
  const sent = curCtx.sentence;
  const box = $('#wcBody');
  box.insertAdjacentHTML('beforeend', `<div class="wc-group" id="sentBox"><h4>整句翻译</h4>${loadingRow('翻译中…')}</div>`);
  $('#sentBox').scrollIntoView({ block: 'nearest' });
  const cn = await translate(sent);
  const el = $('#sentBox'); if (!el) return;
  el.innerHTML = `<h4>整句翻译</h4><p class="wc-ex" style="border-color:var(--line);padding-left:0;color:var(--dim)">${esc(sent)}</p><div class="wc-cn" style="font-size:15.5px">${esc(cnView(cn) || '翻译失败，请检查网络')}</div>`;
});

$('#btnFullTrans').addEventListener('click', openFullTrans);
$('#transBack').addEventListener('click', () => {
  T.stop = true;
  clearHighlight();
  hideCard();
  if (inkActive()) inkSetMode('off');    // 退出译文页时顺手收笔，别把工具条带回阅读页
  unmountTransInk();
  $('#trans').classList.remove('active');
  $('#reader').classList.add('active');
});
$('#segTrans').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  T.mode = b.dataset.mode;
  $('#trans').dataset.mode = T.mode;
  $$('#segTrans button').forEach(x => x.classList.toggle('on', x === b));
});
$('#transWarnClose')?.addEventListener('click', () => { $('#transWarn').hidden = true; });

$('#btnBack').addEventListener('click', () => {
  persistProgress(); hideCard();
  if (inkActive()) inkSetMode('off');
  unmountTransInk();
  speechStop(); inkDetachAll(); inkOpenDoc(null);
  $('#reader').classList.remove('active');
  $('#library').classList.add('active');
  teardownAll(); R.doc = null;
  ocrTerminate();                 // 释放 OCR worker（下次用到会重建）
  renderLibrary();
});

/* 导入由 <label for="fileInput"> 原生触发，这里刻意不写 JS 的 input.click()
   —— iOS Safari 上原生 label 比 JS 调 click() 可靠得多，写两遍会弹两次。 */
$('#fileInput').addEventListener('change', e => {
  const picked = [...e.target.files];
  e.target.value = '';
  if (picked.length) importFiles(picked);
});

$('#btnSample').addEventListener('click', async () => {
  try {
    blocker(true, '正在载入示例…');
    const r = await fetch('sample/sample.pdf');
    if (!r.ok) throw new Error(r.status);
    const blob = await r.blob();
    const f = new File([blob], 'Audit Evidence and Materiality（示例）.pdf', { type: 'application/pdf' });
    await importFiles([f]);          // importFiles 成功后会自己打开，这里不要再调一次
  } catch (e) { console.error(e); blocker(false); toast('示例载入失败，请检查网络'); }
});
document.addEventListener('dragover', e => { e.preventDefault(); $('#importZone')?.classList.add('hot'); });
document.addEventListener('dragleave', e => { if (e.target === document.documentElement) $('#importZone')?.classList.remove('hot'); });
document.addEventListener('drop', e => {
  e.preventDefault(); $('#importZone')?.classList.remove('hot');
  if (e.dataTransfer?.files?.length) { $('#reader').classList.remove('active'); $('#library').classList.add('active'); importFiles(e.dataTransfer.files); }
});

/* 键盘翻页 */
document.addEventListener('keydown', e => {
  if (!$('#reader').classList.contains('active') || R.mode !== 'pdf' || !R.pdf) return;
  if (!/ArrowLeft|ArrowRight|PageUp|PageDown| /.test(e.key)) return;
  const next = /ArrowLeft|PageUp/.test(e.key) ? -1 : 1;
  const i = Math.min(Math.max(R.cur - 1 + next, 0), R.pages.length - 1);
  R.pages[i]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

/* 旋转 / 宽度变化后重排 */
let rzTimer;
window.addEventListener('resize', () => {
  clearTimeout(rzTimer);
  rzTimer = setTimeout(() => {
    if (R.mode !== 'pdf' || !R.pdf) return;
    for (const [num] of [...R.rendered]) {
      const ph = R.pages[num - 1]; if (!ph) continue;
      ph.querySelector('canvas')?.remove(); ph.querySelector('.textLayer')?.remove(); ph.querySelector('.hl-layer')?.remove();
      ph.classList.add('rendering'); ph.dataset.rendered = ''; R.rendered.delete(num);
    }
    R.pages.forEach((p, i) => { if (Math.abs(i + 1 - R.cur) <= 2) renderPage(i + 1, p); });
    inkResizeAll();
  }, 350);
});
window.addEventListener('orientationchange', () => setTimeout(() => inkResizeAll(), 500));

/* 切回前台时收起浮层 */
document.addEventListener('visibilitychange', () => { if (document.hidden) { hideCard(); selbar.classList.remove('show'); } });

/* ═══════════ 离线词典 ═══════════ */
function refreshDictState() {
  const el = $('#dictState'); if (!el) return;
  const net = navigator.onLine ? '已联网' : '当前离线';
  el.textContent = offlineLoaded()
    ? `${net} · 内置词典 ${offlineCount().toLocaleString()} 词已就绪`
    : `${net} · 内置词典加载中…`;
}
async function warmDict() {
  try { await loadOffline(); } catch (e) { console.warn(e); }
  refreshDictState();
}

/* ═══════════ 全文对照翻译 ═══════════ */
const T = { doc: null, paras: [], cn: [], mode: 'both', running: false, stop: false, done: 0 };

const trHash = s => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

async function openFullTrans() {
  if (!R.doc) return;

  /* ① 拿到段落：文字层 PDF 自己抽；扫描件用 OCR 结果；TXT 用现成段落 */
  let paras = [];
  if (R.mode === 'pdf' && !R.ocr.enabled) {
    blocker(true, '正在提取原文…');
    try { paras = await extractPdfParas(R.pdf); } catch (e) { console.error(e); }
    blocker(false);
  } else if (R.mode === 'image') {
    /* 图片：就一页，识别过是秒出，没识别过先识别一次 */
    blocker(true, '正在识别图片里的文字…');
    const res = await ensureOcr(1, true).catch(() => null);
    blocker(false);
    paras = res ? ocrParasToText(R.ocr.pages) : [];
  } else if (R.mode === 'pdf' && R.ocr.enabled) {
    /* 扫描件：需要先把整本识别一遍，页数多会比较久 */
    if (!(await ensureWholeDocOcr())) return;
    paras = ocrParasToText(R.ocr.pages);
  } else if (R.mode === 'txt') {
    paras = [...document.querySelectorAll('#pages .txt-body p')].map(p => ({ page: 0, text: p.textContent }));
  }

  if (!paras.length) { toast('这份文档里没有可翻译的正文内容', 3200); return; }

  /* 正文是中文的 PDF：直接说明，别拿中文去翻中文 */
  if (R.mode === 'pdf' && !R.ocr.enabled && cjkRatio(paras.slice(0, 10).map(p => p.text).join('\n'), 4000) > 0.5) {
    toast('这份 PDF 的正文是中文——本阅读器为英文阅读设计，全文翻译只支持英文文档', 5200);
    return;
  }

  /* 识别质量差的页（中文被硬看成乱码英文）：翻译它们只会产出垃圾，还白烧额度。
     逐页体检，烂页整页跳过，但保留原文行方便对照，长按仍可单独翻。 */
  T.suspect = new Set();
  if (R.mode === 'image' || (R.mode === 'pdf' && R.ocr.enabled)) {
    for (const [page, data] of R.ocr.pages) {
      const q = data.q || (data.q = ocrQuality(data.words, data.paras));
      if (!q.ok) T.suspect.add(page);
    }
  }

  T.doc = R.doc;
  T.paras = paras;
  T.cn = new Array(paras.length).fill(undefined);
  T.stop = false; T.done = 0;

  $('#transName').textContent = R.doc.name + ' · 全文翻译';
  renderTransRows();
  mountTransInk();
  $('#trans').classList.add('active');
  $('#trans').dataset.mode = T.mode;
  $('#reader').classList.remove('active');
  $('#transScroll').scrollTop = 0;
  $('#transWarn').hidden = true;
  if (T.suspect.size) {
    const label = R.mode === 'image' ? '这张图片' : [...T.suspect].sort((a, b) => a - b).map(n => `第 ${n} 页`).join('、');
    $('#transWarnTitle').textContent = '识别结果不像英文，相关段落已跳过翻译';
    $('#transWarnBody').textContent = `${label}识别出来的是乱码（原文可能是中文，或图片太模糊/反光）。`
      + '这部分翻译没有意义，已自动跳过；原文仍保留在下面，长按某一段仍可单独翻译。';
    $('#transWarn').hidden = false;
  }
  $('#transProg').textContent = `0 / ${paras.length}`;
  $('#transBar').style.width = '0%';
  $('#transHead').innerHTML =
    `<b>${paras.length} 段</b> · 逐段翻译并缓存到本机，下次打开同一份文档不用再翻。<br>`
    + `英文段落里的单词照样可以点开查词；长按选中可翻译任意一段。`;

  runTranslate();
}

/* 扫描件：把整本识别一遍（已缓存的页直接读，不重算） */
async function ensureWholeDocOcr() {
  const n = R.pdf.numPages;
  let need = 0;
  for (let i = 1; i <= n; i++) if (!R.ocr.pages.has(i)) need++;
  if (!need) return true;

  blocker(true, `扫描件需要先识别全文（0 / ${need} 页）`);
  let done = 0;
  for (let i = 1; i <= n; i++) {
    if (R.ocr.pages.has(i)) continue;
    try { await ensureOcr(i, true); } catch { }
    done++;
    blocker(true, `扫描件需要先识别全文（${done} / ${need} 页）`);
  }
  blocker(false);
  const ok = R.ocr.pages.size > 0;
  if (!ok) toast('没能识别出文字，全文翻译用不了', 3200);
  return ok;
}

function renderTransRows() {
  const box = $('#transBody');
  box.innerHTML = '';
  const frag = document.createDocumentFragment();
  T.paras.forEach((p, i) => {
    const d = document.createElement('div');
    d.className = 'tpara';
    d.dataset.i = i;
    d.innerHTML = `<div class="hl-layer"></div>`
      + `${p.page ? `<span class="pgno">第 ${p.page} 页</span>` : ''}`
      + `<p class="tp-en txt-body"></p>`
      + `<p class="tp-cn pending">等待翻译…</p>`;
    d.querySelector('.tp-en').textContent = p.text;
    frag.appendChild(d);
  });
  box.appendChild(frag);
}

/* ── 译文视图的批注宿主：每个对照段落一块，由 ink 侧按需挂载画布 ──
   注意 key 里带 docId（ink.js 自己拼），所以「设置 → 清除这篇文档的全部批注」
   会连译文页上的一起清掉，不用另外处理。 */
function mountTransInk() {
  const body = $('#transBody');
  inkPurge(body);                       // 旧段落的 DOM 刚被整体换掉，记录别留着
  if (!Ink.docId || !R.doc || Ink.docId !== R.doc.id) return;
  inkWatchRange(body, $('#transScroll'), el => 'tr' + el.dataset.i);
}
function unmountTransInk() {
  inkStopRange();
  inkPurge($('#transBody'));
}

function setRow(i, cn) {
  const el = $('#transBody').querySelector(`.tpara[data-i="${i}"]`);
  if (!el) return;
  const p = el.querySelector('.tp-cn');
  if (cn) { p.textContent = cnView(cn); p.classList.remove('pending'); }
  else { p.textContent = '（这一段没翻出来）'; p.classList.add('pending'); }
}

/* 改了润色档位或术语开关，把已经翻好的段落重画一遍 */
function repaintTrans() {
  for (let i = 0; i < T.cn.length; i++) if (T.cn[i]) setRow(i, T.cn[i]);
}

async function runTranslate() {
  if (T.running) return;
  T.running = true;
  let hitQuota = false;
  try {
    for (let i = 0; i < T.paras.length; i++) {
      if (T.stop || T.doc !== R.doc) break;
      if (T.cn[i] !== undefined) continue;

      /* 烂页跳过：不翻译、不查缓存 */
      if (T.suspect && T.suspect.has(T.paras[i].page)) {
        T.cn[i] = '';
        const el = $('#transBody').querySelector(`.tpara[data-i="${i}"]`);
        if (el) {
          const pp = el.querySelector('.tp-cn');
          pp.textContent = '（这页识别出来是乱码，已跳过翻译）';
          pp.classList.add('pending');
        }
        T.done++;
        $('#transProg').textContent = `${T.done} / ${T.paras.length}`;
        continue;
      }

      const key = 'tr:' + T.doc.id + ':' + trHash(T.paras[i].text);
      let cn = await blobGet(key).catch(() => null);
      if (!cn) {
        if (quotaExhausted()) { hitQuota = true; break; }
        cn = await translate(T.paras[i].text);
        if (cn) blobPut(key, cn).catch(() => { });
        if (!cn && quotaExhausted()) { hitQuota = true; }
      }
      T.cn[i] = cn || '';
      setRow(i, cn);
      T.done++;
      $('#transProg').textContent = `${T.done} / ${T.paras.length}`;
      $('#transBar').style.width = ((i + 1) / T.paras.length * 100) + '%';
      if (hitQuota) break;
    }
  } finally {
    T.running = false;
  }
  if (hitQuota) {
    $('#transWarnTitle').textContent = '免费翻译额度今天用完了';
    $('#transWarnBody').textContent = '已经翻好的部分会永久存在本机，明天额度恢复后重新打开这份文档，'
      + '会从没翻的那一段接着往下翻，不会重算。';
    $('#transWarn').hidden = false;
  } else if (T.done === T.paras.length && T.paras.length) {
    $('#transHead').innerHTML = `<b>全文翻译完成</b> · 共 ${T.paras.length} 段，已缓存到本机。`
      + `英文段落里的单词可以点开查词。`;
  }
}

/* ═══════════ 启动 ═══════════ */
applyTheme();
renderLibrary();

/* ── 环境自检：把「点了没反应」的原因直接写在页面上，别让用户对着空气发呆 ── */
function showEnvWarnings() {
  const on = sel => { const el = $(sel); if (el) el.hidden = false; };
  if (store.embedded) on('#frameWarn');
  if (storageBroken()) {
    const why = $('#storageWhy');
    if (why) why.textContent = store.reason || '本地存储不可用。';
    on('#storageWarn');
  }
}

/* 记下最后一个错误，方便「复制诊断信息」时能说清楚 */
window.addEventListener('error', e => {
  window.__lastErr = (e.message || '未知错误') + ' @ ' + String(e.filename || '').split('/').pop() + ':' + (e.lineno || 0);
});
window.addEventListener('unhandledrejection', e => {
  const r = e.reason;
  window.__lastErr = 'Promise 未捕获：' + ((r && (r.message || r.name)) || r);
});

/* 批注模式双保险：CSS 关了可选性，这里再拦住 selectstart / 系统呼出菜单 /
   已形成的选区 —— 不给 iOS「笔迹=长按选字」任何机会，写完退出批注自动恢复。 */
document.addEventListener('selectstart', e => { if (inkActive()) e.preventDefault(); });
document.addEventListener('contextmenu', e => { if (inkActive()) e.preventDefault(); });
document.addEventListener('selectionchange', () => {
  if (inkActive() && window.getSelection && !window.getSelection().isCollapsed) {
    window.getSelection().removeAllRanges();
  }
});

function diagText() {
  const htmlVer = document.querySelector('meta[name="rd-ver"]')?.content || '未知';
  const L = [
    '英语阅读器 · 诊断信息',
    '版本：' + APP_VER + '（页面写的是 ' + htmlVer + '）'
      + (window.__verMismatch ? '  ‼️ 页面与脚本不一致：' + window.__verMismatch : ''),
    '时间：' + new Date().toLocaleString('zh-CN'),
    '地址：' + location.href,
    '运行方式：' + (store.embedded ? '嵌在页面/面板里（iframe）' : '独立打开'),
    'localStorage：' + (store.ls ? '可用' : '不可用'),
    'IndexedDB：' + (store.idb ? '可用' : '不可用'),
    'Service Worker：' + ('serviceWorker' in navigator ? '支持' : '不支持'),
    '离线词典：' + (offlineLoaded() ? offlineCount() + ' 词' : '未加载'),
    '已导入文档：' + docs.length + ' 篇',
    '生词本：' + vocab.length + ' 词',
    '阅读器：' + (R.mode === 'txt' ? 'TXT ' + (R.txtRoot ? '已加载' : '未打开')
      : R.pdf ? 'PDF ' + R.pages.length + ' 页' : '未打开文档'),
    '当前文档文字：' + (R.textStats
      ? `英文 ${R.textStats.latin} 字 / 中文 ${R.textStats.cjk} 字 / 文本块 ${R.textStats.items} 个`
        + (R.textStats.latin === 0 && R.textStats.cjk === 0 ? '（无文字层，疑似扫描件）' : '')
      : '—'),
    '文字层生成失败的页：' + (R.layerEmpty ? R.layerEmpty + ' 页' : '无'),
    'OCR：' + (R.ocr.enabled ? '已开启，本次已识别 ' + R.ocr.pages.size + ' 页' : '未开启'),
    'OCR 缓存：' + (ocrCacheCount >= 0 ? ocrCacheCount + ' 页' : '未统计（打开设置会统计）'),
    '最后错误：' + (window.__lastErr || '无'),
  ];
  if (storageBroken()) L.push('存储禁用原因：' + store.reason);
  return L.join('\n');
}
function refreshDiag() {
  const el = $('#diagBox');
  if (el) el.textContent = diagText();
}

/* OCR 缓存的状态与清理 */
let ocrCacheCount = -1;
async function refreshOcrState() {
  const el = $('#ocrState');
  if (el) el.textContent = '统计中…';
  const keys = (await blobKeys()).filter(k => typeof k === 'string' && k.startsWith('ocr:'));
  ocrCacheCount = keys.length;
  if (el) el.textContent = keys.length
    ? `已在本机缓存 ${keys.length} 页的识别结果，重开同一份文件不用再识别。`
    : '还没有缓存。扫描件每页第一次点需要现场识别，识别完会自动存下来。';
}
/* OCR 引擎自检：拿一张只有一行英文的小图，跑一遍完整链路。
   图片和扫描件能不能点词，全看这条链路通不通。
   通不了的时候，用户自己就能把原因复制给我。 */
$('#ocrSelfTest')?.addEventListener('click', async () => {
  const el = $('#ocrSelfResult');
  if (!el) return;
  const t0 = performance.now();
  el.textContent = '正在加载识别引擎…（第一次要下载几 MB，请稍等）';
  try {
    const cv = document.createElement('canvas');
    cv.width = 900; cv.height = 140;
    const cx = cv.getContext('2d', { alpha: false });
    cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, cv.width, cv.height);
    cx.fillStyle = '#111111';
    cx.font = '52px Georgia, "Times New Roman", serif';
    cx.fillText('materiality substantive audit', 18, 88);

    const res = await ocrImage(cv, m => {
      const stage = m && m.status && OCR_STAGE[m.status];
      if (stage) el.textContent = stage + '…';
    }, 0);

    const ms = Math.round(performance.now() - t0);
    const got = res.words.map(w => w.text).join(' ');
    el.innerHTML = /materiality/i.test(got)
      ? `✅ <b>识别引擎正常</b>（${ms} 毫秒）。试识别结果：<code>${esc(got)}</code><br>图片和扫描件点词都应该能用。`
      : `⚠️ 引擎启动了，但认不准（${ms} 毫秒）。试识别结果：<code>${esc(got || '（空）')}</code><br>把这一段发我。`;
  } catch (e) {
    const msg = String((e && e.message) || e);
    window.__lastErr = 'OCR 自检失败：' + msg;
    el.innerHTML = `❌ <b>识别引擎起不来</b>：<code>${esc(msg)}</code><br>把这句话发我就能定位。`;
  }
  refreshDiag();
});

$('#ocrClear')?.addEventListener('click', async () => {
  if (!confirm('清除本机缓存的 OCR 识别结果？下次打开扫描件需要重新识别（原文档不受影响）。')) return;
  await blobDelPrefix('ocr:');
  R.ocr.pages.clear();
  toast('OCR 缓存已清除');
  refreshOcrState();
  refreshDiag();
});

/* 朗读自检：真的读一句，然后报告引擎有没有响应。
   iOS 上「不出声但什么都不报」最常见，必须把结果显式给用户看。 */
function refreshSpkState() {
  const el = $('#spkState');
  if (!el) return;
  if (typeof speechSynthesis === 'undefined') { el.textContent = '这个浏览器不支持朗读'; return; }
  const vs = speechSynthesis.getVoices() || [];
  const en = vs.filter(v => /^en/i.test(v.lang || '')).length;
  el.textContent = `语音引擎在；本机语音 ${vs.length} 个，英文 ${en} 个` + (en ? '' : '（没有英文语音也能读，走系统默认发音）');
}
$('#spkSelfTest')?.addEventListener('click', async () => {
  const el = $('#spkSelfResult');
  if (!el) return;
  if (typeof speechSynthesis === 'undefined') { el.innerHTML = '❌ 这个浏览器没有语音引擎。'; return; }
  el.textContent = '正在读：Reading test, one two three. …';
  let fired = false, err = '';
  await new Promise(res => {
    const u = new SpeechSynthesisUtterance('Reading test, one two three.');
    u.lang = 'en-US'; u.rate = 0.95;
    u.onstart = () => { fired = true; res(); };
    u.onend = () => res();
    u.onerror = e => { err = e.error || 'unknown'; res(); };
    try { speechSynthesis.resume(); speechSynthesis.cancel(); speechSynthesis.speak(u); }
    catch (e) { err = String(e); res(); }
    setTimeout(res, 4000);                     // 引擎假死时事件不来，4 秒兜底
  });
  el.innerHTML = fired
    ? '✅ <b>听到声音了吗？</b>引擎正常响应。听不到的话检查 iPad 音量／静音开关。'
    : (err
      ? `❌ <b>引擎报错</b>：<code>${esc(err)}</code><br>把这一句发我就能定位。`
      : '⚠️ <b>引擎没有任何响应</b>（没报错也没出声）。这是 iOS 语音引擎假死，把阅读器彻底关掉再开通常就好；不行就把这句话发我。');
  refreshSpkState();
});
$('#frameCopy')?.addEventListener('click', copyUrl);
$('#storageCopy')?.addEventListener('click', copyUrl);
$('#pdfWarnClose')?.addEventListener('click', () => { const b = $('#pdfWarn'); if (b) b.hidden = true; });
$('#diagCopy')?.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(diagText()); toast('诊断信息已复制'); }
  catch { toast('复制失败，请手动截图这一屏', 3000); }
});

/* ═══════════ 手写批注 / 朗读 ═══════════ */
inkInit({ toast, onTap: (x, y) => lookupAtPoint(x, y) });
speechInit({ toast });

/* 笔模式下不查词：涂写层吃掉了指针事件，再点词只会让人困惑 */
inkOnModeChange(m => { if (m !== 'off') { hideCard(); selbar.classList.remove('show'); } });

$('#btnRead')?.addEventListener('click', () => {
  if (speechOn()) { speechStop(); return; }
  if (!R.doc) return;
  const host = R.mode === 'pdf' ? R.pages[R.cur - 1] : R.mode === 'image' ? R.pages[0] : $('.txt-wrap');
  const ok = speechStart(R.ocr.pages, host);
  if (!ok) return;
  $('#btnRead').classList.add('on');
});
speechOnToggle(on => $('#btnRead')?.classList.toggle('on', on));

/* 选区浮条上的四颗色点：给选中的文字上高亮 */
$('#selHl')?.addEventListener('click', e => {
  const b = e.target.closest('[data-hl]'); if (!b) return;
  const ok = inkMarkSelection(b.dataset.hl);
  selbar.classList.remove('show');
  toast(ok ? '已标记，笔迹会跟着文档保存' : '这里没法标记（可能还没渲染完）', 2400);
});

$('#inkClear')?.addEventListener('click', async () => {
  if (!R.doc) { toast('先打开一篇文档'); return; }
  if (!confirm(`清除《${R.doc.name}》上的全部手写批注和高亮？文档本身不受影响。`)) return;
  await inkClearDoc(R.doc.id);
  toast('已清除');
  refreshInkState();
});
$('#spkRateDn')?.addEventListener('click', () => bumpRate(-0.1));
$('#spkRateUp')?.addEventListener('click', () => bumpRate(0.1));
$('#spkVoice')?.addEventListener('click', () => $('#spkBar [data-a="voice"]')?.click());
function bumpRate(d) {
  const btn = $('#spkBar')?.querySelector(`[data-a="${d > 0 ? 'faster' : 'slower'}"]`);
  if (btn) btn.click();
  const n = $('#spkRateNow'); if (n) n.textContent = Spk.rate.toFixed(1) + '×';
  toast('语速 ' + Spk.rate.toFixed(1) + '×', 1500);
}

function refreshInkState() {
  const el = $('#inkState'); if (!el) return;
  if (!R.doc) { el.textContent = '打开一篇文档后，在顶部点「批注」即可书写。'; return; }
  const n = inkCount(R.doc.id);
  el.textContent = n ? `这篇文档当前有 ${n} 处批注（笔迹 / 高亮 / 便签）。` : '这篇文档还没有批注。';
}

showEnvWarnings();
refreshDictState();
(window.requestIdleCallback || (f => setTimeout(f, 1500)))(() => warmDict());
window.addEventListener('online', refreshDictState);
window.addEventListener('offline', refreshDictState);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e)));
}

/* 调试/排查用钩子 */
window.__rd = {
  R, settings, loadOffline, lookupOffline, lookupOnline, translate,
  offlineLoaded, offlineCount,
  get docs() { return docs; }, get vocab() { return vocab; }
};

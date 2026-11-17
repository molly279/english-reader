/* ═══════════════════════════════════════════
   ocr.js — 扫描件 OCR（完全在本机跑，文档不外传）
   只做一件事：把一页图片变成「带坐标的单词列表」，供点词用。
   ═══════════════════════════════════════════ */

/* ocr.js 在 /js/ 下，资源在 /vendor/tesseract/ 下 */
const BASE = new URL('../vendor/tesseract/', import.meta.url).href;

/* tesseract.js 会按设备能力自动挑核心文件（relaxedsimd / simd / 普通），
   全内置要 20MB+。这里改成自己探测、直接指定一个：
   - 支持 WASM SIMD（iOS 16.4+ / Chrome 91+ 都有）→ simd 版，快一截
   - 否则 → 普通 LSTM 版，慢但一定能跑
   两版都用「小加载器 + 独立 wasm」，服务器压缩后传输量小很多。 */
function hasSimd() {
  try {
    return WebAssembly.validate(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
      10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11
    ]));
  } catch { return false; }
}
const CORE_FILE = hasSimd() ? 'tesseract-core-simd-lstm.js' : 'tesseract-core-lstm.js';

let workerP = null;
let busy = Promise.resolve();          // OCR 串行化，别让多页同时占内存

export function ocrAvailable() { return true; }

/* ── 识别质量评估 ─────────────────────────────────────────────
   OCR 只有英文模型。遇到中文页面 / 太花的照片，它不会「认不出」，
   而是把汉字硬看成一串像英文的乱码（实测：扫描版中文公函 →
   "FT IAS AF aS"、"AREAS:" 这种碎片，置信度 52，段落全碎）。
   必须主动判出来，别再把乱码当正文去翻译、去点词。
   判据三选一即判「可疑」：常用词命中太低 / 平均置信度太低 /
   段落碎得反常（中位段落不足 5 个词）。 */
const COMMON = new Set(("the of and a to in is you that it he was for on are as with his they i "
+ "at be this have from or one had by word but not what all were they we when your can said "
+ "there use an each which she do how their if will up other about out many then them these so "
+ "some her would make like him into time has look two more write go see number no way could people "
+ "my than first water been call who oil its now find long down day did get come made may part over "
+ "we has through before between never under while along following according within without against "
+ "shall should company financial statements audit auditor reporting entity control risk material "
+ "accounting assets liabilities revenue income tax value cost period cash flow equity profit loss "
+ "transactions balances provision impairment disclosure management accounting standards fair").split(/\s+/));

export function ocrQuality(words, paras) {
  if (!words || !words.length) return { ok: false, why: 'empty', avgConf: 0, hitRatio: 0, medWords: 0 };
  const avgConf = words.reduce((s, w) => s + (w.conf || 0), 0) / words.length;
  const toks = words.map(w => String(w.text || '').toLowerCase().replace(/[^a-z']/g, '')).filter(Boolean);
  const hits = toks.filter(t => COMMON.has(t)).length;
  const hitRatio = toks.length ? hits / toks.length : 0;
  const wc = (paras || []).map(p => String(p.text || '').split(/\s+/).filter(Boolean).length).sort((a, b) => a - b);
  const medWords = wc.length ? wc[Math.floor(wc.length / 2)] : 0;
  const ok = hitRatio >= 0.30 || (avgConf >= 65 && medWords >= 5) || avgConf >= 80;
  return { ok, avgConf: Math.round(avgConf), hitRatio: +hitRatio.toFixed(2), medWords };
}

/* 建一个常驻 worker，之后每页复用 */
function getWorker(onLog) {
  if (workerP) return workerP;
  workerP = (async () => {
    const mod = await import(BASE + 'tesseract.esm.min.js');
    const T = mod.default || mod;
    const w = await T.createWorker('eng', 1, {
      workerPath: BASE + 'worker.min.js',
      corePath: BASE + CORE_FILE,      // 指定到具体文件，关掉自动探测
      langPath: BASE.replace(/\/$/, ''),
      gzip: true,
      cacheMethod: 'none',            // 缓存我们自己管
      // 关键：默认 true 会把 worker 包成 blob，blob 里解析不了核心 .wasm 的相对路径，
      // 会报 "Failed to parse URL from tesseract-core-*.wasm"。我们本来就是同源，关掉。
      workerBlobURL: false,
      logger: m => { if (onLog) onLog(m); },
      errorHandler: e => console.warn('[ocr]', e),
    });
    // 整页自动分栏识别；保留词间空格
    await w.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' });
    return w;
  })().catch(e => { workerP = null; throw e; });
  return workerP;
}

/**
 * 识别一张图（canvas / image / blob）
 * @returns {Promise<{words:Array, paras:Array, width:number, height:number}>}
 *   words: [{ text, x0, y0, x1, y1, para, cs, ce, conf }]  坐标为图片像素
 *   paras: [{ text, words:number }]  cs/ce 是该词在 para.text 中的字符区间
 */
export function ocrImage(image, onProgress, dpi) {
  const job = busy.then(async () => {
    const w = await getWorker(onProgress);
    if (dpi && Math.abs((w.__dpi || 0) - dpi) > 5) {
      // 告诉 tesseract 真实 DPI，避免它瞎猜（否则控制台会警告 Estimating resolution）
      try { await w.setParameters({ user_defined_dpi: String(Math.round(dpi)) }); w.__dpi = dpi; } catch { }
    }
    const { data } = await w.recognize(image, {}, { text: true, blocks: true });
    return flatten(data, image);
  });
  busy = job.catch(() => { });
  return job;
}

function flatten(data, image) {
  const W = image.width || (image.naturalWidth || 0);
  const H = image.height || (image.naturalHeight || 0);
  const words = [];
  const paras = [];

  const pushPara = (lines) => {
    let text = '';
    const local = [];
    for (const l of lines) {
      for (const w of (l.words || [])) {
        const t = String(w.text || '').trim();
        if (!t) continue;
        if (!/[A-Za-z]/.test(t)) continue;                 // 点词只关心英文
        if ((w.confidence ?? 100) < 35) continue;           // 丢掉低置信度的噪声
        const cs = text.length;
        text += (text ? ' ' : '') + t;
        local.push({ t, cs, ce: text.length, bbox: w.bbox, conf: w.confidence });
      }
    }
    if (!local.length) return;
    const pi = paras.length;
    paras.push({ text });
    for (const x of local) {
      words.push({
        text: x.t,
        x0: x.bbox.x0, y0: x.bbox.y0, x1: x.bbox.x1, y1: x.bbox.y1,
        para: pi, cs: x.cs, ce: x.ce, conf: x.conf,
      });
    }
  };

  for (const b of (data.blocks || [])) {
    for (const p of (b.paragraphs || [])) {
      pushPara(p.lines || []);
    }
  }

  // 兜底：有些版本给的是扁平的 data.words
  if (!words.length && data.words && data.words.length) {
    let text = '', local = [];
    for (const w of data.words) {
      const t = String(w.text || '').trim();
      if (!t || !/[A-Za-z]/.test(t) || (w.confidence ?? 100) < 35) continue;
      const cs = text.length;
      text += (text ? ' ' : '') + t;
      local.push({ t, cs, ce: text.length, bbox: w.bbox, conf: w.confidence });
    }
    if (local.length) {
      paras.push({ text });
      for (const x of local) {
        words.push({ text: x.t, x0: x.bbox.x0, y0: x.bbox.y0, x1: x.bbox.x1, y1: x.bbox.y1, para: 0, cs: x.cs, ce: x.ce, conf: x.conf });
      }
    }
  }

  return { words, paras, width: W, height: H };
}

/* 命中测试：找包含该点的词；点偏了就找最近的那个 */
export function hitWord(page, x, y) {
  if (!page || !page.words.length) return null;
  let best = null, bestD = Infinity;
  for (const w of page.words) {
    if (x >= w.x0 - 2 && x <= w.x1 + 2 && y >= w.y0 - 2 && y <= w.y1 + 2) return w;
    const cx = (w.x0 + w.x1) / 2, cy = (w.y0 + w.y1) / 2;
    const d = (cx - x) ** 2 + (cy - y) ** 2;
    if (d < bestD) { bestD = d; best = w; }
  }
  // 阈值按字高估：离得太远就不认
  const h = best ? (best.y1 - best.y0) : 20;
  return bestD <= (h * 2.2) ** 2 ? best : null;
}

export function terminate() {
  if (!workerP) return;
  const p = workerP; workerP = null;
  p.then(w => w.terminate()).catch(() => { });
}

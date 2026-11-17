/* ═══════════════════════════════════════════
   extract.js — 把 PDF 的文字抽成「段落」
   用于「全文翻译」的对照阅读。
   文字层 PDF：按 y 坐标分行、按行距分段，并尝试识别双栏。
   扫描件：直接用 OCR 得到的段落。
   ═══════════════════════════════════════════ */

const median = arr => {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/** 从一页的 getTextContent 结果里抽出段落 */
function pageToParas(tc, pageWidth) {
  const items = (tc.items || []).filter(it => it.str && it.str.trim());
  if (!items.length) return [];

  /* ① 按 y 聚成行 */
  const lines = [];
  for (const it of items) {
    const y = it.transform[5], x = it.transform[4];
    const h = it.height || Math.abs(it.transform[3]) || 10;
    let line = lines.find(l => Math.abs(l.y - y) <= Math.max(2, h * 0.42));
    if (!line) { line = { y, h, parts: [] }; lines.push(line); }
    line.parts.push({ x, w: it.width || 0, s: it.str, h });
    line.h = Math.max(line.h, h);
  }

  /* ② 行内按 x 排序，遇到大间隙切成「段」（应对双栏 / 表格） */
  const segs = [];
  for (const l of lines) {
    l.parts.sort((a, b) => a.x - b.x);
    let cur = null;
    for (const p of l.parts) {
      const gap = cur ? p.x - (cur.x + cur.w) : 0;
      if (!cur || gap > l.h * 2.2) {
        cur = { x: p.x, x1: p.x + p.w, y: l.y, h: l.h, text: p.s };
        segs.push(cur);
      } else {
        cur.text += p.s;
        cur.x1 = Math.max(cur.x1, p.x + p.w);
      }
    }
  }
  if (!segs.length) return [];

  /* ③ 判断是不是双栏：左半和右半各自都有足够多的段起点 */
  const left = segs.filter(s => s.x < pageWidth * 0.5).length;
  const right = segs.length - left;
  const twoCol = right > segs.length * 0.28 && left > segs.length * 0.28;

  const out = [];
  const cols = twoCol ? [0, 1] : [0];
  for (const col of cols) {
    const mine = twoCol
      ? segs.filter(s => (col === 0 ? s.x < pageWidth * 0.5 : s.x >= pageWidth * 0.5))
      : segs;
    mine.sort((a, b) => (b.y - a.y) || (a.x - b.x));

    const gaps = [];
    for (let i = 1; i < mine.length; i++) {
      const g = mine[i - 1].y - mine[i].y;
      if (g > 0.5) gaps.push(g);
    }
    const med = median(gaps) || 12;

    let buf = [];
    const flush = () => {
      const t = buf.join(' ').replace(/\s{2,}/g, ' ').trim();
      if (t.length > 1) out.push(t);
      buf = [];
    };
    for (let i = 0; i < mine.length; i++) {
      const s = mine[i], prev = mine[i - 1];
      if (prev) {
        const gap = prev.y - s.y;
        const indent = s.x - (prev.x || s.x);
        if (gap > med * 1.6 || indent > s.h * 1.6) flush();
      }
      buf.push(s.text.replace(/\s+$/, ''));
    }
    flush();
  }
  return out;
}

/** 整份文字层 PDF → [{page, text}] */
export async function extractPdfParas(pdf, { maxPages = 0, onProgress } = {}) {
  const n = maxPages ? Math.min(pdf.numPages, maxPages) : pdf.numPages;
  const out = [];
  for (let i = 1; i <= n; i++) {
    try {
      const page = await pdf.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      for (const t of pageToParas(tc, vp.width)) out.push({ page: i, text: t });
    } catch { }
    if (onProgress) onProgress(i, n);
    if (i % 3 === 0) await new Promise(r => setTimeout(r, 0));
  }
  return out;
}

/** 扫描件：把 OCR 结果（每页的 paras）拼成同样结构 */
export function ocrParasToText(ocrPages) {
  const out = [];
  for (const [page, data] of [...ocrPages].sort((a, b) => a[0] - b[0])) {
    for (const p of (data.paras || [])) {
      const t = String(p.text || '').trim();
      if (t.length > 1) out.push({ page, text: t });
    }
  }
  return out;
}

/** 太长的一段再按句号切开，避免单次翻译请求过大 */
export function splitLong(text, max = 420) {
  if (text.length <= max) return [text];
  const parts = text.split(/(?<=[.!?;])\s+/);
  const out = [];
  let cur = '';
  for (const p of parts) {
    if (cur && (cur + ' ' + p).length > max) { out.push(cur); cur = p; }
    else cur = cur ? cur + ' ' + p : p;
  }
  if (cur) out.push(cur);
  const flat = [];
  for (const s of out) {
    if (s.length <= max) { flat.push(s); continue; }
    for (let i = 0; i < s.length; i += max) flat.push(s.slice(i, i + max));
  }
  return flat;
}

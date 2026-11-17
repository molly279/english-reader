/* ═══════════════════════════════════════════════════════════
   polish.js —— 中文译文润色
   -----------------------------------------------------------
   翻译接口给的是机器直译，能看懂但读着费劲：术语翻错、
   「合理的保证」这种多余的「的」、中英数字粘在一起（45笔）、
   一堆「进行了……」「在……的情况下」。
   这一层在**显示前**对译文做中文处理，不改原文、不需要联网。

   分四档，用户在设置里切：
     off   原样
     light 繁简 + 错别字 + 标点与空格规范
     std   上面 + 专业术语纠正 + 去机器腔（默认）
     max   上面 + 动句式（在……的情况下 → 在……时）

   注意：润色只对**译文**生效，缓存里存的仍是原始译文，
   所以切换档位立刻见效，不用重新翻译。
   ═══════════════════════════════════════════════════════════ */
import { TRAD, CORE, TERMS, FLAVOR, STRONG } from './terms.js';

const CJK = '\\u4e00-\\u9fa5';
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* 把 ... 当通配符：左边变捕获组，右边变 $1 */
function compile(list) {
  return list.map(([a, b]) => {
    if (a.includes('...')) {
      const re = a.split('...').map(esc).join('(.{1,20}?)');
      return [new RegExp(re, 'g'), b.split('...').join('$1')];
    }
    return [new RegExp(esc(a), 'g'), b];
  });
}

const R_TRAD = TRAD;
const R_CORE = compile(CORE);
const R_TERM = compile(TERMS);
const R_FLAV = compile(FLAVOR);
const R_STRG = compile(STRONG);

/* 半角标点 → 全角（只动挨着中文的那些，避免伤到英文术语） */
const HALF = [',', ';', ':', '?', '!'].map(c => esc(c));
const R_HALF_L = new RegExp('([' + CJK + '])\\s*(' + HALF.join('|') + ')', 'g');
const R_HALF_R = new RegExp('(' + HALF.join('|') + ')\\s*(?=[' + CJK + '])', 'g');
const FULL = { ',': '，', ';': '；', ':': '：', '?': '？', '!': '！' };

function apply(list, s) {
  for (const [re, to] of list) s = s.replace(re, to);
  return s;
}

function trad(s) {
  for (const [a, b] of R_TRAD) if (s.indexOf(a) >= 0) s = s.split(a).join(b);
  return s;
}

/**
 * 润色一段中文译文
 * @param {string} text 机器翻译的原文（中文）
 * @param {'off'|'light'|'std'|'max'} level
 * @param {boolean} useTerms 是否做专业术语纠正
 */
export function polishCN(text, level = 'std', useTerms = true) {
  let s = String(text || '');
  if (!s.trim() || level === 'off') return s;

  /* 0. 保护网址和邮箱，别被空格规则拆开 */
  const keep = [];
  s = s.replace(/https?:\/\/[^\s，。；）"]+/g, m => {
    keep.push(m); return '\u0001' + (keep.length - 1) + '\u0001';
  });

  /* 1. 繁简 + 错别字 */
  s = trad(s);
  s = apply(R_CORE, s);

  /* 2. 标点 */
  s = s.replace(R_HALF_L, (m, a, b) => a + (FULL[b] || b))
       .replace(R_HALF_R, (m, a) => (FULL[a] || a))
       .replace(/--/g, '——')
       .replace(/\(([^()]*[' + CJK + '][^()]*)\)/g, '（$1）')
       .replace(/"([^"]*[' + CJK + '][^"]*)"/g, '“$1”')
       .replace(/。。+/g, '。').replace(/，，+/g, '，')
       .replace(/的的+/g, '的');

  /* 3. 术语（受开关控制） */
  if (useTerms) s = apply(R_TERM, s);

  if (level === 'light') { return restore(s, keep); }

  /* 4. 去机器腔 */
  s = apply(R_FLAV, s);

  if (level === 'max') s = apply(R_STRG, s);

  /* 5. 中英 / 中数之间补空格，百分号贴回去 */
  s = s.replace(new RegExp('([' + CJK + '])([A-Za-z0-9])', 'g'), '$1 $2')
       .replace(new RegExp('([A-Za-z0-9%])([' + CJK + '])', 'g'), '$1 $2')
       .replace(/(\d)\s+%/g, '$1%')
       .replace(/[ \t]{2,}/g, ' ')
       .replace(/^\s+|\s+$/g, '');

  return restore(s, keep);
}

function restore(s, keep) {
  return s.replace(/\u0001(\d+)\u0001/g, (m, i) => keep[+i] || '');
}

export const POLISH_LABEL = { off: '不润色', light: '轻度', std: '标准', max: '强力' };
export const TERM_COUNT = TERMS.length + CORE.length;

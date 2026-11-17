/* Word（.docx）→ 纯文本，全程在本机完成，不上传、不需要服务器。
   docx 本质是一个 zip，浏览器自带的 DecompressionStream 就能解压，
   所以这里不引入任何 zip 库（省掉上百 KB）。
   注意：只支持新版 .docx；老版 .doc 是 OLE2 复合文档，读不了。 */

const SIG_EOCD = 0x06054b50;   // 结尾记录
const SIG_CD = 0x02014b50;     // 中央目录项
const SIG_LOCAL = 0x04034b50;  // 本地文件头

const u16 = (b, p) => b[p] | (b[p + 1] << 8);
const u32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
const utf8 = b => new TextDecoder().decode(b);

/* 在 zip 里找到某个文件，返回 {start, size, method} */
function findEntry(buf, want) {
  let eocd = -1;
  const from = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= from; i--) {
    if (u32(buf, i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 包');

  const count = u16(buf, eocd + 10);
  let p = u32(buf, eocd + 16);

  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (u32(buf, p) !== SIG_CD) break;
    const method = u16(buf, p + 10);
    const compSize = u32(buf, p + 20);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    const localOff = u32(buf, p + 42);
    const name = utf8(buf.subarray(p + 46, p + 46 + nameLen));

    if (name === want) {
      if (u32(buf, localOff) !== SIG_LOCAL) throw new Error('zip 结构异常');
      const lNameLen = u16(buf, localOff + 26);
      const lExtraLen = u16(buf, localOff + 28);
      return { start: localOff + 30 + lNameLen + lExtraLen, size: compSize, method };
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

async function inflate(buf, e) {
  const raw = buf.subarray(e.start, e.start + e.size);
  if (e.method === 0) return utf8(raw);
  if (e.method !== 8) throw new Error('不支持的压缩方式：' + e.method);
  if (typeof DecompressionStream !== 'function') throw new Error('这个浏览器不支持解压 Word 文件');
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return await new Response(stream).text();
}

/* 一个 w:p 里的文字：w:t 收文字，w:tab 制表符，w:br 换行 */
function paraText(p) {
  let s = '';
  const walk = n => {
    for (const c of n.childNodes) {
      if (c.nodeType !== 1) continue;
      const ln = (c.localName || c.nodeName).toLowerCase();
      if (ln === 't' || ln === 'deltext') s += c.textContent || '';
      else if (ln === 'tab') s += '\t';
      else if (ln === 'br' || ln === 'cr') s += '\n';
      else walk(c);
    }
  };
  walk(p);
  return s;
}

export async function extractDocxText(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const e = findEntry(buf, 'word/document.xml');
  if (!e) throw new Error('里面没有 word/document.xml，可能不是 Word 文档');

  const xml = await inflate(buf, e);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Word 内容解析失败');

  const out = [];
  for (const p of doc.getElementsByTagName('w:p')) {
    const t = paraText(p).trim();
    if (t) out.push(t);
  }
  if (!out.length) throw new Error('这个 Word 文档里没有可读取的文字');
  return out.join('\n\n');
}

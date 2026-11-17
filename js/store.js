/* ═══════════════════════════════════════════
   store.js — 本地存储（三级降级）
   浏览器的本地存储不总是可用：无痕模式、被策略禁用、
   以及最坑的一种——嵌在别的页面里（对话预览面板）时是「不透明源」，
   碰 localStorage / IndexedDB 会直接抛 SecurityError。
   这里统一探测 + 内存兜底，保证即使存不了，功能也不能哑掉。
   抽成独立模块，是为了让 ink.js（笔迹）和 speech.js（朗读配置）
   也能直接复用同一套存储，不用各写一份。
   ═══════════════════════════════════════════ */

export const K_SET = 'rd.settings.v1', K_DOCS = 'rd.docs.v1', K_VOCAB = 'rd.vocab.v1';

export const store = { ls: true, idb: true, reason: '', embedded: false };
const memLS = new Map();          // 内存副本：永远是当前会话的权威数据
const memBlobs = new Map();

(function probe() {
  try { embeddedCheck(); } catch { }
  try {
    localStorage.setItem('__rd_probe', '1');
    localStorage.removeItem('__rd_probe');
  } catch (e) { store.ls = false; store.reason += '浏览器禁用了本地存储（' + (e.name || e.message) + '）'; }
  try { void indexedDB; } catch (e) {
    store.idb = false;
    store.reason += (store.reason ? '；' : '') + '浏览器禁用了本地数据库（' + (e.name || e.message) + '）';
  }
})();
function embeddedCheck() {
  try { store.embedded = window.self !== window.top; } catch { store.embedded = true; }
}
export function storageBroken() { return !store.ls || !store.idb; }

export const stGet = (k, d) => {
  if (store.ls) {
    try { const v = JSON.parse(localStorage.getItem(k)); if (v != null) return v; } catch { }
  }
  return memLS.has(k) ? memLS.get(k) : d;
};
export const stSet = (k, v) => {
  memLS.set(k, v);
  if (!store.ls) return false;
  try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; }
};

/* IndexedDB：存原始文件。
   注意：在某些嵌入环境里 indexedDB.open() 会「既不成功也不失败」——
   一个回调都不触发，await 就永远挂着（实测踩到，界面会卡在「正在导入…」）。
   所以所有存储操作都必须带超时。 */
const DB = 'rd-files', ST = 'blob';
let _db = null;

export const withTimeout = (p, ms, what) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error((what || '操作') + '超时')), ms);
  p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); });
});

function db() {
  if (_db) return Promise.resolve(_db);
  if (!store.idb) return Promise.reject(new Error('IndexedDB 不可用'));
  return withTimeout(new Promise((res, rej) => {
    let r;
    try { r = indexedDB.open(DB, 1); } catch (e) { return rej(e); }
    r.onupgradeneeded = () => { try { r.result.createObjectStore(ST); } catch { } };
    r.onsuccess = () => { _db = r.result; res(_db); };
    r.onerror = () => rej(r.error || new Error('IndexedDB 打开失败'));
    r.onblocked = () => rej(new Error('IndexedDB 被其他标签页占用'));
  }), 3000, '打开本地数据库');
}

export async function blobPut(k, v) {
  memBlobs.set(k, v);                       // 先落内存：这次一定能打开
  if (!store.idb) return;
  try {
    await withTimeout((async () => {
      const d = await db();
      await new Promise((res, rej) => {
        const t = d.transaction(ST, 'readwrite');
        t.objectStore(ST).put(v, k);
        t.oncomplete = res;
        t.onerror = () => rej(t.error || new Error('写入失败'));
      });
    })(), 5000, '写入本地数据库');
  } catch (e) {
    store.idb = false;
    console.warn('本地数据库不可用，本次会话改用内存存储：', e && e.message);
  }
}
export async function blobGet(k) {
  if (memBlobs.has(k)) return memBlobs.get(k);
  if (!store.idb) return undefined;
  try {
    return await withTimeout((async () => {
      const d = await db();
      return await new Promise((res, rej) => {
        const q = d.transaction(ST, 'readonly').objectStore(ST).get(k);
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
    })(), 5000, '读取本地数据库');
  } catch { return undefined; }
}
export async function blobDel(k) {
  memBlobs.delete(k);
  if (!store.idb) return;
  try {
    await withTimeout((async () => {
      const d = await db();
      await new Promise((res, rej) => {
        const t = d.transaction(ST, 'readwrite');
        t.objectStore(ST).delete(k);
        t.oncomplete = res;
        t.onerror = () => rej(t.error || new Error('删除失败'));
      });
    })(), 5000, '删除本地数据');
  } catch { }
}

/** 列出本地所有键（用于批量清理） */
export async function blobKeys() {
  const memKeys = [...memBlobs.keys()];
  if (!store.idb) return memKeys;
  try {
    const d = await db();
    const keys = await withTimeout(new Promise((res, rej) => {
      const q = d.transaction(ST, 'readonly').objectStore(ST).getAllKeys();
      q.onsuccess = () => res(q.result || []);
      q.onerror = () => rej(q.error);
    }), 5000, '列出本地数据');
    return [...new Set([...keys, ...memKeys])];
  } catch { return memKeys; }
}
export async function blobDelPrefix(prefix) {
  for (const k of [...memBlobs.keys()]) if (typeof k === 'string' && k.startsWith(prefix)) memBlobs.delete(k);
  if (!store.idb) return;
  const keys = (await blobKeys()).filter(k => typeof k === 'string' && k.startsWith(prefix));
  for (const k of keys) { try { await blobDel(k); } catch { } }
}

/* 英语阅读器 · Service Worker
   目标：App 外壳 + 离线词典本地缓存，断网也能开、能查词。 */

const VER = 'rd-v1.7.2';
const SHELL = `${VER}-shell`;
const DATA = `${VER}-data`;

const SHELL_FILES = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/dict.js',
  './js/ocr.js',
  './js/extract.js',
  './js/docx.js',
  './js/store.js',
  './js/ink.js',
  './js/speech.js',
  './js/polish.js',
  './js/terms.js',
  './js/vendor/pdf.min.mjs',
  './js/vendor/pdf.worker.min.mjs',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './sample/sample.pdf'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // 逐个添加，任何一个失败都不至于让整个安装挂掉
    await Promise.all(SHELL_FILES.map(f => c.add(new Request(f, { cache: 'reload' })).catch(() => { })));
    // 离线词典提前拉一次（失败也不阻塞）
    caches.open(DATA).then(dc => dc.add(new Request('./data/dict.tsv')).catch(() => { })).catch(() => { });
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !k.startsWith(VER)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

const isStatic = url =>
  /\.(?:css|js|mjs|png|jpg|jpeg|svg|webp|woff2?|ttf|json|webmanifest|gz|wasm)$/i.test(url.pathname);

/* ── 替静态服务器说清楚二进制的 MIME ──────────────
   Safari 对 WebAssembly 是硬校验：WebAssembly.instantiateStreaming 只接受
   application/wasm，别的（比如我们托管服务统一给的 application/octet-stream）
   会让它直接拒绝编译。Chromium 会宽容地回退，所以这个坑只在 iPad / iPhone 上暴露。
   这个 Service Worker 就在中间，把 Content-Type 改对了再放行。 */
const BIN_TYPE = p =>
  /\.wasm$/.test(p) ? 'application/wasm'
    : /\.traineddata\.gz$/.test(p) ? 'application/gzip'
      : null;

function fixType(res, type) {
  if (!res || !res.ok) return res || Response.error();
  const h = new Headers(res.headers);
  h.set('Content-Type', type);          // 只改这一项，其余头原样保留
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  /* 跨域（词典 / 翻译接口）：直接走网络，不缓存 */
  if (!sameOrigin) return;

  /* 导航：网络优先，断网回退到缓存的首页 */
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const c = await caches.open(SHELL);
        c.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        return (await caches.match('./index.html')) || (await caches.match('./')) || Response.error();
      }
    })());
    return;
  }

  /* 二进制（OCR 核心 wasm / 语言模型）：改对 MIME，并顺手缓存 */
  const binType = BIN_TYPE(url.pathname);
  if (binType) {
    e.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return fixType(hit, binType);
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then(c => c.put(req, copy)).catch(() => { });
        }
        return fixType(res, binType);
      } catch {
        return Response.error();
      }
    })());
    return;
  }

  /* 静态资源 & 词典：缓存优先 + 后台更新 */
  if (isStatic(url) || url.pathname.endsWith('/dict.tsv')) {
    e.respondWith((async () => {
      const cached = await caches.match(req, { ignoreSearch: false });
      const network = fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then(c => c.put(req, copy)).catch(() => { });
        }
        return res;
      }).catch(() => null);
      return cached || (await network) || Response.error();
    })());
  }
});

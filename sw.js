// Service Worker: アプリ本体をキャッシュし、オフラインでも開けるようにする。
//
// 方針は「ネットワーク優先」。オンラインのときは常に最新のファイルを取りに行き、
// 取れなかったとき（オフライン）だけキャッシュを使う。
// GitHub に更新を上げたのに古い画面が出続ける、という事故を避けるため。
// ファイルを追加・削除したときは、下の一覧と VERSION を更新する。

const VERSION = 'ggpm-0.1.0-phase1';
const FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/config.js',
  './js/storage.js',
  './js/sources.js',
  './js/voice.js',
  './js/ui-measure.js',
  './js/ui-calibrate.js',
  './js/ui-settings.js',
  './js/ui-logs.js',
  './js/core/homography.js',
  './js/core/kinematics.js',
  './js/core/analysis.js',
  './js/core/detector.js',
  './js/core/tracker.js',
  './js/core/pipeline.js',
  './js/core/simscene.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./index.html')))
  );
});

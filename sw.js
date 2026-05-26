// 改版時記得升 version，下次載入會清舊 cache
const CACHE = 'brotrip-v51';
const ASSETS = [
  './',
  './index.html',
  './styles.css?v=51',
  './manifest.json',
  './icons/icon.svg',
  './js/config.js?v=51',
  './js/groups.js?v=51',
  './js/cache.js?v=51',
  './js/auth.js?v=51',
  './js/api.js?v=51',
  './js/trips.js?v=51',
  './js/expenses.js?v=51',
  './js/diaries.js?v=51',
  './js/members.js?v=51',
  './js/nicknames.js?v=51',
  './js/comments.js?v=51',
  './js/notifications.js?v=51',
  './js/itineraries.js?v=51',
  './js/settlements.js?v=51',
  './js/app.js?v=51',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  // 不快取 Google API / GIS / Drive 縮圖
  if (
    url.includes('googleapis.com') ||
    url.includes('accounts.google.com') ||
    url.includes('google.com/uc') ||
    url.includes('drive.google.com')
  ) {
    return;
  }
  if (e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).catch(() => caches.match('./')))
  );
});

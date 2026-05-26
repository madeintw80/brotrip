// 改版時記得升 version，下次載入會清舊 cache
const CACHE = 'brotrip-v50';
const ASSETS = [
  './',
  './index.html',
  './styles.css?v=50',
  './manifest.json',
  './icons/icon.svg',
  './js/config.js?v=50',
  './js/groups.js?v=50',
  './js/cache.js?v=50',
  './js/auth.js?v=50',
  './js/api.js?v=50',
  './js/trips.js?v=50',
  './js/expenses.js?v=50',
  './js/diaries.js?v=50',
  './js/members.js?v=50',
  './js/nicknames.js?v=50',
  './js/comments.js?v=50',
  './js/notifications.js?v=50',
  './js/itineraries.js?v=50',
  './js/settlements.js?v=50',
  './js/app.js?v=50',
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

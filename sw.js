// 改版時記得升 version，下次載入會清舊 cache
const CACHE = 'brotrip-v358';
const ASSETS = [
  './',
  './index.html',
  './styles.css?v=355',
  './manifest.json',
  './icons/icon.svg',
  './js/config.js?v=300',
  './js/groups.js?v=300',
  './js/cache.js?v=300',
  './js/auth.js?v=300',
  './js/api.js?v=300',
  './js/trips.js?v=300',
  './js/expenses.js?v=300',
  './js/diaries.js?v=300',
  './js/members.js?v=300',
  './js/nicknames.js?v=300',
  './js/comments.js?v=300',
  './js/notifications.js?v=300',
  './js/itineraries.js?v=330',
  './js/settlements.js?v=300',
  './js/wishlist.js?v=340',
  './js/geo_notify.js?v=340',
  './js/notifications.js?v=340',
  './js/app.js?v=357',
  './js/diaries.js?v=330',
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

// v3.4.0 M6.3: notification click → focus or open app + 告訴 client 該跳到哪個 wish
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const wishId = data.wishId || '';
  const targetUrl = data.url || '/';

  e.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // 已開的 BroTrip window → focus + postMessage
    for (const c of clientList) {
      if (c.url.includes('brotrip') && 'focus' in c) {
        c.postMessage({ type: 'wish-notify-click', wishId });
        return c.focus();
      }
    }
    // 沒開的 → 新開 window 帶 ?focus_wish=<id>
    if (self.clients.openWindow) {
      const url = wishId ? `${targetUrl}?focus_wish=${encodeURIComponent(wishId)}` : targetUrl;
      return self.clients.openWindow(url);
    }
  })());
});

// v3.4.0 M6.3: client 透過 postMessage 請 SW 顯示通知（讓 iOS PWA 在背景時也能推系統通知）
self.addEventListener('message', (e) => {
  const msg = e.data || {};
  if (msg.type === 'show-wish-notification') {
    const { title, body, wishId, icon } = msg;
    self.registration.showNotification(title || 'BroTrip', {
      body: body || '',
      icon: icon || './icons/icon.svg',
      badge: './icons/icon.svg',
      tag: `wish-${wishId}`,   // 同 wish 重複通知會 replace 而不堆疊
      data: { wishId, url: './' },
      // iOS PWA 支援的選項有限，保持簡單
    });
  }
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

// 附近 wishlist 推播模組 — v3.4.0 (M6.3)
//
// 功能：旅遊中走在路上經過 wishlist 地點 (< 500m) → 推播提醒
//
// 平台限制 (見 docs/wishlist_m6_design.md §5)：
//   - iOS PWA: foreground watchPosition + SW showNotification → 可以在 PWA「被切到背景但沒被 kill」時推系統通知
//   - 完全 background / app killed → 純 client 端 PWA 做不到，需要 backend (留 M7+)
//
// 防 spam：
//   - 每 wish 30 分鐘內只通知一次 (localStorage `brotrip_geo_notif_<wishId>` = timestamp)
//   - 每 session 最多 5 次推播
//
// 電量考量：
//   - 只在 wishlist/map/itinerary tab active 時啟動 watchPosition
//   - 切走其他 tab 或 app 進背景 → clearWatch (省電)

const GeoNotify = {
  // Permission state: 'unset' | 'granted' | 'declined' | 'unsupported'
  STORAGE_KEY: 'brotrip_geo_notify_pref',

  // Runtime state
  _watchId: null,
  _sessionNotifCount: 0,
  _enabled: false,

  // 配置
  DISTANCE_THRESHOLD_M: 500,      // 500m 內觸發
  DEDUP_WINDOW_MS: 30 * 60 * 1000, // 同 wish 30 分鐘 cooldown
  SESSION_NOTIF_CAP: 5,            // 同 session 最多 5 推

  // ===== Permission =====

  // 'unset' | 'granted' | 'declined' | 'unsupported'
  getPref() {
    if (!this.isSupported()) return 'unsupported';
    try {
      return localStorage.getItem(this.STORAGE_KEY) || 'unset';
    } catch { return 'unset'; }
  },

  setPref(val) {
    try { localStorage.setItem(this.STORAGE_KEY, val); } catch {}
  },

  isSupported() {
    return !!(navigator.geolocation && navigator.geolocation.watchPosition
      && 'Notification' in window
      && 'serviceWorker' in navigator);
  },

  // 請求所有必要 permission：geolocation + notification
  // 回傳 'granted' | 'denied' | 'unsupported'
  async requestPermissions() {
    if (!this.isSupported()) {
      this.setPref('unsupported');
      return 'unsupported';
    }

    // Notification permission
    let notifPerm = Notification.permission;
    if (notifPerm === 'default') {
      try {
        notifPerm = await Notification.requestPermission();
      } catch (err) {
        console.warn('Notification.requestPermission failed:', err);
        notifPerm = 'denied';
      }
    }
    if (notifPerm !== 'granted') {
      this.setPref('declined');
      return 'denied';
    }

    // Geolocation permission：直接 getCurrentPosition 一次（首次會跳系統 permission prompt）
    try {
      await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: false,
          timeout: 10000,
          maximumAge: 60000,
        });
      });
    } catch (err) {
      console.warn('Geolocation permission denied/failed:', err);
      this.setPref('declined');
      return 'denied';
    }

    this.setPref('granted');
    return 'granted';
  },

  // ===== Lifecycle =====

  // 啟動 watchPosition（已有 permission 才呼叫）
  start() {
    if (this._watchId !== null) return; // 已啟動
    if (this.getPref() !== 'granted') return;
    if (!this.isSupported()) return;

    try {
      this._watchId = navigator.geolocation.watchPosition(
        (pos) => this._onPosition(pos),
        (err) => console.warn('[GeoNotify] watch error:', err),
        {
          enableHighAccuracy: false,   // 省電：500m 範圍不需要 GPS 精度
          maximumAge: 30000,           // 30 秒內的 cached position 可用
          timeout: 60000,
        }
      );
      this._enabled = true;
      console.log('[GeoNotify] watchPosition started, id=', this._watchId);
    } catch (err) {
      console.warn('[GeoNotify] start failed:', err);
    }
  },

  stop() {
    if (this._watchId !== null) {
      try { navigator.geolocation.clearWatch(this._watchId); } catch {}
      this._watchId = null;
      this._enabled = false;
      console.log('[GeoNotify] watchPosition stopped');
    }
  },

  isRunning() { return this._watchId !== null; },

  // ===== Position handler =====

  _onPosition(pos) {
    if (typeof Wishlist === 'undefined' || !Wishlist.list) return;
    if (this._sessionNotifCount >= this.SESSION_NOTIF_CAP) return;

    const { latitude: myLat, longitude: myLng } = pos.coords;

    // 找最近的 planned wish (status=planned 才推；promoted/visited 不重複推)
    const candidates = Wishlist.list.filter(w =>
      (w.status || 'planned') === 'planned' && w.lat && w.lng
    );

    for (const wish of candidates) {
      const wLat = parseFloat(wish.lat);
      const wLng = parseFloat(wish.lng);
      if (isNaN(wLat) || isNaN(wLng)) continue;

      const dist = this._haversineMeters(myLat, myLng, wLat, wLng);
      if (dist > this.DISTANCE_THRESHOLD_M) continue;

      // dedup check
      if (this._wasRecentlyNotified(wish.id)) continue;

      this._notify(wish, Math.round(dist));
      this._markNotified(wish.id);
      this._sessionNotifCount++;

      if (this._sessionNotifCount >= this.SESSION_NOTIF_CAP) break;
    }
  },

  // ===== 距離計算 (Haversine) =====
  _haversineMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000; // Earth radius in meters
    const toRad = deg => deg * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  },

  // ===== Dedup =====
  _wasRecentlyNotified(wishId) {
    try {
      const ts = parseInt(localStorage.getItem(`brotrip_geo_notif_${wishId}`) || '0', 10);
      return ts && (Date.now() - ts) < this.DEDUP_WINDOW_MS;
    } catch { return false; }
  },

  _markNotified(wishId) {
    try { localStorage.setItem(`brotrip_geo_notif_${wishId}`, String(Date.now())); } catch {}
  },

  // 清除所有 dedup 記錄（給 settings 「重置推播 cooldown」按鈕用）
  resetCooldowns() {
    try {
      Object.keys(localStorage).forEach(k => {
        if (k.startsWith('brotrip_geo_notif_')) localStorage.removeItem(k);
      });
    } catch {}
  },

  // ===== 推播 =====

  _notify(wish, distMeters) {
    const typeIcon = (Wishlist.TYPE_LABEL && Wishlist.TYPE_LABEL[wish.type]) || '📍';
    const addedBy = (typeof App !== 'undefined' && App.nameOf)
      ? (App.nameOf(wish.added_by) || (wish.added_by || '').split('@')[0])
      : (wish.added_by || '').split('@')[0];
    const title = `${typeIcon} 附近有個 wish`;
    const body = `${wish.name}\n${addedBy} 加的 · 距離約 ${distMeters} 公尺`;

    // App 在 foreground 且 wishlist/map tab → 用 in-app toast (沒必要打擾 OS notification)
    const isAppForeground = !document.hidden;
    const isOnRelevantTab = (typeof App !== 'undefined' && App.currentTab &&
      ['wishlist', 'map', 'expenses', 'diaries'].includes(App.currentTab));

    if (isAppForeground && isOnRelevantTab && typeof App !== 'undefined' && App.toast) {
      App.toast(`${typeIcon} 附近 ${distMeters}m 有 wish「${wish.name}」`);
      return;
    }

    // 否則：用 SW notification（即使 PWA 被切到背景但沒 kill 也能推系統通知欄）
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'show-wish-notification',
        title, body, wishId: wish.id,
        icon: './icons/icon.svg',
      });
    } else if ('Notification' in window && Notification.permission === 'granted') {
      // Fallback: 直接用 Notification API（不經過 SW）— 對 desktop 還是 work
      try {
        const n = new Notification(title, { body, icon: './icons/icon.svg', tag: `wish-${wish.id}` });
        n.onclick = () => {
          window.focus();
          if (typeof App !== 'undefined' && App.switchTab) App.switchTab('wishlist');
        };
      } catch (err) { console.warn('Notification fallback failed:', err); }
    }
  },
};

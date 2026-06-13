// localStorage cache for sheet data
// 目的：開 app 瞬間從 cache 渲染（< 100ms），背景再 fetch sheet 更新
// 所有 mutation (create/update/delete) 同步更新 cache 保持一致
// 啟動時清舊版本 cache（CACHE.VERSION 改變時自動清除）

const Cache = {
  VERSION: '4',  // v4: Phase 2 per-group key（每個群組獨立 cache 避免切換時混淆）

  // PREFIX 加入 groupId 隔離，避免切群組看到別組資料
  // 例：brotrip_cache_v4_tgl_legacy_nicknames
  get PREFIX() {
    const gid = (typeof Groups !== 'undefined' && Groups.active())
      ? Groups.active().groupId
      : 'nogroup';
    return `brotrip_cache_v${this.VERSION}_${gid}_`;
  },

  init() {
    // 清掉舊版本 cache（不同版本 + Phase 1 沒 groupId 的 cache）
    try {
      Object.keys(localStorage).forEach(k => {
        if (k.startsWith('brotrip_cache_') && !k.startsWith(this.PREFIX)) {
          localStorage.removeItem(k);
        }
      });
    } catch {}
  },

  get(key) {
    try {
      const raw = localStorage.getItem(this.PREFIX + key);
      if (raw) return JSON.parse(raw);
    } catch (err) {
      console.warn('Cache get failed:', err);
    }
    return null;
  },

  set(key, data) {
    try {
      localStorage.setItem(this.PREFIX + key, JSON.stringify(data));
    } catch (err) {
      console.warn('Cache set failed:', err);
      // QuotaExceededError → 清掉所有 cache 再試一次
      if (err && err.name === 'QuotaExceededError') {
        try {
          this.clear();
          localStorage.setItem(this.PREFIX + key, JSON.stringify(data));
        } catch (err2) {
          console.warn('Cache retry failed:', err2);
        }
      }
    }
  },

  clear() {
    try {
      Object.keys(localStorage).forEach(k => {
        if (k.startsWith(this.PREFIX)) localStorage.removeItem(k);
      });
    } catch {}
  },
};

// 啟動時清舊版 cache
Cache.init();

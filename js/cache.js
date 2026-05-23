// localStorage cache for sheet data
// 目的：開 app 瞬間從 cache 渲染（< 100ms），背景再 fetch sheet 更新
// 所有 mutation (create/update/delete) 同步更新 cache 保持一致
// 啟動時清舊版本 cache（CACHE.VERSION 改變時自動清除）

const Cache = {
  VERSION: '3',  // 每次 sheet schema 改變要 bump（清除舊 cache）

  get PREFIX() { return `brotrip_cache_v${this.VERSION}_`; },

  init() {
    // 清掉舊版本 cache（其他版本的 prefix）
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
      localStorage.setItem(this.PREFIX + '__meta__', JSON.stringify({
        lastSync: new Date().toISOString(),
      }));
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

  meta() {
    try {
      const raw = localStorage.getItem(this.PREFIX + '__meta__');
      if (raw) return JSON.parse(raw);
    } catch {}
    return null;
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

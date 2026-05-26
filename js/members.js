// Members 模組 — M4: 取代 CONFIG.ALLOWED_MEMBERS 寫死的成員清單
// 每個群組各自的 Members sheet 存：email | display_name | joined_at
// 群組擁有者建立時自動寫入自己，新成員 join 時透過 dialog 寫入
//
// Backward compat: 若 Members sheet 是空的（legacy TGL 場景），
// 自動 fallback 到 CONFIG.ALLOWED_MEMBERS，讓舊群組無痛升級

const Members = {
  list: [],  // 當前 active group 的 Members rows（[{email, display_name, joined_at}, ...]）

  loadFromCache() {
    const data = Cache.get('members');
    if (Array.isArray(data)) {
      this.list = data;
      return true;
    }
    return false;
  },

  async loadAll() {
    try {
      const rows = await API.getSheet('Members');
      this.list = API.rowsToObjects(rows);
      Cache.set('members', this.list);
    } catch (err) {
      console.warn('Members.loadAll failed:', err);
      // 不清空現有 list（保留 cache）
    }
    return this.list;
  },

  // ===== 讀取方法（都含 legacy ALLOWED_MEMBERS fallback）=====

  // 用 email 找 member 物件
  getByEmail(email) {
    return this.list.find(m => m.email === email) || null;
  },

  // 用 email 取 display_name；沒有就 fallback 到 ALLOWED_MEMBERS（legacy TGL）
  getName(email) {
    const m = this.getByEmail(email);
    if (m && m.display_name) return m.display_name;
    if (typeof CONFIG !== 'undefined' && CONFIG.ALLOWED_MEMBERS) {
      const am = CONFIG.ALLOWED_MEMBERS.find(x => x.email === email);
      if (am) return am.name;
    }
    return '';
  },

  // 取所有 members（給設定 tab / mention 等列表 UI 用）
  // 格式：[{email, name, joined_at}]
  all() {
    // 優先用 Members.list（新群組正確的成員）
    if (this.list.length > 0) {
      return this.list.map(m => ({
        email: m.email,
        name: m.display_name || m.email.split('@')[0],
        joined_at: m.joined_at || '',
      }));
    }
    // Fallback: legacy TGL 用 ALLOWED_MEMBERS（Members sheet 沒寫的舊群組）
    if (typeof CONFIG !== 'undefined' && CONFIG.ALLOWED_MEMBERS) {
      return CONFIG.ALLOWED_MEMBERS.map(m => ({
        email: m.email,
        name: m.name,
        joined_at: '',
      }));
    }
    return [];
  },

  // 用 name 反查 member（給 mention parse @用）
  findByName(name) {
    const m = this.list.find(x =>
      x.display_name === name || x.email.split('@')[0] === name
    );
    if (m) return { email: m.email, name: m.display_name || m.email.split('@')[0] };
    // Fallback ALLOWED_MEMBERS
    if (typeof CONFIG !== 'undefined' && CONFIG.ALLOWED_MEMBERS) {
      const am = CONFIG.ALLOWED_MEMBERS.find(x => x.name === name);
      if (am) return { email: am.email, name: am.name };
    }
    return null;
  },
};

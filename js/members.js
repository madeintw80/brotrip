// Members 模組 — M4.2: 完全動態，不再 fallback 到任何寫死名單
// 每個群組各自的 Members sheet 存：email | display_name | joined_at
//   - M2 建立群組時自動寫入 owner
//   - M3 加入時 dialog 確認 display_name 後寫入
//
// Fallback 邏輯：當 Members.list 為空（例如新群組剛建好還沒 loadAll），
// 至少包含「當前用戶自己」（Auth.user），避免完全沒人可選

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

  // ===== 讀取方法（自我 fallback：list 空時至少回當前用戶）=====

  // 取得當前用戶的 "Members row 物件"（給 fallback 用）
  _selfMember() {
    if (typeof Auth !== 'undefined' && Auth.user) {
      return {
        email: Auth.user.email,
        display_name: Auth.user.name || Auth.user.email.split('@')[0],
        joined_at: '',
      };
    }
    return null;
  },

  // 用 email 找 member 物件
  getByEmail(email) {
    return this.list.find(m => m.email === email) || null;
  },

  // 用 email 取 display_name
  // 1. Members sheet 有 → 用 display_name
  // 2. 是當前用戶自己 → 用 Gmail 名（即使 sheet 沒寫）
  // 3. 都沒有 → 回空字串（呼叫者用 email prefix fallback）
  getName(email) {
    const m = this.getByEmail(email);
    if (m && m.display_name) return m.display_name;
    if (typeof Auth !== 'undefined' && Auth.user && email === Auth.user.email) {
      return Auth.user.name || '';
    }
    return '';
  },

  // 取所有 members（給設定 tab / mention 等列表 UI 用）
  // 格式：[{email, name, joined_at}]
  // list 空時至少回當前用戶（避免「新群組第一次開沒任何成員可選」的尷尬）
  // v3.1.0: 按 email 去重（保留第一筆有 display_name 的）
  //         修復 bug：早期版本 _tryJoin 沒檢查重複，朋友在不同裝置加入時 Members sheet 會有重複 row
  all() {
    if (this.list.length > 0) {
      const seen = new Set();
      const result = [];
      for (const m of this.list) {
        if (!m.email || seen.has(m.email)) continue;
        seen.add(m.email);
        result.push({
          email: m.email,
          name: m.display_name || m.email.split('@')[0],
          joined_at: m.joined_at || '',
        });
      }
      return result;
    }
    // Fallback: 至少包含當前用戶自己
    const self = this._selfMember();
    if (self) {
      return [{
        email: self.email,
        name: self.display_name,
        joined_at: self.joined_at,
      }];
    }
    return [];
  },

  // 用 name 反查 member（給 mention parse @用）
  findByName(name) {
    const m = this.list.find(x =>
      x.display_name === name || x.email.split('@')[0] === name
    );
    if (m) return { email: m.email, name: m.display_name || m.email.split('@')[0] };
    // Self fallback
    if (typeof Auth !== 'undefined' && Auth.user) {
      const selfName = Auth.user.name;
      const selfPrefix = Auth.user.email.split('@')[0];
      if (selfName === name || selfPrefix === name) {
        return { email: Auth.user.email, name: selfName || selfPrefix };
      }
    }
    return null;
  },
};

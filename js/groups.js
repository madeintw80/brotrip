// Groups 模組 — Phase 2 多群組管理
// 每群組存在用戶 Drive 的獨立資料夾+Sheet
// localStorage 存群組清單和當前 active group id
// Phase 1 → Phase 2 升級時自動 migration（用 CONFIG 建 TGL 群組）

const Groups = {
  list: [],        // 所有已加入的群組
  activeId: null,  // 當前活躍的群組 id

  STORAGE_KEY: 'brotrip_groups',
  ACTIVE_KEY: 'brotrip_active_group',

  // 初始化：從 localStorage 載入 + 自動 migration
  init() {
    this._load();

    // 🔄 自動 migration：第一次跑 Phase 2 且有 CONFIG.SHEET_ID
    //   → 把現有資料夾包成 TGL 群組，5 男好友無感升級
    if (this.list.length === 0 && typeof CONFIG !== 'undefined' && CONFIG.SHEET_ID) {
      this.add({
        groupId: 'tgl_legacy',
        name: 'TGL',
        sheetId: CONFIG.SHEET_ID,
        folderId: CONFIG.ROOT_FOLDER_ID,
        photosFolderId: CONFIG.PHOTOS_FOLDER_ID,
        role: 'member',
      });
      this.setActive('tgl_legacy');
      console.log('[Groups] Auto-migrated Phase 1 → Phase 2: created TGL group');
    }
  },

  // 從 localStorage 載入群組清單和 active id
  _load() {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          // 過濾掉壞掉的條目（缺 groupId 或 sheetId）
          this.list = parsed.filter(g => g && g.groupId && g.sheetId);
        }
      }
      this.activeId = localStorage.getItem(this.ACTIVE_KEY);
      // active id 不在 list 內 → 預設第一個
      if (!this.list.find(g => g.groupId === this.activeId) && this.list.length > 0) {
        this.activeId = this.list[0].groupId;
      }
    } catch (err) {
      console.warn('Groups load failed:', err);
      this.list = [];
      this.activeId = null;
    }
  },

  // 寫回 localStorage
  _save() {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.list));
      if (this.activeId) {
        localStorage.setItem(this.ACTIVE_KEY, this.activeId);
      } else {
        localStorage.removeItem(this.ACTIVE_KEY);
      }
    } catch (err) {
      console.warn('Groups save failed:', err);
    }
  },

  // 取得當前 active group 物件，沒有則回 null
  active() {
    if (!this.activeId) return null;
    return this.list.find(g => g.groupId === this.activeId) || null;
  },

  // 切換 active group
  setActive(groupId) {
    if (this.list.find(g => g.groupId === groupId)) {
      this.activeId = groupId;
      this._save();
      return true;
    }
    return false;
  },

  // 加新群組（重複會更新而非重複加）
  add(group) {
    if (!group || !group.groupId || !group.sheetId) return false;
    const exists = this.list.find(g => g.groupId === group.groupId);
    if (exists) {
      Object.assign(exists, group);
    } else {
      this.list.push(group);
    }
    this._save();
    return true;
  },

  // 移除群組（M3 才會用到，M1 先寫好）
  remove(groupId) {
    const idx = this.list.findIndex(g => g.groupId === groupId);
    if (idx === -1) return false;
    this.list.splice(idx, 1);
    if (this.activeId === groupId) {
      this.activeId = this.list.length > 0 ? this.list[0].groupId : null;
    }
    this._save();
    return true;
  },

  // 取得所有群組（供 UI 列表用）
  all() {
    return [...this.list];
  },
};

// 模組載入時立即 init（在 cache.js 載入前就要有 active group，
// 因為 cache PREFIX 會依賴 Groups.active().groupId）
Groups.init();

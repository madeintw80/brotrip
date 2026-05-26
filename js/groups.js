// Groups 模組 — Phase 2 多群組管理
// 每群組存在用戶 Drive 的獨立資料夾+Sheet（BroTrip/<group_name>/）
// localStorage 存群組清單和當前 active group id

// 9 個分頁的 schema（Sheet 建立時用）
const GROUP_SCHEMA = {
  Trips: ['trip_id', 'name', 'start_date', 'end_date', 'members', 'created_by', 'created_at'],
  Expenses: ['id', 'trip_id', 'date', 'payer', 'amount', 'currency', 'category', 'description', 'splits', 'photo_url', 'created_at', 'payers', 'settled'],
  Diaries: ['id', 'trip_id', 'date', 'author', 'content', 'mood', 'photo_ids', 'location', 'created_at', 'pinned', 'drive_folder_url', 'mentions'],
  Members: ['email', 'display_name', 'joined_at'],
  Nicknames: ['target_email', 'nickname', 'updated_by', 'updated_at'],
  Comments: ['id', 'diary_id', 'author', 'content', 'created_at', 'mentions'],
  Notifications: ['id', 'target_email', 'type', 'diary_id', 'comment_id', 'from_email', 'created_at'],
  Itineraries: ['id', 'trip_id', 'name', 'waypoints', 'travel_mode', 'author', 'created_at'],
  Settlements: ['id', 'trip_id', 'from_email', 'to_email', 'amount', 'currency', 'status', 'note', 'created_at', 'confirmed_at'],
};

const Groups = {
  list: [],        // 所有已加入的群組
  activeId: null,  // 當前活躍的群組 id

  STORAGE_KEY: 'brotrip_groups',
  ACTIVE_KEY: 'brotrip_active_group',

  // 初始化：從 localStorage 載入 + 自動 migration
  init() {
    this._load();

    // 🔄 自動 migration：第一次跑 Phase 2 且有 CONFIG.SHEET_ID
    //   → 把現有資料夾包成 TGL 群組（5 男好友無感升級）
    // M4: 加 migration_done 旗標，避免「用戶手動刪除 legacy 群組後 → reload 又被加回來」的 loop
    const migrationDone = localStorage.getItem('brotrip_legacy_migrated');
    if (this.list.length === 0 && !migrationDone && typeof CONFIG !== 'undefined' && CONFIG.SHEET_ID) {
      this.add({
        groupId: 'tgl_legacy',
        name: 'TGL',
        sheetId: CONFIG.SHEET_ID,
        folderId: CONFIG.ROOT_FOLDER_ID,
        photosFolderId: CONFIG.PHOTOS_FOLDER_ID,
        sheetTabIds: CONFIG.SHEET_TAB_IDS || {},  // legacy tab IDs from config
        role: 'member',
      });
      this.setActive('tgl_legacy');
      localStorage.setItem('brotrip_legacy_migrated', '1');
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
          this.list = parsed.filter(g => g && g.groupId && g.sheetId);
        }
      }
      this.activeId = localStorage.getItem(this.ACTIVE_KEY);
      if (!this.list.find(g => g.groupId === this.activeId) && this.list.length > 0) {
        this.activeId = this.list[0].groupId;
      }
    } catch (err) {
      console.warn('Groups load failed:', err);
      this.list = [];
      this.activeId = null;
    }
  },

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

  // 移除群組（只移除本地紀錄，Drive 資料夾不會刪）
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

  // 取得所有群組
  all() {
    return [...this.list];
  },

  // ===== M2: 建立新群組 =====
  // 流程：
  //   1. ensureFolder('BroTrip', 'root')      → 私人父資料夾
  //   2. ensureFolder(name, parentId)         → 群組子資料夾
  //   3. ensureFolder('photos', groupFolder)  → photos 資料夾
  //   4. createSpreadsheet('BroTrip-Data')    → 建 Sheet（先在 root）
  //   5. moveFileToFolder(sheet, groupFolder) → 把 Sheet 搬進群組資料夾
  //   6. addSheetTabs(...) × 8                → 加另外 8 個 tab
  //   7. setSheetHeaders × 9                  → 寫 9 個 tab 的 headers
  //   8. 加進 list，切換 active
  //   9. appendRow('Members', [self])         → 寫第一筆成員（自己）
  async create(name, onProgress) {
    if (!name || !name.trim()) throw new Error('群組名稱必填');
    name = name.trim();

    // 重複檢查
    if (this.list.find(g => g.name === name)) {
      throw new Error(`群組「${name}」已存在`);
    }

    const progress = (step, total, msg) => {
      if (onProgress) onProgress(step, total, msg);
    };

    try {
      // Step 1: BroTrip 父資料夾
      progress(1, 9, '建立 BroTrip 父資料夾...');
      const broTripFolderId = await API.ensureFolder('BroTrip', 'root');

      // Step 2: 群組子資料夾
      progress(2, 9, `建立群組資料夾 ${name}...`);
      const groupFolderId = await API.ensureFolder(name, broTripFolderId);

      // Step 3: photos 子資料夾
      progress(3, 9, '建立 photos 資料夾...');
      const photosFolderId = await API.ensureFolder('photos', groupFolderId);

      // Step 4: 建立 Sheet
      progress(4, 9, '建立 Google Sheet...');
      const sheet = await API.createSpreadsheet('BroTrip-Data');
      const sheetId = sheet.spreadsheetId;
      // 預設 tab 是 Trips，取它的 sheetId
      const tripsTabId = sheet.sheets[0].properties.sheetId;

      // Step 5: 把 Sheet 搬進群組資料夾
      progress(5, 9, '整理檔案位置...');
      await API.moveFileToFolder(sheetId, groupFolderId);

      // Step 6: 加另外 8 個 tab
      progress(6, 9, '建立資料表分頁...');
      const otherTabs = ['Expenses', 'Diaries', 'Members', 'Nicknames', 'Comments', 'Notifications', 'Itineraries', 'Settlements'];
      const otherTabIds = await API.addSheetTabs(sheetId, otherTabs);
      const sheetTabIds = { Trips: tripsTabId, ...otherTabIds };

      // Step 7: 寫所有 9 個 tab 的 headers
      progress(7, 9, '寫入欄位定義...');
      for (const tabName of Object.keys(GROUP_SCHEMA)) {
        await API.setSheetHeaders(sheetId, tabName, GROUP_SCHEMA[tabName]);
      }

      // Step 8: 加進 list 並 setActive
      progress(8, 9, '設定群組...');
      const groupId = 'g_' + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
      const newGroup = {
        groupId,
        name,
        sheetId,
        folderId: groupFolderId,
        photosFolderId,
        sheetTabIds,
        role: 'owner',
        createdAt: new Date().toISOString(),
      };
      this.add(newGroup);
      this.setActive(groupId);

      // Step 9: 寫第一筆 Member（自己）— 此時 Groups.active() 已切到新群組
      progress(9, 9, '加入你為第一位成員...');
      await API.appendRow('Members', [
        Auth.user.email,
        Auth.user.name || Auth.user.email.split('@')[0],
        new Date().toISOString(),
      ]);

      return newGroup;
    } catch (err) {
      // 失敗：記 log，但不 rollback（避免複雜化，用戶下次重試或手動清 Drive）
      console.error('Groups.create failed:', err);
      throw err;
    }
  },

  // ===== M2: 重新命名群組 =====
  // 改 localStorage 紀錄 + 同步改 Drive 群組資料夾名稱
  // 不影響 Sheet 內容、photos 子資料夾、邀請碼有效性（這些都靠 ID 而非名稱）
  async rename(groupId, newName) {
    newName = (newName || '').trim();
    if (!newName) throw new Error('新名稱不能空白');

    const group = this.list.find(g => g.groupId === groupId);
    if (!group) throw new Error('找不到該群組');
    if (group.name === newName) return group;  // 沒變動

    // 重複檢查（同 user 不能有兩個同名群組）
    if (this.list.find(g => g.groupId !== groupId && g.name === newName)) {
      throw new Error(`群組「${newName}」已存在`);
    }

    // 改 Drive 資料夾名稱（如果有 folderId 才改，legacy TGL 也適用）
    if (group.folderId) {
      await API.renameDriveFile(group.folderId, newName);
    }

    // 更新本地
    group.name = newName;
    this._save();

    return group;
  },

  // ===== M4.4: 退出 / 刪除 / 踢人 =====

  // Member 退出群組（owner 不能用這個，要用 deleteGroup）
  // 流程：
  //   1. 從 Members sheet 刪自己的 row（其他成員看不到「離開的人」）
  //   2. 從本地 Groups 移除
  //   3. （Drive 權限要 owner 收回，這裡無法主動撤銷自己的權限）
  // 歷史 trip / expense / diary 都保留（其他人的紀錄會引用到 email，nameOf 會 fallback 到 email prefix）
  async leave(groupId) {
    const group = this.list.find(g => g.groupId === groupId);
    if (!group) throw new Error('找不到該群組');
    if (group.role === 'owner') {
      throw new Error('你是這個群組的擁有者，請改用「刪除群組」');
    }

    // 嘗試從 Members sheet 移除（失敗也繼續，至少本地能清掉）
    if (group.sheetTabIds && group.sheetTabIds.Members !== undefined) {
      try {
        // 暫時把 active 切到要 leave 的群組（讓 API 認得 sheetId）
        const prevActive = this.activeId;
        this.activeId = groupId;
        await API.deleteRow('Members', Auth.user.email);
        this.activeId = prevActive;
      } catch (err) {
        console.warn('Failed to remove from Members sheet:', err);
      }
    }

    // 從本地移除（同時 setActive 切到其他群組）
    this.remove(groupId);
    return true;
  },

  // Owner 踢成員出群組
  // 流程：
  //   1. Members sheet 刪該 email 的 row
  //   2. Drive 撤銷該 email 的存取權限
  //   3. 該 member 下次 reload 會 403 → M4.1 fix 自動把群組從他 localStorage 清掉
  async kickMember(groupId, memberEmail) {
    const group = this.list.find(g => g.groupId === groupId);
    if (!group) throw new Error('找不到群組');
    if (group.role !== 'owner') throw new Error('只有 owner 可以踢人');
    if (memberEmail === Auth.user.email) {
      throw new Error('不能踢自己（要刪整個群組請用「刪除群組」）');
    }

    // 1. 從 Members sheet 移除
    const prevActive = this.activeId;
    this.activeId = groupId;
    try {
      await API.deleteRow('Members', memberEmail);
    } catch (err) {
      console.warn('Failed to remove from Members sheet:', err);
    } finally {
      this.activeId = prevActive;
    }

    // 2. Drive 撤銷權限
    if (group.folderId) {
      try {
        await API.revokeDrivePermission(group.folderId, memberEmail);
      } catch (err) {
        console.warn('Failed to revoke Drive permission:', err);
        throw new Error('Drive 權限撤銷失敗：' + (err.message || '未知錯誤'));
      }
    }

    return true;
  },

  // Owner 刪除整個群組
  // 流程：
  //   1. Drive 刪掉群組資料夾（連 Sheet + photos 一起刪，所有成員的 app 會 404 → 自動清 localStorage）
  //   2. 本地 Groups 移除
  // ⚠️ 不可復原！所有 trip / expense / diary / 照片全部消失
  async deleteGroup(groupId) {
    const group = this.list.find(g => g.groupId === groupId);
    if (!group) throw new Error('找不到群組');
    if (group.role !== 'owner') throw new Error('只有 owner 可以刪除群組');

    // 1. 刪 Drive 整個資料夾
    if (group.folderId) {
      try {
        await API.deleteDriveFile(group.folderId);
      } catch (err) {
        console.warn('Failed to delete Drive folder:', err);
        throw new Error('Drive 資料夾刪除失敗：' + (err.message || '未知錯誤'));
      }
    }

    // 2. 本地移除
    this.remove(groupId);
    return true;
  },

  // ===== M2: 邀請碼編解碼 =====
  // 邀請碼 = base64(JSON({s:sheetId, f:folderId, p:photosFolderId, t:sheetTabIds, n:name, c:createdBy}))
  // 注意：邀請碼不算機密，沒 Drive 分享還是讀不到資料

  // ===== M4.3: 邀請連結（取代純邀請碼）=====
  // 產一個朋友點開就能用的 URL
  // 格式：<current origin + path>?invite=<encoded>
  buildInviteLink(group) {
    const code = this.encodeInvite(group);
    if (!code) return '';
    const url = new URL(window.location.href);
    url.search = '';   // 清掉現有 query params
    url.hash = '';
    url.searchParams.set('invite', code);
    return url.toString();
  },

  encodeInvite(group) {
    if (!group) return '';
    const payload = {
      s: group.sheetId,
      f: group.folderId,
      p: group.photosFolderId,
      t: group.sheetTabIds,
      n: group.name,
      c: (typeof Auth !== 'undefined' && Auth.user) ? Auth.user.email : '',
    };
    // base64url（URL safe）
    const json = JSON.stringify(payload);
    const b64 = btoa(unescape(encodeURIComponent(json)));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },

  // ===== M3: 用邀請碼加入群組 =====
  // 流程：
  //   1. 解碼邀請碼 → 取出 sheetId / folderId 等
  //   2. 試讀 Sheet → 403 throw PERMISSION_DENIED（含 folderId 給 UI 用）
  //   3. 有權限 → 加進 list、setActive
  //   4. 由 UI 後續處理 display_name + 寫 Members row
  async joinByInvite(code) {
    const data = this.decodeInvite(code);
    if (!data) throw new Error('邀請碼格式錯誤，請確認複製完整');

    // 已加入檢查
    if (this.list.find(g => g.sheetId === data.sheetId)) {
      throw new Error(`你已經加入「${data.name}」這個群組了`);
    }

    // 試讀 Sheet 確認權限（用 Sheets API 而非 sheetsRequest 因為 active group 不是這個）
    const token = await Auth.ensureToken();
    const probeUrl = `https://sheets.googleapis.com/v4/spreadsheets/${data.sheetId}/values/Trips!A1:A1`;
    const resp = await fetch(probeUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      if (resp.status === 403 || resp.status === 401) {
        // 沒權限 — throw 特殊 error 讓 UI 自動處理 request access flow
        const err = new Error('PERMISSION_DENIED');
        err.code = 'PERMISSION_DENIED';
        err.folderId = data.folderId;
        err.ownerEmail = data.createdBy || '';
        err.groupName = data.name;
        err.inviteData = data;  // UI 重試時不用再 decode
        throw err;
      }
      if (resp.status === 404) {
        throw new Error('找不到該群組（Sheet 可能被刪了）');
      }
      throw new Error(`存取群組失敗 (${resp.status})，請稍後再試`);
    }

    // 有權限 → 加進 list
    const groupId = 'g_' + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
    const newGroup = {
      groupId,
      name: data.name,
      sheetId: data.sheetId,
      folderId: data.folderId,
      photosFolderId: data.photosFolderId,
      sheetTabIds: data.sheetTabIds || {},
      role: 'member',
      joinedAt: new Date().toISOString(),
      ownerEmail: data.createdBy || '',
    };
    this.add(newGroup);
    this.setActive(groupId);
    return newGroup;
  },

  decodeInvite(code) {
    if (!code) return null;
    try {
      // 還原 base64url
      const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
      // 補 padding
      const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
      const json = decodeURIComponent(escape(atob(b64 + pad)));
      const data = JSON.parse(json);
      if (!data.s || !data.f || !data.n) return null;
      return {
        sheetId: data.s,
        folderId: data.f,
        photosFolderId: data.p,
        sheetTabIds: data.t || {},
        name: data.n,
        createdBy: data.c || '',
      };
    } catch (err) {
      console.warn('decodeInvite failed:', err);
      return null;
    }
  },
};

// 模組載入時立即 init（在 cache.js 載入前就要有 active group，
// 因為 cache PREFIX 會依賴 Groups.active().groupId）
Groups.init();

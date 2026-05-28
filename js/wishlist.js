// Wishlist 模組 — v3.2.0 (M6.1)
// Sheet: Wishlist (id | trip_id | place_id | name | address | lat | lng | type | added_by
//                  | source_note | status | rejected_votes | created_at | promoted_at | visited_at)
//
// status 生命週期：planned → promoted (M6.2 整合 itinerary 時用) / visited (寫日記時) / rejected (投票否決)
// rejected_votes: JSON string array of emails，達 (members-1)/2 票自動視為 rejected
//
// Trip-scoped: 每個 trip 各自的願望清單，loadAll 拿 group 全部，_filter 篩當前 trip

const Wishlist = {
  allList: [],   // 當前 group 全部 wishlist row
  list: [],      // 當前 trip 的 wishlist row

  TYPES: ['restaurant', 'attraction', 'cafe', 'experience', 'shopping', 'other'],
  TYPE_LABEL: {
    restaurant: '🍜 餐廳',
    attraction: '🏛️ 景點',
    cafe: '☕ 咖啡',
    experience: '✨ 體驗',
    shopping: '🛍️ 購物',
    other: '📍 其他',
  },

  loadFromCache() {
    const data = Cache.get('wishlist');
    if (data && Array.isArray(data)) {
      this.allList = data;
      this._filter();
      return true;
    }
    return false;
  },

  // 既有群組第一次 load → tab 可能不存在 → ensureGroupTab 自動建好再 retry
  async loadAll() {
    try {
      const rows = await API.getSheet('Wishlist');
      this.allList = API.rowsToObjects(rows);
      Cache.set('wishlist', this.allList);
      this._filter();
    } catch (err) {
      const msg = String(err && err.message || err);
      // 404 / Unable to parse range → tab 不存在 → 建立並重試一次
      if (msg.includes('Unable to parse range') || msg.includes('404')) {
        try {
          console.log('[Wishlist] tab 不存在，自動建立中...');
          await Groups.ensureGroupTab('Wishlist');
          const rows = await API.getSheet('Wishlist');
          this.allList = API.rowsToObjects(rows);
          Cache.set('wishlist', this.allList);
          this._filter();
        } catch (err2) {
          console.error('Wishlist.loadAll retry failed:', err2);
          if (typeof App !== 'undefined') App._lastError = `Wishlist: ${err2.message}`;
        }
      } else {
        console.error('Wishlist.loadAll failed:', err);
        if (typeof App !== 'undefined') App._lastError = `Wishlist: ${err.message}`;
      }
    }
    return this.list;
  },

  // 篩當前 trip 的願望
  _filter() {
    if (!Trips.current) { this.list = []; return; }
    this.list = this.allList.filter(w => w.trip_id === Trips.current.trip_id);
    // 排序：planned 在前、visited / rejected 在後；同狀態按 created_at 新→舊
    const statusOrder = { planned: 0, promoted: 1, visited: 2, rejected: 3 };
    this.list.sort((a, b) => {
      const so = (statusOrder[a.status || 'planned'] || 0) - (statusOrder[b.status || 'planned'] || 0);
      if (so !== 0) return so;
      return (b.created_at || '').localeCompare(a.created_at || '');
    });
  },

  // ===== CRUD =====

  async add({ placeId, name, address, lat, lng, type, sourceNote }) {
    if (!Trips.current) throw new Error('沒有當前 trip，先建一個');
    if (!name || !name.trim()) throw new Error('地點名稱必填');
    if (!Wishlist.TYPES.includes(type)) type = 'other';

    // 重複檢查：同 trip 同 place_id 已存在 → 拒絕
    if (placeId) {
      const dup = this.list.find(w => w.place_id === placeId);
      if (dup) throw new Error(`「${dup.name}」已經在當前 trip 的願望清單了`);
    }

    const id = API.newId();
    const createdAt = new Date().toISOString();
    const row = [
      id,
      Trips.current.trip_id,
      placeId || '',
      name.trim(),
      address || '',
      lat || '',
      lng || '',
      type,
      Auth.user.email,
      (sourceNote || '').trim(),
      'planned',
      '[]',           // rejected_votes
      createdAt,
      '',             // promoted_at
      '',             // visited_at
    ];
    await API.appendRow('Wishlist', row);

    const newWish = {
      id, trip_id: Trips.current.trip_id, place_id: placeId || '',
      name: name.trim(), address: address || '', lat: lat || '', lng: lng || '',
      type, added_by: Auth.user.email, source_note: (sourceNote || '').trim(),
      status: 'planned', rejected_votes: '[]',
      created_at: createdAt, promoted_at: '', visited_at: '',
    };
    this.allList.push(newWish);
    this._filter();
    Cache.set('wishlist', this.allList);
    return newWish;
  },

  async remove(id) {
    const existing = this.allList.find(w => w.id === id);
    if (!existing) throw new Error('找不到該筆 wish');
    await API.deleteRow('Wishlist', id);
    this.allList = this.allList.filter(w => w.id !== id);
    this._filter();
    Cache.set('wishlist', this.allList);
  },

  // 通用 update — 用 patches 合併現有 row 後 PUT 整 row
  async _updateRow(id, patches) {
    const existing = this.allList.find(w => w.id === id);
    if (!existing) throw new Error('找不到該筆 wish');
    const merged = { ...existing, ...patches };
    const row = [
      merged.id, merged.trip_id, merged.place_id || '',
      merged.name, merged.address || '', merged.lat || '', merged.lng || '',
      merged.type, merged.added_by, merged.source_note || '',
      merged.status || 'planned', merged.rejected_votes || '[]',
      merged.created_at, merged.promoted_at || '', merged.visited_at || '',
    ];
    await API.updateRow('Wishlist', id, row);
    Object.assign(existing, merged);
    this._filter();
    Cache.set('wishlist', this.allList);
    return existing;
  },

  // ===== Lifecycle: promote / markVisited =====

  // M6.2 整合：itinerary 從某 wish 建立時呼叫
  async promote(id) {
    return await this._updateRow(id, {
      status: 'promoted',
      promoted_at: new Date().toISOString(),
    });
  },

  // M6.2 整合：寫日記時 location 從 wish 選 → 自動標
  async markVisited(id) {
    return await this._updateRow(id, {
      status: 'visited',
      visited_at: new Date().toISOString(),
    });
  },

  // 從 visited / rejected 改回 planned（誤標還原）
  async resetToPlanned(id) {
    return await this._updateRow(id, {
      status: 'planned',
      promoted_at: '',
      visited_at: '',
    });
  },

  // ===== 否決投票 =====

  // 解析 rejected_votes JSON 成 email array
  getVoters(wish) {
    try {
      const arr = JSON.parse(wish.rejected_votes || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  },

  // 計算 threshold：(成員數 - 1) / 2，無條件捨去；最少 1
  rejectionThreshold(memberCount) {
    return Math.max(1, Math.floor((memberCount - 1) / 2));
  },

  // 達 threshold 即視為 rejected
  isRejected(wish, memberCount) {
    if (wish.status === 'rejected') return true;
    const voters = this.getVoters(wish);
    return voters.length >= this.rejectionThreshold(memberCount);
  },

  // 投否決票（不能投自己加的、不能重複投）
  async vote(id, voterEmail) {
    const existing = this.allList.find(w => w.id === id);
    if (!existing) throw new Error('找不到該筆 wish');
    if (existing.added_by === voterEmail) throw new Error('不能否決自己加的 wish');
    const voters = this.getVoters(existing);
    if (voters.includes(voterEmail)) throw new Error('你已經投過了');
    voters.push(voterEmail);

    // 達 threshold → 自動標 rejected
    let patches = { rejected_votes: JSON.stringify(voters) };
    if (typeof Members !== 'undefined') {
      const memberCount = Members.all().length || 1;
      if (voters.length >= this.rejectionThreshold(memberCount)) {
        patches.status = 'rejected';
      }
    }
    return await this._updateRow(id, patches);
  },

  // 撤回否決票
  async unvote(id, voterEmail) {
    const existing = this.allList.find(w => w.id === id);
    if (!existing) throw new Error('找不到該筆 wish');
    const voters = this.getVoters(existing).filter(e => e !== voterEmail);
    let patches = { rejected_votes: JSON.stringify(voters) };
    // 如果之前已 rejected 但現在票數降到 threshold 以下 → 改回 planned
    if (existing.status === 'rejected' && typeof Members !== 'undefined') {
      const memberCount = Members.all().length || 1;
      if (voters.length < this.rejectionThreshold(memberCount)) {
        patches.status = 'planned';
      }
    }
    return await this._updateRow(id, patches);
  },

  // 加 wish 的人強行覆寫被 rejected 的決定
  async forceRestore(id) {
    return await this._updateRow(id, {
      status: 'planned',
      rejected_votes: '[]',
    });
  },

  // ===== 篩選 helper =====

  // 按 type 過濾當前 trip 的 wishlist
  filterByType(type) {
    if (!type || type === 'all') return this.list;
    return this.list.filter(w => w.type === type);
  },

  // 按 status 過濾
  filterByStatus(status) {
    return this.list.filter(w => (w.status || 'planned') === status);
  },

  // 給地圖用：拿當前 trip 所有有座標的 wish（含已 visited 的灰色 marker）
  getMappable() {
    return this.list.filter(w => w.lat && w.lng && w.status !== 'rejected');
  },
};

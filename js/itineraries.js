// 預計行程模組：路線規劃 + 共享
// Sheet: Itineraries (id | trip_id | name | waypoints | travel_mode | author | created_at)
// waypoints: JSON 陣列 [{name, address, lat, lng, place_id}, ...]
// travel_mode: DRIVING | TRANSIT | WALKING | BICYCLING（對應 Google Directions API）

const Itineraries = {
  allList: [],    // 所有 trip 的行程
  list: [],       // 當前 trip 的行程

  loadFromCache() {
    const data = Cache.get('itineraries');
    if (data && Array.isArray(data)) {
      this.allList = data;
      this._filter();
      return true;
    }
    return false;
  },

  async loadAll() {
    try {
      const rows = await API.getSheet('Itineraries');
      this.allList = API.rowsToObjects(rows);
      Cache.set('itineraries', this.allList);
      this._filter();
    } catch (err) {
      console.error('Itineraries.loadAll failed:', err);
      if (typeof App !== 'undefined') App._lastError = `Itineraries: ${err.message}`;
    }
    return this.list;
  },

  // 篩出當前 trip 的行程
  _filter() {
    if (!Trips.current) { this.list = []; return; }
    this.list = this.allList.filter(i => i.trip_id === Trips.current.trip_id);
    // 按建立時間舊→新排
    this.list.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  },

  async create({ name, waypoints, travel_mode }) {
    if (!Trips.current) throw new Error('沒有當前 trip');
    if (!name || !name.trim()) throw new Error('行程要有名稱');
    if (!Array.isArray(waypoints) || waypoints.length < 2) throw new Error('至少要 2 個地點（起點 + 終點）');

    const id = API.newId();
    const createdAt = new Date().toISOString();
    const row = [
      id,
      Trips.current.trip_id,
      name.trim(),
      JSON.stringify(waypoints),
      travel_mode || 'DRIVING',
      Auth.user.email,
      createdAt,
    ];
    await API.appendRow('Itineraries', row);

    const newItin = {
      id,
      trip_id: Trips.current.trip_id,
      name: name.trim(),
      waypoints: JSON.stringify(waypoints),
      travel_mode: travel_mode || 'DRIVING',
      author: Auth.user.email,
      created_at: createdAt,
    };
    this.allList.push(newItin);
    this._filter();
    Cache.set('itineraries', this.allList);

    // 通知該 trip 其他成員
    if (typeof Notifications !== 'undefined' && Trips.current) {
      try {
        const members = Trips.getMembers();
        const items = members
          .filter(email => email !== Auth.user.email)
          .map(email => ({
            target_email: email,
            type: 'itinerary-add',
            diary_id: id, // 重用欄位放 itinerary_id
          }));
        if (items.length > 0) Notifications.createBatch(items).catch(() => {});
      } catch {}
    }

    return newItin;
  },

  async delete(id) {
    const existing = this.allList.find(i => i.id === id);
    if (!existing) throw new Error('找不到該行程');

    // v3.3.0 (M6.2.5) 反向 reset：刪 itinerary 時，把含 wishlist_id 的 waypoint 對應的 wish 改回 planned
    if (typeof Wishlist !== 'undefined') {
      const waypoints = this.getWaypoints(existing);
      const wishIds = waypoints.map(w => w.wishlist_id).filter(Boolean);
      for (const wid of wishIds) {
        try { await Wishlist.resetToPlanned(wid); } catch (e) { console.warn('reset wish failed:', e); }
      }
    }

    await API.deleteRow('Itineraries', id);
    this.allList = this.allList.filter(i => i.id !== id);
    this._filter();
    Cache.set('itineraries', this.allList);
  },

  // Parse waypoints JSON 成 array
  getWaypoints(itin) {
    try {
      const arr = JSON.parse(itin.waypoints || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  },

  // ===== v3.3.0 (M6.2.1): Wishlist → Itinerary 互通 =====

  // 用 wish 建一個新 itinerary（waypoint 只有一個 = 該 wish）
  // 之後可在地圖 tab 編輯 itinerary 加更多 waypoint
  async createFromWish(wish, { name, travel_mode } = {}) {
    if (!wish) throw new Error('沒有 wish');
    if (!Trips.current) throw new Error('沒有當前 trip');
    const itinName = (name && name.trim()) || `${wish.name} 行程`;
    const lat = parseFloat(wish.lat);
    const lng = parseFloat(wish.lng);
    if (isNaN(lat) || isNaN(lng)) throw new Error('該 wish 沒有座標，無法加進行程');

    const waypoint = {
      name: wish.name,
      address: wish.address || '',
      lat, lng,
      place_id: wish.place_id || '',
      wishlist_id: wish.id,  // M6.2 雙向 link
    };

    const id = API.newId();
    const createdAt = new Date().toISOString();
    // 注意：保持 7 column 跟原 create() 一致，避免既有群組 (Itineraries header 還沒 wishlist_id 欄) 寫到沒 header 的 cell。
    // wishlist_id 是 *waypoint level* 帶在 JSON 內，已足夠反向 lookup。
    const row = [
      id, Trips.current.trip_id, itinName,
      JSON.stringify([waypoint]),
      travel_mode || 'DRIVING',
      Auth.user.email, createdAt,
    ];
    await API.appendRow('Itineraries', row);

    const newItin = {
      id, trip_id: Trips.current.trip_id, name: itinName,
      waypoints: JSON.stringify([waypoint]),
      travel_mode: travel_mode || 'DRIVING',
      author: Auth.user.email, created_at: createdAt,
    };
    this.allList.push(newItin);
    this._filter();
    Cache.set('itineraries', this.allList);
    return newItin;
  },

  // 把某 wish append 成既有 itinerary 的最後一個 waypoint
  async addWaypointFromWish(itineraryId, wish) {
    const itin = this.allList.find(i => i.id === itineraryId);
    if (!itin) throw new Error('找不到該行程');
    const lat = parseFloat(wish.lat);
    const lng = parseFloat(wish.lng);
    if (isNaN(lat) || isNaN(lng)) throw new Error('該 wish 沒有座標');

    const waypoints = this.getWaypoints(itin);
    // 重複檢查（同 itinerary 同 wishlist_id 不重複加）
    if (waypoints.find(w => w.wishlist_id === wish.id)) {
      throw new Error(`「${wish.name}」已經在此行程內了`);
    }
    waypoints.push({
      name: wish.name,
      address: wish.address || '',
      lat, lng,
      place_id: wish.place_id || '',
      wishlist_id: wish.id,
    });

    const updatedJson = JSON.stringify(waypoints);
    // 保持 7 column 避免污染既有群組的 schema
    const row = [
      itin.id, itin.trip_id, itin.name,
      updatedJson,
      itin.travel_mode || 'DRIVING',
      itin.author, itin.created_at,
    ];
    await API.updateRow('Itineraries', itin.id, row);

    itin.waypoints = updatedJson;
    this._filter();
    Cache.set('itineraries', this.allList);
    return itin;
  },
};

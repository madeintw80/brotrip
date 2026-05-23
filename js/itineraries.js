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
};

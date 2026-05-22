// Trip 管理：每趟出遊獨立 trip_id，記錄日期區間 + 成員

const Trips = {
  list: [],
  current: null,

  async loadAll() {
    const rows = await API.getSheet('Trips');
    this.list = API.rowsToObjects(rows);
    // 還原上次選的 trip，沒有就用最後一個
    const saved = localStorage.getItem('brotrip_current_trip');
    if (saved) {
      const found = this.list.find(t => t.trip_id === saved);
      if (found) {
        this.current = found;
        return this.list;
      }
    }
    if (this.list.length > 0) {
      this.current = this.list[this.list.length - 1];
      localStorage.setItem('brotrip_current_trip', this.current.trip_id);
    } else {
      this.current = null;
    }
    return this.list;
  },

  async create(tripId, name, startDate, endDate, members) {
    const row = [
      tripId,
      name,
      startDate,
      endDate,
      JSON.stringify(members),
      Auth.user.email,
      new Date().toISOString(),
    ];
    await API.appendRow('Trips', row);
    const newTrip = {
      trip_id: tripId,
      name,
      start_date: startDate,
      end_date: endDate,
      members: JSON.stringify(members),
      created_by: Auth.user.email,
      created_at: new Date().toISOString(),
    };
    this.list.push(newTrip);
    this.setCurrent(tripId);
    return newTrip;
  },

  setCurrent(tripId) {
    const t = this.list.find(x => x.trip_id === tripId);
    if (t) {
      this.current = t;
      localStorage.setItem('brotrip_current_trip', tripId);
    }
  },

  getMembers() {
    if (!this.current) return [];
    try {
      const arr = JSON.parse(this.current.members || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  },

  // 編輯 trip（trip_id 不能改，其他都可改）
  async update(tripId, data) {
    const existing = this.list.find(t => t.trip_id === tripId);
    if (!existing) throw new Error('找不到該 trip');
    const newRow = [
      existing.trip_id,
      data.name,
      data.start_date,
      data.end_date,
      JSON.stringify(data.members),
      existing.created_by,
      existing.created_at,
    ];
    await API.updateRow('Trips', tripId, newRow);
    Object.assign(existing, {
      name: data.name,
      start_date: data.start_date,
      end_date: data.end_date,
      members: JSON.stringify(data.members),
    });
    return existing;
  },
};

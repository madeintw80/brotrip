// Trip 管理：每趟出遊獨立 trip_id，記錄日期區間 + 成員
// v1.5.0：加 localStorage cache，loadFromCache 啟動時瞬間渲染

const Trips = {
  list: [],
  current: null,

  loadFromCache() {
    const data = Cache.get('trips');
    if (data && Array.isArray(data)) {
      this.list = data;
      this._restoreCurrent();
      return true;
    }
    return false;
  },

  _restoreCurrent() {
    const saved = localStorage.getItem('brotrip_current_trip');
    if (saved) {
      const found = this.list.find(t => t.trip_id === saved);
      if (found) {
        this.current = found;
        return;
      }
    }
    if (this.list.length > 0) {
      this.current = this.list[this.list.length - 1];
      localStorage.setItem('brotrip_current_trip', this.current.trip_id);
    } else {
      this.current = null;
    }
  },

  async loadAll() {
    try {
      const rows = await API.getSheet('Trips');
      this.list = API.rowsToObjects(rows);
      Cache.set('trips', this.list);
      this._restoreCurrent();
    } catch (err) {
      console.error('Trips.loadAll failed:', err);
      throw err;  // 讓 caller 知道，可以顯示 UI 錯誤
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
    Cache.set('trips', this.list);
    this.setCurrent(tripId);

    // 通知被加入的人（trip-add）
    if (typeof Notifications !== 'undefined') {
      const others = members.filter(e => e !== Auth.user.email);
      if (others.length > 0) {
        try {
          await Notifications.createBatch(others.map(email => ({
            target_email: email, type: 'trip-add', diary_id: tripId,
          })));
        } catch (err) { console.warn('trip-add notif failed:', err); }
      }
    }
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

  // 刪除整個 trip + 所有關聯資料（expenses/diaries/comments/notifications）
  // 用 batchDeleteRows 一次刪同 sheet 多 rows，避免 rate limit
  async delete(tripId) {
    const existing = this.list.find(t => t.trip_id === tripId);
    if (!existing) throw new Error('找不到該 trip');

    // 收集要刪的 IDs
    const expenseIds = (typeof Expenses !== 'undefined')
      ? Expenses.allList.filter(e => e.trip_id === tripId).map(e => e.id)
      : [];
    const diaryIds = (typeof Diaries !== 'undefined')
      ? Diaries.allList.filter(d => d.trip_id === tripId).map(d => d.id)
      : [];
    const diaryIdSet = new Set(diaryIds);
    const expenseIdSet = new Set(expenseIds);
    const commentIds = (typeof Comments !== 'undefined')
      ? Comments.list.filter(c => diaryIdSet.has(c.diary_id)).map(c => c.id)
      : [];
    const itineraryIds = (typeof Itineraries !== 'undefined')
      ? Itineraries.allList.filter(i => i.trip_id === tripId).map(i => i.id)
      : [];
    const itineraryIdSet = new Set(itineraryIds);
    const settlementIds = (typeof Settlements !== 'undefined')
      ? Settlements.allList.filter(s => s.trip_id === tripId).map(s => s.id)
      : [];
    const settlementIdSet = new Set(settlementIds);
    const notifIds = (typeof Notifications !== 'undefined')
      ? Notifications.list.filter(n =>
          n.diary_id === tripId || diaryIdSet.has(n.diary_id) || expenseIdSet.has(n.diary_id) || itineraryIdSet.has(n.diary_id) || settlementIdSet.has(n.diary_id)
        ).map(n => n.id)
      : [];

    // 逐 sheet batch delete
    if (expenseIds.length > 0) await API.batchDeleteRows('Expenses', expenseIds);
    if (diaryIds.length > 0) await API.batchDeleteRows('Diaries', diaryIds);
    if (commentIds.length > 0) await API.batchDeleteRows('Comments', commentIds);
    if (itineraryIds.length > 0) await API.batchDeleteRows('Itineraries', itineraryIds);
    if (settlementIds.length > 0) await API.batchDeleteRows('Settlements', settlementIds);
    if (notifIds.length > 0) await API.batchDeleteRows('Notifications', notifIds);
    await API.deleteRow('Trips', tripId);

    // 同步 memory + cache
    if (typeof Expenses !== 'undefined') {
      Expenses.allList = Expenses.allList.filter(e => e.trip_id !== tripId);
      Expenses._filter();
      Cache.set('expenses', Expenses.allList);
    }
    if (typeof Diaries !== 'undefined') {
      Diaries.allList = Diaries.allList.filter(d => d.trip_id !== tripId);
      Diaries._filter();
      Cache.set('diaries', Diaries.allList);
    }
    if (typeof Comments !== 'undefined') {
      Comments.list = Comments.list.filter(c => !diaryIdSet.has(c.diary_id));
      Cache.set('comments', Comments.list);
    }
    if (typeof Itineraries !== 'undefined') {
      Itineraries.allList = Itineraries.allList.filter(i => i.trip_id !== tripId);
      Itineraries._filter();
      Cache.set('itineraries', Itineraries.allList);
    }
    if (typeof Settlements !== 'undefined') {
      Settlements.allList = Settlements.allList.filter(s => s.trip_id !== tripId);
      Settlements._filter();
      Cache.set('settlements', Settlements.allList);
    }
    if (typeof Notifications !== 'undefined') {
      Notifications.list = Notifications.list.filter(n =>
        !(n.diary_id === tripId || diaryIdSet.has(n.diary_id) || expenseIdSet.has(n.diary_id) || itineraryIdSet.has(n.diary_id) || settlementIdSet.has(n.diary_id))
      );
      Cache.set('notifications', Notifications.list);
    }

    this.list = this.list.filter(t => t.trip_id !== tripId);
    Cache.set('trips', this.list);

    // 如果刪掉的是 current trip，切換到剩下的（或 null）
    if (this.current && this.current.trip_id === tripId) {
      this.current = null;
      localStorage.removeItem('brotrip_current_trip');
      this._restoreCurrent();
    }

    return {
      expenses: expenseIds.length,
      diaries: diaryIds.length,
      comments: commentIds.length,
      itineraries: itineraryIds.length,
      settlements: settlementIds.length,
      notifications: notifIds.length,
    };
  },

  async update(tripId, data) {
    const existing = this.list.find(t => t.trip_id === tripId);
    if (!existing) throw new Error('找不到該 trip');

    // Diff: 找出新加入的成員（要通知他們）
    let oldMembers = [];
    try { oldMembers = JSON.parse(existing.members || '[]'); } catch {}
    const oldSet = new Set(oldMembers);
    const newlyAdded = (data.members || []).filter(e => !oldSet.has(e) && e !== Auth.user.email);

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
    Cache.set('trips', this.list);

    // 通知 newly added 的成員
    if (newlyAdded.length > 0 && typeof Notifications !== 'undefined') {
      try {
        await Notifications.createBatch(newlyAdded.map(email => ({
          target_email: email, type: 'trip-add', diary_id: existing.trip_id,
        })));
      } catch (err) { console.warn('trip-add notif failed:', err); }
    }
    return existing;
  },
};

// Peer-to-peer 結算模組（v2.0.0）
// 設計：A 欠 B 1000 → A 給錢後按「我已付 1000」→ 寫 pending → 通知 B
//      → B 按「確認收到」→ status=confirmed → settle() 抵銷該筆債務
// Sheet: Settlements (id|trip_id|from_email|to_email|amount|currency|status|note|created_at|confirmed_at)

const Settlements = {
  allList: [],   // 所有 trip 的
  list: [],      // 當前 trip 的

  loadFromCache() {
    const data = Cache.get('settlements');
    if (data && Array.isArray(data)) {
      this.allList = data;
      this._filter();
      return true;
    }
    return false;
  },

  async loadAll() {
    try {
      const rows = await API.getSheet('Settlements');
      this.allList = API.rowsToObjects(rows);
      Cache.set('settlements', this.allList);
      this._filter();
    } catch (err) {
      console.error('Settlements.loadAll failed:', err);
      if (typeof App !== 'undefined') App._lastError = `Settlements: ${err.message}`;
    }
    return this.list;
  },

  _filter() {
    if (!Trips.current) { this.list = []; return; }
    this.list = this.allList.filter(s => s.trip_id === Trips.current.trip_id);
    this.list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  },

  // A 按「我已付」→ 建 pending settlement
  async create({ to_email, amount, currency, note }) {
    if (!Trips.current) throw new Error('沒有當前 trip');
    if (!to_email || to_email === Auth.user.email) throw new Error('收款人不對');
    if (!(amount > 0)) throw new Error('金額要 > 0');

    const id = API.newId();
    const createdAt = new Date().toISOString();
    const row = [
      id,
      Trips.current.trip_id,
      Auth.user.email, // from
      to_email,
      amount,
      currency || 'TWD',
      'pending',
      note || '',
      createdAt,
      '', // confirmed_at
    ];
    await API.appendRow('Settlements', row);

    const newS = {
      id,
      trip_id: Trips.current.trip_id,
      from_email: Auth.user.email,
      to_email,
      amount,
      currency: currency || 'TWD',
      status: 'pending',
      note: note || '',
      created_at: createdAt,
      confirmed_at: '',
    };
    this.allList.push(newS);
    this._filter();
    Cache.set('settlements', this.allList);

    // 通知收款方來確認
    if (typeof Notifications !== 'undefined') {
      try {
        await Notifications.createBatch([{
          target_email: to_email,
          type: 'settlement-claim',
          diary_id: id, // 重用欄位放 settlement_id
        }]);
      } catch {}
    }
    return newS;
  },

  // B 按「確認收到」→ status=confirmed
  async confirm(id) {
    const s = this.allList.find(x => x.id === id);
    if (!s) throw new Error('找不到該轉帳');
    if (s.to_email !== Auth.user.email) throw new Error('只有收款方能確認');
    if (s.status !== 'pending') throw new Error('狀態不對');

    const confirmedAt = new Date().toISOString();
    // 更新 sheet row
    const rows = await API.getSheet('Settlements');
    const idx = rows.findIndex((r, i) => i > 0 && r[0] === id);
    if (idx <= 0) {
      // 找不到該列就中止 — 默默跳過會做出「sheet 裡不存在的 confirmed」，本地與雲端分裂
      throw new Error('Sheet 找不到這筆轉帳（可能已被刪除），請下拉重新整理後再試');
    }
    const newRow = [...rows[idx]];
    newRow[6] = 'confirmed';
    newRow[9] = confirmedAt;
    const range = `Settlements!A${idx + 1}:J${idx + 1}`;
    await API.sheetsRequest(`/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
      method: 'PUT',
      body: JSON.stringify({ values: [newRow] }),
    });

    s.status = 'confirmed';
    s.confirmed_at = confirmedAt;
    Cache.set('settlements', this.allList);
    this._filter();

    // 通知付款方「確認收到」
    if (typeof Notifications !== 'undefined') {
      try {
        await Notifications.createBatch([{
          target_email: s.from_email,
          type: 'settlement-confirm',
          diary_id: id,
        }]);
      } catch {}
    }
    return s;
  },

  // B 拒絕（沒收到）/ A 撤回 → delete
  async cancel(id) {
    const s = this.allList.find(x => x.id === id);
    if (!s) throw new Error('找不到該轉帳');
    if (s.from_email !== Auth.user.email && s.to_email !== Auth.user.email) {
      throw new Error('沒權限');
    }
    if (s.status === 'confirmed') throw new Error('已確認的不能取消');

    await API.deleteRow('Settlements', id);
    this.allList = this.allList.filter(x => x.id !== id);
    this._filter();
    Cache.set('settlements', this.allList);

    // 如果是收款方拒絕 → 通知付款方
    if (s.to_email === Auth.user.email && typeof Notifications !== 'undefined') {
      try {
        await Notifications.createBatch([{
          target_email: s.from_email,
          type: 'settlement-reject',
          diary_id: id,
        }]);
      } catch {}
    }
  },

  // 拿我需要確認的 pending（to=me）
  getPendingForMe() {
    if (!Auth.user) return [];
    return this.list.filter(s => s.status === 'pending' && s.to_email === Auth.user.email);
  },

  // 拿已 confirmed 的，給 Expenses.settle() 抵銷用
  getConfirmedForTrip() {
    return this.list.filter(s => s.status === 'confirmed');
  },

  // 拿某 from→to 對的 pending（給 UI 顯示「等對方確認」）
  getPendingPair(fromEmail, toEmail, currency) {
    return this.list.find(s =>
      s.status === 'pending' &&
      s.from_email === fromEmail &&
      s.to_email === toEmail &&
      (s.currency || 'TWD') === (currency || 'TWD')
    );
  },
};

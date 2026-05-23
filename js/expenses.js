// 記帳模組：CRUD + 結算
// v1.6.0：支援多付款人（payers JSON in column L）
// v1.5.0：allList + list 雙層 cache

const Expenses = {
  list: [],
  allList: [],

  _filter() {
    if (Trips.current) {
      this.list = this.allList.filter(e => e.trip_id === Trips.current.trip_id);
    } else {
      this.list = [];
    }
  },

  loadFromCache() {
    const data = Cache.get('expenses');
    if (data && Array.isArray(data)) {
      this.allList = data;
      this._filter();
      return true;
    }
    return false;
  },

  async loadAll() {
    const rows = await API.getSheet('Expenses');
    this.allList = API.rowsToObjects(rows);
    Cache.set('expenses', this.allList);
    this._filter();
    return this.list;
  },

  async create(data) {
    if (!Trips.current) throw new Error('沒有當前 trip');
    const id = API.newId();
    const splits = JSON.stringify(data.splits);

    // 多付款人支援：data.payers = [{email, amount}, ...]
    let payers;
    if (Array.isArray(data.payers) && data.payers.length > 0) {
      payers = data.payers;
    } else {
      payers = [{ email: data.payer, amount: parseFloat(data.amount) || 0 }];
    }
    const payersJson = JSON.stringify(payers);
    const firstPayer = payers[0].email;
    const totalAmount = payers.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);

    const row = [
      id,
      Trips.current.trip_id,
      data.date,
      firstPayer,
      totalAmount,
      data.currency || 'TWD',
      data.category || '',
      data.description || '',
      splits,
      data.photo_url || '',
      new Date().toISOString(),
      payersJson,  // L: payers JSON
      '',           // M: settled (預設空 = 未結清)
    ];
    await API.appendRow('Expenses', row);
    const newExpense = {
      id,
      trip_id: Trips.current.trip_id,
      date: data.date,
      payer: firstPayer,
      amount: String(totalAmount),
      currency: data.currency || 'TWD',
      category: data.category || '',
      description: data.description || '',
      splits,
      photo_url: data.photo_url || '',
      created_at: new Date().toISOString(),
      payers: payersJson,
      settled: '',
    };
    this.allList.push(newExpense);
    this._filter();
    Cache.set('expenses', this.allList);
    return newExpense;
  },

  // 結算：credit payers，debit splits；幣別分開算
  // 已結清的 expense (settled=TRUE) 不算入
  settle() {
    const balances = {};

    this.list.forEach(e => {
      if (String(e.settled).toUpperCase() === 'TRUE') return;  // 跳過已結清
      const currency = e.currency || 'TWD';
      if (!balances[currency]) balances[currency] = {};

      // === Credit: payers ===
      let payers;
      try { payers = JSON.parse(e.payers || '[]'); } catch {}
      if (!Array.isArray(payers) || payers.length === 0) {
        // Fallback to single payer
        payers = [{ email: e.payer, amount: parseFloat(e.amount) || 0 }];
      }
      payers.forEach(p => {
        const amt = parseFloat(p.amount) || 0;
        balances[currency][p.email] = (balances[currency][p.email] || 0) + amt;
      });

      // === Debit: splits ===
      let splits;
      try { splits = JSON.parse(e.splits || '[]'); } catch {}
      if (!Array.isArray(splits) || splits.length === 0) return;

      const totalAmount = parseFloat(e.amount) || 0;
      const hasShare = splits.some(s => s.share !== undefined);
      if (hasShare) {
        splits.forEach(s => {
          const share = parseFloat(s.share) || 0;
          balances[currency][s.email] = (balances[currency][s.email] || 0) - share;
        });
      } else {
        const totalRatio = splits.reduce((sum, x) => sum + (parseFloat(x.ratio) || 0), 0);
        if (totalRatio === 0) return;
        splits.forEach(s => {
          const share = totalAmount * (parseFloat(s.ratio) || 0) / totalRatio;
          balances[currency][s.email] = (balances[currency][s.email] || 0) - share;
        });
      }
    });

    const result = {};
    for (const currency in balances) {
      const b = balances[currency];
      const owers = [];
      const earners = [];
      for (const email in b) {
        const v = Math.round(b[email] * 100) / 100;
        if (v < -0.01) owers.push({ email, amount: -v });
        else if (v > 0.01) earners.push({ email, amount: v });
      }
      owers.sort((a, b) => b.amount - a.amount);
      earners.sort((a, b) => b.amount - a.amount);

      const transfers = [];
      let i = 0, j = 0;
      while (i < owers.length && j < earners.length) {
        const owe = owers[i];
        const earn = earners[j];
        const amount = Math.min(owe.amount, earn.amount);
        transfers.push({
          from: owe.email,
          to: earn.email,
          amount: Math.round(amount * 100) / 100,
        });
        owe.amount -= amount;
        earn.amount -= amount;
        if (owe.amount < 0.01) i++;
        if (earn.amount < 0.01) j++;
      }
      result[currency] = transfers;
    }
    return result;
  },

  async update(id, data) {
    const existing = this.list.find(e => e.id === id);
    if (!existing) throw new Error('找不到該支出');
    // v1.7.0：拿掉 payer 限制，任何 trip 成員都可改（共享記帳）
    const splits = JSON.stringify(data.splits);

    let payers;
    if (Array.isArray(data.payers) && data.payers.length > 0) {
      payers = data.payers;
    } else {
      payers = [{ email: data.payer, amount: parseFloat(data.amount) || 0 }];
    }
    const payersJson = JSON.stringify(payers);
    const firstPayer = payers[0].email;
    const totalAmount = payers.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);

    const newRow = [
      existing.id,
      existing.trip_id,
      data.date,
      firstPayer,
      totalAmount,
      data.currency || 'TWD',
      data.category || '',
      data.description || '',
      splits,
      existing.photo_url || '',
      existing.created_at,
      payersJson,
      existing.settled || '',  // M
    ];
    await API.updateRow('Expenses', id, newRow);
    Object.assign(existing, {
      date: data.date,
      payer: firstPayer,
      amount: String(totalAmount),
      currency: data.currency || 'TWD',
      category: data.category || '',
      description: data.description || '',
      splits,
      payers: payersJson,
    });
    Cache.set('expenses', this.allList);
    return existing;
  },

  async delete(id) {
    const existing = this.list.find(e => e.id === id);
    if (!existing) throw new Error('找不到該支出');
    // v1.7.0：拿掉 payer 限制，任何 trip 成員都可刪
    await API.deleteRow('Expenses', id);
    const idx = this.list.indexOf(existing);
    if (idx >= 0) this.list.splice(idx, 1);
    const allIdx = this.allList.indexOf(existing);
    if (allIdx >= 0) this.allList.splice(allIdx, 1);
    Cache.set('expenses', this.allList);
  },

  // 切換單筆 settled
  async toggleSettled(id) {
    const existing = this.allList.find(e => e.id === id);
    if (!existing) throw new Error('找不到該支出');
    const wasSettled = String(existing.settled).toUpperCase() === 'TRUE';
    const newSettled = wasSettled ? 'FALSE' : 'TRUE';
    const newRow = [
      existing.id, existing.trip_id, existing.date, existing.payer,
      existing.amount, existing.currency, existing.category, existing.description,
      existing.splits, existing.photo_url || '', existing.created_at,
      existing.payers || '', newSettled,
    ];
    await API.updateRow('Expenses', id, newRow);
    existing.settled = newSettled;
    Cache.set('expenses', this.allList);
    return !wasSettled;
  },

  // 把當前 trip 所有未結清的標為 TRUE（用 batch 序列 update，因為 Sheets API 沒有原生 batch update by id）
  async markAllSettled() {
    if (!Trips.current) throw new Error('沒有當前 trip');
    const tripId = Trips.current.trip_id;
    const targets = this.allList.filter(e =>
      e.trip_id === tripId && String(e.settled).toUpperCase() !== 'TRUE'
    );
    if (targets.length === 0) return 0;
    for (const e of targets) {
      const newRow = [
        e.id, e.trip_id, e.date, e.payer, e.amount, e.currency,
        e.category, e.description, e.splits, e.photo_url || '', e.created_at,
        e.payers || '', 'TRUE',
      ];
      await API.updateRow('Expenses', e.id, newRow);
      e.settled = 'TRUE';
    }
    Cache.set('expenses', this.allList);
    return targets.length;
  },
};

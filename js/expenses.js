// 記帳模組：CRUD + 結算

const Expenses = {
  list: [],

  async loadAll() {
    const rows = await API.getSheet('Expenses');
    const all = API.rowsToObjects(rows);
    if (Trips.current) {
      this.list = all.filter(e => e.trip_id === Trips.current.trip_id);
    } else {
      this.list = [];
    }
    return this.list;
  },

  async create(data) {
    if (!Trips.current) throw new Error('沒有當前 trip');
    const id = API.newId();
    const splits = JSON.stringify(data.splits);
    const row = [
      id,
      Trips.current.trip_id,
      data.date,
      data.payer,
      data.amount,
      data.currency || 'TWD',
      data.category || '',
      data.description || '',
      splits,
      data.photo_url || '',
      new Date().toISOString(),
    ];
    await API.appendRow('Expenses', row);
    const newExpense = {
      id,
      trip_id: Trips.current.trip_id,
      date: data.date,
      payer: data.payer,
      amount: String(data.amount),
      currency: data.currency || 'TWD',
      category: data.category || '',
      description: data.description || '',
      splits,
      photo_url: data.photo_url || '',
      created_at: new Date().toISOString(),
    };
    this.list.push(newExpense);
    return newExpense;
  },

  // 結算邏輯：
  //   每人應付 = 支出金額 × (自己 ratio / 總 ratio)
  //   每人餘額 = 該人付掉的 - 該人應付的
  //   餘額 > 0 → 別人欠他；餘額 < 0 → 他欠別人
  // 用 greedy 配對：欠最多的 → 賺最多的，直到全清
  // 各幣別分開算（不換匯）
  settle() {
    const balances = {};  // { currency: { email: balance } }

    this.list.forEach(e => {
      const amount = parseFloat(e.amount);
      if (!amount || isNaN(amount)) return;
      const currency = e.currency || 'TWD';

      let splits;
      try { splits = JSON.parse(e.splits); } catch { return; }
      if (!Array.isArray(splits) || splits.length === 0) return;

      if (!balances[currency]) balances[currency] = {};
      balances[currency][e.payer] = (balances[currency][e.payer] || 0) + amount;

      // 兼容兩種格式：新版 `share`（具體金額），舊版 `ratio`（份數）
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
          const share = amount * (parseFloat(s.ratio) || 0) / totalRatio;
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
      // 大→小排序讓配對結果更少
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

  // 編輯（只能改自己付的支出）
  async update(id, data) {
    const existing = this.list.find(e => e.id === id);
    if (!existing) throw new Error('找不到該支出');
    if (existing.payer !== Auth.user.email) throw new Error('只能改自己付的支出');
    const splits = JSON.stringify(data.splits);
    const newRow = [
      existing.id,
      existing.trip_id,
      data.date,
      data.payer,
      data.amount,
      data.currency || 'TWD',
      data.category || '',
      data.description || '',
      splits,
      existing.photo_url || '',
      existing.created_at,
    ];
    await API.updateRow('Expenses', id, newRow);
    Object.assign(existing, {
      date: data.date,
      payer: data.payer,
      amount: String(data.amount),
      currency: data.currency || 'TWD',
      category: data.category || '',
      description: data.description || '',
      splits,
    });
    return existing;
  },

  // 刪除（只能刪自己付的）
  async delete(id) {
    const existing = this.list.find(e => e.id === id);
    if (!existing) throw new Error('找不到該支出');
    if (existing.payer !== Auth.user.email) throw new Error('只能刪自己付的支出');
    await API.deleteRow('Expenses', id);
    const idx = this.list.indexOf(existing);
    if (idx >= 0) this.list.splice(idx, 1);
  },
};

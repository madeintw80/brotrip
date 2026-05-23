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
    try {
      const rows = await API.getSheet('Expenses');
      this.allList = API.rowsToObjects(rows);
      Cache.set('expenses', this.allList);
      this._filter();
    } catch (err) {
      console.error('Expenses.loadAll failed:', err);
      if (typeof App !== 'undefined') App._lastError = `Expenses: ${err.message}`;
    }
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

    // 通知 splits 中除自己外的人（expense-split）
    if (typeof Notifications !== 'undefined') {
      try {
        const uniq = [...new Set((data.splits || []).map(s => s.email))]
          .filter(email => email !== Auth.user.email);
        if (uniq.length > 0) {
          await Notifications.createBatch(uniq.map(email => ({
            target_email: email, type: 'expense-split', diary_id: id,
          })));
        }
      } catch (err) { console.warn('expense-split notif failed:', err); }
    }
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

    // ⭐ v2.0.0: 把已 confirmed Settlements 算入抵銷
    // confirmed settlement (A→B 1000) 表示 A 已實際付給 B 1000
    // → 等同於 A 多付了 1000 (credit)、B 多收了 1000 (debit)
    if (typeof Settlements !== 'undefined') {
      Settlements.getConfirmedForTrip().forEach(s => {
        const currency = s.currency || 'TWD';
        if (!balances[currency]) balances[currency] = {};
        const amt = parseFloat(s.amount) || 0;
        // from 等同於再多付了 amt（credit balance 增加）
        balances[currency][s.from_email] = (balances[currency][s.from_email] || 0) + amt;
        // to 等同於再多被分了 amt（debit balance 減少）
        balances[currency][s.to_email] = (balances[currency][s.to_email] || 0) - amt;
      });
    }

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

    // Diff: 找新加入分帳的人（要通知）
    let oldSplitEmails = new Set();
    try { JSON.parse(existing.splits || '[]').forEach(s => oldSplitEmails.add(s.email)); } catch {}
    const newlyAddedSplits = [...new Set((data.splits || []).map(s => s.email))]
      .filter(email => !oldSplitEmails.has(email) && email !== Auth.user.email);

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

    // 如果是從已結清解鎖出來改的，自動標回未結清
    const newSettled = data.resetSettled ? '' : (existing.settled || '');

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
      newSettled,  // M
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
      settled: newSettled,
    });
    Cache.set('expenses', this.allList);

    // 通知新加入分帳的人
    if (newlyAddedSplits.length > 0 && typeof Notifications !== 'undefined') {
      try {
        await Notifications.createBatch(newlyAddedSplits.map(email => ({
          target_email: email, type: 'expense-split', diary_id: existing.id,
        })));
      } catch (err) { console.warn('expense-split notif failed:', err); }
    }
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

    // 通知所有相關 split 成員（除自己）— 每人收 ONE summary 通知
    if (typeof Notifications !== 'undefined') {
      const affected = new Set();
      targets.forEach(e => {
        try {
          JSON.parse(e.splits || '[]').forEach(s => {
            if (s.email && s.email !== Auth.user.email) affected.add(s.email);
          });
        } catch {}
      });
      if (affected.size > 0) {
        try {
          await Notifications.createBatch([...affected].map(email => ({
            target_email: email, type: 'expense-settle', diary_id: tripId,
          })));
        } catch (err) { console.warn('expense-settle notif failed:', err); }
      }
    }
    return targets.length;
  },
};

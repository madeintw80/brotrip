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

    // ⭐ 改版：用「支付筆數最少」演算法產生轉帳清單
    //（原本是貪婪法，只把最大欠款人配最大債主，不保證筆數最少）
    const result = {};
    for (const currency in balances) {
      result[currency] = Expenses._minTransfers(balances[currency]);
    }
    return result;
  },

  // 算「支付筆數最少」的轉帳清單
  // 作法：把每個人的淨額轉成「整數分」(避免浮點誤差)，用回溯法試所有結清組合，挑筆數最少那組
  // 每筆金額一律取 min(欠, 收)，不會叫人付超過對方該收的（乾淨好懂）
  // 群組 > 12 人才退回原本的貪婪法（正常旅遊團不會到，純防呆避免回溯算太久）
  _minTransfers(balanceMap) {
    // 1) 淨額 → 整數分，丟掉剛好打平(=0)的人
    const people = [];   // [{ email, cents }]
    for (const email in balanceMap) {
      const cents = Math.round((balanceMap[email] || 0) * 100);
      if (cents !== 0) people.push({ email, cents });
    }
    if (people.length <= 1) return [];

    if (people.length > 12) return Expenses._greedyTransfers(people);

    let bestTransfers = null;
    let bestCount = Infinity;

    // 回溯：cents = 目前每個人的餘額(陣列)，acc = 一路累積的轉帳
    const dfs = (cents, acc) => {
      if (acc.length >= bestCount) return;   // 剪枝：已經不可能更少

      const hasPos = cents.some(c => c > 0);   // 還有人要收錢
      const hasNeg = cents.some(c => c < 0);   // 還有人要付錢
      if (!hasPos || !hasNeg) {
        // 配不下去了（全部結清，或只剩浮點零頭）→ 收尾比較
        if (acc.length < bestCount) { bestCount = acc.length; bestTransfers = acc.slice(); }
        return;
      }

      // 找第一個還沒結清的人 k，跟每個「正負號相反」的人配對
      let k = 0;
      while (cents[k] === 0) k++;
      for (let m = 0; m < cents.length; m++) {
        if (cents[m] === 0) continue;
        if ((cents[k] > 0) === (cents[m] > 0)) continue;   // 同號不能互抵

        const amt = Math.min(Math.abs(cents[k]), Math.abs(cents[m]));   // 只轉較小的，乾淨
        const from = cents[k] < 0 ? people[k].email : people[m].email;
        const to   = cents[k] < 0 ? people[m].email : people[k].email;

        const next = cents.slice();
        next[k] += cents[k] < 0 ? amt : -amt;   // 兩邊各往 0 靠
        next[m] += cents[m] < 0 ? amt : -amt;
        acc.push({ from, to, amount: amt / 100 });
        dfs(next, acc);
        acc.pop();   // 還原，再試別種配法
      }
    };
    dfs(people.map(p => p.cents), []);

    // 金額大的排前面，顯示比較順
    return (bestTransfers || []).sort((a, b) => b.amount - a.amount);
  },

  // 後備：原本的貪婪法（最大欠款人配最大債主），給超大群組用，整數分版
  _greedyTransfers(people) {
    const owers = [];
    const earners = [];
    people.forEach(p => {
      if (p.cents < 0) owers.push({ email: p.email, cents: -p.cents });
      else if (p.cents > 0) earners.push({ email: p.email, cents: p.cents });
    });
    owers.sort((a, b) => b.cents - a.cents);
    earners.sort((a, b) => b.cents - a.cents);
    const transfers = [];
    let i = 0, j = 0;
    while (i < owers.length && j < earners.length) {
      const amt = Math.min(owers[i].cents, earners[j].cents);
      transfers.push({ from: owers[i].email, to: earners[j].email, amount: amt / 100 });
      owers[i].cents -= amt;
      earners[j].cents -= amt;
      if (owers[i].cents === 0) i++;
      if (earners[j].cents === 0) j++;
    }
    return transfers;
  },

  // ⭐ v2.0.1 每個人實際花了多少（分攤後應付金額），按幣別分
  // 用於「個人支出統計」section，看每個人這趟旅行的真實花費
  // 含已結清的（因為這是 trip 回顧，要看實際花費，不是欠款）
  getPerPersonSpending() {
    const result = {}; // { TWD: { email: amount, ... }, USD: {...} }
    this.list.forEach(e => {
      const currency = e.currency || 'TWD';
      if (!result[currency]) result[currency] = {};
      let splits;
      try { splits = JSON.parse(e.splits || '[]'); } catch {}
      if (!Array.isArray(splits) || splits.length === 0) return;

      const totalAmount = parseFloat(e.amount) || 0;
      const hasShare = splits.some(s => s.share !== undefined);
      if (hasShare) {
        splits.forEach(s => {
          const share = parseFloat(s.share) || 0;
          result[currency][s.email] = (result[currency][s.email] || 0) + share;
        });
      } else {
        const totalRatio = splits.reduce((sum, x) => sum + (parseFloat(x.ratio) || 0), 0);
        if (totalRatio === 0) return;
        splits.forEach(s => {
          const share = totalAmount * (parseFloat(s.ratio) || 0) / totalRatio;
          result[currency][s.email] = (result[currency][s.email] || 0) + share;
        });
      }
    });
    // round 到 2 位
    for (const cur in result) {
      for (const email in result[cur]) {
        result[cur][email] = Math.round(result[cur][email] * 100) / 100;
      }
    }
    return result;
  },

  // ⭐ v3.9.5 每人在每個「類別」分攤後花了多少（給「個人支出統計」點開人名後的細項）
  // 結構：{ TWD: { email: { '🍜 食': amount, ... } }, ... }
  // share 邏輯跟 getPerPersonSpending 完全一致 → 各類別加總 = 該人總花費
  getPerPersonByCategory() {
    const result = {};
    this.list.forEach(e => {
      const currency = e.currency || 'TWD';
      const cat = e.category || '💊 其他';   // 沒填類別歸「其他」，加總才對得起來
      if (!result[currency]) result[currency] = {};
      let splits;
      try { splits = JSON.parse(e.splits || '[]'); } catch {}
      if (!Array.isArray(splits) || splits.length === 0) return;

      const totalAmount = parseFloat(e.amount) || 0;
      const hasShare = splits.some(s => s.share !== undefined);
      const add = (email, share) => {
        if (!result[currency][email]) result[currency][email] = {};
        result[currency][email][cat] = (result[currency][email][cat] || 0) + share;
      };
      if (hasShare) {
        splits.forEach(s => add(s.email, parseFloat(s.share) || 0));
      } else {
        const totalRatio = splits.reduce((sum, x) => sum + (parseFloat(x.ratio) || 0), 0);
        if (totalRatio === 0) return;
        splits.forEach(s => add(s.email, totalAmount * (parseFloat(s.ratio) || 0) / totalRatio));
      }
    });
    // round 到 2 位
    for (const cur in result) {
      for (const email in result[cur]) {
        for (const cat in result[cur][email]) {
          result[cur][email][cat] = Math.round(result[cur][email][cat] * 100) / 100;
        }
      }
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

};

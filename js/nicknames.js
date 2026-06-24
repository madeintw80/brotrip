// 暱稱模組：Meta Messenger 風格，誰最後改算數
// v1.5.0：加 localStorage cache

const Nicknames = {
  map: {},

  loadFromCache() {
    const data = Cache.get('nicknames');
    if (data && typeof data === 'object') {
      this.map = data;
      return true;
    }
    return false;
  },

  async loadAll() {
    try {
      const rows = await API.getSheet('Nicknames');
      const list = API.rowsToObjects(rows);
      const newMap = {};
      list.forEach(n => {
        if (n.target_email) {
          newMap[n.target_email] = {
            nickname: n.nickname || '',
            updated_by: n.updated_by || '',
            updated_at: n.updated_at || '',
          };
        }
      });
      // 合併策略：本地比 server 新的條目保留
      // 避免「剛改完暱稱 → 下拉更新 → server 還沒 propagate → 清掉新值」
      Object.keys(this.map).forEach(email => {
        const local = this.map[email];
        const remote = newMap[email];
        if (local && local.updated_at && (!remote || (remote.updated_at || '') < local.updated_at)) {
          newMap[email] = local;
        }
      });
      this.map = newMap;
      Cache.set('nicknames', this.map);
    } catch (err) {
      console.warn('Load nicknames failed:', err);
      // 失敗時不清 map（保留現有狀態）
    }
    return this.map;
  },

  get(email) {
    const entry = this.map[email];
    return entry ? entry.nickname : '';
  },

  getEntry(email) {
    return this.map[email] || null;
  },

  async set(targetEmail, nickname) {
    const now = new Date().toISOString();
    const cleanNick = (nickname || '').trim();
    const row = [targetEmail, cleanNick, Auth.user.email, now];

    const rows = await API.getSheet('Nicknames');
    const idx = rows.findIndex((r, i) => i > 0 && r[0] === targetEmail);
    if (idx > 0) {
      const range = `Nicknames!A${idx + 1}:D${idx + 1}`;
      await API.sheetsRequest(`/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
        method: 'PUT',
        body: JSON.stringify({ values: [row] }),
      });
    } else {
      await API.appendRow('Nicknames', row);
    }

    this.map[targetEmail] = {
      nickname: cleanNick,
      updated_by: Auth.user.email,
      updated_at: now,
    };
    Cache.set('nicknames', this.map);
  },
};

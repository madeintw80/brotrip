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
      this.map = {};
      list.forEach(n => {
        if (n.target_email) {
          this.map[n.target_email] = {
            nickname: n.nickname || '',
            updated_by: n.updated_by || '',
            updated_at: n.updated_at || '',
          };
        }
      });
      Cache.set('nicknames', this.map);
    } catch (err) {
      console.warn('Load nicknames failed:', err);
      this.map = {};
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

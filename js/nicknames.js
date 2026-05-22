// 暱稱模組：Meta Messenger 風格，誰最後改算數
// Sheet: Nicknames (target_email | nickname | updated_by | updated_at)
// 任何人都可以給任何人取暱稱，全部成員看到的暱稱一致

const Nicknames = {
  map: {},  // { target_email: { nickname, updated_by, updated_at } }

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

    // 看 sheet 中是否已有該 target 的 row（rows[0] 是 header）
    const rows = await API.getSheet('Nicknames');
    const idx = rows.findIndex((r, i) => i > 0 && r[0] === targetEmail);
    if (idx > 0) {
      // 更新既有 row（idx 是 0-based array index，對應 sheet 1-based row 是 idx+1）
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
  },
};

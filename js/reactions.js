// 表情反應模組 — v3.9.14
// 每篇日記可以按多種表情（👍❤️😂😮😢🔥），Slack/Discord 風格：
//   - 同一個人對同一篇日記可以按多個「不同」表情
//   - 再按一次同一個表情 = 取消（toggle）
// Sheet: Reactions (id | diary_id | author | emoji | created_at)
// 跟留言不同：不發通知（避免 toggle 來回造成通知洗版）

const Reactions = {
  list: [],

  // 可選的表情（陣列順序 = UI 上的顯示順序）
  // 要增減表情改這裡即可，不用動 schema（emoji 直接存字串）
  EMOJIS: ['👍', '❤️', '😂', '😮', '😢', '🔥'],

  loadFromCache() {
    const data = Cache.get('reactions');
    if (data && Array.isArray(data)) {
      this.list = data;
      return true;
    }
    return false;
  },

  // 既有群組第一次 load → Reactions tab 可能還不存在 → ensureGroupTab 自動建好再 retry
  // （照 wishlist.js 的同款 fallback，讓 5 個朋友都不用手動升級）
  async loadAll() {
    try {
      const rows = await API.getSheet('Reactions');
      this.list = API.rowsToObjects(rows);
      Cache.set('reactions', this.list);
    } catch (err) {
      const msg = String((err && err.message) || err);
      // 404 / Unable to parse range → tab 不存在 → 建立並重試一次
      if (msg.includes('Unable to parse range') || msg.includes('404')) {
        try {
          console.log('[Reactions] tab 不存在，自動建立中...');
          await Groups.ensureGroupTab('Reactions');
          const rows = await API.getSheet('Reactions');
          this.list = API.rowsToObjects(rows);
          Cache.set('reactions', this.list);
        } catch (err2) {
          console.warn('Reactions.loadAll retry failed:', err2);
          this.list = [];
        }
      } else {
        console.warn('Load reactions failed:', err);
        this.list = [];
      }
    }
    return this.list;
  },

  // 某篇日記的所有反應 row
  getForDiary(diaryId) {
    return this.list.filter(r => r.diary_id === diaryId);
  },

  // 聚合成 UI 要的格式：{ emoji: { count, mine, authors:[email,...] }, ... }
  //   count   = 該表情幾個人按
  //   mine    = 我自己有沒有按這個表情（決定按鈕要不要 highlight）
  //   authors = 按的人 email 清單（render 時轉成暱稱當 tooltip）
  summary(diaryId) {
    const me = Auth.user ? Auth.user.email : null;
    const result = {};
    this.getForDiary(diaryId).forEach(r => {
      if (!result[r.emoji]) result[r.emoji] = { count: 0, mine: false, authors: [] };
      result[r.emoji].count++;
      result[r.emoji].authors.push(r.author);
      if (me && r.author === me) result[r.emoji].mine = true;
    });
    return result;
  },

  // 找「我」對某篇某表情的那一筆（找得到 = 我按過了）
  _mine(diaryId, emoji) {
    const me = Auth.user ? Auth.user.email : null;
    if (!me) return null;
    return this.list.find(r =>
      r.diary_id === diaryId && r.emoji === emoji && r.author === me
    );
  },

  // 切換反應：已按 → 取消；沒按 → 新增。回傳 true=現在有按 / false=現在取消
  // 樂觀更新：function 一進來就先改本地 list（同步、在第一個 await 之前完成），
  //   呼叫端可以立刻重畫做到「秒回饋」；API 失敗會自動 revert 並 throw
  async toggle(diaryId, emoji) {
    if (!Auth.user) throw new Error('尚未登入');
    if (!this.EMOJIS.includes(emoji)) throw new Error('不支援的表情');

    const existing = this._mine(diaryId, emoji);

    if (existing) {
      // === 取消：先本地移除，再刪 sheet row ===
      const idx = this.list.indexOf(existing);
      if (idx >= 0) this.list.splice(idx, 1);
      Cache.set('reactions', this.list);
      try {
        await API.deleteRow('Reactions', existing.id);
      } catch (err) {
        // 失敗 → 把剛剛移除的那筆塞回去（revert）
        this.list.push(existing);
        Cache.set('reactions', this.list);
        throw err;
      }
      return false;
    }

    // === 新增：先本地塞一筆（id 跟之後寫 sheet 用同一個），再 append ===
    const id = API.newId();
    const createdAt = new Date().toISOString();
    const newRow = {
      id,
      diary_id: diaryId,
      author: Auth.user.email,
      emoji,
      created_at: createdAt,
    };
    this.list.push(newRow);
    Cache.set('reactions', this.list);
    try {
      await API.appendRow('Reactions', [id, diaryId, Auth.user.email, emoji, createdAt]);
    } catch (err) {
      // 失敗 → 移除剛剛樂觀加的那筆（revert）
      const idx = this.list.indexOf(newRow);
      if (idx >= 0) this.list.splice(idx, 1);
      Cache.set('reactions', this.list);
      throw err;
    }
    return true;
  },
};

// 留言模組：每篇日記可以留言，自己的留言可刪
// Sheet: Comments (id | diary_id | author | content | created_at)

const Comments = {
  list: [],  // 全部留言 (不分 trip)

  async loadAll() {
    try {
      const rows = await API.getSheet('Comments');
      this.list = API.rowsToObjects(rows);
    } catch (err) {
      console.warn('Load comments failed:', err);
      this.list = [];
    }
    return this.list;
  },

  // 拿某篇日記的留言（按時間正序：舊到新）
  getForDiary(diaryId) {
    return this.list
      .filter(c => c.diary_id === diaryId)
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  },

  async create(diaryId, content) {
    const id = API.newId();
    const createdAt = new Date().toISOString();
    const row = [id, diaryId, Auth.user.email, content, createdAt];
    await API.appendRow('Comments', row);
    const newComment = {
      id,
      diary_id: diaryId,
      author: Auth.user.email,
      content,
      created_at: createdAt,
    };
    this.list.push(newComment);
    return newComment;
  },

  async delete(id) {
    const existing = this.list.find(c => c.id === id);
    if (!existing) throw new Error('找不到該留言');
    if (existing.author !== Auth.user.email) throw new Error('只能刪自己的留言');
    await API.deleteRow('Comments', id);
    const idx = this.list.indexOf(existing);
    if (idx >= 0) this.list.splice(idx, 1);
  },
};

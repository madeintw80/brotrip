// 留言模組：每篇日記可以留言，自己的留言可刪
// v1.6.0：加 mentions 欄位 + 觸發通知（留言給日記作者 + tag 的人）
// v1.5.0：加 localStorage cache

const Comments = {
  list: [],

  loadFromCache() {
    const data = Cache.get('comments');
    if (data && Array.isArray(data)) {
      this.list = data;
      return true;
    }
    return false;
  },

  async loadAll() {
    try {
      const rows = await API.getSheet('Comments');
      this.list = API.rowsToObjects(rows);
      Cache.set('comments', this.list);
    } catch (err) {
      console.warn('Load comments failed:', err);
      this.list = [];
    }
    return this.list;
  },

  getForDiary(diaryId) {
    return this.list
      .filter(c => c.diary_id === diaryId)
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  },

  async create(diaryId, content, mentions = []) {
    const id = API.newId();
    const createdAt = new Date().toISOString();
    const mentionsArr = Array.isArray(mentions) ? mentions : [];
    const mentionsJson = JSON.stringify(mentionsArr);
    const row = [id, diaryId, Auth.user.email, content, createdAt, mentionsJson];
    await API.appendRow('Comments', row);
    const newComment = {
      id,
      diary_id: diaryId,
      author: Auth.user.email,
      content,
      created_at: createdAt,
      mentions: mentionsJson,
    };
    this.list.push(newComment);
    Cache.set('comments', this.list);

    // 觸發通知：
    // 1. 日記作者（不是自己時）→ 'comment'
    // 2. mentioned 的人 → 'comment-mention'
    if (typeof Notifications !== 'undefined') {
      try {
        const items = [];
        const diary = (typeof Diaries !== 'undefined')
          ? Diaries.allList.find(d => d.id === diaryId)
          : null;
        const diaryAuthor = diary ? diary.author : null;
        if (diaryAuthor && diaryAuthor !== Auth.user.email) {
          items.push({
            target_email: diaryAuthor,
            type: 'comment',
            diary_id: diaryId,
            comment_id: id,
          });
        }
        mentionsArr.forEach(email => {
          if (email !== diaryAuthor && email !== Auth.user.email) {
            items.push({
              target_email: email,
              type: 'comment-mention',
              diary_id: diaryId,
              comment_id: id,
            });
          }
        });
        if (items.length > 0) await Notifications.createBatch(items);
      } catch (err) {
        console.warn('Create notifications failed:', err);
      }
    }

    return newComment;
  },

  async delete(id) {
    const existing = this.list.find(c => c.id === id);
    if (!existing) throw new Error('找不到該留言');
    if (existing.author !== Auth.user.email) throw new Error('只能刪自己的留言');
    await API.deleteRow('Comments', id);
    const idx = this.list.indexOf(existing);
    if (idx >= 0) this.list.splice(idx, 1);
    Cache.set('comments', this.list);
  },
};

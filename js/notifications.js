// 通知模組：被 tag 或留言時建立 notification
// Sheet: Notifications (id | target_email | type | diary_id | comment_id | from_email | created_at)
// 未讀判斷：localStorage 存 lastReadAt timestamp，notifications.created_at > lastReadAt = 未讀

const Notifications = {
  list: [],

  loadFromCache() {
    const data = Cache.get('notifications');
    if (data && Array.isArray(data)) {
      this.list = data;
      return true;
    }
    return false;
  },

  async loadAll() {
    try {
      const rows = await API.getSheet('Notifications');
      this.list = API.rowsToObjects(rows);
      Cache.set('notifications', this.list);
    } catch (err) {
      console.warn('Load notifications failed:', err);
      this.list = [];
    }
    return this.list;
  },

  // 拿我的通知（target=me，按時間新→舊）
  getForMe() {
    if (!Auth.user) return [];
    return this.list
      .filter(n => n.target_email === Auth.user.email && n.from_email !== Auth.user.email)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  },

  isUnread(notif) {
    const lastRead = parseInt(localStorage.getItem('brotrip_last_notif_read') || '0', 10);
    const ts = new Date(notif.created_at || 0).getTime();
    return ts > lastRead;
  },

  unreadCount() {
    return this.getForMe().filter(n => this.isUnread(n)).length;
  },

  markAllRead() {
    localStorage.setItem('brotrip_last_notif_read', String(Date.now()));
  },

  // Batch 建立多筆通知（appendRows）
  async createBatch(items) {
    if (!items || items.length === 0) return;
    const myEmail = Auth.user.email;
    const validItems = items.filter(it => it.target_email && it.target_email !== myEmail);
    if (validItems.length === 0) return;

    const objs = validItems.map(it => {
      const id = API.newId();
      const createdAt = new Date().toISOString();
      return {
        id,
        target_email: it.target_email,
        type: it.type,
        diary_id: it.diary_id || '',
        comment_id: it.comment_id || '',
        from_email: myEmail,
        created_at: createdAt,
      };
    });

    const rows = objs.map(o => [
      o.id,
      o.target_email,
      o.type,
      o.diary_id,
      o.comment_id,
      o.from_email,
      o.created_at,
    ]);

    await API.appendRows('Notifications', rows);
    objs.forEach(o => this.list.push(o));
    Cache.set('notifications', this.list);
  },
};

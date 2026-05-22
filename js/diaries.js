// 日記模組：上傳照片 + 文字心情，依 trip 篩選顯示

const Diaries = {
  list: [],

  async loadAll() {
    const rows = await API.getSheet('Diaries');
    const all = API.rowsToObjects(rows);
    if (Trips.current) {
      this.list = all.filter(d => d.trip_id === Trips.current.trip_id);
    } else {
      this.list = [];
    }
    // 新到舊
    this.list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    return this.list;
  },

  async create(data, onProgress) {
    if (!Trips.current) throw new Error('沒有當前 trip');
    const id = API.newId();

    // 上傳照片：trip 一個資料夾 → date 一個資料夾
    const photoIds = [];
    if (data.photos && data.photos.length > 0) {
      const tripFolderId = await API.ensureFolder(Trips.current.trip_id, CONFIG.PHOTOS_FOLDER_ID);
      const dateFolderId = await API.ensureFolder(data.date, tripFolderId);

      for (let i = 0; i < data.photos.length; i++) {
        const file = data.photos[i];
        if (onProgress) onProgress(i + 1, data.photos.length);
        const uploaded = await API.uploadFile(file, dateFolderId);
        photoIds.push(uploaded.id);
        // 公開讀（讓朋友能看縮圖）
        try { await API.makePublic(uploaded.id); } catch {}
      }
    }

    // 編碼 location：有 place（含座標）就存 JSON，否則純文字
    let locationStr = '';
    if (data.place) {
      locationStr = JSON.stringify({
        name: data.place.name,
        address: data.place.address,
        place_id: data.place.place_id,
        lat: data.place.lat,
        lng: data.place.lng,
      });
    } else if (data.location) {
      locationStr = data.location;
    }

    const createdAt = new Date().toISOString();
    const row = [
      id,
      Trips.current.trip_id,
      data.date,
      Auth.user.email,
      data.content,
      data.mood || '',
      JSON.stringify(photoIds),
      locationStr,
      createdAt,
      '',  // pinned (預設空字串 = 未置頂)
    ];
    await API.appendRow('Diaries', row);
    const newDiary = {
      id,
      trip_id: Trips.current.trip_id,
      date: data.date,
      author: Auth.user.email,
      content: data.content,
      mood: data.mood || '',
      photo_ids: JSON.stringify(photoIds),
      location: locationStr,
      created_at: createdAt,
      pinned: '',
    };
    this.list.unshift(newDiary);
    return newDiary;
  },

  // 編輯（只能改自己的）
  async update(id, data) {
    const existing = this.list.find(d => d.id === id);
    if (!existing) throw new Error('找不到該日記');
    if (existing.author !== Auth.user.email) throw new Error('只能改自己的日記');

    let locationStr = '';
    if (data.place) {
      locationStr = JSON.stringify({
        name: data.place.name,
        address: data.place.address,
        place_id: data.place.place_id,
        lat: data.place.lat,
        lng: data.place.lng,
      });
    } else if (data.location) {
      locationStr = data.location;
    }

    const newRow = [
      existing.id,
      existing.trip_id,
      data.date,
      existing.author,
      data.content,
      data.mood || '',
      existing.photo_ids,  // 編輯不改照片
      locationStr,
      existing.created_at,
      existing.pinned || '',
    ];
    await API.updateRow('Diaries', id, newRow);
    Object.assign(existing, {
      date: data.date,
      content: data.content,
      mood: data.mood || '',
      location: locationStr,
    });
    return existing;
  },

  // 刪除（只能刪自己的）
  async delete(id) {
    const existing = this.list.find(d => d.id === id);
    if (!existing) throw new Error('找不到該日記');
    if (existing.author !== Auth.user.email) throw new Error('只能刪自己的日記');
    await API.deleteRow('Diaries', id);
    const idx = this.list.indexOf(existing);
    if (idx >= 0) this.list.splice(idx, 1);
  },

  // 切換置頂（任何人都可以）
  async togglePinned(id) {
    const existing = this.list.find(d => d.id === id);
    if (!existing) throw new Error('找不到該日記');
    const wasPinned = String(existing.pinned).toUpperCase() === 'TRUE';
    const newPinned = wasPinned ? 'FALSE' : 'TRUE';
    const newRow = [
      existing.id,
      existing.trip_id,
      existing.date,
      existing.author,
      existing.content,
      existing.mood,
      existing.photo_ids,
      existing.location,
      existing.created_at,
      newPinned,
    ];
    await API.updateRow('Diaries', id, newRow);
    existing.pinned = newPinned;
    return !wasPinned;
  },
};

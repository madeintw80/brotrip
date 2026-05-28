// 日記模組：上傳照片 + 文字心情，依 trip 篩選顯示
// v1.6.0：加 mentions 欄位（被 tag 的 email JSON），create 後觸發 Notifications
// v1.5.0：allList + list 雙層 cache
// 每篇日記獨立 Drive 資料夾

const Diaries = {
  list: [],
  allList: [],

  _filter() {
    if (Trips.current) {
      this.list = this.allList.filter(d => d.trip_id === Trips.current.trip_id);
    } else {
      this.list = [];
    }
    this.list.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  },

  loadFromCache() {
    const data = Cache.get('diaries');
    if (data && Array.isArray(data)) {
      this.allList = data;
      this._filter();
      return true;
    }
    return false;
  },

  async loadAll() {
    try {
      const rows = await API.getSheet('Diaries');
      this.allList = API.rowsToObjects(rows);
      Cache.set('diaries', this.allList);
      this._filter();
    } catch (err) {
      console.error('Diaries.loadAll failed:', err);
      // 不 throw（讓其他模組可以繼續），但 expose error 給 debug 用
      if (typeof App !== 'undefined') App._lastError = `Diaries: ${err.message}`;
    }
    return this.list;
  },

  async create(data, onProgress) {
    if (!Trips.current) throw new Error('沒有當前 trip');
    const id = API.newId();

    const photoIds = [];
    let driveFolderUrl = '';
    if (data.photos && data.photos.length > 0) {
      // Phase 2: photos folder 從 active group 取
      const tripFolderId = await API.ensureFolder(Trips.current.trip_id, Groups.active().photosFolderId);
      const diaryFolderName = `${data.date}-${id}`;
      const diaryFolderId = await API.ensureFolder(diaryFolderName, tripFolderId);
      driveFolderUrl = `https://drive.google.com/drive/folders/${diaryFolderId}`;

      for (let i = 0; i < data.photos.length; i++) {
        const file = data.photos[i];
        if (onProgress) onProgress(i + 1, data.photos.length);
        const uploaded = await API.uploadFile(file, diaryFolderId);
        photoIds.push(uploaded.id);
        try { await API.makePublic(uploaded.id); } catch {}
      }
    }

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
    const mentions = Array.isArray(data.mentions) ? data.mentions : [];
    const mentionsJson = JSON.stringify(mentions);
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
      '',
      driveFolderUrl,
      mentionsJson,  // L: mentions JSON
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
      url: driveFolderUrl,
      mentions: mentionsJson,
    };
    this.allList.push(newDiary);
    this._filter();
    Cache.set('diaries', this.allList);

    // 觸發通知（被 tag 的人）
    if (mentions.length > 0 && typeof Notifications !== 'undefined') {
      try {
        await Notifications.createBatch(mentions.map(email => ({
          target_email: email,
          type: 'mention',
          diary_id: id,
        })));
      } catch (err) {
        console.warn('Create notifications failed:', err);
      }
    }

    return newDiary;
  },

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

    const mentions = Array.isArray(data.mentions) ? data.mentions : [];
    const mentionsJson = JSON.stringify(mentions);

    const newRow = [
      existing.id,
      existing.trip_id,
      data.date,
      existing.author,
      data.content,
      data.mood || '',
      existing.photo_ids,
      locationStr,
      existing.created_at,
      existing.pinned || '',
      existing.url || '',
      mentionsJson,
    ];
    await API.updateRow('Diaries', id, newRow);
    Object.assign(existing, {
      date: data.date,
      content: data.content,
      mood: data.mood || '',
      location: locationStr,
      mentions: mentionsJson,
    });
    Cache.set('diaries', this.allList);
    return existing;
  },

  async delete(id) {
    const existing = this.list.find(d => d.id === id);
    if (!existing) throw new Error('找不到該日記');
    if (existing.author !== Auth.user.email) throw new Error('只能刪自己的日記');
    // TODO (v3.4+): 反向 reset wish — 目前 diary row 沒存 wishlist_id (避免污染既有群組 schema)，
    //   未來實作 ensureGroupColumns 補 sheet header 後再啟用：
    //     if (existing.wishlist_id) try { await Wishlist.resetToPlanned(existing.wishlist_id); } catch {}
    await API.deleteRow('Diaries', id);
    const idx = this.list.indexOf(existing);
    if (idx >= 0) this.list.splice(idx, 1);
    const allIdx = this.allList.indexOf(existing);
    if (allIdx >= 0) this.allList.splice(allIdx, 1);
    Cache.set('diaries', this.allList);
  },

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
      existing.url || '',
      existing.mentions || '',
    ];
    await API.updateRow('Diaries', id, newRow);
    existing.pinned = newPinned;
    Cache.set('diaries', this.allList);
    return !wasPinned;
  },
};

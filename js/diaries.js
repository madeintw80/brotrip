// 日記模組：上傳照片 + 文字心情，依 trip 篩選顯示
// v1.5.0：allList + list 雙層（cache 全部、list 當前 trip filtered）
// 每篇日記獨立 Drive 資料夾 (BroTrip/photos/<trip>/<date>-<id>/)

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
    const rows = await API.getSheet('Diaries');
    this.allList = API.rowsToObjects(rows);
    Cache.set('diaries', this.allList);
    this._filter();
    return this.list;
  },

  async create(data, onProgress) {
    if (!Trips.current) throw new Error('沒有當前 trip');
    const id = API.newId();

    const photoIds = [];
    let driveFolderUrl = '';
    if (data.photos && data.photos.length > 0) {
      const tripFolderId = await API.ensureFolder(Trips.current.trip_id, CONFIG.PHOTOS_FOLDER_ID);
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
    };
    this.allList.push(newDiary);
    this._filter();
    Cache.set('diaries', this.allList);
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
    ];
    await API.updateRow('Diaries', id, newRow);
    Object.assign(existing, {
      date: data.date,
      content: data.content,
      mood: data.mood || '',
      location: locationStr,
    });
    Cache.set('diaries', this.allList);
    return existing;
  },

  async delete(id) {
    const existing = this.list.find(d => d.id === id);
    if (!existing) throw new Error('找不到該日記');
    if (existing.author !== Auth.user.email) throw new Error('只能刪自己的日記');
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
    ];
    await API.updateRow('Diaries', id, newRow);
    existing.pinned = newPinned;
    Cache.set('diaries', this.allList);
    return !wasPinned;
  },
};

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

    const row = [
      id,
      Trips.current.trip_id,
      data.date,
      Auth.user.email,
      data.content,
      data.mood || '',
      JSON.stringify(photoIds),
      locationStr,
      new Date().toISOString(),
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
      created_at: new Date().toISOString(),
    };
    this.list.unshift(newDiary);
    return newDiary;
  },
};

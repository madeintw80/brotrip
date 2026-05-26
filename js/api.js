// Google Sheets + Drive REST API 封裝
// 沒用 gapi library，直接打 REST，比較少 dependency

const API = {
  // ===== Sheets =====

  async sheetsRequest(path, options = {}) {
    const token = await Auth.ensureToken();
    // Phase 2: sheet ID 從當前 active group 取（不再從 CONFIG）
    const group = Groups.active();
    if (!group) throw new Error('No active group — please join or create one');
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${group.sheetId}${path}`;
    const resp = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Sheets API ${resp.status}: ${err.slice(0, 200)}`);
    }
    return resp.json();
  },

  // 讀整個分頁（含 header）
  async getSheet(sheetName) {
    const data = await this.sheetsRequest(`/values/${encodeURIComponent(sheetName)}`);
    return data.values || [];
  },

  // 追加一 row
  async appendRow(sheetName, values) {
    return await this.sheetsRequest(
      `/values/${encodeURIComponent(sheetName)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        body: JSON.stringify({ values: [values] }),
      }
    );
  },

  // 批次追加多 rows（一次 API call 寫多筆）
  async appendRows(sheetName, rows) {
    if (!rows || rows.length === 0) return;
    return await this.sheetsRequest(
      `/values/${encodeURIComponent(sheetName)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        body: JSON.stringify({ values: rows }),
      }
    );
  },

  // 把 [[header],[row1],[row2]...] 變成 [{col1:v, col2:v},...]
  rowsToObjects(rows) {
    if (!rows || rows.length === 0) return [];
    const headers = rows[0];
    return rows.slice(1).map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? row[i] : ''; });
      return obj;
    });
  },

  // ===== Drive =====

  // 確保子資料夾存在（不存在就建），回傳 ID
  async ensureFolder(name, parentId) {
    const token = await Auth.ensureToken();
    // 先查
    const q = `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`;
    const sResp = await fetch(searchUrl, { headers: { Authorization: `Bearer ${token}` } });
    const sData = await sResp.json();
    if (sData.files && sData.files.length > 0) {
      return sData.files[0].id;
    }
    // 建立
    const cResp = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      }),
    });
    if (!cResp.ok) throw new Error(`Create folder failed: ${cResp.status}`);
    const cData = await cResp.json();
    return cData.id;
  },

  // 上傳檔案到指定資料夾
  async uploadFile(file, folderId, customName) {
    const token = await Auth.ensureToken();
    const metadata = {
      name: customName || file.name,
      parents: [folderId],
    };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', file);

    const resp = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      }
    );
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Upload failed: ${resp.status} ${err.slice(0, 200)}`);
    }
    return resp.json();
  },

  // 設定為「擁有連結的人皆可檢視」（讓縮圖能跨用戶顯示）
  async makePublic(fileId) {
    const token = await Auth.ensureToken();
    const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ role: 'reader', type: 'anyone' }),
    });
    if (!resp.ok) {
      console.warn('makePublic failed', resp.status, await resp.text());
    }
  },

  // 拿 Drive 圖片縮圖 URL（給 <img src>）
  // lh3 CDN 對 anyone-with-link 檔案最穩；drive.google.com/thumbnail 常 403
  driveImageUrl(fileId, width = 400) {
    return `https://lh3.googleusercontent.com/d/${fileId}=w${width}`;
  },

  // Fallback：lh3 載入失敗時用 Drive API + access token 拿原檔做 blob URL
  async fetchDriveBlobUrl(fileId) {
    const token = await Auth.ensureToken();
    const resp = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!resp.ok) throw new Error('fetch blob failed: ' + resp.status);
    const blob = await resp.blob();
    return URL.createObjectURL(blob);
  },

  // 產生簡單的 ID（時間戳 + 隨機）
  newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  },

  // 更新某 row（用第一欄 id 找到 row index，再用 PUT 覆寫整列）
  async updateRow(sheetName, id, newRow) {
    const rows = await this.getSheet(sheetName);
    const idx = rows.findIndex(r => r[0] === id);
    if (idx < 0) throw new Error('找不到該筆資料');
    const rowNum = idx + 1; // 1-based
    // 算 range: 最多支援到 Z 欄（26 cols 夠用）
    const endCol = String.fromCharCode(65 + newRow.length - 1);
    const range = `${sheetName}!A${rowNum}:${endCol}${rowNum}`;
    return await this.sheetsRequest(
      `/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
      {
        method: 'PUT',
        body: JSON.stringify({ values: [newRow] }),
      }
    );
  },

  // 刪除某 row（batchUpdate deleteDimension，整列刪除避免留空格）
  async deleteRow(sheetName, id) {
    const sheetId = CONFIG.SHEET_TAB_IDS[sheetName];
    if (sheetId === undefined) throw new Error('未知的 sheet: ' + sheetName);
    const rows = await this.getSheet(sheetName);
    const idx = rows.findIndex(r => r[0] === id);
    if (idx < 0) throw new Error('找不到該筆資料');
    return await this.sheetsRequest(':batchUpdate', {
      method: 'POST',
      body: JSON.stringify({
        requests: [{
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: idx,
              endIndex: idx + 1,
            },
          },
        }],
      }),
    });
  },

  // 一次刪掉多 rows（給 Trip 刪除時清關聯資料用，避免 API rate limit）
  async batchDeleteRows(sheetName, ids) {
    if (!ids || ids.length === 0) return;
    const sheetId = CONFIG.SHEET_TAB_IDS[sheetName];
    if (sheetId === undefined) throw new Error('未知的 sheet: ' + sheetName);
    const rows = await this.getSheet(sheetName);
    const idSet = new Set(ids);
    const indexes = [];
    rows.forEach((r, i) => {
      if (i > 0 && idSet.has(r[0])) indexes.push(i);
    });
    if (indexes.length === 0) return;
    // 從後面開始刪（避免 index shift）
    indexes.sort((a, b) => b - a);
    const requests = indexes.map(idx => ({
      deleteDimension: {
        range: { sheetId, dimension: 'ROWS', startIndex: idx, endIndex: idx + 1 },
      },
    }));
    return await this.sheetsRequest(':batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ requests }),
    });
  },
};

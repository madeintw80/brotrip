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
    // Phase 2: tab ID 從 active group 取（新群組的 tab ID 由 Google 自動分配）
    const group = Groups.active();
    if (!group || !group.sheetTabIds) throw new Error('No active group with sheetTabIds');
    const sheetId = group.sheetTabIds[sheetName];
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
    // Phase 2: tab ID 從 active group 取
    const group = Groups.active();
    if (!group || !group.sheetTabIds) throw new Error('No active group with sheetTabIds');
    const sheetId = group.sheetTabIds[sheetName];
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

  // ===== Spreadsheet 建立流程（M2: Phase 2 建新群組用）=====

  // 建立新 Google Sheet（檔案先放 Drive 根目錄，之後 move 到目標 folder）
  // 回傳 { spreadsheetId, sheets: [{ properties: { sheetId, title } }] }
  async createSpreadsheet(title) {
    const token = await Auth.ensureToken();
    const resp = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        properties: { title },
        // 預設一個 tab 叫 Trips（之後再加另外 8 個）
        sheets: [{ properties: { title: 'Trips' } }],
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Create spreadsheet failed: ${resp.status} ${err.slice(0, 200)}`);
    }
    return await resp.json();
  },

  // 把 Drive 檔案 move 到指定 folder（用於把新建的 Sheet 從根目錄搬進群組資料夾）
  async moveFileToFolder(fileId, targetFolderId) {
    const token = await Auth.ensureToken();
    // 先查當前的 parents
    const getResp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const fileData = await getResp.json();
    const previousParents = fileData.parents ? fileData.parents.join(',') : '';
    // Move
    const moveResp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${targetFolderId}&removeParents=${previousParents}&fields=id,parents`,
      { method: 'PATCH', headers: { Authorization: `Bearer ${token}` } }
    );
    if (!moveResp.ok) {
      const err = await moveResp.text();
      throw new Error(`Move file failed: ${moveResp.status} ${err.slice(0, 200)}`);
    }
    return await moveResp.json();
  },

  // 一次加多個 tab 到現有 Sheet，回傳 { tabName: sheetId } 對照表
  // sheetId 是 Google API 給的整數，後續 deleteRow / batchUpdate 會用到
  async addSheetTabs(spreadsheetId, tabNames) {
    const token = await Auth.ensureToken();
    const requests = tabNames.map(name => ({
      addSheet: { properties: { title: name } },
    }));
    const resp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ requests }),
      }
    );
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Add tabs failed: ${resp.status} ${err.slice(0, 200)}`);
    }
    const data = await resp.json();
    // data.replies 順序對應 requests 順序
    const map = {};
    data.replies.forEach((r, i) => {
      map[tabNames[i]] = r.addSheet.properties.sheetId;
    });
    return map;
  },

  // ===== M4.5: Drive 掃描（auto-detect owned groups）=====

  // 找指定 parent 下的同名資料夾（回第一個，沒有回 null）
  async findFolderByName(name, parentId = 'root') {
    const token = await Auth.ensureToken();
    const q = `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return (data.files && data.files.length > 0) ? data.files[0] : null;
  },

  // 列出某資料夾下的所有子資料夾
  async listSubFolders(parentId) {
    const token = await Auth.ensureToken();
    const q = `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=100`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.files || [];
  },

  // 找指定 parent 下的同名檔案（用於找 BroTrip-Data Sheet）
  async findFileByName(name, parentId) {
    const token = await Auth.ensureToken();
    const q = `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed=false`;
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return (data.files && data.files.length > 0) ? data.files[0] : null;
  },

  // 取 spreadsheet 的所有 tab IDs（建群組偵測用）
  async getSpreadsheetTabIds(spreadsheetId) {
    const token = await Auth.ensureToken();
    const resp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties(sheetId,title)`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) return {};
    const data = await resp.json();
    if (!data.sheets) return {};
    const map = {};
    data.sheets.forEach(s => {
      map[s.properties.title] = s.properties.sheetId;
    });
    return map;
  },

  // v3.1.1: 搜尋「我能看到但不是我擁有」的同名檔案（用於 detect 被邀請加入的群組）
  //
  // 為什麼不用 `sharedWithMe = true`：
  //   Google Drive 的 sharedWithMe 只標記「直接 share 給我的 root item」。
  //   當 owner 是 share **整個資料夾**（BroTrip/<group>/），裡面的 BroTrip-Data Sheet
  //   是 inherited access — query `sharedWithMe = true` **不會回**這些子檔案。
  //   v3.1.0 用 sharedWithMe → 哩哩看不到群組（folder share）→ 等很久無結果 → 進無群組畫面。
  //
  // 改用 `not 'me' in owners`：搜尋「我能看到但不是我自己擁有」的檔案，
  // Drive 預設搜尋範圍含 folder inherited，所以兩種 share 模式都涵蓋。
  async searchSharedWithMeFiles(name) {
    const token = await Auth.ensureToken();
    const q = `name = '${name.replace(/'/g, "\\'")}' and not 'me' in owners and trashed = false`;
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,parents,mimeType,owners)&pageSize=100`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) {
      console.warn(`[Drive] searchSharedWithMeFiles failed: ${resp.status}`);
      return [];
    }
    const data = await resp.json();
    return data.files || [];
  },

  // v3.1.0: 取單一檔案/資料夾的 metadata（含 parents 和 name）
  // 用於 sharedWithMe 偵測時反查 group folder 名稱
  async getFileMetadata(fileId) {
    const token = await Auth.ensureToken();
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,parents,mimeType`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) return null;
    return await resp.json();
  },

  // ===== M4.4: Drive 權限管理（踢人 + 刪群組用）=====

  // 列出某檔案/資料夾的所有 permissions（owner / editor / viewer 等）
  // 注意：member（非 owner）呼叫時可能只看到部分權限（Drive API 限制）
  async listDrivePermissions(fileId) {
    const token = await Auth.ensureToken();
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?fields=permissions(id,emailAddress,role,type,displayName,deleted)&pageSize=100`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`List permissions failed: ${resp.status} ${err.slice(0, 200)}`);
    }
    const data = await resp.json();
    const perms = data.permissions || [];
    console.log(`[Drive] listPermissions(${fileId}) returned ${perms.length} perms:`, perms);
    return perms;
  },

  // 撤銷某 email 對檔案/資料夾的存取權
  // 回傳：'deleted' | 'not_found' | throws on error
  // M4.7: 不再把 not_found 偽裝成 success — 給呼叫者決定怎麼處理
  async revokeDrivePermission(fileId, userEmail) {
    const perms = await this.listDrivePermissions(fileId);
    const perm = perms.find(p => (p.emailAddress || '').toLowerCase() === userEmail.toLowerCase());
    if (!perm) {
      console.warn(`[Drive] No permission found for ${userEmail} on ${fileId}. (Member 可能 list API 看不到自己的 perm)`);
      return 'not_found';
    }
    console.log(`[Drive] Found perm to delete:`, perm);
    const token = await Auth.ensureToken();
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}/permissions/${perm.id}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Revoke permission failed: ${resp.status} ${err.slice(0, 200)}`);
    }
    console.log(`[Drive] Deleted perm ${perm.id} for ${userEmail}`);
    return 'deleted';
  },

  // 刪除 Drive 檔案/資料夾（移到垃圾桶）
  // owner 刪整個群組用
  async deleteDriveFile(fileId) {
    const token = await Auth.ensureToken();
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Delete file failed: ${resp.status} ${err.slice(0, 200)}`);
    }
    return true;
  },

  // 改 Drive 檔案/資料夾名稱（用於重新命名群組資料夾）
  async renameDriveFile(fileId, newName) {
    const token = await Auth.ensureToken();
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: newName }),
      }
    );
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Rename failed: ${resp.status} ${err.slice(0, 200)}`);
    }
    return await resp.json();
  },

  // 寫 headers 到指定 tab 的第一列（用於建群組時初始化 schema）
  // 注意：這個方法接受任意 spreadsheetId（不像 sheetsRequest 是讀 active group）
  async setSheetHeaders(spreadsheetId, tabName, headers) {
    const token = await Auth.ensureToken();
    const range = `${tabName}!A1`;
    const resp = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ values: [headers] }),
      }
    );
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Set headers failed for ${tabName}: ${resp.status} ${err.slice(0, 200)}`);
    }
    return await resp.json();
  },
};

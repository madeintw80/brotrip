// BroTrip 主應用：UI router + 事件處理
// v1.6.0：tag 人 + 通知 + 多付款人

// Google Maps 動態載入
const Maps = {
  loaded: false,
  loadPromise: null,

  load() {
    if (this.loaded) return Promise.resolve();
    if (this.loadPromise) return this.loadPromise;
    if (!CONFIG.MAPS_API_KEY) return Promise.reject(new Error('沒有 MAPS_API_KEY'));

    this.loadPromise = new Promise((resolve, reject) => {
      window.__onGoogleMapsLoaded = () => { this.loaded = true; resolve(); };
      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${CONFIG.MAPS_API_KEY}&libraries=places&v=weekly&callback=__onGoogleMapsLoaded&loading=async`;
      script.async = true;
      script.defer = true;
      script.onerror = () => reject(new Error('Maps script 載入失敗'));
      document.head.appendChild(script);
    });
    return this.loadPromise;
  },

  attachAutocomplete(input, onSelect) {
    const ac = new google.maps.places.Autocomplete(input, {
      fields: ['place_id', 'name', 'geometry', 'formatted_address'],
    });
    ac.addListener('place_changed', () => {
      const p = ac.getPlace();
      if (!p || !p.geometry) return;
      onSelect({
        place_id: p.place_id || '',
        name: p.name || p.formatted_address || '',
        address: p.formatted_address || '',
        lat: p.geometry.location.lat(),
        lng: p.geometry.location.lng(),
      });
    });
    return ac;
  },
};

const App = {
  currentTab: 'expenses',
  _toastTimer: null,
  _selectedPlace: null,
  _editingExpenseId: null,
  _editingDiaryId: null,
  _editingTripId: null,
  _map: null,
  _mapMarkers: null,
  _itineraryRenderer: null,  // DirectionsRenderer 實例
  _itineraryWaypoints: [],   // 新增 modal 用的暫存 waypoints
  _activeItineraryId: null,  // 當前在地圖上顯示的行程
  _diaryFilter: { authors: [], dateFrom: '', dateTo: '', keyword: '' },
  _lightboxPhotos: [],
  _lightboxIndex: 0,
  _mentionState: null,  // { inputEl, atIdx } 當 @ 正在輸入中
  _lastError: null,  // 上次 loadAll 失敗的訊息（debug 用）

  async init() {
    // 還原 dark/light theme（最早做以免閃白）
    const savedTheme = localStorage.getItem('brotrip_theme');
    if (savedTheme) document.documentElement.dataset.theme = savedTheme;

    // M4.3: 偵測 invite 連結 ?invite=...（要在 Auth.init 之前，避免 reload 後 URL 已被清掉）
    this._checkInviteFromUrl();

    await Auth.init();
    this.bindUI();
    this.initPullToRefresh();
    this.updateVersionInfo();
    this.updateThemeUI();

    if (Auth.isLoggedIn()) {
      document.getElementById('loading').classList.add('hidden');
      await this.afterLogin();
      return;
    }

    if (Auth.user) {
      try {
        // ⭐ v2.0.2 timeout 5s → 10s（iOS GIS 載入慢，給多一點時間）
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('silent timeout')), 10000));
        await Promise.race([Auth.ensureToken(), timeout]);
        document.getElementById('loading').classList.add('hidden');
        await this.afterLogin();
        return;
      } catch (err) {
        console.warn('Silent re-auth failed:', err);
        // ⭐ v2.0.2 silent fail 不清 user，改進主畫面 with cache + 顯示續登 banner
        document.getElementById('loading').classList.add('hidden');
        // Phase 2: 沒群組時不能跑 cache main app，直接跳 no-group 畫面
        if (!Groups.active()) {
          this.showNoGroupScreen();
          this.showReauthBanner();
          return;
        }
        this.showReauthBanner();
        await this._showMainAppCacheOnly();
        return;
      }
    }

    document.getElementById('loading').classList.add('hidden');
    document.getElementById('login-screen').classList.remove('hidden');
    // v3.1.0: PWA 模式下顯示「第一次需要重登」hint，告知會自動找回群組
    this._updatePwaLoginHint();
  },

  // v3.1.0: 偵測是否以 PWA standalone 模式執行
  _isPWA() {
    try {
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
      // iOS Safari 的 PWA 特例（navigator.standalone）
      if (window.navigator && window.navigator.standalone === true) return true;
    } catch {}
    return false;
  },

  // v3.1.0: PWA 模式下 show login screen 的 hint（解釋 PWA storage 獨立、會自動找回群組）
  _updatePwaLoginHint() {
    const hint = document.getElementById('pwa-first-login-hint');
    if (!hint) return;
    if (this._isPWA()) {
      hint.classList.remove('hidden');
    } else {
      hint.classList.add('hidden');
    }
  },

  // M4.3: 從 URL 偵測 ?invite=xxx，存到 localStorage 後 reload 也能用
  _checkInviteFromUrl() {
    try {
      const params = new URLSearchParams(window.location.search);
      const inviteCode = params.get('invite');
      if (inviteCode) {
        localStorage.setItem('brotrip_pending_invite', inviteCode);
        // 清掉 URL 參數避免 reload 重複觸發
        const url = new URL(window.location.href);
        url.searchParams.delete('invite');
        window.history.replaceState({}, '', url.toString());
      }
    } catch (err) {
      console.warn('Invite URL check failed:', err);
    }
  },

  // Phase 2: 登入完成後依群組狀態分流
  async afterLogin() {
    // M4.3: 處理 pending invite（從連結來的）— 優先級最高
    const pendingInvite = localStorage.getItem('brotrip_pending_invite');
    if (pendingInvite) {
      localStorage.removeItem('brotrip_pending_invite');
      // 先決定底層畫面（有群組 → 主畫面；無 → 無群組畫面）
      if (Groups.active()) {
        await this.showMainApp();
      } else {
        this.showNoGroupScreen();
      }
      // 然後彈出 join modal 預填邀請碼
      setTimeout(() => {
        this.openJoinGroupModal();
        const input = document.querySelector('#join-group-form textarea[name="code"]');
        if (input) input.value = pendingInvite;
        this.toast('🎉 偵測到邀請連結！按「加入」即可');
      }, 300);
      return;
    }

    // M4.5 + v3.1.0: 本地沒群組 → 掃 Drive 找 (a) 自己建的 + (b) 被邀請加入的
    // 這是 PWA 第一次開啟 / 換裝置登入時的「自動找回群組」入口，
    // 包含 sharedWithMe 偵測 → 朋友從瀏覽器加入後，PWA 不用再貼一次邀請碼
    if (Groups.list.length === 0 && Auth.user) {
      try {
        this.toast('🔍 從 Google Drive 找你的群組...');
        const detected = await Groups.autoDetectGroups();
        if (detected.length > 0) {
          const ownerCount = detected.filter(g => g.role === 'owner').length;
          const memberCount = detected.filter(g => g.role === 'member').length;
          let msg = `✨ 找回 ${detected.length} 個群組`;
          if (ownerCount && memberCount) {
            msg += `（你建的 ${ownerCount}、被邀請 ${memberCount}）`;
          } else if (memberCount) {
            msg += '（被邀請加入的）';
          }
          this.toast(msg);
        }
      } catch (err) {
        console.warn('Auto-detect failed:', err);
      }
    }

    // 無群組（新用戶 / TGL legacy 被刪光）→ 顯示無群組畫面
    if (!Groups.active()) {
      this.showNoGroupScreen();
      return;
    }
    // 有群組 → 進主畫面
    await this.showMainApp();
  },

  // Phase 2: 無群組畫面（建立 / 加入）
  showNoGroupScreen() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app').classList.add('hidden');
    document.getElementById('no-group-screen').classList.remove('hidden');
    // 清掉殘留的 error banner（避免上次 404 提示停在最上面）
    const banner = document.getElementById('global-error-banner');
    if (banner) banner.classList.add('hidden');
  },

  // Phase 2: 打開建立群組 modal
  openCreateGroupModal() {
    const modal = document.getElementById('modal-create-group');
    if (!modal) return;
    // 重置表單
    const form = document.getElementById('create-group-form');
    if (form) form.reset();
    document.getElementById('create-group-progress').classList.add('hidden');
    document.getElementById('create-group-submit').disabled = false;
    modal.classList.remove('hidden');
  },

  // Phase 2: 處理建立群組表單 submit
  async handleCreateGroupSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const name = (form.elements.name.value || '').trim();
    if (!name) {
      this.toast('請輸入群組名稱');
      return;
    }

    const submitBtn = document.getElementById('create-group-submit');
    const progress = document.getElementById('create-group-progress');
    const stepText = document.getElementById('create-group-step');
    submitBtn.disabled = true;
    progress.classList.remove('hidden');

    try {
      const newGroup = await Groups.create(name, (step, total, msg) => {
        if (stepText) stepText.textContent = `${step}/${total} — ${msg}`;
      });

      // 關閉 modal
      document.getElementById('modal-create-group').classList.add('hidden');
      this.toast(`✅ 群組「${newGroup.name}」建立完成！`);

      // 顯示邀請碼
      this.showInviteCodeModal(newGroup);

      // 如果這是第一個群組（剛從 no-group-screen 進來），直接切去 app
      const noGroupScreen = document.getElementById('no-group-screen');
      if (noGroupScreen && !noGroupScreen.classList.contains('hidden')) {
        noGroupScreen.classList.add('hidden');
        await this.showMainApp();
      } else {
        // 已經在 app 內，切到新群組 + reload 資料
        // M2 不做 dropdown 切換，所以這裡先 reload 整頁
        // 之後 M3 加上 dropdown 後可以軟切換
        setTimeout(() => {
          if (confirm('新群組已建立！要切過去使用嗎？（會 reload app）')) {
            location.reload();
          }
        }, 500);
      }
    } catch (err) {
      progress.classList.add('hidden');
      submitBtn.disabled = false;
      this.toast('建立失敗：' + (err.message || '未知錯誤'));
      console.error('Create group error:', err);
    }
  },

  // ===== M5.1: 群組封存 toggle =====
  handleToggleArchive() {
    const g = Groups.active();
    if (!g) return;
    const next = !g.archived;
    const verb = next ? '封存' : '取消封存';
    if (!confirm(`確定要${verb}「${g.name}」?\n\n${next ? '封存後會從切換 dropdown 隱藏，可隨時取消封存復原。資料不會刪除。' : '取消封存會讓群組回到 dropdown 顯示。'}`)) return;
    Groups.setArchived(g.groupId, next);
    this.toast(`✅ 已${verb}「${g.name}」`);
    if (next) {
      // 封存後自動切到下一個 active（在 Groups.setArchived 內已做）
      setTimeout(() => location.reload(), 800);
    } else {
      this.updateGroupInfo();
    }
  },

  // ===== M5.0: 群組切換 dropdown =====
  openGroupSwitcher() {
    const modal = document.getElementById('modal-group-switcher');
    if (!modal) return;
    const listEl = document.getElementById('group-switcher-list');
    if (!listEl) return;

    const allGroups = Groups.all();
    const activeGroups = allGroups.filter(g => !g.archived);
    const archivedGroups = allGroups.filter(g => g.archived);
    const activeId = Groups.activeId;

    const renderRow = (g) => {
      const isCurrent = g.groupId === activeId;
      const roleLabel = g.role === 'owner' ? '👑 owner' : '👤 member';
      const archivedLabel = g.archived ? ' · 已封存' : '';
      return `
        <div class="group-switcher-row ${isCurrent ? 'current' : ''}">
          <div class="group-switcher-info">
            <span class="group-name">${isCurrent ? '✅ ' : '📁 '}${this.escapeHtml(g.name)}</span>
            <small>${isCurrent ? '當前' : '可切換'} · ${roleLabel}${archivedLabel}</small>
          </div>
          ${isCurrent
            ? `<button type="button" disabled>當前</button>`
            : `<button type="button" data-group-id="${this.escapeAttr(g.groupId)}">→ 切換</button>`
          }
        </div>
      `;
    };

    let html = '';
    if (allGroups.length === 0) {
      html = '<p class="hint" style="text-align:center; padding:20px;">還沒有任何群組<br>點下方按鈕建立或加入</p>';
    } else {
      html = activeGroups.map(renderRow).join('');
      if (archivedGroups.length > 0) {
        html += `
          <details style="margin-top:12px;">
            <summary style="cursor:pointer; color:var(--text-light); font-size:13px; padding:8px 0;">📦 已封存 (${archivedGroups.length})</summary>
            <div style="margin-top:8px;">
              ${archivedGroups.map(renderRow).join('')}
            </div>
          </details>
        `;
      }
    }
    listEl.innerHTML = html;

    // 綁定切換 buttons
    listEl.querySelectorAll('button[data-group-id]').forEach(btn => {
      btn.addEventListener('click', () => this.switchToGroup(btn.dataset.groupId));
    });

    modal.classList.remove('hidden');
  },

  async switchToGroup(groupId) {
    if (!groupId) return;
    if (Groups.activeId === groupId) {
      document.getElementById('modal-group-switcher').classList.add('hidden');
      return;
    }
    const target = Groups.list.find(g => g.groupId === groupId);
    if (!target) return;
    Groups.setActive(groupId);
    this.toast(`切換到「${target.name}」...`);
    // 完整 reload 切換 — 確保所有 cache / state 重置乾淨
    setTimeout(() => location.reload(), 400);
  },

  // ===== M5.0: 邀請連結 native Web Share =====
  // 手機優先用 navigator.share（跳 native sheet），否則 fallback 到複製剪貼簿
  async shareOrCopyText(text, opts = {}) {
    const { shareTitle = 'BroTrip 群組邀請', shareText = '來加入我們的出遊群組', copyToast = '已複製' } = opts;
    // 偵測 Web Share API（多數 mobile + 部分桌機 Safari 支援）
    if (navigator.share && navigator.canShare && navigator.canShare({ url: text })) {
      try {
        await navigator.share({ title: shareTitle, text: shareText, url: text });
        this.toast('✅ 已分享');
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;  // 用戶取消
        console.warn('Web Share failed, fallback to clipboard:', err);
      }
    }
    // Fallback: clipboard
    try {
      await navigator.clipboard.writeText(text);
      this.toast('✅ ' + copyToast);
    } catch (err) {
      // 最後 fallback: execCommand
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        this.toast('✅ ' + copyToast);
      } catch (err2) {
        this.toast('複製失敗，請手動選取');
        console.error(err2);
      }
    }
  },

  // ===== M4.4: 退出 / 刪除 / 管理成員 =====

  async openManageMembersModal() {
    const g = Groups.active();
    if (!g) return;
    const modal = document.getElementById('modal-manage-members');
    if (!modal) return;
    document.getElementById('manage-members-group-name').textContent = g.name;
    document.getElementById('manage-members-owner-note').textContent =
      g.role === 'owner' ? '你是 owner，可以踢成員' : '只有 owner 能踢人，你只能看';

    const listEl = document.getElementById('manage-members-list');
    listEl.innerHTML = '<p class="hint">載入中...</p>';
    modal.classList.remove('hidden');

    // 確保最新成員資料
    try {
      await Members.loadAll();
    } catch (err) {
      console.warn(err);
    }

    const all = Members.all();
    if (all.length === 0) {
      listEl.innerHTML = '<p class="hint">（無成員資料）</p>';
      return;
    }

    listEl.innerHTML = all.map(m => {
      const isSelf = m.email === Auth.user.email;
      const canKick = g.role === 'owner' && !isSelf;
      const joined = m.joined_at ? new Date(m.joined_at).toLocaleDateString() : '';
      return `
        <div class="member-manage-row" style="display:flex; align-items:center; padding:10px; border:1px solid var(--border); border-radius:6px; margin-bottom:8px;">
          <div style="flex:1; min-width:0;">
            <div style="font-weight:600;">${this.escapeHtml(m.name)} ${isSelf ? '<span style="color:var(--text-muted); font-weight:normal;">(你)</span>' : ''}</div>
            <div style="font-size:12px; color:var(--text-muted); overflow:hidden; text-overflow:ellipsis;">${this.escapeHtml(m.email)}</div>
            ${joined ? `<div style="font-size:11px; color:var(--text-muted);">加入：${joined}</div>` : ''}
          </div>
          ${canKick ? `<button type="button" class="btn-kick-member" data-email="${this.escapeAttr(m.email)}" style="padding:6px 12px; background:transparent; border:1px solid #ef4444; color:#ef4444; border-radius:6px; cursor:pointer;">踢出</button>` : ''}
        </div>
      `;
    }).join('');

    // 綁定踢出按鈕
    listEl.querySelectorAll('.btn-kick-member').forEach(btn => {
      btn.addEventListener('click', async () => {
        const email = btn.dataset.email;
        const member = all.find(m => m.email === email);
        if (!member) return;
        if (!confirm(`確定要把「${member.name}」(${email}) 踢出群組嗎？\n\n會:\n1. 從 Members 名單移除\n2. 撤銷 Drive 權限（資料夾 + Sheet + photos 全部）\n\n他們的歷史紀錄（trip/支出/日記）會保留`)) return;
        try {
          btn.disabled = true;
          btn.textContent = '處理中...';
          const result = await Groups.kickMember(g.groupId, email);
          // M4.7: 詳細狀態
          const deleted = result.driveResults.filter(r => r.status === 'deleted');
          const notFound = result.driveResults.filter(r => r.status === 'not_found');
          const errors = result.driveResults.filter(r => r.status === 'error');
          const driveUrl = `https://drive.google.com/drive/folders/${g.folderId}`;

          let msg = `✅ 已踢出「${member.name}」\n\n`;
          if (deleted.length > 0) {
            msg += `🔓 已撤銷 ${deleted.length} 個 Drive 權限：${deleted.map(r => r.name).join('、')}\n\n`;
          }
          if (errors.length > 0) {
            msg += `❌ ${errors.length} 個撤銷失敗：\n${errors.map(r => `  • ${r.name}：${r.err}`).join('\n')}\n\n`;
          }
          if (notFound.length === result.driveResults.length && errors.length === 0) {
            msg += `⚠️ Drive 找不到該 email 的權限（可能已被移除 / 或 API 沒回傳）\n建議手動驗證：\n\n`;
          }
          msg += `📂 請開 Drive 確認 ${member.name} 不在 BroTrip/${g.name}/ 共用名單：\n${driveUrl}\n\n如果還在 → 點該人旁邊 ✕ 手動移除`;

          if (confirm(msg + '\n\n要直接開 Drive 確認嗎？')) {
            window.open(driveUrl, '_blank');
          }
          await this.openManageMembersModal();
        } catch (err) {
          this.toast('踢出失敗：' + (err.message || '未知錯誤'));
          btn.disabled = false;
          btn.textContent = '踢出';
        }
      });
    });
  },

  async handleLeaveGroup() {
    const g = Groups.active();
    if (!g) return;
    if (g.role === 'owner') {
      this.toast('你是 owner，請改用「💀 刪除整個群組」');
      return;
    }
    if (!confirm(`確定退出「${g.name}」?\n\n會:\n1. 從群組 Members 名單刪掉你的 row\n2. 嘗試撤銷你自己的 Drive 存取權限\n3. 從你的 app 移除這個群組\n\n你之前的紀錄會留給其他人看（只是名字顯示成 email）`)) return;
    try {
      this.toast('退出中...');
      const result = await Groups.leave(g.groupId);

      // M4.7: 詳細狀態分類
      const deleted = result.driveResults.filter(r => r.status === 'deleted');
      const notFound = result.driveResults.filter(r => r.status === 'not_found');
      const errors = result.driveResults.filter(r => r.status === 'error');
      const folderId = g.folderId;
      const driveUrl = `https://drive.google.com/drive/folders/${folderId}`;

      // 一律顯示驗證 alert（不論成功失敗，因為 list API 對 member 可能不準）
      let msg = `✅ 已退出「${g.name}」\n\n`;
      if (deleted.length > 0) {
        msg += `🔓 已撤銷 ${deleted.length} 個 Drive 權限：${deleted.map(r => r.name).join('、')}\n\n`;
      }
      if (errors.length > 0) {
        msg += `❌ ${errors.length} 個撤銷失敗：\n${errors.map(r => `  • ${r.name}：${r.err}`).join('\n')}\n\n`;
      }
      if (notFound.length === result.driveResults.length && errors.length === 0) {
        // 全部找不到 → 可能 API 限制看不到自己的 perm
        msg += `⚠️ Drive API 沒回傳你的權限（member 自我查詢限制）\n所以「自動撤銷」做不到，請手動移除：\n\n`;
      }
      msg += `📂 請開 Drive 確認 BroTrip/${g.name}/ 不在你共用名單：\n${driveUrl}\n\n如果還在 → 點該資料夾右上角 ⋮ → 「移除我」`;

      // 用 confirm 讓用戶選擇要不要直接開 Drive
      if (confirm(msg + '\n\n要直接開 Drive 確認嗎？')) {
        window.open(driveUrl, '_blank');
      }
      setTimeout(() => location.reload(), 800);
    } catch (err) {
      this.toast('退出失敗：' + (err.message || '未知錯誤'));
      console.error(err);
    }
  },

  async handleDeleteGroup() {
    const g = Groups.active();
    if (!g) return;
    if (g.role !== 'owner') {
      this.toast('只有 owner 可以刪除群組（你是 member，請用「🚪 退出此群組」）');
      return;
    }
    if (!confirm(`⚠️ 第一次確認\n\n刪除「${g.name}」會:\n1. 刪掉整個 Drive 資料夾 BroTrip/${g.name}/\n2. 包含所有 Sheet 資料、照片、日記\n3. 所有成員都會看不到\n4. 不可復原！\n\n要繼續嗎？`)) return;

    // 二次確認 + 要打字
    const confirmText = prompt(`⚠️ 最後確認\n\n輸入「DELETE ${g.name}」確認刪除：`);
    if (confirmText !== `DELETE ${g.name}`) {
      this.toast('輸入不符，取消刪除');
      return;
    }

    try {
      this.toast('刪除中...');
      await Groups.deleteGroup(g.groupId);
      this.toast(`💀 已刪除「${g.name}」`);
      setTimeout(() => location.reload(), 1000);
    } catch (err) {
      this.toast('刪除失敗：' + (err.message || '未知錯誤'));
      console.error(err);
    }
  },

  // Phase 2: 顯示邀請連結 + 純邀請碼 modal (M4.3 升級：以連結為主)
  showInviteCodeModal(group) {
    const code = Groups.encodeInvite(group);
    const link = Groups.buildInviteLink(group);
    const codeEl = document.getElementById('invite-code-text');
    const linkEl = document.getElementById('invite-link-text');
    if (codeEl) codeEl.value = code;
    if (linkEl) linkEl.value = link;
    const modal = document.getElementById('modal-invite-code');
    if (modal) modal.classList.remove('hidden');
  },

  // ===== M3: 加入群組流程 =====

  openJoinGroupModal() {
    const modal = document.getElementById('modal-join-group');
    if (!modal) return;
    const form = document.getElementById('join-group-form');
    if (form) form.reset();
    document.getElementById('join-group-permission-banner').classList.add('hidden');
    document.getElementById('join-group-progress').classList.add('hidden');
    document.getElementById('join-group-submit').disabled = false;
    this._pendingJoinCode = null;
    modal.classList.remove('hidden');
  },

  async handleJoinGroupSubmit(e) {
    e.preventDefault();
    const code = (e.target.elements.code.value || '').trim();
    if (!code) { this.toast('請貼上邀請碼'); return; }
    await this._tryJoin(code);
  },

  async _tryJoin(code) {
    const submitBtn = document.getElementById('join-group-submit');
    const progress = document.getElementById('join-group-progress');
    const banner = document.getElementById('join-group-permission-banner');
    const stepText = document.getElementById('join-group-step');

    submitBtn.disabled = true;
    banner.classList.add('hidden');
    progress.classList.remove('hidden');
    stepText.textContent = '驗證邀請碼 + 嘗試讀取群組...';

    try {
      const newGroup = await Groups.joinByInvite(code);
      // 加入成功！
      progress.classList.add('hidden');
      this.toast(`✅ 加入「${newGroup.name}」成功！`);

      // 跳設定 display_name dialog（預設帶 Gmail 名）
      const defaultName = Auth.user && Auth.user.name ? Auth.user.name : '';
      this.openDisplayNameModal(newGroup, defaultName, async (name) => {
        // 寫進 Members sheet（此時 active group 已是新群組）
        try {
          await API.appendRow('Members', [
            Auth.user.email,
            name,
            new Date().toISOString(),
          ]);
        } catch (err) {
          console.warn('Failed to write Members row:', err);
        }
        // 關 join modal、切換到主畫面
        document.getElementById('modal-join-group').classList.add('hidden');
        const noGroupScreen = document.getElementById('no-group-screen');
        if (noGroupScreen && !noGroupScreen.classList.contains('hidden')) {
          noGroupScreen.classList.add('hidden');
          await this.showMainApp();
        } else {
          // 設定 tab 加入時，問用戶是否切過去
          setTimeout(() => {
            if (confirm(`已加入「${newGroup.name}」，要切到該群組嗎？（會 reload）`)) {
              location.reload();
            }
          }, 300);
        }
      });
    } catch (err) {
      progress.classList.add('hidden');
      submitBtn.disabled = false;

      if (err.code === 'PERMISSION_DENIED') {
        // 自動開 Drive folder 觸發 Google 的 request access UI
        const driveUrl = `https://drive.google.com/drive/folders/${err.folderId}`;
        window.open(driveUrl, '_blank');
        // 顯示說明 banner
        document.getElementById('join-owner-email').textContent = err.ownerEmail || '（不明）';
        banner.classList.remove('hidden');
        // 暫存邀請碼供重試
        this._pendingJoinCode = code;
        return;
      }
      this.toast('加入失敗：' + (err.message || '未知錯誤'));
      console.error('Join error:', err);
    }
  },

  // 設定 display_name modal（建立群組 + 加入後 + 設定 tab 都用同一個）
  openDisplayNameModal(group, defaultName, onConfirm) {
    const modal = document.getElementById('modal-display-name');
    if (!modal) return;
    document.getElementById('display-name-group').textContent = group.name;
    const input = modal.querySelector('input[name="name"]');
    input.value = defaultName || '';
    const form = document.getElementById('display-name-form');
    // 移除舊的 listener（避免重複觸發）
    const newForm = form.cloneNode(true);
    form.parentNode.replaceChild(newForm, form);
    newForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = (e.target.elements.name.value || '').trim();
      if (!name) { this.toast('名稱不能空白'); return; }
      modal.classList.add('hidden');
      try { await onConfirm(name); } catch (err) {
        console.error(err);
        this.toast('儲存失敗：' + (err.message || '未知錯誤'));
      }
    });
    // re-bind cancel
    newForm.querySelectorAll('.modal-close, .btn-cancel').forEach(btn => {
      btn.addEventListener('click', () => modal.classList.add('hidden'));
    });
    modal.classList.remove('hidden');
    input.focus();
    input.select();
  },

  // 我在當前群組的 display_name（從 Members sheet 讀，沒有就用 Gmail 名）
  async getMyDisplayName() {
    try {
      const rows = await API.getSheet('Members');
      const list = API.rowsToObjects(rows);
      const me = list.find(m => m.email === Auth.user.email);
      if (me && me.display_name) return me.display_name;
    } catch (err) {
      console.warn('getMyDisplayName failed:', err);
    }
    return Auth.user && Auth.user.name ? Auth.user.name : Auth.user.email.split('@')[0];
  },

  // 改我在當前群組的 display_name
  async setMyDisplayName(newName) {
    const rows = await API.getSheet('Members');
    const idx = rows.findIndex((r, i) => i > 0 && r[0] === Auth.user.email);
    const row = [Auth.user.email, newName, new Date().toISOString()];
    if (idx > 0) {
      // 已存在 → updateRow（沿用現有的 updateRow API）
      const range = `Members!A${idx + 1}:C${idx + 1}`;
      await API.sheetsRequest(`/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
        method: 'PUT',
        body: JSON.stringify({ values: [row] }),
      });
    } else {
      await API.appendRow('Members', row);
    }
  },

  bindUI() {
    document.getElementById('login-btn').addEventListener('click', async () => {
      try {
        await Auth.login();
        await this.afterLogin();
      } catch (err) {
        const msg = err.error_description || err.error || err.message || '請重試';
        this.toast('登入失敗：' + msg);
        console.error('Login error:', err);
      }
    });

    // Phase 2: 無群組畫面的建立按鈕
    const createGroupBtn = document.getElementById('create-group-btn');
    if (createGroupBtn) {
      createGroupBtn.addEventListener('click', () => this.openCreateGroupModal());
    }
    const noGroupLogout = document.getElementById('no-group-logout');
    if (noGroupLogout) {
      noGroupLogout.addEventListener('click', (e) => {
        e.preventDefault();
        if (confirm('登出？')) { Auth.logout(); location.reload(); }
      });
    }

    // 設定 tab 的建立群組 / 顯示邀請碼按鈕
    const settingsCreateBtn = document.getElementById('settings-create-group-btn');
    if (settingsCreateBtn) {
      settingsCreateBtn.addEventListener('click', () => this.openCreateGroupModal());
    }
    const settingsInviteBtn = document.getElementById('settings-show-invite-btn');
    if (settingsInviteBtn) {
      settingsInviteBtn.addEventListener('click', () => {
        const g = Groups.active();
        if (g) this.showInviteCodeModal(g);
      });
    }

    // 建立群組表單
    const createGroupForm = document.getElementById('create-group-form');
    if (createGroupForm) {
      createGroupForm.addEventListener('submit', (e) => this.handleCreateGroupSubmit(e));
    }

    // M5.0: Header 群組切換 pill
    const groupSwitchBtn = document.getElementById('group-switch');
    if (groupSwitchBtn) {
      groupSwitchBtn.addEventListener('click', () => this.openGroupSwitcher());
    }
    // M5.0: 切換 modal 內的 entry buttons
    const switcherCreateBtn = document.getElementById('switcher-create-btn');
    if (switcherCreateBtn) {
      switcherCreateBtn.addEventListener('click', () => {
        document.getElementById('modal-group-switcher').classList.add('hidden');
        this.openCreateGroupModal();
      });
    }
    const switcherJoinBtn = document.getElementById('switcher-join-btn');
    if (switcherJoinBtn) {
      switcherJoinBtn.addEventListener('click', () => {
        document.getElementById('modal-group-switcher').classList.add('hidden');
        this.openJoinGroupModal();
      });
    }

    // M3: 加入群組（無群組畫面 + 設定 tab 都用同一個 handler）
    const joinGroupBtn = document.getElementById('join-group-btn');
    if (joinGroupBtn) {
      joinGroupBtn.addEventListener('click', () => this.openJoinGroupModal());
    }
    const settingsJoinBtn = document.getElementById('settings-join-group-btn');
    if (settingsJoinBtn) {
      settingsJoinBtn.addEventListener('click', () => this.openJoinGroupModal());
    }
    const joinForm = document.getElementById('join-group-form');
    if (joinForm) {
      joinForm.addEventListener('submit', (e) => this.handleJoinGroupSubmit(e));
    }
    // 「我已經有權限了 → 重試」按鈕
    const joinRetryBtn = document.getElementById('join-retry-btn');
    if (joinRetryBtn) {
      joinRetryBtn.addEventListener('click', async () => {
        if (this._pendingJoinCode) {
          await this._tryJoin(this._pendingJoinCode);
        }
      });
    }
    // 再開一次 Drive
    const openDriveBtn = document.getElementById('join-open-drive-btn');
    if (openDriveBtn) {
      openDriveBtn.addEventListener('click', () => {
        if (this._pendingJoinCode) {
          const data = Groups.decodeInvite(this._pendingJoinCode);
          if (data && data.folderId) {
            window.open(`https://drive.google.com/drive/folders/${data.folderId}`, '_blank');
          }
        }
      });
    }
    // M3: 改我在此群組的顯示名稱
    const editDispBtn = document.getElementById('settings-edit-displayname-btn');
    if (editDispBtn) {
      editDispBtn.addEventListener('click', async () => {
        const g = Groups.active();
        if (!g) return;
        const currentName = await this.getMyDisplayName();
        this.openDisplayNameModal(g, currentName, async (name) => {
          await this.setMyDisplayName(name);
          this.toast(`✅ 已改為「${name}」`);
          this.updateGroupInfo();
        });
      });
    }

    // M4.4: 管理成員 modal
    const manageMembersBtn = document.getElementById('settings-manage-members-btn');
    if (manageMembersBtn) {
      manageMembersBtn.addEventListener('click', () => this.openManageMembersModal());
    }

    // M4.4: 退出此群組
    const leaveGroupBtn = document.getElementById('settings-leave-group-btn');
    if (leaveGroupBtn) {
      leaveGroupBtn.addEventListener('click', () => this.handleLeaveGroup());
    }

    // M5.1: 封存/取消封存當前群組
    const archiveBtn = document.getElementById('settings-archive-group-btn');
    if (archiveBtn) {
      archiveBtn.addEventListener('click', () => this.handleToggleArchive());
    }

    // M4.4: 刪除整個群組（owner only）
    const deleteGroupBtn = document.getElementById('settings-delete-group-btn');
    if (deleteGroupBtn) {
      deleteGroupBtn.addEventListener('click', () => this.handleDeleteGroup());
    }

    // 重新命名當前群組
    const renameGroupBtn = document.getElementById('settings-rename-group-btn');
    if (renameGroupBtn) {
      renameGroupBtn.addEventListener('click', async () => {
        const g = Groups.active();
        if (!g) return;
        const newName = prompt(`重新命名群組\n當前：${g.name}\n\n輸入新名稱：`, g.name);
        if (newName === null) return;  // 取消
        const trimmed = (newName || '').trim();
        if (!trimmed) { this.toast('名稱不能空白'); return; }
        if (trimmed === g.name) return;
        try {
          this.toast('改名中...');
          await Groups.rename(g.groupId, trimmed);
          this.toast(`✅ 已改名為「${trimmed}」`);
          this.updateGroupInfo();
        } catch (err) {
          this.toast('改名失敗：' + (err.message || '未知錯誤'));
          console.error('Rename error:', err);
        }
      });
    }

    // 複製/分享邀請連結（M5.0: 用 native share or clipboard）
    const copyInviteLinkBtn = document.getElementById('copy-invite-link-btn');
    if (copyInviteLinkBtn) {
      // 手機 hint 文案微調
      if (navigator.share) {
        copyInviteLinkBtn.innerHTML = '📤 分享邀請連結';
      }
      copyInviteLinkBtn.addEventListener('click', () => {
        const ta = document.getElementById('invite-link-text');
        if (!ta || !ta.value) return;
        const g = Groups.active();
        this.shareOrCopyText(ta.value, {
          shareTitle: g ? `加入「${g.name}」BroTrip 群組` : 'BroTrip 群組邀請',
          shareText: g ? `來加入「${g.name}」一起記錄出遊` : '來加入我們的出遊群組',
          copyToast: '邀請連結已複製，直接貼到 LINE！',
        });
      });
    }

    // 複製純邀請碼（次要按鈕，藏在 details 內，純文字 fallback）
    const copyInviteBtn = document.getElementById('copy-invite-btn');
    if (copyInviteBtn) {
      copyInviteBtn.addEventListener('click', () => {
        const ta = document.getElementById('invite-code-text');
        if (!ta || !ta.value) return;
        this.shareOrCopyText(ta.value, {
          shareTitle: 'BroTrip 邀請碼',
          shareText: '貼到 BroTrip app 加入群組',
          copyToast: '邀請碼已複製',
        });
      });
    }

    document.getElementById('logout-btn').addEventListener('click', () => {
      if (confirm('登出？')) { Auth.logout(); location.reload(); }
    });

    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });

    document.getElementById('fab').addEventListener('click', () => {
      if (!Trips.current) { this.openModal('modal-trips'); return; }
      if (this.currentTab === 'expenses') this.openExpenseModal();
      else if (this.currentTab === 'diaries') this.openDiaryModal();
    });

    document.getElementById('trip-switch').addEventListener('click', () => this.openTripsModal());
    document.getElementById('new-trip-btn').addEventListener('click', () => {
      this.closeModal('modal-trips');
      this.openNewTripModal();
    });

    document.querySelectorAll('.modal-close, .btn-cancel').forEach(btn => {
      btn.addEventListener('click', () => {
        const modal = btn.closest('.modal');
        if (modal) modal.classList.add('hidden');
      });
    });
    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', e => {
        if (e.target === modal) modal.classList.add('hidden');
      });
    });

    document.getElementById('expense-form').addEventListener('submit', e => this.handleExpenseSubmit(e));
    document.getElementById('diary-form').addEventListener('submit', e => this.handleDiarySubmit(e));
    document.getElementById('new-trip-form').addEventListener('submit', e => this.handleNewTripSubmit(e));

    // Photo lightbox
    const lightbox = document.getElementById('photo-lightbox');
    document.getElementById('lightbox-close').addEventListener('click', () => lightbox.close());
    lightbox.addEventListener('click', e => { if (e.target === lightbox) lightbox.close(); });
    // 任何關閉路徑（button / 背景 / Escape）統一觸發 close event → 還原 viewport
    lightbox.addEventListener('close', () => this._setViewportZoom(false));
    document.getElementById('lightbox-img').addEventListener('error', async (e) => {
      const li = e.target;
      if (li.dataset.fallbackTried === '1') return;
      li.dataset.fallbackTried = '1';
      const id = li.dataset.photoId;
      if (!id) return;
      try { li.src = await API.fetchDriveBlobUrl(id); } catch (err) { console.warn(err); }
    });
    document.getElementById('lightbox-prev').addEventListener('click', () => {
      if (this._lightboxIndex > 0) { this._lightboxIndex--; this.showLightboxPhoto(); }
    });
    document.getElementById('lightbox-next').addEventListener('click', () => {
      if (this._lightboxIndex < this._lightboxPhotos.length - 1) { this._lightboxIndex++; this.showLightboxPhoto(); }
    });
    document.addEventListener('keydown', (e) => {
      if (!lightbox.open) return;
      if (e.key === 'ArrowLeft' && this._lightboxIndex > 0) { this._lightboxIndex--; this.showLightboxPhoto(); }
      else if (e.key === 'ArrowRight' && this._lightboxIndex < this._lightboxPhotos.length - 1) { this._lightboxIndex++; this.showLightboxPhoto(); }
      else if (e.key === 'Escape') lightbox.close();
    });

    // Expense list edit/delete + 點 row 任何地方都展開 edit modal（檢視或修改）
    document.getElementById('expense-list').addEventListener('click', e => {
      const editBtn = e.target.closest('[data-action="edit-expense"]');
      const delBtn = e.target.closest('[data-action="delete-expense"]');
      if (editBtn) { e.stopPropagation(); this.openExpenseModal(editBtn.dataset.id); return; }
      if (delBtn) { e.stopPropagation(); this.deleteExpense(delBtn.dataset.id); return; }
      const item = e.target.closest('.expense-item');
      if (item && item.dataset.expenseId) {
        this.openExpenseModal(item.dataset.expenseId);
      }
    });

    // 全部結清按鈕（動態 render，用 delegation）
    document.getElementById('settlement-content').addEventListener('click', async (ev) => {
      // ⭐ v2.0.0 peer-to-peer 結算動作
      const claimBtn = ev.target.closest('[data-action="claim-settlement"]');
      if (claimBtn) {
        await this.claimSettlement(claimBtn);
        return;
      }
      const cancelBtn = ev.target.closest('[data-action="cancel-settlement"]');
      if (cancelBtn) {
        await this.cancelSettlement(cancelBtn.dataset.id);
        return;
      }
      const confirmBtn = ev.target.closest('[data-action="confirm-settlement"]');
      if (confirmBtn) {
        await this.confirmSettlementClaim(confirmBtn.dataset.id);
        return;
      }
      const rejectBtn = ev.target.closest('[data-action="reject-settlement"]');
      if (rejectBtn) {
        await this.rejectSettlementClaim(rejectBtn.dataset.id);
        return;
      }

      // 舊「強制全部結清」按鈕（保留作 emergency 用，但提示用新流程）
      const btn = ev.target.closest('#mark-all-settled-btn');
      if (!btn) return;
      if (!confirm('⚠️ 強制全部結清\n\n建議改用「✅ 我已付」流程讓對方確認。\n\n仍要跳過確認直接全清嗎？（不可復原）')) return;
      try {
        btn.disabled = true;
        btn.textContent = '處理中...';
        const n = await Expenses.markAllSettled();
        this.toast(`✅ 已標 ${n} 筆為結清`);
        this.renderExpenses();
        this.renderSettlement();
      } catch (err) {
        console.error(err);
        this.toast('結清失敗：' + err.message);
        btn.disabled = false;
      }
    });

    // Dark mode toggle
    document.getElementById('toggle-dark-btn').addEventListener('click', () => this.toggleDarkMode());

    // 完全重置（救援按鈕）
    document.getElementById('reset-app-btn').addEventListener('click', () => this.resetApp());

    // 已結清解鎖 / 反悔重新鎖定
    document.getElementById('expense-unlock-btn').addEventListener('click', () => this.unlockExpense());
    document.getElementById('expense-relock-btn').addEventListener('click', () => this.relockExpense());

    // Diary list edit/delete/pin + comment + photo lightbox + mention chips
    document.getElementById('diary-list').addEventListener('click', e => {
      const editBtn = e.target.closest('[data-action="edit-diary"]');
      const delBtn = e.target.closest('[data-action="delete-diary"]');
      const pinBtn = e.target.closest('[data-action="pin-diary"]');
      const folderBtn = e.target.closest('[data-action="open-trip-folder"]');
      const delCommentBtn = e.target.closest('[data-action="delete-comment"]');
      const sendBtn = e.target.closest('.comment-send');
      // Note: mention-chip click handler 已移除（v1.7.5 改用 @autocomplete dropdown）
      if (editBtn) { e.stopPropagation(); this.openDiaryModal(editBtn.dataset.id); return; }
      if (delBtn) { e.stopPropagation(); this.deleteDiary(delBtn.dataset.id); return; }
      if (pinBtn) { e.stopPropagation(); this.togglePin(pinBtn.dataset.id); return; }
      if (folderBtn) { e.stopPropagation(); this.openTripPhotosFolder(folderBtn.dataset.id); return; }
      if (delCommentBtn) { e.stopPropagation(); this.deleteComment(delCommentBtn.dataset.id); return; }
      if (sendBtn) {
        e.stopPropagation();
        const wrap = sendBtn.closest('.comment-input-wrap');
        const input = wrap.querySelector('.comment-input');
        this.submitComment(wrap.dataset.diaryId, input.value, input);
        return;
      }
      const img = e.target.closest('.diary-photos img');
      if (img && img.dataset.photoId) {
        const card = img.closest('.diary-item');
        const allImgs = Array.from(card.querySelectorAll('.diary-photos img'));
        const ids = allImgs.map(im => im.dataset.photoId);
        const startIdx = ids.indexOf(img.dataset.photoId);
        this.openLightbox(ids, Math.max(0, startIdx));
      }
    });

    document.getElementById('diary-list').addEventListener('keypress', e => {
      if (e.key === 'Enter' && e.target.classList.contains('comment-input')) {
        e.preventDefault();
        const wrap = e.target.closest('.comment-input-wrap');
        this.submitComment(wrap.dataset.diaryId, e.target.value, e.target);
      }
    });

    // Trip list
    document.getElementById('trip-list').addEventListener('click', e => {
      const editBtn = e.target.closest('[data-action="edit-trip"]');
      const deleteBtn = e.target.closest('[data-action="delete-trip"]');
      if (editBtn) {
        e.stopPropagation();
        this.closeModal('modal-trips');
        this.openEditTripModal(editBtn.dataset.tripId);
        return;
      }
      if (deleteBtn) {
        e.stopPropagation();
        this.confirmDeleteTrip(deleteBtn.dataset.tripId);
        return;
      }
      const selectArea = e.target.closest('[data-action="select-trip"]');
      if (selectArea) {
        Trips.setCurrent(selectArea.dataset.tripId);
        this.closeModal('modal-trips');
        Expenses._filter();
        Diaries._filter();
        this.renderAll();
        this.refreshAll();
      }
    });

    // Diary filter
    document.getElementById('filter-authors').addEventListener('click', e => {
      const chip = e.target.closest('.filter-chip');
      if (!chip) return;
      const email = chip.dataset.email;
      const idx = this._diaryFilter.authors.indexOf(email);
      if (idx >= 0) this._diaryFilter.authors.splice(idx, 1);
      else this._diaryFilter.authors.push(email);
      chip.classList.toggle('active');
      this.renderDiaries();
      this.updateFilterSummary();
    });
    document.getElementById('filter-date-from').addEventListener('change', e => {
      this._diaryFilter.dateFrom = e.target.value;
      this.renderDiaries();
      this.updateFilterSummary();
    });
    document.getElementById('filter-date-to').addEventListener('change', e => {
      this._diaryFilter.dateTo = e.target.value;
      this.renderDiaries();
      this.updateFilterSummary();
    });
    // 關鍵字搜尋（debounce 200ms 避免每打一字就 re-render 全部）
    const kwInput = document.getElementById('filter-keyword');
    if (kwInput) {
      kwInput.addEventListener('input', e => {
        clearTimeout(this._kwTimer);
        const val = e.target.value;
        this._kwTimer = setTimeout(() => {
          this._diaryFilter.keyword = val;
          this.renderDiaries();
          this.updateFilterSummary();
        }, 200);
      });
    }
    document.getElementById('filter-clear').addEventListener('click', () => {
      this._diaryFilter = { authors: [], dateFrom: '', dateTo: '', keyword: '' };
      document.querySelectorAll('#filter-authors .filter-chip').forEach(c => c.classList.remove('active'));
      document.getElementById('filter-date-from').value = '';
      document.getElementById('filter-date-to').value = '';
      const kw = document.getElementById('filter-keyword');
      if (kw) kw.value = '';
      this.renderDiaries();
      this.updateFilterSummary();
    });

    // Nicknames edit
    document.getElementById('nicknames-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('.btn-edit-nickname');
      if (!btn) return;
      const email = btn.dataset.email;
      const current = Nicknames.get(email);
      const targetName = Members.getName(email) || email;
      const newNick = prompt(`給 ${targetName} 取暱稱（清空 = 移除）：`, current);
      if (newNick === null) return;
      try {
        await Nicknames.set(email, newNick);
        this.toast('✅ 暱稱已更新');
        this.renderNicknamesUI();
        this.renderSettlement();
        this.renderExpenses();
        this.renderDiaryFilters();
        this.renderDiaries();
      } catch (err) {
        console.error(err);
        this.toast('更新失敗：' + err.message);
      }
    });

    // Settings
    document.getElementById('check-update-btn').addEventListener('click', () => this.checkUpdate());
    document.getElementById('open-sheet-btn').addEventListener('click', () => {
      // Phase 2: 從 active group 取 sheet/folder ID
      const g = Groups.active();
      if (g) window.open(`https://docs.google.com/spreadsheets/d/${g.sheetId}/`, '_blank');
    });
    document.getElementById('open-drive-btn').addEventListener('click', () => {
      const g = Groups.active();
      if (g) window.open(`https://drive.google.com/drive/folders/${g.folderId}`, '_blank');
    });

    // Trip ID auto slug
    const tripIdInput = document.querySelector('#new-trip-form [name="trip_id"]');
    const tripNameInput = document.querySelector('#new-trip-form [name="name"]');
    tripNameInput.addEventListener('input', () => {
      if (!tripIdInput.dataset.touched) {
        const year = new Date().getFullYear();
        const slug = tripNameInput.value.toLowerCase()
          .replace(/[^\w\s-]/g, '')
          .replace(/\s+/g, '-')
          .slice(0, 30);
        if (slug) tripIdInput.value = `${year}-${slug}`;
      }
    });
    tripIdInput.addEventListener('focus', () => { tripIdInput.dataset.touched = '1'; });

    // Expense form: split + payer realtime
    const expenseForm = document.getElementById('expense-form');
    expenseForm.addEventListener('input', e => {
      if (e.target.matches('[name="amount"], #split-rows input')) this.updateSplitPreview();
      if (e.target.matches('[name="amount"], #payer-rows input')) this.updatePayerPreview();
    });
    expenseForm.addEventListener('change', e => {
      if (e.target.matches('#split-rows input[type="checkbox"]')) this.updateSplitPreview();
    });

    // 加 payer 按鈕
    document.getElementById('add-payer-btn').addEventListener('click', () => this.addPayerRow());
    // 刪 payer (event delegation)
    document.getElementById('payer-rows').addEventListener('click', e => {
      const btn = e.target.closest('.remove-payer');
      if (btn) {
        btn.closest('.payer-row').remove();
        this.updatePayerPreview();
      }
    });

    // === Mention autocomplete ===
    // 日記 textarea
    const diaryTextarea = document.querySelector('#diary-form [name="content"]');
    if (diaryTextarea) {
      diaryTextarea.addEventListener('input', () => this.handleMentionInput(diaryTextarea));
      diaryTextarea.addEventListener('keydown', (e) => this.handleMentionKey(e));
    }
    // 留言 input（用 delegation 抓 dynamic 元素）
    document.getElementById('diary-list').addEventListener('input', (e) => {
      if (e.target.classList.contains('comment-input')) this.handleMentionInput(e.target);
    });
    document.getElementById('diary-list').addEventListener('keydown', (e) => {
      if (e.target.classList.contains('comment-input')) this.handleMentionKey(e);
    });
    // 點 dropdown 外面就關（用 mousedown 比 click 早，避免 blur 先觸發）
    document.addEventListener('mousedown', (e) => {
      if (!this._mentionState) return;
      if (e.target.closest('#mention-dropdown')) return;
      if (e.target === this._mentionState.inputEl) return;
      this.closeMentionDropdown();
    });

    // ===== 預計行程 =====
    const newItinBtn = document.getElementById('new-itinerary-btn');
    if (newItinBtn) newItinBtn.addEventListener('click', () => this.openNewItineraryModal());

    const itinForm = document.getElementById('itinerary-form');
    if (itinForm) itinForm.addEventListener('submit', e => this.handleItinerarySubmit(e));

    // waypoint 動態加 / 上下移動 / 移除
    const addWpBtn = document.getElementById('add-waypoint-btn');
    if (addWpBtn) addWpBtn.addEventListener('click', () => {
      // 把當前 input 值同步到暫存（input 沒選 place 也保留 typed 文字方便用戶調整順序時不丟）
      this._syncWaypointInputs();
      this._itineraryWaypoints.push({ name: '', address: '', lat: null, lng: null, place_id: '' });
      this.renderWaypointRows();
    });

    document.getElementById('waypoint-rows').addEventListener('click', e => {
      const btn = e.target.closest('[data-action^="wp-"]');
      if (!btn) return;
      this._syncWaypointInputs();
      const idx = parseInt(btn.dataset.idx, 10);
      const wps = this._itineraryWaypoints;
      if (btn.dataset.action === 'wp-up' && idx > 0) {
        [wps[idx - 1], wps[idx]] = [wps[idx], wps[idx - 1]];
      } else if (btn.dataset.action === 'wp-down' && idx < wps.length - 1) {
        [wps[idx], wps[idx + 1]] = [wps[idx + 1], wps[idx]];
      } else if (btn.dataset.action === 'wp-remove' && wps.length > 2) {
        wps.splice(idx, 1);
      }
      this.renderWaypointRows();
    });

    // 行程列表 click：取消選擇 / 用 Google Maps 開 / 刪除 / 載入到地圖
    document.getElementById('itinerary-list').addEventListener('click', e => {
      const clearBtn = e.target.closest('[data-action="clear-itinerary"]');
      if (clearBtn) { e.stopPropagation(); this.clearItinerarySelection(); return; }
      const gmapsBtn = e.target.closest('[data-action="open-in-gmaps"]');
      if (gmapsBtn) { e.stopPropagation(); this.openItineraryInGoogleMaps(gmapsBtn.dataset.id); return; }
      const delBtn = e.target.closest('[data-action="delete-itinerary"]');
      if (delBtn) { e.stopPropagation(); this.deleteItinerary(delBtn.dataset.id); return; }
      const item = e.target.closest('.itinerary-item');
      if (item) this.showItineraryOnMap(item.dataset.id);
    });

    // 通知 bell + modal
    document.getElementById('notif-bell').addEventListener('click', () => this.openNotifModal());
    document.getElementById('mark-all-read-btn').addEventListener('click', () => {
      Notifications.markAllRead();
      this.updateNotifBadge();
      this.renderNotifList();
    });
    document.getElementById('notif-list').addEventListener('click', (e) => {
      const item = e.target.closest('.notif-item');
      if (!item) return;
      const type = item.dataset.type;
      const refId = item.dataset.refId;
      if (!refId) return;

      Notifications.markAllRead();
      this.updateNotifBadge();
      this.closeModal('modal-notifications');

      // Route 依 type（用 cache 立刻顯示）
      if (type === 'mention' || type === 'comment' || type === 'comment-mention') {
        this.openDiaryFromMap(refId);
      } else if (type === 'trip-add') {
        // refId = trip_id
        const trip = Trips.list.find(t => t.trip_id === refId);
        if (trip) {
          Trips.setCurrent(refId);
          Expenses._filter();
          Diaries._filter();
          this.renderAll();
        }
      } else if (type === 'expense-split') {
        // refId = expense_id
        const expense = Expenses.allList.find(e => e.id === refId);
        if (expense) {
          // 切到該 trip
          if (!Trips.current || Trips.current.trip_id !== expense.trip_id) {
            Trips.setCurrent(expense.trip_id);
            Expenses._filter();
            Diaries._filter();
            this.renderAll();
          }
          this.switchTab('expenses');
          setTimeout(() => this.openExpenseModal(refId), 200);
        } else {
          this.switchTab('expenses');
        }
      } else if (type === 'expense-settle') {
        // refId = trip_id（markAllSettled 用 trip_id）
        const trip = Trips.list.find(t => t.trip_id === refId);
        if (trip) {
          Trips.setCurrent(refId);
          Expenses._filter();
          Diaries._filter();
          this.renderAll();
          this.switchTab('expenses');
        }
      } else if (type === 'itinerary-add') {
        // refId = itinerary_id
        this.switchTab('map');
        setTimeout(() => this.showItineraryOnMap(refId), 300);
      } else if (type === 'settlement-claim' || type === 'settlement-confirm' || type === 'settlement-reject') {
        // 跳到結算頁面（在 expenses tab 上方）
        const s = (typeof Settlements !== 'undefined') ? Settlements.allList.find(x => x.id === refId) : null;
        if (s && (!Trips.current || Trips.current.trip_id !== s.trip_id)) {
          Trips.setCurrent(s.trip_id);
          Expenses._filter();
          Diaries._filter();
          this.renderAll();
        }
        this.switchTab('expenses');
        setTimeout(() => {
          const settleEl = document.getElementById('settlement-content');
          if (settleEl) settleEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 200);
      }

      // 背景拉最新資料（cache 可能過時），拿到後自動 re-render
      // 不 await：navigate 立刻完成，refreshAll 完成後畫面會自動更新
      this.refreshAll().catch(err => console.warn('post-notif refresh failed:', err));
    });
  },

  initPullToRefresh() {
    const indicator = document.getElementById('pull-indicator');
    if (!indicator) return;
    let startY = 0;
    let pulling = false;
    const threshold = 60;
    document.addEventListener('touchstart', (e) => {
      if (document.querySelector('.modal:not(.hidden), dialog[open]')) return;
      // 地圖頁停用下拉：跟 Google Maps 互動（拖移/縮放）衝突且無意義
      if (this.currentTab === 'map') return;
      if (window.scrollY === 0) { startY = e.touches[0].clientY; pulling = true; }
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      if (!pulling) return;
      const dy = e.touches[0].clientY - startY;
      if (dy > 10 && dy < 150) {
        indicator.classList.add('show');
        const triggered = dy >= threshold;
        indicator.classList.toggle('triggered', triggered);
        indicator.textContent = triggered ? '🔄 放開重新整理' : '⬇︎ 下拉重新整理...';
      } else if (dy <= 0) indicator.classList.remove('show');
    }, { passive: true });
    document.addEventListener('touchend', () => {
      if (!pulling) return;
      const wasTriggered = indicator.classList.contains('triggered');
      pulling = false;
      indicator.classList.remove('show', 'triggered');
      if (wasTriggered) {
        indicator.classList.add('show');
        indicator.textContent = '重新整理中...';
        this.softRefresh(indicator);
      }
    });
  },

  toggleDarkMode() {
    const current = document.documentElement.dataset.theme || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('brotrip_theme', next);
    this.updateThemeUI();
  },

  updateThemeUI() {
    const current = document.documentElement.dataset.theme || 'light';
    const el = document.getElementById('theme-current');
    if (el) el.textContent = current === 'dark' ? '深色 🌙' : '淺色 ☀';
  },

  updateVersionInfo() {
    const el = document.getElementById('version-info');
    if (!el) return;
    el.textContent = `BroTrip ${CONFIG.VERSION}`;
    if ('caches' in window) {
      caches.keys().then(names => {
        const cur = names.find(n => n.startsWith('brotrip-')) || 'none';
        el.textContent = `BroTrip ${CONFIG.VERSION} | cache: ${cur}`;
      });
    }
    this.updateGroupInfo();
    this.updateDebugInfo();
  },

  // M5.1: 群組統計 dashboard
  updateGroupStats() {
    const tripsEl = document.getElementById('stat-trips');
    const membersEl = document.getElementById('stat-members');
    const expensesEl = document.getElementById('stat-expenses');
    const diariesEl = document.getElementById('stat-diaries');
    if (!tripsEl) return;  // 設定 tab 沒開時不算

    const tripCount = (Trips.list || []).length;
    const memberCount = Members.list.length || Members.all().length;
    const diaryCount = (Diaries.allList || []).length;
    // 總花費（所有 trip 的 expenses 加總，以 TWD 為主，其他幣別簡單相加示意）
    const allExpenses = Expenses.allList || [];
    const byCurrency = {};
    allExpenses.forEach(e => {
      const cur = e.currency || 'TWD';
      const amt = parseFloat(e.amount) || 0;
      byCurrency[cur] = (byCurrency[cur] || 0) + amt;
    });
    const expenseStr = Object.entries(byCurrency)
      .map(([cur, amt]) => `${cur} ${amt.toLocaleString()}`)
      .join(', ') || '0';

    tripsEl.textContent = tripCount;
    membersEl.textContent = memberCount;
    expensesEl.textContent = expenseStr;
    diariesEl.textContent = diaryCount;
  },

  // Phase 2: 設定 tab 顯示當前群組名 + 角色 + 我的 display_name + Header pill
  updateGroupInfo() {
    const nameEl = document.getElementById('current-group-name');
    const roleEl = document.getElementById('current-group-role');
    const dispEl = document.getElementById('my-display-name');
    const headerPill = document.getElementById('group-switch');
    const g = Groups.active();
    if (nameEl) nameEl.textContent = g ? g.name : '無';
    if (roleEl) roleEl.textContent = g ? (g.role === 'owner' ? '👑 owner' : '👤 member') : '-';
    // M5.0: Header 上的群組切換 pill
    if (headerPill) {
      // 計算未封存的群組數量（封存的不算進切換選項）
      const activeCount = Groups.list.filter(x => !x.archived).length;
      const indicator = activeCount > 1 ? '▾' : '';  // 只有 1 個群組時不顯示箭頭
      headerPill.textContent = g ? `🏠 ${g.name} ${indicator}` : '🏠 -';
    }
    // M5.1: 封存按鈕 label 切換
    const archiveLabel = document.getElementById('archive-toggle-label');
    if (archiveLabel) {
      archiveLabel.textContent = (g && g.archived) ? '取消封存此群組' : '封存此群組';
    }
    // M3: async 抓 display name
    if (dispEl && g) {
      this.getMyDisplayName().then(name => { dispEl.textContent = name; });
    }
  },

  async updateDebugInfo() {
    const el = document.getElementById('debug-info');
    if (!el) return;
    const ua = navigator.userAgent || '?';
    const isAndroid = /Android/i.test(ua);
    const isIOS = /iPad|iPhone|iPod/.test(ua);
    const platform = isAndroid ? '🤖 Android' : (isIOS ? '🍎 iOS' : '💻 Desktop');
    const swStatus = ('serviceWorker' in navigator)
      ? (await navigator.serviceWorker.getRegistration() ? '✓ 已註冊' : '✗ 未註冊')
      : '不支援';
    const onLine = navigator.onLine ? '✓ 上線' : '✗ 離線';
    const tripsCount = (typeof Trips !== 'undefined') ? Trips.list.length : '?';
    const expensesCount = (typeof Expenses !== 'undefined') ? Expenses.allList.length : '?';
    const diariesCount = (typeof Diaries !== 'undefined') ? Diaries.allList.length : '?';
    const lastErr = this._lastError ? `<div style="color:#ef4444;">❌ ${this.escapeHtml(this._lastError)}</div>` : '';
    el.innerHTML = `
      <div class="debug-row"><span>Email:</span> <code>${this.escapeHtml(Auth.user ? Auth.user.email : '(未登入)')}</code></div>
      <div class="debug-row"><span>App version:</span> <code>${CONFIG.VERSION}</code></div>
      <div class="debug-row"><span>平台:</span> <code>${platform}</code></div>
      <div class="debug-row"><span>SW:</span> <code>${swStatus}</code></div>
      <div class="debug-row"><span>網路:</span> <code>${onLine}</code></div>
      <div class="debug-row"><span>Trips/Expenses/Diaries:</span> <code>${tripsCount}/${expensesCount}/${diariesCount}</code></div>
      ${lastErr}
    `;
  },

  // 重置：清 SW + login，但保留 data cache（暱稱/日記/支出）
  // 為什麼保留 data cache：避免「剛改完東西、按重置、sheet 還沒 propagate」的資料消失
  // 真要 wipe data cache 也行（Sheet 是 source of truth，下次 fetch 會 restore）
  async resetApp() {
    if (!confirm('🚨 重置 BroTrip\n\n會清掉：\n• Service Worker (拿最新 code)\n• 登入狀態 (要重登)\n• UI 偏好 (主題/當前 trip)\n\n保留：\n• 暱稱、日記、支出等本地快取 (避免剛改的東西消失)\n\n確定？')) return;
    this.toast('重置中...');
    // SW caches (code)
    if ('caches' in window) {
      try {
        const names = await caches.keys();
        await Promise.all(names.map(n => caches.delete(n)));
      } catch {}
    }
    // 只清 非 cache 的 brotrip_* keys（保留 brotrip_cache_v*_*）
    try {
      const cachePrefix = (typeof Cache !== 'undefined') ? Cache.PREFIX : 'brotrip_cache_';
      Object.keys(localStorage).forEach(k => {
        if (k.startsWith('brotrip_') && !k.startsWith(cachePrefix) && !k.startsWith('brotrip_cache_')) {
          localStorage.removeItem(k);
        }
      });
    } catch {}
    // Unregister SW
    if ('serviceWorker' in navigator) {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      } catch {}
    }
    // Revoke OAuth token
    try { Auth.logout(); } catch {}
    setTimeout(() => {
      window.location.href = window.location.pathname + '?t=' + Date.now();
    }, 600);
  },

  async checkUpdate() {
    this.toast('檢查新版本中...');
    if ('serviceWorker' in navigator) {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.update()));
      } catch {}
    }
    if ('caches' in window) {
      try {
        const names = await caches.keys();
        await Promise.all(names.map(n => caches.delete(n)));
      } catch {}
    }
    // 不清資料 cache（Sheets API eventual consistency 風險）：
    // 剛改的暱稱可能還沒 propagate 到 Sheet read。若這時清 cache + reload，
    // Phase 2 fetch 回的是舊資料 → 本地剛改的東西就消失。
    // 保留 cache + 靠 Nicknames.loadAll 的 merge by updated_at 自然保住本地最新狀態。
    setTimeout(() => { window.location.href = window.location.pathname + '?t=' + Date.now(); }, 800);
  },

  async softRefresh(indicator) {
    // M4.5: 沒群組時 pull-to-refresh 直接顯示提示，不要去打 Sheets API（會炸）
    if (!Groups.active()) {
      if (indicator) {
        indicator.textContent = '請先建立或加入群組';
        setTimeout(() => indicator.classList.remove('show'), 1500);
      }
      return;
    }
    try {
      if (!Trips.current) await Trips.loadAll();
      else await this.refreshAll();
      if (indicator) {
        indicator.textContent = '✅ 已更新';
        setTimeout(() => indicator.classList.remove('show'), 800);
      }
    } catch (err) {
      console.error(err);
      if (indicator) {
        indicator.textContent = '❌ 更新失敗';
        setTimeout(() => indicator.classList.remove('show'), 1500);
      }
    }
  },

  async initOrRefreshMap() {
    const mapEl = document.getElementById('trip-map');
    const emptyEl = document.getElementById('trip-map-empty');
    const diariesWithCoords = Diaries.list.map(d => {
      if (d.location && d.location.startsWith('{')) {
        try {
          const info = JSON.parse(d.location);
          if (info && info.lat && info.lng) return { ...info, diary: d };
        } catch {}
      }
      return null;
    }).filter(Boolean);

    // 永遠載入並建立地圖（即使沒日記座標，也讓行程功能能用）
    try { await Maps.load(); }
    catch (err) {
      mapEl.innerHTML = `<div class="list-empty">地圖載入失敗：${err.message}</div>`;
      return;
    }

    mapEl.style.display = '';
    // 沒日記座標+沒行程 → 顯示空態提示在地圖下方但仍建地圖
    const hasItineraries = (typeof Itineraries !== 'undefined') && Itineraries.list.length > 0;
    if (diariesWithCoords.length === 0 && !hasItineraries) {
      emptyEl.classList.remove('hidden');
    } else {
      emptyEl.classList.add('hidden');
    }

    // 預設中心：第一個日記座標 → 第一個行程第一個點 → 台北 101 (fallback)
    let defaultCenter = { lat: 25.0339, lng: 121.5645 };
    if (diariesWithCoords.length > 0) {
      defaultCenter = { lat: diariesWithCoords[0].lat, lng: diariesWithCoords[0].lng };
    } else if (hasItineraries) {
      const firstItin = Itineraries.list[0];
      const wps = Itineraries.getWaypoints(firstItin);
      if (wps.length > 0) defaultCenter = { lat: wps[0].lat, lng: wps[0].lng };
    }

    if (!this._map) {
      this._map = new google.maps.Map(mapEl, {
        zoom: 12,
        center: defaultCenter,
        mapTypeControl: false, streetViewControl: false, fullscreenControl: false,
      });
    } else {
      // map 已存在但 viewport 改變（PWA resize / dark mode 切換）→ 觸發 resize 避免灰屏
      google.maps.event.trigger(this._map, 'resize');
    }
    if (this._mapMarkers) this._mapMarkers.forEach(m => m.setMap(null));
    this._mapMarkers = [];

    // 沒日記座標時直接 return（不畫 markers，但 _map 已建立讓行程功能可用）
    if (diariesWithCoords.length === 0) return;

    let activeInfo = null;
    const bounds = new google.maps.LatLngBounds();
    diariesWithCoords.forEach(loc => {
      const marker = new google.maps.Marker({
        position: { lat: loc.lat, lng: loc.lng },
        map: this._map,
        title: loc.name,
      });
      const content = `
        <div style="max-width:220px; font-family:inherit; cursor:pointer;" onclick="App.openDiaryFromMap('${loc.diary.id}')">
          <div style="font-weight:600; font-size:14px;">${this.escapeHtml(loc.diary.mood || '')} ${this.escapeHtml(this.nameOf(loc.diary.author))}</div>
          <div style="font-size:12px; color:#6b7280;">${loc.diary.date} · ${this.escapeHtml(loc.name)}</div>
          <div style="margin-top:6px; font-size:13px; white-space:pre-wrap;">${this.escapeHtml((loc.diary.content || '').slice(0, 200))}${(loc.diary.content || '').length > 200 ? '...' : ''}</div>
          <div style="margin-top:8px; color:#3b82f6; font-size:12px; font-weight:600;">點此查看完整日記 →</div>
        </div>
      `;
      const info = new google.maps.InfoWindow({ content });
      marker.addListener('click', () => {
        if (activeInfo) activeInfo.close();
        info.open(this._map, marker);
        activeInfo = info;
      });
      bounds.extend({ lat: loc.lat, lng: loc.lng });
      this._mapMarkers.push(marker);
    });

    if (diariesWithCoords.length > 1) this._map.fitBounds(bounds);
    else {
      this._map.setCenter({ lat: diariesWithCoords[0].lat, lng: diariesWithCoords[0].lng });
      this._map.setZoom(14);
    }
  },

  openDiaryFromMap(id) {
    this.switchTab('diaries');
    setTimeout(() => {
      const target = document.querySelector(`.diary-item[data-diary-id="${id}"]`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('highlight-flash');
        setTimeout(() => target.classList.remove('highlight-flash'), 2500);
      }
    }, 150);
  },

  // ===== 預計行程 =====

  renderItineraries() {
    const el = document.getElementById('itinerary-list');
    if (!el || typeof Itineraries === 'undefined') return;
    const list = Itineraries.list;
    if (list.length === 0) {
      el.innerHTML = '<div style="text-align:center; color:var(--text-light); padding:14px; font-size:13px;">還沒有行程，點 + 新增規劃一條路線</div>';
      return;
    }
    el.innerHTML = list.map(itin => {
      const wps = Itineraries.getWaypoints(itin);
      const modeIcon = { DRIVING: '🚗', TRANSIT: '🚆', WALKING: '🚶', BICYCLING: '🚴' }[itin.travel_mode] || '🚗';
      const isMine = Auth.user && itin.author === Auth.user.email;
      const isActive = this._activeItineraryId === itin.id;
      const summary = wps.map(w => w.name).slice(0, 3).join(' → ') + (wps.length > 3 ? ` → ...(+${wps.length - 3})` : '');
      // active 時顯示 ● 點 + 「取消」按鈕；點 item 本身也能 toggle 取消
      return `
        <div class="itinerary-item ${isActive ? 'active' : ''}" data-id="${this.escapeAttr(itin.id)}">
          <div class="itinerary-info">
            <div class="itinerary-name">${isActive ? '<span class="itinerary-active-dot">●</span> ' : ''}${modeIcon} ${this.escapeHtml(itin.name)}</div>
            <div class="itinerary-meta">${this.escapeHtml(this.nameOf(itin.author))} · ${wps.length} 個地點 · ${this.escapeHtml(summary)}</div>
          </div>
          <div class="itinerary-actions">
            ${isActive ? `<button data-action="clear-itinerary" type="button" title="取消選擇，回到日記模式" class="itinerary-clear-btn">✕ 取消</button>` : ''}
            <button data-action="open-in-gmaps" data-id="${this.escapeAttr(itin.id)}" type="button" title="用 Google Maps 開（含完整導航）">🗺</button>
            ${isMine ? `<button data-action="delete-itinerary" data-id="${this.escapeAttr(itin.id)}" type="button" title="刪除">🗑</button>` : ''}
          </div>
        </div>
      `;
    }).join('');
  },

  openNewItineraryModal() {
    if (!Trips.current) { this.toast('先選一個 trip'); return; }
    const form = document.getElementById('itinerary-form');
    form.reset();
    this._itineraryWaypoints = [
      { name: '', address: '', lat: null, lng: null, place_id: '' },
      { name: '', address: '', lat: null, lng: null, place_id: '' },
    ];
    this.renderWaypointRows();
    this.openModal('modal-itinerary');
  },

  // 把當前 DOM input 的值同步回 _itineraryWaypoints[i].name（避免重排時丟字）
  _syncWaypointInputs() {
    const inputs = document.querySelectorAll('#waypoint-rows .waypoint-input');
    inputs.forEach((input, i) => {
      if (this._itineraryWaypoints[i]) {
        this._itineraryWaypoints[i].name = input.value;
      }
    });
  },

  renderWaypointRows() {
    const container = document.getElementById('waypoint-rows');
    const wps = this._itineraryWaypoints;
    container.innerHTML = wps.map((w, i) => `
      <div class="waypoint-row" data-idx="${i}">
        <span class="waypoint-num">${i + 1}</span>
        <input type="text" class="waypoint-input" placeholder="搜尋地點..." value="${this.escapeAttr(w.name)}" autocomplete="off">
        ${i > 0 ? `<button type="button" class="waypoint-up" data-action="wp-up" data-idx="${i}" title="往上">↑</button>` : '<span style="width:24px;"></span>'}
        ${i < wps.length - 1 ? `<button type="button" class="waypoint-down" data-action="wp-down" data-idx="${i}" title="往下">↓</button>` : '<span style="width:24px;"></span>'}
        ${wps.length > 2 ? `<button type="button" class="waypoint-remove" data-action="wp-remove" data-idx="${i}" title="移除">✕</button>` : ''}
      </div>
    `).join('');

    // 每個 input 綁 Places Autocomplete
    container.querySelectorAll('.waypoint-input').forEach((input, i) => {
      Maps.attachAutocomplete(input, (place) => {
        this._itineraryWaypoints[i] = place;
        input.value = place.name;
      });
    });
  },

  async handleItinerarySubmit(e) {
    e.preventDefault();
    const form = e.target;
    const name = form.elements['name'].value.trim();
    const travelMode = form.elements['travel_mode'].value;
    // 過濾掉沒選 place（lat 為 null）的 waypoints
    const wps = this._itineraryWaypoints.filter(w => w.lat && w.lng);
    if (wps.length < 2) { this.toast('至少要 2 個有效地點'); return; }
    const submitBtn = form.querySelector('[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = '儲存中...';
    try {
      const itin = await Itineraries.create({ name, waypoints: wps, travel_mode: travelMode });
      this.toast('✅ 行程已新增');
      this.closeModal('modal-itinerary');
      this.renderItineraries();
      // 自動載入到地圖
      this.showItineraryOnMap(itin.id);
    } catch (err) {
      console.error(err);
      this.toast('新增失敗：' + err.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '儲存行程';
    }
  },

  async deleteItinerary(id) {
    const itin = Itineraries.list.find(x => x.id === id);
    if (!itin) return;
    if (!confirm(`刪除行程「${itin.name}」？`)) return;
    try {
      await Itineraries.delete(id);
      this.toast('✅ 已刪除');
      if (this._activeItineraryId === id) {
        this._activeItineraryId = null;
        this.clearItineraryRoute();
      }
      this.renderItineraries();
    } catch (err) {
      this.toast('刪除失敗：' + err.message);
    }
  },

  clearItineraryRoute() {
    if (this._itineraryRenderer) {
      this._itineraryRenderer.setMap(null);
      this._itineraryRenderer = null;
    }
  },

  // 取消行程選擇 → 清路線 + 重新顯示日記 markers
  async clearItinerarySelection() {
    this.clearItineraryRoute();
    this._activeItineraryId = null;
    // 重新跑 initOrRefreshMap 把日記 markers 畫回來
    await this.initOrRefreshMap();
    this.renderItineraries();
    this.toast('已取消行程選擇，回到日記模式');
  },

  // 點行程 → 切到地圖顯示路線。如果點到當前 active 行程則 toggle 取消
  async showItineraryOnMap(id) {
    const itin = Itineraries.list.find(x => x.id === id);
    if (!itin) return;

    // Toggle：點當前 active 那個 → 取消選擇，回到日記 markers 模式
    if (this._activeItineraryId === id) {
      await this.clearItinerarySelection();
      return;
    }

    const wps = Itineraries.getWaypoints(itin);
    if (wps.length < 2) { this.toast('行程地點不足'); return; }

    // 切到地圖 tab + await 等地圖完全就緒（之前 switchTab 是 sync 不 await initOrRefreshMap → _map 還沒建好就 return）
    this.switchTab('map');
    await this.initOrRefreshMap();
    if (!this._map) { this.toast('地圖尚未就緒，請再試一次'); return; }

    // 清掉日記 markers（讓畫面只剩行程路線+其標記，比較清楚）
    if (this._mapMarkers) {
      this._mapMarkers.forEach(m => m.setMap(null));
      this._mapMarkers = [];
    }
    this.clearItineraryRoute();
    const service = new google.maps.DirectionsService();
    const renderer = new google.maps.DirectionsRenderer({
      map: this._map,
      suppressMarkers: false,
      polylineOptions: { strokeColor: '#3b82f6', strokeWeight: 6, strokeOpacity: 0.85 },
    });
    this._itineraryRenderer = renderer;
    this._activeItineraryId = id;

    const origin = { lat: wps[0].lat, lng: wps[0].lng };
    const destination = { lat: wps[wps.length - 1].lat, lng: wps[wps.length - 1].lng };
    const middleWps = wps.slice(1, -1).map(w => ({
      location: new google.maps.LatLng(w.lat, w.lng),
      stopover: true,
    }));

    service.route({
      origin,
      destination,
      waypoints: middleWps,
      travelMode: google.maps.TravelMode[itin.travel_mode] || google.maps.TravelMode.DRIVING,
      optimizeWaypoints: false,
    }, (result, status) => {
      if (status === 'OK') {
        renderer.setDirections(result);
        // 算總時間/距離 → toast 顯示
        let totalDist = 0, totalDur = 0;
        result.routes[0].legs.forEach(leg => {
          totalDist += leg.distance.value;
          totalDur += leg.duration.value;
        });
        const km = (totalDist / 1000).toFixed(1);
        const mins = Math.round(totalDur / 60);
        const dur = mins >= 60 ? `${Math.floor(mins / 60)} 小時 ${mins % 60} 分` : `${mins} 分鐘`;
        this.toast(`📍 ${itin.name}：${km} 公里 · 約 ${dur}`, 5000);
        this.renderItineraries(); // 更新 active 樣式
      } else {
        // 常見錯誤：TRANSIT 在台灣的小範圍可能 ZERO_RESULTS、
        // API key 沒開 Directions API 會 REQUEST_DENIED (要去 Google Cloud Console 啟用) 等
        // → fallback：自己畫直線 + numbered markers 至少讓用戶看到地點
        console.warn('Directions failed:', status, '— fallback to manual markers + Google Maps deep link. If REQUEST_DENIED, enable Directions API in Google Cloud Console.');
        renderer.setMap(null);
        this._itineraryRenderer = this._renderItineraryFallback(wps, itin.name);
        this.toast('請按 🗺 用 Google Maps 看完整路線', 5000);
        this.renderItineraries();
      }
    });
  },

  // 路線算不出來時的降級顯示：手動畫 markers + 連線 + fitBounds
  _renderItineraryFallback(wps, name) {
    const markers = [];
    const path = [];
    const bounds = new google.maps.LatLngBounds();
    wps.forEach((w, i) => {
      const pos = { lat: w.lat, lng: w.lng };
      const marker = new google.maps.Marker({
        position: pos,
        map: this._map,
        label: { text: String(i + 1), color: 'white', fontWeight: 'bold' },
        title: `${i + 1}. ${w.name}`,
      });
      markers.push(marker);
      path.push(pos);
      bounds.extend(pos);
    });
    const polyline = new google.maps.Polyline({
      path,
      strokeColor: '#3b82f6',
      strokeWeight: 4,
      strokeOpacity: 0.7,
      map: this._map,
    });
    this._map.fitBounds(bounds, { top: 50, bottom: 50, left: 50, right: 50 });
    // 回傳 fake renderer：setMap(null) 時清掉 markers + polyline
    return {
      setMap(map) {
        if (map === null) {
          markers.forEach(m => m.setMap(null));
          polyline.setMap(null);
        }
      },
      setDirections() {},
    };
  },

  // 用 Google Maps 開啟行程（手機跳 app、桌面跳 web）
  openItineraryInGoogleMaps(id) {
    const itin = Itineraries.list.find(x => x.id === id);
    if (!itin) return;
    const wps = Itineraries.getWaypoints(itin);
    if (wps.length < 2) { this.toast('地點不足'); return; }
    // Google Maps 通用 URL（dir/?api=1）— 自動跳手機 app 或開 web
    const modeMap = { DRIVING: 'driving', TRANSIT: 'transit', WALKING: 'walking', BICYCLING: 'bicycling' };
    const params = new URLSearchParams({
      api: '1',
      origin: `${wps[0].lat},${wps[0].lng}`,
      destination: `${wps[wps.length - 1].lat},${wps[wps.length - 1].lng}`,
      travelmode: modeMap[itin.travel_mode] || 'driving',
    });
    // 中途點（最多 9 個 free，用 | 分隔）
    if (wps.length > 2) {
      const middle = wps.slice(1, -1).map(w => `${w.lat},${w.lng}`).join('|');
      params.set('waypoints', middle);
    }
    const url = `https://www.google.com/maps/dir/?${params.toString()}`;
    window.open(url, '_blank');
  },

  openLightbox(photoIds, startIdx) {
    this._lightboxPhotos = photoIds;
    this._lightboxIndex = startIdx;
    this.showLightboxPhoto();
    document.getElementById('photo-lightbox').showModal();
    // lightbox 期間允許 pinch zoom 看照片細節
    this._setViewportZoom(true);
  },

  // 舊日記（v1.3.0 之前）沒記 folder URL → 點 📁 時 fallback 連到該 trip 整個照片資料夾
  async openTripPhotosFolder(diaryId) {
    const d = Diaries.allList.find(x => x.id === diaryId);
    if (!d) { this.toast('找不到該日記'); return; }
    // 同步開 placeholder tab 避免 popup blocker（await 後再 window.open 會被擋）
    const w = window.open('about:blank', '_blank');
    try {
      // Phase 2: photos folder 從 active group 取
      const tripFolderId = await API.ensureFolder(d.trip_id, Groups.active().photosFolderId);
      const url = `https://drive.google.com/drive/folders/${tripFolderId}`;
      if (w) w.location = url;
      else window.location.href = url; // 用戶擋彈出視窗 → 直接跳當前頁
    } catch (err) {
      if (w) w.close();
      console.error(err);
      this.toast('開啟資料夾失敗：' + err.message);
    }
  },

  // 動態切換 viewport：lightbox 開啟允許放大、平常維持禁止避免 input focus auto-zoom
  _setViewportZoom(allow) {
    const meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return;
    if (allow) {
      meta.setAttribute('content', 'width=device-width, initial-scale=1.0, viewport-fit=cover');
    } else {
      meta.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=cover');
    }
  },

  showLightboxPhoto() {
    if (!this._lightboxPhotos.length) return;
    const id = this._lightboxPhotos[this._lightboxIndex];
    const li = document.getElementById('lightbox-img');
    li.dataset.photoId = id;
    delete li.dataset.fallbackTried;
    li.src = API.driveImageUrl(id, 1600);
    document.getElementById('lightbox-prev').style.visibility = this._lightboxIndex > 0 ? '' : 'hidden';
    document.getElementById('lightbox-next').style.visibility = this._lightboxIndex < this._lightboxPhotos.length - 1 ? '' : 'hidden';
    const counter = document.getElementById('lightbox-counter');
    if (this._lightboxPhotos.length > 1) {
      counter.textContent = `${this._lightboxIndex + 1} / ${this._lightboxPhotos.length}`;
      counter.style.display = '';
    } else counter.style.display = 'none';
  },

  // ⭐ v2.0.2 token 失效時的降級版：只顯示 cache，不打 API（避免 401 一直噴）
  async _showMainAppCacheOnly() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    const img = document.getElementById('user-avatar');
    if (Auth.user && Auth.user.picture) { img.src = Auth.user.picture; img.style.display = ''; }
    else img.style.display = 'none';
    const hasCache = Trips.loadFromCache();
    if (hasCache && Trips.current) {
      Members.loadFromCache();
      Nicknames.loadFromCache();
      Expenses.loadFromCache();
      Diaries.loadFromCache();
      Comments.loadFromCache();
      Notifications.loadFromCache();
      if (typeof Itineraries !== 'undefined') Itineraries.loadFromCache();
      if (typeof Settlements !== 'undefined') Settlements.loadFromCache();
      this.renderAll();
      this.updateNotifBadge();
    }
  },

  async showMainApp() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');

    const img = document.getElementById('user-avatar');
    if (Auth.user && Auth.user.picture) { img.src = Auth.user.picture; img.style.display = ''; }
    else img.style.display = 'none';

    // Phase 1: cache 瞬間渲染
    const hasCache = Trips.loadFromCache();
    if (hasCache && Trips.current) {
      Members.loadFromCache();
      Nicknames.loadFromCache();
      Expenses.loadFromCache();
      Diaries.loadFromCache();
      Comments.loadFromCache();
      Notifications.loadFromCache();
      if (typeof Itineraries !== 'undefined') Itineraries.loadFromCache();
      if (typeof Settlements !== 'undefined') Settlements.loadFromCache();
      this.renderAll();
      this.updateNotifBadge();
    }

    // Phase 2: 背景同步
    try {
      // M4.3: 清掉舊的 _lastError（避免上次 session 的 stale error 留在 debug）
      this._lastError = null;
      await this.ensureMemberRegistered();
      // M4.2: 平行載入 Trips + Members
      //   Members 一定要在 openNewTripModal 之前載入，否則新 trip 成員 checkbox 會空白
      await Promise.all([Trips.loadAll(), Members.loadAll()]);
      if (Trips.list.length === 0) {
        this.toast('還沒有任何 trip，先建一個吧');
        this.openNewTripModal();
        return;
      }
      await this.refreshAll();
    } catch (err) {
      console.error('showMainApp Phase 2 failed:', err);
      const msg = err.message || '未知錯誤';
      this._lastError = msg;

      // M4 fix: 404 (sheet 不存在) / 403 (沒權限) 都代表「群組壞掉了」
      //   → 把壞掉的群組移除，回到無群組畫面讓用戶重建/重加入
      const isBrokenGroup =
        msg.includes('404') ||
        msg.includes('not found') ||
        msg.includes('Requested entity was not found') ||
        msg.includes('403') ||
        msg.includes('Forbidden') ||
        msg.includes('permission');

      if (isBrokenGroup && Groups.active()) {
        const broken = Groups.active();
        console.warn(`Group "${broken.name}" inaccessible, removing from list`);
        Groups.remove(broken.groupId);
        // 切到下一個群組（如果還有的話）reload；否則進無群組畫面
        if (Groups.list.length > 0) {
          this.toast(`群組「${broken.name}」無法存取（Drive 被刪 或 無權限），切到下一個群組`);
          setTimeout(() => location.reload(), 1500);
        } else {
          this.toast(`群組「${broken.name}」無法存取，請重新建立或加入新群組`);
          this.showNoGroupScreen();
        }
        return;
      }

      if (msg.includes('401') || msg.includes('Unauthorized')) {
        // ⭐ v2.0.2 不再叫用戶重置，改用輕量續登 banner
        this.showReauthBanner();
      } else {
        this.showErrorBanner('⚠️ 載入失敗：' + msg.slice(0, 150));
      }
    }
  },

  // 持久錯誤橫幅（toast 會消失，banner 留著）
  showErrorBanner(msg) {
    let banner = document.getElementById('global-error-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'global-error-banner';
      banner.className = 'global-error-banner';
      document.body.insertBefore(banner, document.body.firstChild);
    }
    banner.innerHTML = `<div>${msg}</div><button type="button" id="error-banner-close" aria-label="關閉">✕</button>`;
    banner.classList.remove('hidden');
    const closeBtn = document.getElementById('error-banner-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => banner.classList.add('hidden'));
    }
  },

  // ⭐ v2.0.2 session 過期橫幅（取代全螢幕登入畫面 — 用戶看到 cache + 按一下續登）
  showReauthBanner() {
    if (document.getElementById('reauth-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'reauth-banner';
    banner.className = 'reauth-banner';
    const name = Auth.user ? (Auth.user.name || Auth.user.email.split('@')[0]) : '你';
    // v3.1.0: 加一句安心提示 — PWA 第一次登入或 session 過期時不會丟失群組
    const isPwa = this._isPWA && this._isPWA();
    const extraHint = isPwa
      ? '<div style="font-size:12px; opacity:0.9; margin-top:4px;">續登後會自動同步你所有群組（含被邀請的）</div>'
      : '';
    banner.innerHTML = `
      <div>👋 歡迎回來 <strong>${this.escapeHtml(name)}</strong>，session 過期了，續登才能存取最新資料${extraHint}</div>
      <button type="button" id="reauth-btn">續登</button>
    `;
    document.body.insertBefore(banner, document.body.firstChild);
    document.getElementById('reauth-btn').addEventListener('click', async () => {
      const btn = document.getElementById('reauth-btn');
      btn.disabled = true;
      btn.textContent = '...';
      try {
        await Auth.login();
        banner.remove();
        this.toast('✅ 已續登，正在同步資料...');
        // 重新跑 Phase 2 抓最新資料
        try {
          await this.ensureMemberRegistered();
          await Trips.loadAll();
          if (Trips.current) await this.refreshAll();
        } catch (err) {
          console.warn('post-reauth sync failed:', err);
        }
      } catch (err) {
        console.error('reauth failed:', err);
        btn.disabled = false;
        btn.textContent = '續登';
        this.toast('續登失敗：' + (err.message || err));
      }
    });
  },

  // 新版 SW 已啟用 → 提示用戶 reload（不強制 reload 避免打斷編輯）
  showUpdateBanner() {
    // 避免重複顯示（SW 一次更新有可能 fire 兩次）
    if (document.getElementById('update-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'update-banner';
    banner.className = 'update-banner';
    banner.innerHTML = `
      <div>🆕 BroTrip 有新版！點此立刻使用最新功能</div>
      <button type="button" id="update-reload-btn">重新整理</button>
      <button type="button" id="update-dismiss-btn" aria-label="稍後">✕</button>
    `;
    document.body.insertBefore(banner, document.body.firstChild);
    document.getElementById('update-reload-btn').addEventListener('click', () => {
      window.location.reload();
    });
    document.getElementById('update-dismiss-btn').addEventListener('click', () => {
      banner.remove();
    });
  },

  async ensureMemberRegistered() {
    try {
      const rows = await API.getSheet('Members');
      const members = API.rowsToObjects(rows);
      const exists = members.some(m => m.email === Auth.user.email);
      if (!exists) {
        await API.appendRow('Members', [
          Auth.user.email,
          Auth.user.name || Auth.user.email.split('@')[0],
          new Date().toISOString(),
        ]);
      }
    } catch (err) { console.warn('Member register failed:', err); }
  },

  async refreshAll() {
    if (!Trips.current) return;
    // M4.3: 清掉舊的 _lastError
    this._lastError = null;
    await Promise.all([
      Members.loadAll(),
      Expenses.loadAll(), Diaries.loadAll(),
      Nicknames.loadAll(), Comments.loadAll(),
      Notifications.loadAll(),
      typeof Itineraries !== 'undefined' ? Itineraries.loadAll() : Promise.resolve(),
      typeof Settlements !== 'undefined' ? Settlements.loadAll() : Promise.resolve(),
    ]);
    this.renderAll();
    this.updateNotifBadge();
  },

  renderAll() {
    if (!Trips.current) return;
    document.getElementById('trip-switch').textContent = `📍 ${Trips.current.name}`;
    document.getElementById('trip-dates').textContent = `${Trips.current.start_date || ''} ~ ${Trips.current.end_date || ''}`;
    this.renderSettlement();
    this.renderExpenses();
    this.renderDiaryFilters();
    this.renderDiaries();
    this.renderNicknamesUI();
    this.renderItineraries();
    this.updateDebugInfo();
  },

  switchTab(tab) {
    this.currentTab = tab;
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
    document.getElementById('tab-expenses').classList.toggle('hidden', tab !== 'expenses');
    document.getElementById('tab-diaries').classList.toggle('hidden', tab !== 'diaries');
    document.getElementById('tab-map').classList.toggle('hidden', tab !== 'map');
    document.getElementById('tab-settings').classList.toggle('hidden', tab !== 'settings');
    document.getElementById('fab').style.display = (tab === 'expenses' || tab === 'diaries') ? '' : 'none';
    if (tab === 'map') this.initOrRefreshMap();
    // M5.1: 切到設定 tab 時更新群組統計
    if (tab === 'settings') this.updateGroupStats();
  },

  // ===== Renders =====

  renderSettlement() {
    const el = document.getElementById('settlement-content');
    const result = Expenses.settle();
    const currencies = Object.keys(result);
    const hasUnsettled = currencies.some(c => result[c].length > 0);
    const totals = {};
    Expenses.list.forEach(e => {
      const amount = parseFloat(e.amount);
      if (!amount || isNaN(amount)) return;
      const cur = e.currency || 'TWD';
      totals[cur] = (totals[cur] || 0) + amount;
    });
    const hasExpense = Object.keys(totals).length > 0;
    if (!hasExpense) {
      el.innerHTML = '<div style="color:var(--text-light);text-align:center;padding:8px;">還沒有支出 💸</div>';
      return;
    }
    const totalLine = Object.entries(totals).map(([c, v]) => `${c} ${v.toLocaleString()}`).join(' + ');
    let html = `<div style="font-size:13px;color:var(--text-light);margin-bottom:10px;padding-bottom:8px;border-bottom:1px dashed var(--border);">💵 總花費 ${totalLine}</div>`;
    // 算未結清筆數
    let unsettledCount = 0;
    Expenses.list.forEach(e => {
      if (String(e.settled).toUpperCase() !== 'TRUE') unsettledCount++;
    });

    // ⭐ v2.0.0: 待我確認的轉帳（最上面顯眼提醒）
    const pendingForMe = (typeof Settlements !== 'undefined') ? Settlements.getPendingForMe() : [];
    if (pendingForMe.length > 0) {
      html += `<div class="pending-claims-section">`;
      html += `<div class="pending-claims-title">💳 待我確認的轉帳 (${pendingForMe.length})</div>`;
      pendingForMe.forEach(s => {
        html += `
          <div class="pending-claim-row">
            <div class="pending-claim-info">
              <strong>${this.escapeHtml(this.nameOf(s.from_email))}</strong> 說已給你
              <span class="pending-claim-amount">${this.escapeHtml(s.currency || 'TWD')} ${parseFloat(s.amount).toLocaleString()}</span>
              ${s.note ? `<small>（${this.escapeHtml(s.note)}）</small>` : ''}
            </div>
            <div class="pending-claim-actions">
              <button data-action="confirm-settlement" data-id="${this.escapeAttr(s.id)}" type="button" class="btn-confirm">✓ 收到</button>
              <button data-action="reject-settlement" data-id="${this.escapeAttr(s.id)}" type="button" class="btn-reject">❌ 沒收到</button>
            </div>
          </div>
        `;
      });
      html += `</div>`;
    }

    if (!hasUnsettled) html += '<div style="color:var(--text-light);text-align:center;padding:8px;">✨ 大家都結清了！</div>';
    else {
      const myEmail = Auth.user ? Auth.user.email : '';
      for (const currency of currencies) {
        if (result[currency].length === 0) continue;
        result[currency].forEach(t => {
          // 該對的 pending（我作為 from 已按「我已付」等對方確認）
          const pending = (typeof Settlements !== 'undefined')
            ? Settlements.getPendingPair(t.from, t.to, currency) : null;
          let btnHtml = '';
          if (pending && pending.from_email === myEmail) {
            btnHtml = `<button data-action="cancel-settlement" data-id="${this.escapeAttr(pending.id)}" type="button" class="btn-pending" title="點此撤回">⏳ 等對方確認</button>`;
          } else if (t.from === myEmail) {
            // 我是付款方且沒 pending → 顯示「我已付」按鈕
            btnHtml = `<button data-action="claim-settlement" data-from="${this.escapeAttr(t.from)}" data-to="${this.escapeAttr(t.to)}" data-amount="${t.amount}" data-currency="${this.escapeAttr(currency)}" type="button" class="btn-claim">✅ 我已付</button>`;
          }
          html += `
            <div class="settle-row">
              <span><strong>${this.nameOf(t.from)}</strong> 給 <strong>${this.nameOf(t.to)}</strong></span>
              <span class="settle-amount-actions">
                <span>${currency} ${t.amount.toLocaleString()}</span>
                ${btnHtml}
              </span>
            </div>
          `;
        });
      }
      html += `<button id="mark-all-settled-btn" type="button" class="btn-link" style="width:100%;margin-top:10px;font-size:12px;">🏁 強制全部結清（${unsettledCount} 筆，跳過確認）</button>`;
    }

    // ⭐ v2.0.1 個人支出統計（每人實際分攤後的花費，含已結清，按金額多→少）
    const perPerson = Expenses.getPerPersonSpending();
    const perPersonCurrencies = Object.keys(perPerson);
    if (perPersonCurrencies.length > 0) {
      html += `<details class="per-person-section"><summary>📊 個人支出統計（含已結清）</summary>`;
      perPersonCurrencies.forEach(currency => {
        const entries = Object.entries(perPerson[currency])
          .filter(([_, amt]) => amt > 0.01)
          .sort((a, b) => b[1] - a[1]); // 多 → 少
        if (entries.length === 0) return;
        const total = entries.reduce((s, [_, v]) => s + v, 0);
        if (perPersonCurrencies.length > 1) {
          html += `<div class="per-person-currency-label">${this.escapeHtml(currency)}</div>`;
        }
        entries.forEach(([email, amt]) => {
          const isMe = Auth.user && email === Auth.user.email;
          const pct = total > 0 ? Math.round((amt / total) * 100) : 0;
          html += `
            <div class="per-person-row ${isMe ? 'me' : ''}">
              <span class="per-person-name">${isMe ? '👤 ' : ''}${this.escapeHtml(this.nameOf(email))}</span>
              <span class="per-person-bar-wrap">
                <span class="per-person-bar" style="width:${pct}%"></span>
              </span>
              <span class="per-person-amount">${currency} ${amt.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
            </div>
          `;
        });
        html += `<div class="per-person-total">小計 ${currency} ${total.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>`;
      });
      html += `</details>`;
    }

    el.innerHTML = html;
  },

  // ⭐ v2.0.0 Peer-to-peer 結算 actions

  // A 按「我已付」 → 建 pending settlement → 通知 B
  async claimSettlement(btn) {
    const from = btn.dataset.from;
    const to = btn.dataset.to;
    const amount = parseFloat(btn.dataset.amount) || 0;
    const currency = btn.dataset.currency || 'TWD';
    if (from !== Auth.user.email) { this.toast('只能標記自己付的'); return; }
    const note = prompt(`你已給 ${this.nameOf(to)} ${currency} ${amount.toLocaleString()} 了？\n\n可加備註（轉帳方式之類，可空白）：`, '');
    if (note === null) return; // 取消
    btn.disabled = true;
    btn.textContent = '...';
    try {
      await Settlements.create({ to_email: to, amount, currency, note: note.trim() });
      this.toast(`✅ 已記錄，等 ${this.nameOf(to)} 確認`, 4000);
      this.renderSettlement();
    } catch (err) {
      console.error(err);
      this.toast('失敗：' + err.message);
      btn.disabled = false;
    }
  },

  // A 撤回未確認的 settlement（如果按錯）
  async cancelSettlement(id) {
    const s = Settlements.list.find(x => x.id === id);
    if (!s) return;
    if (!confirm(`撤回這筆「我已付 ${s.currency} ${parseFloat(s.amount).toLocaleString()}」嗎？\n（如果還沒實際給錢、按錯了就撤回）`)) return;
    try {
      await Settlements.cancel(id);
      this.toast('已撤回');
      this.renderSettlement();
    } catch (err) {
      this.toast('撤回失敗：' + err.message);
    }
  },

  // B 按「確認收到」
  async confirmSettlementClaim(id) {
    const s = Settlements.list.find(x => x.id === id);
    if (!s) return;
    if (!confirm(`確認收到 ${this.nameOf(s.from_email)} 的 ${s.currency} ${parseFloat(s.amount).toLocaleString()}？\n\n確認後就抵銷這筆債務（不可復原）。`)) return;
    try {
      await Settlements.confirm(id);
      this.toast(`✅ 已確認，債務已抵銷`);
      this.renderSettlement();
    } catch (err) {
      console.error(err);
      this.toast('確認失敗：' + err.message);
    }
  },

  // B 拒絕（沒收到）
  async rejectSettlementClaim(id) {
    const s = Settlements.list.find(x => x.id === id);
    if (!s) return;
    if (!confirm(`回報「沒收到 ${this.nameOf(s.from_email)} 的 ${s.currency} ${parseFloat(s.amount).toLocaleString()}」？\n\n會通知對方，這筆會被刪除（債務維持原樣）`)) return;
    try {
      await Settlements.cancel(id);
      this.toast(`已通知 ${this.nameOf(s.from_email)}`);
      this.renderSettlement();
    } catch (err) {
      this.toast('失敗：' + err.message);
    }
  },

  nameOf(email) {
    if (!email) return '?';
    if (typeof Nicknames !== 'undefined') {
      const nick = Nicknames.get(email);
      if (nick) return nick;
    }
    // M4.2: Members.getName 內建 Auth.user 自我 fallback（沒寫死名單了）
    const memberName = Members.getName(email);
    if (memberName) return memberName;
    if (Auth.user && email === Auth.user.email) return '我';
    return email.split('@')[0];
  },

  renderExpenses() {
    const el = document.getElementById('expense-list');
    if (Expenses.list.length === 0) {
      el.innerHTML = '<div class="list-empty">還沒有支出，點右下角 + 新增</div>';
      return;
    }
    const sorted = [...Expenses.list].sort((a, b) => {
      if (a.date !== b.date) return (b.date || '').localeCompare(a.date || '');
      return (b.created_at || '').localeCompare(a.created_at || '');
    });
    el.innerHTML = sorted.map(e => {
      const amt = parseFloat(e.amount) || 0;
      // 多付款人顯示
      let payersStr = this.nameOf(e.payer);
      try {
        const payers = JSON.parse(e.payers || '[]');
        if (Array.isArray(payers) && payers.length > 1) {
          payersStr = payers.map(p => `${this.nameOf(p.email)}(${(parseFloat(p.amount) || 0).toLocaleString()})`).join(' + ');
        }
      } catch {}

      const isSettled = String(e.settled).toUpperCase() === 'TRUE';
      const settledBadge = isSettled ? '<span class="settled-badge">✅ 已結清</span>' : '';
      // v1.7.0: 任何 trip 成員都能編輯/刪除
      const actions = `
        <div class="item-actions">
          <button data-action="edit-expense" data-id="${this.escapeAttr(e.id)}" type="button" title="編輯">✏️</button>
          <button data-action="delete-expense" data-id="${this.escapeAttr(e.id)}" type="button" title="刪除">🗑</button>
        </div>`;
      return `
        <div class="list-item expense-item ${isSettled ? 'settled' : ''}" data-expense-id="${this.escapeAttr(e.id)}">
          <div class="row">
            <span>${this.escapeHtml(e.category || '')} ${this.escapeHtml(e.description || '(無說明)')}</span>
            <span class="expense-amount">${e.currency || 'TWD'} ${amt.toLocaleString()}</span>
          </div>
          <div class="row">
            <div class="meta">${e.date} · 由 ${payersStr} 付 ${settledBadge}</div>
            ${actions}
          </div>
        </div>
      `;
    }).join('');
  },

  renderDiaryFilters() {
    const el = document.getElementById('filter-authors');
    if (!el) return;
    const allAuthors = [...new Set(Diaries.list.map(d => d.author))];
    el.innerHTML = allAuthors.map(email => {
      const active = this._diaryFilter.authors.includes(email);
      return `<button type="button" class="filter-chip ${active ? 'active' : ''}" data-email="${this.escapeAttr(email)}">${this.nameOf(email)}</button>`;
    }).join('');
    this.updateFilterSummary();
  },

  updateFilterSummary() {
    const el = document.getElementById('filter-summary');
    if (!el) return;
    const f = this._diaryFilter;
    const active = (f.authors.length > 0 ? 1 : 0) + (f.dateFrom ? 1 : 0) + (f.dateTo ? 1 : 0) + (f.keyword ? 1 : 0);
    if (active === 0) { el.textContent = ''; return; }
    const filtered = this.applyDiaryFilter(Diaries.list);
    el.textContent = `${active} 個篩選 · 顯示 ${filtered.length}/${Diaries.list.length}`;
  },

  applyDiaryFilter(list) {
    const f = this._diaryFilter;
    // 關鍵字小寫化一次，提升 filter 效率
    const kw = (f.keyword || '').trim().toLowerCase();
    return list.filter(d => {
      if (f.authors.length > 0 && !f.authors.includes(d.author)) return false;
      if (f.dateFrom && d.date < f.dateFrom) return false;
      if (f.dateTo && d.date > f.dateTo) return false;
      if (kw) {
        // 搜尋範圍：content / mood / location_name / author 暱稱或本名
        const hay = [
          d.content || '',
          d.mood || '',
          d.location_name || '',
          this.nameOf(d.author) || '',
        ].join('\n').toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  },

  renderDiaries() {
    const el = document.getElementById('diary-list');
    let list = this.applyDiaryFilter(Diaries.list);
    list = [...list].sort((a, b) => {
      const pa = String(a.pinned).toUpperCase() === 'TRUE';
      const pb = String(b.pinned).toUpperCase() === 'TRUE';
      if (pa !== pb) return pa ? -1 : 1;
      return (b.created_at || '').localeCompare(a.created_at || '');
    });
    if (list.length === 0) {
      const isFiltered = (this._diaryFilter.authors.length > 0 || this._diaryFilter.dateFrom || this._diaryFilter.dateTo || this._diaryFilter.keyword);
      el.innerHTML = `<div class="list-empty">${isFiltered ? '篩選後沒有日記' : '還沒有日記，點右下角 + 新增'}</div>`;
      return;
    }
    el.innerHTML = list.map(d => {
      let photoIds = [];
      try { photoIds = JSON.parse(d.photo_ids || '[]'); } catch {}
      const photosHtml = photoIds.length ? `
        <div class="diary-photos">
          ${photoIds.map(id => `<img src="${API.driveImageUrl(id)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-photo-id="${id}" onerror="App.handleImgError(this)">`).join('')}
        </div>` : '';
      let locHtml = '';
      if (d.location) {
        let info = null;
        if (d.location.startsWith('{')) {
          try { info = JSON.parse(d.location); } catch {}
        }
        if (info) {
          const name = info.name || info.address || '';
          let link = '';
          if (info.place_id) link = `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(info.place_id)}`;
          else if (info.lat && info.lng) link = `https://www.google.com/maps/?q=${info.lat},${info.lng}`;
          if (name) locHtml = link
            ? ` · <a href="${link}" target="_blank" rel="noopener">📍 ${this.escapeHtml(name)}</a>`
            : ` · 📍 ${this.escapeHtml(name)}`;
        } else locHtml = ` · 📍 ${this.escapeHtml(d.location)}`;
      }
      // 📁 連結：有 d.url 直接連；舊日記沒 url 但有 photos 也顯示，點下去 fallback 到 trip 資料夾
      let driveLink = '';
      if (d.url) {
        driveLink = `<a href="${this.escapeAttr(d.url)}" target="_blank" rel="noopener" class="diary-drive-link" title="開啟 Drive 相簿資料夾">📁</a>`;
      } else if (photoIds.length > 0) {
        driveLink = `<button data-action="open-trip-folder" data-id="${this.escapeAttr(d.id)}" type="button" class="diary-drive-link" title="開啟 trip 照片資料夾（早期日記沒記 folder URL）">📁</button>`;
      }
      const isMine = Auth.user && d.author === Auth.user.email;
      const isPinned = String(d.pinned).toUpperCase() === 'TRUE';
      const actions = `
        <div class="item-actions">
          ${driveLink}
          <button data-action="pin-diary" data-id="${this.escapeAttr(d.id)}" type="button" title="${isPinned ? '取消置頂' : '置頂'}">${isPinned ? '⭐' : '☆'}</button>
          ${isMine ? `
            <button data-action="edit-diary" data-id="${this.escapeAttr(d.id)}" type="button" title="編輯">✏️</button>
            <button data-action="delete-diary" data-id="${this.escapeAttr(d.id)}" type="button" title="刪除">🗑</button>` : ''}
        </div>`;
      return `
        <div class="diary-item ${isPinned ? 'pinned' : ''}" data-diary-id="${this.escapeAttr(d.id)}">
          <div class="diary-header">
            <div>
              <span class="diary-mood">${this.escapeHtml(d.mood || '')}</span>
              <strong>${this.nameOf(d.author)}</strong>
            </div>
            <div class="diary-meta">${d.date}${locHtml}</div>
          </div>
          <div class="diary-content">${this.renderContentWithMentions(d.content || '')}</div>
          ${photosHtml}
          ${actions}
          ${this.renderCommentsSection(d.id)}
        </div>
      `;
    }).join('');
  },

  renderCommentsSection(diaryId) {
    if (typeof Comments === 'undefined') return '';
    const comments = Comments.getForDiary(diaryId);
    return `
      <div class="comments-section">
        ${comments.length > 0 ? `
          <div class="comments-list">
            ${comments.map(c => {
              const isMine = Auth.user && c.author === Auth.user.email;
              return `
                <div class="comment-item" data-comment-id="${this.escapeAttr(c.id)}">
                  <div class="comment-header">
                    <strong>${this.escapeHtml(this.nameOf(c.author))}</strong>
                    <small class="comment-time">${this.formatRelativeTime(c.created_at)}</small>
                    ${isMine ? `<button class="comment-delete" data-action="delete-comment" data-id="${this.escapeAttr(c.id)}" type="button" aria-label="刪除">×</button>` : ''}
                  </div>
                  <div class="comment-content">${this.renderContentWithMentions(c.content)}</div>
                </div>
              `;
            }).join('')}
          </div>
        ` : ''}
        <div class="comment-input-wrap" data-diary-id="${this.escapeAttr(diaryId)}">
          <input type="text" class="comment-input" placeholder="💬 留言（打「@」tag 人）..." maxlength="500">
          <button type="button" class="comment-send">送出</button>
        </div>
      </div>
    `;
  },

  formatRelativeTime(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (isNaN(date)) return '';
    const diff = Date.now() - date.getTime();
    const min = Math.floor(diff / 60000);
    if (min < 1) return '剛剛';
    if (min < 60) return `${min} 分鐘前`;
    const hour = Math.floor(min / 60);
    if (hour < 24) return `${hour} 小時前`;
    const day = Math.floor(hour / 24);
    if (day < 30) return `${day} 天前`;
    return date.toISOString().slice(0, 10);
  },

  renderNicknamesUI() {
    const el = document.getElementById('nicknames-list');
    if (!el || typeof Nicknames === 'undefined') return;
    el.innerHTML = Members.all().map((m) => {
      const entry = Nicknames.getEntry(m.email);
      const nick = entry ? entry.nickname : '';
      const byInfo = (entry && entry.updated_by && entry.updated_by !== m.email)
        ? `<small class="nick-by">（${this.escapeHtml(this.nameOf(entry.updated_by))} 改的）</small>`
        : '';
      return `
        <div class="nickname-row">
          <div class="nickname-info">
            <div><strong>${this.escapeHtml(m.name)}</strong> <small style="color:var(--text-light);">${this.escapeHtml(m.email)}</small></div>
            <div class="current-nick">${nick ? '「' + this.escapeHtml(nick) + '」' : '<span style="color:var(--text-light);">(無暱稱)</span>'} ${byInfo}</div>
          </div>
          <button class="btn-edit-nickname" data-email="${this.escapeAttr(m.email)}" type="button">改</button>
        </div>
      `;
    }).join('');
  },

  // ===== Mentions =====

  // 解析 content 中的 @名字 → emails
  parseMentions(content) {
    if (!content) return [];
    const emails = new Set();
    const tokens = content.match(/@([^\s@,。，！？!?]+)/g) || [];
    tokens.forEach(token => {
      const name = token.slice(1);
      const m = Members.findByName(name);
      if (m) { emails.add(m.email); return; }
      if (typeof Nicknames !== 'undefined') {
        for (const email in Nicknames.map) {
          if (Nicknames.map[email].nickname === name) { emails.add(email); return; }
        }
      }
    });
    return Array.from(emails);
  },

  // 顯示 content + highlight @mentions
  // 顯示時優先用暱稱（即使原文打的是本名「@魏德睿」，有暱稱「禿」就顯示「@禿」）
  renderContentWithMentions(content) {
    if (!content) return '';
    const escaped = this.escapeHtml(content);
    return escaped.replace(/@([^\s@,。，！？!?]+)/g, (m, name) => {
      // 先找出對應 email
      let email = null;
      const member = Members.findByName(name);
      if (member) email = member.email;
      if (!email && typeof Nicknames !== 'undefined') {
        for (const e in Nicknames.map) {
          if (Nicknames.map[e].nickname === name) { email = e; break; }
        }
      }
      if (email) {
        // 顯示用 nameOf：暱稱 > Members.display_name > Gmail 名
        const display = this.nameOf(email);
        return `<span class="mention">@${this.escapeHtml(display)}</span>`;
      }
      return m;
    });
  },

  insertAtCursor(el, text) {
    const start = el.selectionStart || 0;
    const end = el.selectionEnd || 0;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    el.selectionStart = el.selectionEnd = start + text.length;
    el.focus();
  },

  // ===== Mention autocomplete dropdown =====

  // 偵測游標前是否有 @xxx，若有就 show dropdown
  handleMentionInput(inputEl) {
    const text = inputEl.value;
    const pos = inputEl.selectionStart || 0;
    const before = text.slice(0, pos);
    const atIdx = before.lastIndexOf('@');
    if (atIdx === -1) { this.closeMentionDropdown(); return; }
    const between = before.slice(atIdx + 1);
    // @ 跟游標之間如果有 space / 標點，已經結束 mention
    if (/[\s,，。、!?！？]/.test(between)) { this.closeMentionDropdown(); return; }
    if (between.length > 20) { this.closeMentionDropdown(); return; }
    this.showMentionDropdown(inputEl, atIdx, between);
  },

  showMentionDropdown(inputEl, atIdx, query) {
    this._mentionState = { inputEl, atIdx };
    const dropdown = document.getElementById('mention-dropdown');
    if (!dropdown) return;

    const lowerQ = (query || '').toLowerCase();
    const matches = Members.all().filter(m => {
      if (!lowerQ) return true;
      const display = this.nameOf(m.email).toLowerCase();
      return display.includes(lowerQ) || (m.name || '').toLowerCase().includes(lowerQ);
    });
    if (matches.length === 0) { this.closeMentionDropdown(); return; }

    dropdown.innerHTML = matches.map((m, i) => {
      const display = this.nameOf(m.email);
      return `<div class="mention-option ${i === 0 ? 'active' : ''}" data-name="${this.escapeAttr(display)}">@${this.escapeHtml(display)}</div>`;
    }).join('');

    // 定位在 input 下方
    const rect = inputEl.getBoundingClientRect();
    dropdown.style.left = `${rect.left + window.scrollX}px`;
    dropdown.style.top = `${rect.bottom + window.scrollY + 4}px`;
    dropdown.style.minWidth = `${Math.min(Math.max(rect.width, 160), 240)}px`;
    dropdown.classList.remove('hidden');
    dropdown.classList.add('show');

    // Mousedown + touchstart 避免 blur 觸發
    dropdown.querySelectorAll('.mention-option').forEach(opt => {
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.applyMention(opt.dataset.name);
      });
      opt.addEventListener('touchstart', (e) => {
        e.preventDefault();
        this.applyMention(opt.dataset.name);
      }, { passive: false });
    });
  },

  closeMentionDropdown() {
    const dropdown = document.getElementById('mention-dropdown');
    if (dropdown) {
      dropdown.classList.add('hidden');
      dropdown.classList.remove('show');
    }
    this._mentionState = null;
  },

  applyMention(name) {
    if (!this._mentionState) return;
    const { inputEl, atIdx } = this._mentionState;
    const pos = inputEl.selectionStart || 0;
    const before = inputEl.value.slice(0, atIdx);
    const after = inputEl.value.slice(pos);
    const inserted = `@${name} `;
    inputEl.value = before + inserted + after;
    const newPos = atIdx + inserted.length;
    inputEl.selectionStart = inputEl.selectionEnd = newPos;
    inputEl.focus();
    this.closeMentionDropdown();
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  },

  handleMentionKey(e) {
    const dropdown = document.getElementById('mention-dropdown');
    if (!dropdown || dropdown.classList.contains('hidden')) return;

    if (e.key === 'Escape') { this.closeMentionDropdown(); e.preventDefault(); return; }

    if (e.key === 'Enter' || e.key === 'Tab') {
      const active = dropdown.querySelector('.mention-option.active');
      if (active) {
        e.preventDefault();
        this.applyMention(active.dataset.name);
      }
      return;
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const options = Array.from(dropdown.querySelectorAll('.mention-option'));
      if (options.length === 0) return;
      let activeIdx = options.findIndex(o => o.classList.contains('active'));
      if (activeIdx === -1) activeIdx = 0;
      if (e.key === 'ArrowDown') activeIdx = (activeIdx + 1) % options.length;
      else activeIdx = (activeIdx - 1 + options.length) % options.length;
      options.forEach((o, i) => o.classList.toggle('active', i === activeIdx));
    }
  },

  escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  },

  escapeAttr(s) { return String(s).replace(/"/g, '&quot;'); },

  // ===== Modals =====

  openModal(id) { document.getElementById(id).classList.remove('hidden'); },
  closeModal(id) { document.getElementById(id).classList.add('hidden'); },

  // ===== Payer (多付款人) =====

  renderPayerRows(payers) {
    const el = document.getElementById('payer-rows');
    if (!el) return;
    el.innerHTML = payers.map((p, i) => this._payerRowHTML(p, i)).join('');
  },

  _payerRowHTML(payer, idx) {
    const members = Trips.getMembers();
    const memberOptions = members.map(m =>
      `<option value="${this.escapeAttr(m)}" ${m === payer.email ? 'selected' : ''}>${this.nameOf(m)}</option>`
    ).join('');
    const amountVal = (payer.amount !== '' && payer.amount !== null && payer.amount !== undefined) ? payer.amount : '';
    return `
      <div class="payer-row">
        <select class="payer-email">${memberOptions}</select>
        <input type="number" class="payer-amount" placeholder="${idx === 0 ? '= 總額' : '金額'}" value="${amountVal}" step="0.01" min="0" inputmode="decimal">
        ${idx > 0 ? '<button type="button" class="remove-payer" aria-label="刪除">×</button>' : ''}
      </div>
    `;
  },

  addPayerRow() {
    const el = document.getElementById('payer-rows');
    const idx = el.querySelectorAll('.payer-row').length;
    const div = document.createElement('div');
    div.innerHTML = this._payerRowHTML({ email: Auth.user.email, amount: '' }, idx);
    el.appendChild(div.firstElementChild);
    this.updatePayerPreview();
  },

  updatePayerPreview() {
    const form = document.getElementById('expense-form');
    if (!form) return;
    const totalAmount = parseFloat(form.elements['amount'].value) || 0;
    const rows = Array.from(document.querySelectorAll('#payer-rows .payer-row'));
    let sumExplicit = 0;
    let emptyRowFirst = null;
    rows.forEach(r => {
      const inp = r.querySelector('.payer-amount');
      const v = parseFloat(inp.value);
      if (!isNaN(v) && inp.value !== '') sumExplicit += v;
      else if (!emptyRowFirst) emptyRowFirst = r;
    });
    if (emptyRowFirst) {
      const remainder = Math.round((totalAmount - sumExplicit) * 100) / 100;
      const inp = emptyRowFirst.querySelector('.payer-amount');
      inp.placeholder = remainder > 0 ? `= ${remainder.toLocaleString()}` : '0';
    }
    const summary = document.getElementById('payer-summary');
    if (summary) {
      if (totalAmount === 0) { summary.textContent = ''; summary.classList.remove('error'); }
      else if (!emptyRowFirst && Math.abs(sumExplicit - totalAmount) > 0.01) {
        summary.textContent = `⚠️ 付款人合計 ${sumExplicit} ≠ 總額 ${totalAmount}`;
        summary.classList.add('error');
      } else {
        summary.textContent = `付款人合計 ${(sumExplicit + (emptyRowFirst ? totalAmount - sumExplicit : 0)).toLocaleString()} / ${totalAmount.toLocaleString()} ✓`;
        summary.classList.remove('error');
      }
    }
  },

  openExpenseModal(id = null) {
    const form = document.getElementById('expense-form');
    form.reset();
    this._editingExpenseId = id;
    this._expenseUnlockedFromSettled = false;  // reset flag
    const headerTitle = document.querySelector('#modal-expense .modal-header h2');
    headerTitle.textContent = id ? '編輯支出' : '新增支出';
    const members = Trips.getMembers();
    if (members.length === 0) { this.toast('當前 trip 沒有成員，請先編輯 trip'); return; }
    form.elements['date'].value = new Date().toISOString().slice(0, 10);

    // 預設付款人（自己，空白會自動 = 總額）
    let initialPayers = [{ email: Auth.user.email, amount: '' }];

    // splits rows
    const rowsEl = document.getElementById('split-rows');
    rowsEl.innerHTML = members.map((m, idx) => `
      <div class="split-row">
        <input type="checkbox" id="split-${idx}" data-email="${this.escapeAttr(m)}" checked>
        <label for="split-${idx}">${this.nameOf(m)}</label>
        <input type="number" placeholder="自動均分" data-share-email="${this.escapeAttr(m)}" step="0.01" min="0" inputmode="decimal">
      </div>
    `).join('');

    if (id) {
      const e = Expenses.list.find(x => x.id === id);
      if (!e) { this.toast('找不到該支出'); return; }
      form.elements['date'].value = e.date;
      form.elements['amount'].value = e.amount;
      form.elements['currency'].value = e.currency;
      const catSelect = form.elements['category'];
      const catOption = Array.from(catSelect.options).find(o => o.value === e.category);
      if (catOption) catSelect.value = e.category;
      form.elements['description'].value = e.description;

      // Parse payers
      let parsedPayers;
      try { parsedPayers = JSON.parse(e.payers || '[]'); } catch {}
      if (Array.isArray(parsedPayers) && parsedPayers.length > 0) {
        initialPayers = parsedPayers.map(p => ({ email: p.email, amount: p.amount }));
      } else {
        initialPayers = [{ email: e.payer, amount: parseFloat(e.amount) }];
      }

      // Parse splits
      try {
        const splits = JSON.parse(e.splits);
        const splitMap = {};
        splits.forEach(s => { splitMap[s.email] = s; });
        members.forEach((m, idx) => {
          const cb = document.getElementById(`split-${idx}`);
          const amtInput = rowsEl.querySelector(`[data-share-email="${this.escapeAttr(m)}"]`);
          if (splitMap[m]) {
            cb.checked = true;
            if (splitMap[m].share !== undefined) {
              const share = parseFloat(splitMap[m].share);
              // 負值或 0 視為空白（修舊 bug 的爛資料；submit 時會自動均分重算）
              if (share > 0) amtInput.value = share;
            } else if (splitMap[m].ratio !== undefined) {
              const totalRatio = splits.reduce((s, x) => s + (parseFloat(x.ratio) || 0), 0);
              if (totalRatio > 0) {
                const share = parseFloat(e.amount) * (parseFloat(splitMap[m].ratio) || 0) / totalRatio;
                if (share > 0) amtInput.value = Math.round(share * 100) / 100;
              }
            }
          } else cb.checked = false;
        });
      } catch (err) { console.warn('Failed to parse splits', err); }
    }

    this.renderPayerRows(initialPayers);
    this.updateSplitPreview();
    this.updatePayerPreview();
    // 已結清的鎖定（編輯模式才需要 check）
    let lockState = 'normal';
    if (id) {
      const e = Expenses.list.find(x => x.id === id);
      if (e && String(e.settled).toUpperCase() === 'TRUE') lockState = 'locked';
    }
    this._toggleExpenseFormLock(lockState);
    this.openModal('modal-expense');
  },

  // state: 'normal' / 'locked' / 'unlocked-from-settled'
  _toggleExpenseFormLock(state) {
    const form = document.getElementById('expense-form');
    const banner = document.getElementById('expense-lock-banner');
    const unlockBtn = document.getElementById('expense-unlock-btn');
    const relockBtn = document.getElementById('expense-relock-btn');
    const submitBtn = form.querySelector('[type="submit"]');

    const isLocked = state === 'locked';

    // 鎖/解鎖所有 inputs/selects/textareas
    form.querySelectorAll('input, select, textarea').forEach(el => { el.disabled = isLocked; });
    const addPayerBtn = document.getElementById('add-payer-btn');
    if (addPayerBtn) addPayerBtn.disabled = isLocked;
    form.querySelectorAll('.remove-payer').forEach(b => b.disabled = isLocked);

    if (submitBtn) submitBtn.style.display = isLocked ? 'none' : '';

    if (banner) {
      banner.classList.remove('unlocked');
      if (state === 'normal') {
        banner.classList.add('hidden');
      } else if (state === 'locked') {
        banner.classList.remove('hidden');
        banner.textContent = '🔒 這筆已結清，僅檢視。按「✏️ 解鎖修改」可改（會變回未結清）';
      } else if (state === 'unlocked-from-settled') {
        banner.classList.remove('hidden');
        banner.classList.add('unlocked');
        banner.textContent = '⚠️ 已解鎖修改中（儲存後變回未結清）。想取消？按「🔒 取消修改」恢復鎖定';
      }
    }

    if (unlockBtn) unlockBtn.classList.toggle('hidden', state !== 'locked');
    if (relockBtn) relockBtn.classList.toggle('hidden', state !== 'unlocked-from-settled');
  },

  unlockExpense() {
    if (!confirm('這筆已結清。\n\n確定要修改嗎？修改後會自動變回「未結清」狀態，重新算入結算。')) return;
    this._expenseUnlockedFromSettled = true;
    this._toggleExpenseFormLock('unlocked-from-settled');
    this.toast('已解鎖，可修改（或按「🔒 取消修改」恢復鎖定）');
  },

  // 解鎖後反悔，恢復鎖定狀態（不改 sheet，只改 UI 跟 flag）
  relockExpense() {
    this._expenseUnlockedFromSettled = false;
    this._toggleExpenseFormLock('locked');
    this.toast('🔒 已恢復鎖定');
  },

  updateSplitPreview() {
    const form = document.getElementById('expense-form');
    const totalAmount = parseFloat(form.elements['amount'].value) || 0;
    const rowsEl = document.getElementById('split-rows');
    if (!rowsEl) return;
    const rows = Array.from(rowsEl.querySelectorAll('.split-row'));
    const checkedRows = rows.filter(r => r.querySelector('input[type="checkbox"]').checked);
    let filledTotal = 0;
    let emptyCount = 0;
    checkedRows.forEach(r => {
      const amtInput = r.querySelector('input[type="number"]');
      const val = parseFloat(amtInput.value);
      if (!isNaN(val) && amtInput.value !== '') filledTotal += val;
      else emptyCount++;
    });
    const remaining = totalAmount - filledTotal;
    const perEmpty = emptyCount > 0 ? remaining / emptyCount : 0;
    checkedRows.forEach(r => {
      const amtInput = r.querySelector('input[type="number"]');
      if (amtInput.value === '' || isNaN(parseFloat(amtInput.value))) {
        amtInput.placeholder = totalAmount > 0 ? `均分 ${(Math.round(perEmpty * 100) / 100).toLocaleString()}` : '自動均分';
      }
    });
    rows.filter(r => !r.querySelector('input[type="checkbox"]').checked).forEach(r => {
      const inp = r.querySelector('input[type="number"]');
      inp.value = '';
      inp.placeholder = '不分';
    });
    const summary = document.getElementById('split-summary');
    if (summary) {
      const computedTotal = filledTotal + (emptyCount * perEmpty);
      const diff = Math.abs(computedTotal - totalAmount);
      if (totalAmount === 0) { summary.textContent = ''; summary.classList.remove('error'); }
      else if (checkedRows.length === 0) { summary.textContent = '⚠️ 請至少勾一個分帳人'; summary.classList.add('error'); }
      else if (emptyCount === 0 && diff > 0.01) { summary.textContent = `⚠️ 已填 ${filledTotal.toLocaleString()}，總額 ${totalAmount.toLocaleString()}（差 ${(totalAmount - filledTotal).toLocaleString()}）`; summary.classList.add('error'); }
      else if (remaining < -0.01) { summary.textContent = `⚠️ 已填超過總額`; summary.classList.add('error'); }
      else { summary.textContent = `合計 ${computedTotal.toLocaleString()} / ${totalAmount.toLocaleString()} ✓`; summary.classList.remove('error'); }
    }
  },

  async openDiaryModal(id = null) {
    const form = document.getElementById('diary-form');
    form.reset();
    this._editingDiaryId = id;
    this._selectedPlace = null;
    document.querySelector('#modal-diary .modal-header h2').textContent = id ? '編輯日記' : '新增日記';
    form.elements['date'].value = new Date().toISOString().slice(0, 10);
    const photosLabel = form.querySelector('input[name="photos"]').closest('label');
    photosLabel.style.display = id ? 'none' : '';
    const locInput = form.elements['location'];
    try {
      await Maps.load();
      if (!locInput.dataset.acAttached) {
        Maps.attachAutocomplete(locInput, (place) => { this._selectedPlace = place; });
        locInput.dataset.acAttached = '1';
      }
    } catch (err) { console.warn('Places autocomplete 未啟用：', err.message); }

    // v1.7.5: 取消 chip 列，改用 @autocomplete dropdown
    if (id) {
      const d = Diaries.list.find(x => x.id === id);
      if (!d) { this.toast('找不到該日記'); return; }
      form.elements['date'].value = d.date;
      form.elements['mood'].value = d.mood;
      form.elements['content'].value = d.content;
      let locDisplay = d.location || '';
      if (locDisplay.startsWith('{')) {
        try { const info = JSON.parse(locDisplay); locDisplay = info.name || info.address || ''; } catch {}
      }
      form.elements['location'].value = locDisplay;
    }
    this.openModal('modal-diary');
  },

  openTripsModal() {
    const el = document.getElementById('trip-list');
    if (Trips.list.length === 0) el.innerHTML = '<div class="list-empty">還沒有任何 trip</div>';
    else {
      el.innerHTML = Trips.list.map(t => `
        <div class="trip-item ${Trips.current && t.trip_id === Trips.current.trip_id ? 'current' : ''}">
          <div class="trip-select" data-action="select-trip" data-trip-id="${this.escapeAttr(t.trip_id)}">
            <div><strong>${this.escapeHtml(t.name)}</strong></div>
            <div class="dates">${t.start_date} ~ ${t.end_date}</div>
          </div>
          <button data-action="edit-trip" data-trip-id="${this.escapeAttr(t.trip_id)}" type="button" title="編輯成員/日期" class="trip-edit-btn">✏️</button>
          <button data-action="delete-trip" data-trip-id="${this.escapeAttr(t.trip_id)}" type="button" title="刪除整個 trip" class="trip-delete-btn">🗑</button>
        </div>
      `).join('');
    }
    this.openModal('modal-trips');
  },

  renderTripMemberCheckboxes(existingMembers) {
    const el = document.getElementById('new-trip-members');
    if (!el) return;
    el.innerHTML = Members.all().map((m, i) => {
      const checked = (existingMembers.length === 0 || existingMembers.includes(m.email)) ? 'checked' : '';
      return `
        <div class="member-check-row">
          <input type="checkbox" id="ntmem-${i}" value="${this.escapeAttr(m.email)}" ${checked}>
          <label for="ntmem-${i}">${this.escapeHtml(this.nameOf(m.email))}</label>
        </div>
      `;
    }).join('');
  },

  openNewTripModal() {
    const form = document.getElementById('new-trip-form');
    form.reset();
    this._editingTripId = null;
    form.elements['trip_id'].disabled = false;
    form.elements['start_date'].value = new Date().toISOString().slice(0, 10);
    delete form.elements['trip_id'].dataset.touched;
    this.renderTripMemberCheckboxes([]);
    document.querySelector('#modal-new-trip .modal-header h2').textContent = '新增 Trip';
    document.querySelector('#modal-new-trip [type="submit"]').textContent = '建立';
    this.openModal('modal-new-trip');
  },

  openEditTripModal(tripId) {
    const t = Trips.list.find(x => x.trip_id === tripId);
    if (!t) { this.toast('找不到該 trip'); return; }
    const form = document.getElementById('new-trip-form');
    form.reset();
    this._editingTripId = tripId;
    form.elements['trip_id'].value = t.trip_id;
    form.elements['trip_id'].disabled = true;
    form.elements['name'].value = t.name;
    form.elements['start_date'].value = t.start_date;
    form.elements['end_date'].value = t.end_date;
    try {
      const members = JSON.parse(t.members || '[]');
      this.renderTripMemberCheckboxes(Array.isArray(members) ? members : []);
    } catch { this.renderTripMemberCheckboxes([]); }
    document.querySelector('#modal-new-trip .modal-header h2').textContent = '編輯 Trip';
    document.querySelector('#modal-new-trip [type="submit"]').textContent = '儲存';
    this.openModal('modal-new-trip');
  },

  // 刪除整個 trip（要兩次確認）
  async confirmDeleteTrip(tripId) {
    const trip = Trips.list.find(t => t.trip_id === tripId);
    if (!trip) { this.toast('找不到該 trip'); return; }
    // 統計連帶影響
    const tripExpenses = (typeof Expenses !== 'undefined')
      ? Expenses.allList.filter(e => e.trip_id === tripId) : [];
    const tripDiaries = (typeof Diaries !== 'undefined')
      ? Diaries.allList.filter(d => d.trip_id === tripId) : [];
    const tripItineraries = (typeof Itineraries !== 'undefined')
      ? Itineraries.allList.filter(i => i.trip_id === tripId) : [];
    const stats = `📊 ${trip.name} (${trip.start_date} ~ ${trip.end_date})\n` +
      `  • ${tripExpenses.length} 筆記帳\n` +
      `  • ${tripDiaries.length} 篇日記\n` +
      `  • ${tripItineraries.length} 條行程\n` +
      `  • 留言/通知會連帶清掉\n` +
      `  • 照片仍保留在 Drive`;
    // 第 1 次確認
    if (!confirm(`⚠️ 刪除 trip？\n\n${stats}\n\n(第 1 次確認)`)) return;
    // 第 2 次確認
    if (!confirm(`🚨 最後確認\n\n真的要刪「${trip.name}」嗎？\n\n此操作不可復原。`)) return;
    this.closeModal('modal-trips');
    this.toast('刪除中...請稍候');
    try {
      const counts = await Trips.delete(tripId);
      const total = counts.expenses + counts.diaries + counts.comments + (counts.itineraries || 0) + (counts.settlements || 0) + counts.notifications;
      this.toast(`✅ Trip「${trip.name}」已刪除（連 ${total} 筆相關資料）`, 5000);
      if (Trips.list.length === 0) {
        this.toast('沒有 trip 了，建一個新的吧');
        this.openNewTripModal();
      } else {
        await this.refreshAll();
      }
    } catch (err) {
      console.error('delete trip failed:', err);
      this.toast('刪除失敗：' + (err.message || err), 6000);
    }
  },

  // ===== Form handlers =====

  async handleExpenseSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const submitBtn = form.querySelector('[type="submit"]');
    submitBtn.disabled = true;
    const origText = submitBtn.textContent;
    submitBtn.textContent = '儲存中...';
    try {
      const totalAmount = parseFloat(form.elements['amount'].value) || 0;
      if (totalAmount <= 0) { this.toast('總額要 > 0'); return; }

      // === 收集 payers ===
      const payerRows = Array.from(document.querySelectorAll('#payer-rows .payer-row'));
      if (payerRows.length === 0) { this.toast('需要至少一位付款人'); return; }
      let sumExplicit = 0;
      const payersTmp = [];
      let emptyIdx = -1;
      payerRows.forEach((r, i) => {
        const sel = r.querySelector('.payer-email');
        const inp = r.querySelector('.payer-amount');
        const email = sel.value;
        const v = parseFloat(inp.value);
        if (inp.value !== '' && !isNaN(v) && v > 0) {
          sumExplicit += v;
          payersTmp.push({ email, amount: v });
        } else {
          payersTmp.push({ email, amount: null });
          if (emptyIdx === -1) emptyIdx = i;
        }
      });
      if (emptyIdx >= 0) payersTmp[emptyIdx].amount = Math.round((totalAmount - sumExplicit) * 100) / 100;
      const payers = payersTmp.filter(p => p.amount && p.amount > 0);
      if (payers.length === 0) { this.toast('需要至少一位有效付款人'); return; }
      const payersSum = payers.reduce((s, p) => s + p.amount, 0);
      if (Math.abs(payersSum - totalAmount) > 0.01) {
        this.toast(`付款人合計 ${payersSum} ≠ 總額 ${totalAmount}`);
        return;
      }

      // === 收集 splits ===
      const rowsEl = document.getElementById('split-rows');
      const rows = Array.from(rowsEl.querySelectorAll('.split-row'));
      const checkedRows = rows.filter(r => r.querySelector('input[type="checkbox"]').checked);
      if (checkedRows.length === 0) { this.toast('至少勾一個分帳人'); return; }
      let filledTotal = 0;
      const emptyEmails = [];
      const splits = [];
      checkedRows.forEach(r => {
        const cb = r.querySelector('input[type="checkbox"]');
        const amtInp = r.querySelector('input[type="number"]');
        const email = cb.dataset.email;
        const val = parseFloat(amtInp.value);
        if (!isNaN(val) && amtInp.value !== '' && val > 0) {
          filledTotal += val;
          splits.push({ email, share: Math.round(val * 100) / 100 });
        } else emptyEmails.push(email);
      });
      const remaining = totalAmount - filledTotal;
      if (remaining < -0.01) { this.toast(`分帳已填超過總額`); return; }
      if (emptyEmails.length === 0 && Math.abs(remaining) > 0.01) { this.toast(`分帳合計 ${filledTotal} ≠ 總額 ${totalAmount}`); return; }
      if (emptyEmails.length > 0) {
        const perEmpty = remaining / emptyEmails.length;
        emptyEmails.forEach((email, i) => {
          let share;
          if (i === emptyEmails.length - 1) {
            // 最後一人吸收 rounding diff = 總額 - 其他已 push 的全部
            // (splits 此刻已含 filled rows + 前面 i 個 empty rows)
            const used = splits.reduce((s, x) => s + x.share, 0);
            share = Math.round((totalAmount - used) * 100) / 100;
          } else {
            share = Math.round(perEmpty * 100) / 100;
          }
          splits.push({ email, share });
        });
      }

      const data = {
        date: form.elements['date'].value,
        payer: payers[0].email,
        payers,
        amount: totalAmount,
        currency: form.elements['currency'].value,
        category: form.elements['category'].value,
        description: form.elements['description'].value,
        splits,
      };

      if (this._editingExpenseId) {
        data.resetSettled = !!this._expenseUnlockedFromSettled;
        await Expenses.update(this._editingExpenseId, data);
        this.toast(data.resetSettled ? '✅ 已更新（變回未結清）' : '✅ 已更新支出');
      } else {
        await Expenses.create(data);
        this.toast('✅ 已記錄支出');
      }
      this.closeModal('modal-expense');
      this.renderExpenses();
      this.renderSettlement();
    } catch (err) {
      console.error(err);
      this.toast('儲存失敗：' + err.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = origText;
      this._editingExpenseId = null;
      this._expenseUnlockedFromSettled = false;
    }
  },

  async handleDiarySubmit(e) {
    e.preventDefault();
    const form = e.target;
    const submitBtn = form.querySelector('[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = '處理中...';
    try {
      const files = Array.from(form.elements['photos'].files);
      const content = form.elements['content'].value.trim();
      const data = {
        date: form.elements['date'].value,
        mood: form.elements['mood'].value,
        content,
        location: form.elements['location'].value.trim(),
        place: this._selectedPlace,
        photos: files,
        mentions: this.parseMentions(content),
      };
      if (!data.content) { this.toast('內容不能空白'); return; }
      if (this._editingDiaryId) {
        await Diaries.update(this._editingDiaryId, data);
        this.toast('✅ 已更新日記');
      } else {
        await Diaries.create(data, (cur, total) => { submitBtn.textContent = `上傳照片 ${cur}/${total}...`; });
        this.toast('✅ 已記錄日記' + (files.length ? `（${files.length} 張照片）` : ''));
      }
      this.closeModal('modal-diary');
      this.renderDiaryFilters();
      this.renderDiaries();
      this.updateNotifBadge();
    } catch (err) {
      console.error(err);
      this.toast('儲存失敗：' + err.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '儲存';
      this._editingDiaryId = null;
    }
  },

  async handleNewTripSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const submitBtn = form.querySelector('[type="submit"]');
    submitBtn.disabled = true;
    const origText = submitBtn.textContent;
    submitBtn.textContent = this._editingTripId ? '更新中...' : '建立中...';
    try {
      const members = Array.from(document.querySelectorAll('#new-trip-members input[type="checkbox"]:checked')).map(cb => cb.value);
      if (members.length === 0) { this.toast('至少選一個成員'); return; }
      if (this._editingTripId) {
        await Trips.update(this._editingTripId, {
          name: form.elements['name'].value.trim(),
          start_date: form.elements['start_date'].value,
          end_date: form.elements['end_date'].value,
          members,
        });
        this.closeModal('modal-new-trip');
        this.toast('✅ Trip 已更新');
        await this.refreshAll();
      } else {
        const tripId = form.elements['trip_id'].value.trim().toLowerCase();
        if (!/^[a-z0-9-]+$/.test(tripId)) { this.toast('Trip ID 只能用英文小寫、數字、減號'); return; }
        if (Trips.list.find(t => t.trip_id === tripId)) { this.toast('Trip ID 已存在，換一個'); return; }
        await Trips.create(tripId, form.elements['name'].value.trim(), form.elements['start_date'].value, form.elements['end_date'].value, members);
        this.closeModal('modal-new-trip');
        this.toast('✅ Trip 已建立');
        await this.refreshAll();
      }
    } catch (err) {
      console.error(err);
      this.toast((this._editingTripId ? '更新' : '建立') + '失敗：' + err.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = origText;
      this._editingTripId = null;
      form.elements['trip_id'].disabled = false;
    }
  },

  // ===== Actions =====

  async deleteExpense(id) {
    if (!confirm('確定刪除這筆支出？')) return;
    try { this.toast('刪除中...'); await Expenses.delete(id); this.toast('✅ 已刪除'); this.renderExpenses(); this.renderSettlement(); }
    catch (err) { console.error(err); this.toast('刪除失敗：' + err.message); }
  },

  async deleteDiary(id) {
    if (!confirm('確定刪除這篇日記？（照片不會刪）')) return;
    try { this.toast('刪除中...'); await Diaries.delete(id); this.toast('✅ 已刪除'); this.renderDiaryFilters(); this.renderDiaries(); }
    catch (err) { console.error(err); this.toast('刪除失敗：' + err.message); }
  },

  async togglePin(id) {
    try { const wasPinned = await Diaries.togglePinned(id); this.toast(wasPinned ? '⭐ 已置頂' : '☆ 取消置頂'); this.renderDiaries(); }
    catch (err) { console.error(err); this.toast('操作失敗：' + err.message); }
  },

  async handleImgError(img) {
    if (img.dataset.fallbackTried === '1') return;
    img.dataset.fallbackTried = '1';
    const id = img.dataset.photoId;
    if (!id) return;
    try { img.src = await API.fetchDriveBlobUrl(id); } catch (err) { console.warn('Image fallback failed:', err); }
  },

  // ===== Comments =====

  async submitComment(diaryId, content, inputEl) {
    content = (content || '').trim();
    if (!content) return;
    try {
      const mentions = this.parseMentions(content);
      await Comments.create(diaryId, content, mentions);
      if (inputEl) inputEl.value = '';
      this.refreshDiaryComments(diaryId);
      this.updateNotifBadge();
    } catch (err) { console.error(err); this.toast('留言失敗：' + err.message); }
  },

  async deleteComment(id) {
    if (!confirm('確定刪除這則留言？')) return;
    const c = Comments.list.find(x => x.id === id);
    if (!c) return;
    const diaryId = c.diary_id;
    try { await Comments.delete(id); this.toast('✅ 已刪除留言'); this.refreshDiaryComments(diaryId); }
    catch (err) { console.error(err); this.toast('刪除失敗：' + err.message); }
  },

  refreshDiaryComments(diaryId) {
    const diaryEl = document.querySelector(`.diary-item[data-diary-id="${diaryId}"]`);
    if (!diaryEl) return;
    const section = diaryEl.querySelector('.comments-section');
    if (!section) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = this.renderCommentsSection(diaryId);
    section.replaceWith(wrapper.firstElementChild);
  },

  // ===== Notifications =====

  async openNotifModal() {
    await Notifications.loadAll();
    this.renderNotifList();
    this.openModal('modal-notifications');
  },

  renderNotifList() {
    const el = document.getElementById('notif-list');
    const list = Notifications.getForMe();
    if (list.length === 0) { el.innerHTML = '<div class="list-empty">沒有通知</div>'; return; }
    el.innerHTML = list.slice(0, 50).map(n => {
      const isUnread = Notifications.isUnread(n);
      let typeIcon = '💬';
      let text = '';
      if (n.type === 'mention') { typeIcon = '🏷'; text = `<strong>${this.nameOf(n.from_email)}</strong> 在日記 tag 了你`; }
      else if (n.type === 'comment') { typeIcon = '💬'; text = `<strong>${this.nameOf(n.from_email)}</strong> 在你的日記留言`; }
      else if (n.type === 'comment-mention') { typeIcon = '🏷'; text = `<strong>${this.nameOf(n.from_email)}</strong> 在留言中 tag 了你`; }
      else if (n.type === 'trip-add') {
        const trip = Trips.list.find(t => t.trip_id === n.diary_id);
        typeIcon = '✈️';
        text = `<strong>${this.nameOf(n.from_email)}</strong> 把你加進 trip「${trip ? this.escapeHtml(trip.name) : this.escapeHtml(n.diary_id)}」`;
      }
      else if (n.type === 'expense-split') { typeIcon = '💰'; text = `<strong>${this.nameOf(n.from_email)}</strong> 新增/編輯了支出，你也要分`; }
      else if (n.type === 'expense-settle') { typeIcon = '🏁'; text = `<strong>${this.nameOf(n.from_email)}</strong> 結清了和你有關的支出`; }
      else if (n.type === 'itinerary-add') {
        const itin = (typeof Itineraries !== 'undefined') ? Itineraries.allList.find(x => x.id === n.diary_id) : null;
        typeIcon = '📋';
        text = `<strong>${this.nameOf(n.from_email)}</strong> 規劃了新行程「${itin ? this.escapeHtml(itin.name) : '行程'}」`;
      }
      else if (n.type === 'settlement-claim') {
        const s = (typeof Settlements !== 'undefined') ? Settlements.allList.find(x => x.id === n.diary_id) : null;
        typeIcon = '💳';
        const amt = s ? `${s.currency || 'TWD'} ${parseFloat(s.amount).toLocaleString()}` : '';
        text = `<strong>${this.nameOf(n.from_email)}</strong> 說已給你 ${amt}，請去結算確認`;
      }
      else if (n.type === 'settlement-confirm') {
        const s = (typeof Settlements !== 'undefined') ? Settlements.allList.find(x => x.id === n.diary_id) : null;
        typeIcon = '✅';
        const amt = s ? `${s.currency || 'TWD'} ${parseFloat(s.amount).toLocaleString()}` : '';
        text = `<strong>${this.nameOf(n.from_email)}</strong> 確認收到你的 ${amt}`;
      }
      else if (n.type === 'settlement-reject') {
        typeIcon = '⚠️';
        text = `<strong>${this.nameOf(n.from_email)}</strong> 回報「沒收到你說已付的款」，請確認後再試`;
      }
      else text = '通知';
      return `
        <div class="notif-item ${isUnread ? 'unread' : ''}" data-type="${this.escapeAttr(n.type)}" data-ref-id="${this.escapeAttr(n.diary_id)}">
          <span class="notif-icon">${typeIcon}</span>
          <div class="notif-content">
            <div class="notif-text">${text}</div>
            <small class="notif-time">${this.formatRelativeTime(n.created_at)}</small>
          </div>
        </div>
      `;
    }).join('');
  },

  updateNotifBadge() {
    if (typeof Notifications === 'undefined') return;
    const count = Notifications.unreadCount();
    const badge = document.getElementById('notif-badge');
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.classList.remove('hidden');
    } else badge.classList.add('hidden');
  },

  toast(msg, ms = 3000) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
  },
};

window.addEventListener('DOMContentLoaded', () => App.init());

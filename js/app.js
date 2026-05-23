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
  _diaryFilter: { authors: [], dateFrom: '', dateTo: '' },
  _lightboxPhotos: [],
  _lightboxIndex: 0,
  _mentionState: null,  // { inputEl, atIdx } 當 @ 正在輸入中

  async init() {
    // 還原 dark/light theme（最早做以免閃白）
    const savedTheme = localStorage.getItem('brotrip_theme');
    if (savedTheme) document.documentElement.dataset.theme = savedTheme;

    await Auth.init();
    this.bindUI();
    this.initPullToRefresh();
    this.updateVersionInfo();
    this.updateThemeUI();

    if (Auth.isLoggedIn()) {
      document.getElementById('loading').classList.add('hidden');
      await this.showMainApp();
      return;
    }

    if (Auth.user) {
      try {
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('silent timeout')), 5000));
        await Promise.race([Auth.ensureToken(), timeout]);
        document.getElementById('loading').classList.add('hidden');
        await this.showMainApp();
        return;
      } catch (err) {
        console.warn('Silent re-auth failed:', err);
        Auth.user = null;
      }
    }

    document.getElementById('loading').classList.add('hidden');
    document.getElementById('login-screen').classList.remove('hidden');
  },

  bindUI() {
    document.getElementById('login-btn').addEventListener('click', async () => {
      try {
        await Auth.login();
        await this.showMainApp();
      } catch (err) {
        const msg = err.error_description || err.error || err.message || '請重試';
        this.toast('登入失敗：' + msg);
        console.error('Login error:', err);
      }
    });

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
      const btn = ev.target.closest('#mark-all-settled-btn');
      if (!btn) return;
      if (!confirm('確定把所有未結清支出標為「已結清」？\n\n標記後不再算入結算，但記錄保留可以檢視。')) return;
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
      const delCommentBtn = e.target.closest('[data-action="delete-comment"]');
      const sendBtn = e.target.closest('.comment-send');
      // Note: mention-chip click handler 已移除（v1.7.5 改用 @autocomplete dropdown）
      if (editBtn) { e.stopPropagation(); this.openDiaryModal(editBtn.dataset.id); return; }
      if (delBtn) { e.stopPropagation(); this.deleteDiary(delBtn.dataset.id); return; }
      if (pinBtn) { e.stopPropagation(); this.togglePin(pinBtn.dataset.id); return; }
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
      if (editBtn) {
        e.stopPropagation();
        this.closeModal('modal-trips');
        this.openEditTripModal(editBtn.dataset.tripId);
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
    document.getElementById('filter-clear').addEventListener('click', () => {
      this._diaryFilter = { authors: [], dateFrom: '', dateTo: '' };
      document.querySelectorAll('#filter-authors .filter-chip').forEach(c => c.classList.remove('active'));
      document.getElementById('filter-date-from').value = '';
      document.getElementById('filter-date-to').value = '';
      this.renderDiaries();
      this.updateFilterSummary();
    });

    // Nicknames edit
    document.getElementById('nicknames-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('.btn-edit-nickname');
      if (!btn) return;
      const email = btn.dataset.email;
      const current = Nicknames.get(email);
      const member = CONFIG.ALLOWED_MEMBERS.find(m => m.email === email);
      const targetName = member ? member.name : email;
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
      window.open(`https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/`, '_blank');
    });
    document.getElementById('open-drive-btn').addEventListener('click', () => {
      window.open(`https://drive.google.com/drive/folders/${CONFIG.ROOT_FOLDER_ID}`, '_blank');
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
      const diaryId = item.dataset.diaryId;
      if (diaryId) {
        Notifications.markAllRead();
        this.updateNotifBadge();
        this.closeModal('modal-notifications');
        this.openDiaryFromMap(diaryId);
      }
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
  },

  // 完全重置：清所有 cache + localStorage + SW + logout
  async resetApp() {
    if (!confirm('🚨 完全重置 BroTrip\n\n會清掉：\n• 所有本地快取\n• 登入狀態（要重登）\n• Service Worker\n\n資料在 Google Sheet 不會掉，只是本地 reset。\n\n確定？')) return;
    this.toast('重置中...');
    // SW caches
    if ('caches' in window) {
      try {
        const names = await caches.keys();
        await Promise.all(names.map(n => caches.delete(n)));
      } catch {}
    }
    // Data cache
    if (typeof Cache !== 'undefined') Cache.clear();
    // All brotrip_* localStorage
    try {
      Object.keys(localStorage).forEach(k => {
        if (k.startsWith('brotrip_')) localStorage.removeItem(k);
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

    if (diariesWithCoords.length === 0) {
      mapEl.style.display = 'none';
      emptyEl.classList.remove('hidden');
      return;
    }
    mapEl.style.display = '';
    emptyEl.classList.add('hidden');

    try { await Maps.load(); }
    catch (err) {
      mapEl.innerHTML = `<div class="list-empty">地圖載入失敗：${err.message}</div>`;
      return;
    }

    if (!this._map) {
      this._map = new google.maps.Map(mapEl, {
        zoom: 12,
        center: { lat: diariesWithCoords[0].lat, lng: diariesWithCoords[0].lng },
        mapTypeControl: false, streetViewControl: false, fullscreenControl: false,
      });
    }
    if (this._mapMarkers) this._mapMarkers.forEach(m => m.setMap(null));
    this._mapMarkers = [];

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

  openLightbox(photoIds, startIdx) {
    this._lightboxPhotos = photoIds;
    this._lightboxIndex = startIdx;
    this.showLightboxPhoto();
    document.getElementById('photo-lightbox').showModal();
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

  async showMainApp() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');

    const img = document.getElementById('user-avatar');
    if (Auth.user && Auth.user.picture) { img.src = Auth.user.picture; img.style.display = ''; }
    else img.style.display = 'none';

    // Phase 1: cache 瞬間渲染
    const hasCache = Trips.loadFromCache();
    if (hasCache && Trips.current) {
      Nicknames.loadFromCache();
      Expenses.loadFromCache();
      Diaries.loadFromCache();
      Comments.loadFromCache();
      Notifications.loadFromCache();
      this.renderAll();
      this.updateNotifBadge();
    }

    // Phase 2: 背景同步
    try {
      await this.ensureMemberRegistered();
      await Trips.loadAll();
      if (Trips.list.length === 0) {
        this.toast('還沒有任何 trip，先建一個吧');
        this.openNewTripModal();
        return;
      }
      await this.refreshAll();
    } catch (err) {
      console.error('showMainApp Phase 2 failed:', err);
      const msg = err.message || '未知錯誤';
      if (msg.includes('403') || msg.includes('Forbidden') || msg.includes('permission')) {
        this.toast('⚠️ 你的帳號沒有 Sheet 讀取權限。請聯絡管理員 madeintw80@gmail.com', 8000);
      } else if (msg.includes('404')) {
        this.toast('⚠️ 找不到 BroTrip-Data Sheet。請聯絡管理員', 8000);
      } else {
        this.toast('⚠️ 載入失敗：' + msg.slice(0, 100), 6000);
      }
    }
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
    await Promise.all([
      Expenses.loadAll(), Diaries.loadAll(),
      Nicknames.loadAll(), Comments.loadAll(),
      Notifications.loadAll(),
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

    if (!hasUnsettled) html += '<div style="color:var(--text-light);text-align:center;padding:8px;">✨ 大家都結清了！</div>';
    else {
      for (const currency of currencies) {
        if (result[currency].length === 0) continue;
        result[currency].forEach(t => {
          html += `<div class="settle-row"><span><strong>${this.nameOf(t.from)}</strong> 給 <strong>${this.nameOf(t.to)}</strong></span><span>${currency} ${t.amount.toLocaleString()}</span></div>`;
        });
      }
      html += `<button id="mark-all-settled-btn" type="button" class="btn-primary" style="width:100%;margin-top:10px;">🏁 全部結清（標記 ${unsettledCount} 筆）</button>`;
    }
    el.innerHTML = html;
  },

  nameOf(email) {
    if (!email) return '?';
    if (typeof Nicknames !== 'undefined') {
      const nick = Nicknames.get(email);
      if (nick) return nick;
    }
    if (CONFIG.ALLOWED_MEMBERS) {
      const m = CONFIG.ALLOWED_MEMBERS.find(x => x.email === email);
      if (m) return m.name;
    }
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
    const active = (f.authors.length > 0 ? 1 : 0) + (f.dateFrom ? 1 : 0) + (f.dateTo ? 1 : 0);
    if (active === 0) { el.textContent = ''; return; }
    const filtered = this.applyDiaryFilter(Diaries.list);
    el.textContent = `${active} 個篩選 · 顯示 ${filtered.length}/${Diaries.list.length}`;
  },

  applyDiaryFilter(list) {
    const f = this._diaryFilter;
    return list.filter(d => {
      if (f.authors.length > 0 && !f.authors.includes(d.author)) return false;
      if (f.dateFrom && d.date < f.dateFrom) return false;
      if (f.dateTo && d.date > f.dateTo) return false;
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
      const isFiltered = (this._diaryFilter.authors.length > 0 || this._diaryFilter.dateFrom || this._diaryFilter.dateTo);
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
      const driveLink = d.url ? `<a href="${this.escapeAttr(d.url)}" target="_blank" rel="noopener" class="diary-drive-link" title="開啟 Drive 相簿資料夾">📁</a>` : '';
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
          <input type="text" class="comment-input" placeholder="💬 留言（打「@」跳推薦）..." maxlength="500">
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
    el.innerHTML = CONFIG.ALLOWED_MEMBERS.map((m) => {
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
      const m = CONFIG.ALLOWED_MEMBERS.find(x => x.name === name);
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
      const member = CONFIG.ALLOWED_MEMBERS.find(x => x.name === name);
      if (member) email = member.email;
      if (!email && typeof Nicknames !== 'undefined') {
        for (const e in Nicknames.map) {
          if (Nicknames.map[e].nickname === name) { email = e; break; }
        }
      }
      if (email) {
        // 顯示用 nameOf：暱稱 > ALLOWED_MEMBERS 名字
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
    const matches = CONFIG.ALLOWED_MEMBERS.filter(m => {
      if (!lowerQ) return true;
      const display = this.nameOf(m.email).toLowerCase();
      return display.includes(lowerQ) || m.name.toLowerCase().includes(lowerQ);
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
        </div>
      `).join('');
    }
    this.openModal('modal-trips');
  },

  renderTripMemberCheckboxes(existingMembers) {
    const el = document.getElementById('new-trip-members');
    if (!el) return;
    el.innerHTML = CONFIG.ALLOWED_MEMBERS.map((m, i) => {
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
      else text = '通知';
      return `
        <div class="notif-item ${isUnread ? 'unread' : ''}" data-diary-id="${this.escapeAttr(n.diary_id)}">
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

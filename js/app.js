// BroTrip 主應用：UI router + 事件處理

// Google Maps 動態載入（給 Places Autocomplete 用）
const Maps = {
  loaded: false,
  loadPromise: null,

  load() {
    if (this.loaded) return Promise.resolve();
    if (this.loadPromise) return this.loadPromise;
    if (!CONFIG.MAPS_API_KEY) return Promise.reject(new Error('沒有 MAPS_API_KEY'));

    this.loadPromise = new Promise((resolve, reject) => {
      window.__onGoogleMapsLoaded = () => {
        this.loaded = true;
        resolve();
      };
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

  async init() {
    await Auth.init();
    this.bindUI();
    this.initPullToRefresh();
    this.updateVersionInfo();

    // 1. Token 還在 localStorage 且沒過期 → 直接進主畫面（最常見路徑）
    if (Auth.isLoggedIn()) {
      document.getElementById('loading').classList.add('hidden');
      await this.showMainApp();
      return;
    }

    // 2. 有上次的 user 但 token 過期 → silent re-auth（5 秒超時 fallback）
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

    // 3. 沒登入或 silent 失敗 → 顯示登入畫面
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('login-screen').classList.remove('hidden');
  },

  bindUI() {
    // Login
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

    // Logout
    document.getElementById('logout-btn').addEventListener('click', () => {
      if (confirm('登出？')) {
        Auth.logout();
        location.reload();
      }
    });

    // Tab switch
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });

    // FAB
    document.getElementById('fab').addEventListener('click', () => {
      if (!Trips.current) {
        this.openModal('modal-trips');
        return;
      }
      if (this.currentTab === 'expenses') this.openExpenseModal();
      else if (this.currentTab === 'diaries') this.openDiaryModal();
    });

    // Trip switch
    document.getElementById('trip-switch').addEventListener('click', () => {
      this.openTripsModal();
    });

    // New trip btn
    document.getElementById('new-trip-btn').addEventListener('click', () => {
      this.closeModal('modal-trips');
      this.openNewTripModal();
    });

    // Close modals
    document.querySelectorAll('.modal-close, .btn-cancel').forEach(btn => {
      btn.addEventListener('click', () => {
        const modal = btn.closest('.modal');
        if (modal) modal.classList.add('hidden');
      });
    });

    // Click modal backdrop to close
    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', e => {
        if (e.target === modal) modal.classList.add('hidden');
      });
    });

    // Forms
    document.getElementById('expense-form').addEventListener('submit', e => this.handleExpenseSubmit(e));
    document.getElementById('diary-form').addEventListener('submit', e => this.handleDiarySubmit(e));
    document.getElementById('new-trip-form').addEventListener('submit', e => this.handleNewTripSubmit(e));

    // Photo lightbox
    const lightbox = document.getElementById('photo-lightbox');
    document.getElementById('lightbox-close').addEventListener('click', () => lightbox.close());
    lightbox.addEventListener('click', e => {
      if (e.target === lightbox) lightbox.close();
    });
    // Lightbox image fallback（lh3 失敗 → Drive API blob）
    document.getElementById('lightbox-img').addEventListener('error', async (e) => {
      const li = e.target;
      if (li.dataset.fallbackTried === '1') return;
      li.dataset.fallbackTried = '1';
      const id = li.dataset.photoId;
      if (!id) return;
      try {
        li.src = await API.fetchDriveBlobUrl(id);
      } catch (err) { console.warn(err); }
    });

    // Expense list edit/delete (event delegation)
    document.getElementById('expense-list').addEventListener('click', e => {
      const editBtn = e.target.closest('[data-action="edit-expense"]');
      const delBtn = e.target.closest('[data-action="delete-expense"]');
      if (editBtn) this.openExpenseModal(editBtn.dataset.id);
      else if (delBtn) this.deleteExpense(delBtn.dataset.id);
    });

    // Diary list edit/delete/pin/photo-lightbox (event delegation)
    document.getElementById('diary-list').addEventListener('click', e => {
      const editBtn = e.target.closest('[data-action="edit-diary"]');
      const delBtn = e.target.closest('[data-action="delete-diary"]');
      const pinBtn = e.target.closest('[data-action="pin-diary"]');
      if (editBtn) { e.stopPropagation(); this.openDiaryModal(editBtn.dataset.id); return; }
      if (delBtn) { e.stopPropagation(); this.deleteDiary(delBtn.dataset.id); return; }
      if (pinBtn) { e.stopPropagation(); this.togglePin(pinBtn.dataset.id); return; }
      const img = e.target.closest('.diary-photos img');
      if (img && img.dataset.photoId) {
        const li = document.getElementById('lightbox-img');
        li.dataset.photoId = img.dataset.photoId;
        delete li.dataset.fallbackTried;
        li.src = API.driveImageUrl(img.dataset.photoId, 1600);
        lightbox.showModal();
      }
    });

    // Trip list select / edit (event delegation)
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

    // Settings buttons
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

    // Expense split form realtime calculation
    const expenseForm = document.getElementById('expense-form');
    expenseForm.addEventListener('input', e => {
      if (e.target.matches('[name="amount"], #split-rows input')) {
        this.updateSplitPreview();
      }
    });
    expenseForm.addEventListener('change', e => {
      if (e.target.matches('#split-rows input[type="checkbox"]')) {
        this.updateSplitPreview();
      }
    });
  },

  // ===== Pull to Refresh =====
  initPullToRefresh() {
    const indicator = document.getElementById('pull-indicator');
    if (!indicator) return;
    let startY = 0;
    let pulling = false;
    const threshold = 60;

    document.addEventListener('touchstart', (e) => {
      // 任何 modal 開著就不觸發
      if (document.querySelector('.modal:not(.hidden), dialog[open]')) return;
      if (window.scrollY === 0) {
        startY = e.touches[0].clientY;
        pulling = true;
      }
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!pulling) return;
      const dy = e.touches[0].clientY - startY;
      if (dy > 10 && dy < 150) {
        indicator.classList.add('show');
        const triggered = dy >= threshold;
        indicator.classList.toggle('triggered', triggered);
        indicator.textContent = triggered ? '🔄 放開重新整理' : '⬇︎ 下拉重新整理...';
      } else if (dy <= 0) {
        indicator.classList.remove('show');
      }
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
    setTimeout(() => {
      window.location.href = window.location.pathname + '?t=' + Date.now();
    }, 800);
  },

  // 下拉軟更新：只重抓 Sheet 資料，不清快取、不重載、不會被登出
  async softRefresh(indicator) {
    try {
      if (!Trips.current) {
        await Trips.loadAll();
      } else {
        await this.refreshAll();
      }
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

  async showMainApp() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');

    const img = document.getElementById('user-avatar');
    if (Auth.user && Auth.user.picture) {
      img.src = Auth.user.picture;
      img.style.display = '';
    } else {
      img.style.display = 'none';
    }

    await this.ensureMemberRegistered();
    await Trips.loadAll();

    if (Trips.list.length === 0) {
      this.toast('還沒有任何 trip，先建一個吧');
      this.openNewTripModal();
    } else {
      await this.refreshAll();
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
    } catch (err) {
      console.warn('Member register failed:', err);
    }
  },

  async refreshAll() {
    if (!Trips.current) return;
    document.getElementById('trip-switch').textContent = `📍 ${Trips.current.name}`;
    document.getElementById('trip-dates').textContent =
      `${Trips.current.start_date || ''} ~ ${Trips.current.end_date || ''}`;
    await Promise.all([Expenses.loadAll(), Diaries.loadAll()]);
    this.renderSettlement();
    this.renderExpenses();
    this.renderDiaryFilters();
    this.renderDiaries();
  },

  switchTab(tab) {
    this.currentTab = tab;
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.getElementById('tab-expenses').classList.toggle('hidden', tab !== 'expenses');
    document.getElementById('tab-diaries').classList.toggle('hidden', tab !== 'diaries');
    document.getElementById('tab-map').classList.toggle('hidden', tab !== 'map');
    document.getElementById('tab-settings').classList.toggle('hidden', tab !== 'settings');
    // FAB 只在記帳/日記 tab 顯示
    document.getElementById('fab').style.display = (tab === 'expenses' || tab === 'diaries') ? '' : 'none';
    if (tab === 'map') this.initOrRefreshMap();
  },

  // ===== Renders =====

  renderSettlement() {
    const el = document.getElementById('settlement-content');
    const result = Expenses.settle();
    const currencies = Object.keys(result);
    const hasUnsettled = currencies.some(c => result[c].length > 0);

    // 計算本次 trip 總花費（by currency）
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

    const totalLine = Object.entries(totals)
      .map(([c, v]) => `${c} ${v.toLocaleString()}`)
      .join(' + ');
    let html = `<div style="font-size:13px;color:var(--text-light);margin-bottom:10px;padding-bottom:8px;border-bottom:1px dashed var(--border);">💵 總花費 ${totalLine}</div>`;

    if (!hasUnsettled) {
      html += '<div style="color:var(--text-light);text-align:center;padding:8px;">✨ 大家都結清了！</div>';
    } else {
      for (const currency of currencies) {
        if (result[currency].length === 0) continue;
        result[currency].forEach(t => {
          html += `<div class="settle-row"><span>${this.nameOf(t.from)} → ${this.nameOf(t.to)}</span><span>${currency} ${t.amount.toLocaleString()}</span></div>`;
        });
      }
    }
    el.innerHTML = html;
  },

  nameOf(email) {
    if (!email) return '?';
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
      const isMine = Auth.user && e.payer === Auth.user.email;
      const actions = isMine ? `
        <div class="item-actions">
          <button data-action="edit-expense" data-id="${this.escapeAttr(e.id)}" type="button" title="編輯">✏️</button>
          <button data-action="delete-expense" data-id="${this.escapeAttr(e.id)}" type="button" title="刪除">🗑</button>
        </div>` : '';
      return `
        <div class="list-item">
          <div class="row">
            <span>${this.escapeHtml(e.category || '')} ${this.escapeHtml(e.description || '(無說明)')}</span>
            <span class="expense-amount">${e.currency || 'TWD'} ${amt.toLocaleString()}</span>
          </div>
          <div class="row">
            <div class="meta">${e.date} · 由 ${this.nameOf(e.payer)} 付</div>
            ${actions}
          </div>
        </div>
      `;
    }).join('');
  },

  renderDiaryFilters() {
    const el = document.getElementById('filter-authors');
    if (!el) return;
    // 所有 distinct 作者
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
    if (active === 0) {
      el.textContent = '';
      return;
    }
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

    // 排序：置頂的先，再按 created_at 新到舊
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

      // 解析 location（兼容純文字跟 JSON）
      let locHtml = '';
      if (d.location) {
        let info = null;
        if (d.location.startsWith('{')) {
          try { info = JSON.parse(d.location); } catch {}
        }
        if (info) {
          const name = info.name || info.address || '';
          let link = '';
          if (info.place_id) {
            link = `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(info.place_id)}`;
          } else if (info.lat && info.lng) {
            link = `https://www.google.com/maps/?q=${info.lat},${info.lng}`;
          }
          if (name) {
            locHtml = link
              ? ` · <a href="${link}" target="_blank" rel="noopener">📍 ${this.escapeHtml(name)}</a>`
              : ` · 📍 ${this.escapeHtml(name)}`;
          }
        } else {
          locHtml = ` · 📍 ${this.escapeHtml(d.location)}`;
        }
      }

      const isMine = Auth.user && d.author === Auth.user.email;
      const isPinned = String(d.pinned).toUpperCase() === 'TRUE';
      const actions = `
        <div class="item-actions">
          <button data-action="pin-diary" data-id="${this.escapeAttr(d.id)}" type="button" title="${isPinned ? '取消置頂' : '置頂'}">${isPinned ? '⭐' : '☆'}</button>
          ${isMine ? `
            <button data-action="edit-diary" data-id="${this.escapeAttr(d.id)}" type="button" title="編輯">✏️</button>
            <button data-action="delete-diary" data-id="${this.escapeAttr(d.id)}" type="button" title="刪除">🗑</button>` : ''}
        </div>`;

      return `
        <div class="diary-item ${isPinned ? 'pinned' : ''}">
          <div class="diary-header">
            <div>
              <span class="diary-mood">${this.escapeHtml(d.mood || '')}</span>
              <strong>${this.nameOf(d.author)}</strong>
            </div>
            <div class="diary-meta">${d.date}${locHtml}</div>
          </div>
          <div class="diary-content">${this.escapeHtml(d.content || '')}</div>
          ${photosHtml}
          ${actions}
        </div>
      `;
    }).join('');
  },

  escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  },

  escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;');
  },

  // ===== Modals =====

  openModal(id) { document.getElementById(id).classList.remove('hidden'); },
  closeModal(id) { document.getElementById(id).classList.add('hidden'); },

  openExpenseModal(id = null) {
    const form = document.getElementById('expense-form');
    form.reset();
    this._editingExpenseId = id;

    const headerTitle = document.querySelector('#modal-expense .modal-header h2');
    headerTitle.textContent = id ? '編輯支出' : '新增支出';

    const members = Trips.getMembers();
    if (members.length === 0) {
      this.toast('當前 trip 沒有成員，請先編輯 trip');
      return;
    }

    form.elements['date'].value = new Date().toISOString().slice(0, 10);

    // 付款人 dropdown
    form.elements['payer'].innerHTML = members.map(m =>
      `<option value="${this.escapeAttr(m)}" ${m === Auth.user.email ? 'selected' : ''}>${this.nameOf(m)}</option>`
    ).join('');

    // 分帳 rows（預設全勾、空白）
    const rowsEl = document.getElementById('split-rows');
    rowsEl.innerHTML = members.map((m, idx) => `
      <div class="split-row">
        <input type="checkbox" id="split-${idx}" data-email="${this.escapeAttr(m)}" checked>
        <label for="split-${idx}">${this.nameOf(m)}</label>
        <input type="number" placeholder="自動均分" data-share-email="${this.escapeAttr(m)}" step="0.01" min="0" inputmode="decimal">
      </div>
    `).join('');

    // 編輯模式：填入既有資料
    if (id) {
      const e = Expenses.list.find(x => x.id === id);
      if (!e) { this.toast('找不到該支出'); return; }
      form.elements['date'].value = e.date;
      form.elements['payer'].value = e.payer;
      form.elements['amount'].value = e.amount;
      form.elements['currency'].value = e.currency;
      const catSelect = form.elements['category'];
      const catOption = Array.from(catSelect.options).find(o => o.value === e.category);
      if (catOption) catSelect.value = e.category;
      form.elements['description'].value = e.description;

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
              amtInput.value = splitMap[m].share;
            } else if (splitMap[m].ratio !== undefined) {
              // 舊版 ratio 格式 → 算 share
              const totalRatio = splits.reduce((s, x) => s + (parseFloat(x.ratio) || 0), 0);
              if (totalRatio > 0) {
                const share = parseFloat(e.amount) * (parseFloat(splitMap[m].ratio) || 0) / totalRatio;
                amtInput.value = Math.round(share * 100) / 100;
              }
            }
          } else {
            cb.checked = false;
          }
        });
      } catch (err) {
        console.warn('Failed to parse splits', err);
      }
    }

    this.updateSplitPreview();
    this.openModal('modal-expense');
  },

  // 即時算「未填欄位均分多少」+「合計確認」
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
      if (!isNaN(val) && amtInput.value !== '') {
        filledTotal += val;
      } else {
        emptyCount++;
      }
    });

    const remaining = totalAmount - filledTotal;
    const perEmpty = emptyCount > 0 ? remaining / emptyCount : 0;

    // 更新空欄位的 placeholder
    checkedRows.forEach(r => {
      const amtInput = r.querySelector('input[type="number"]');
      if (amtInput.value === '' || isNaN(parseFloat(amtInput.value))) {
        amtInput.placeholder = totalAmount > 0
          ? `均分 ${(Math.round(perEmpty * 100) / 100).toLocaleString()}`
          : '自動均分';
      }
    });

    // 未勾的人：清空、變 "不分"
    rows.filter(r => !r.querySelector('input[type="checkbox"]').checked).forEach(r => {
      const inp = r.querySelector('input[type="number"]');
      inp.value = '';
      inp.placeholder = '不分';
    });

    // 合計確認
    const summary = document.getElementById('split-summary');
    if (summary) {
      const computedTotal = filledTotal + (emptyCount * perEmpty);
      const diff = Math.abs(computedTotal - totalAmount);
      if (totalAmount === 0) {
        summary.textContent = '';
        summary.classList.remove('error');
      } else if (checkedRows.length === 0) {
        summary.textContent = '⚠️ 請至少勾一個分帳人';
        summary.classList.add('error');
      } else if (emptyCount === 0 && diff > 0.01) {
        summary.textContent = `⚠️ 已填 ${filledTotal.toLocaleString()}，總額 ${totalAmount.toLocaleString()}（差 ${(totalAmount - filledTotal).toLocaleString()}）`;
        summary.classList.add('error');
      } else if (remaining < -0.01) {
        summary.textContent = `⚠️ 已填超過總額`;
        summary.classList.add('error');
      } else {
        summary.textContent = `合計 ${computedTotal.toLocaleString()} / ${totalAmount.toLocaleString()} ✓`;
        summary.classList.remove('error');
      }
    }
  },

  async openDiaryModal(id = null) {
    const form = document.getElementById('diary-form');
    form.reset();
    this._editingDiaryId = id;
    this._selectedPlace = null;

    const headerTitle = document.querySelector('#modal-diary .modal-header h2');
    headerTitle.textContent = id ? '編輯日記' : '新增日記';

    form.elements['date'].value = new Date().toISOString().slice(0, 10);

    // 編輯模式不開啟照片上傳（避免不小心改）
    const photosLabel = form.querySelector('input[name="photos"]').closest('label');
    photosLabel.style.display = id ? 'none' : '';

    // Places Autocomplete
    const locInput = form.elements['location'];
    try {
      await Maps.load();
      if (!locInput.dataset.acAttached) {
        Maps.attachAutocomplete(locInput, (place) => {
          this._selectedPlace = place;
        });
        locInput.dataset.acAttached = '1';
      }
    } catch (err) {
      console.warn('Places autocomplete 未啟用：', err.message);
    }

    // 編輯模式：填既有資料
    if (id) {
      const d = Diaries.list.find(x => x.id === id);
      if (!d) { this.toast('找不到該日記'); return; }
      form.elements['date'].value = d.date;
      form.elements['mood'].value = d.mood;
      form.elements['content'].value = d.content;
      let locDisplay = d.location || '';
      if (locDisplay.startsWith('{')) {
        try {
          const info = JSON.parse(locDisplay);
          locDisplay = info.name || info.address || '';
        } catch {}
      }
      form.elements['location'].value = locDisplay;
    }

    this.openModal('modal-diary');
  },

  openTripsModal() {
    const el = document.getElementById('trip-list');
    if (Trips.list.length === 0) {
      el.innerHTML = '<div class="list-empty">還沒有任何 trip</div>';
    } else {
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

  openNewTripModal() {
    const form = document.getElementById('new-trip-form');
    form.reset();
    this._editingTripId = null;
    form.elements['trip_id'].disabled = false;
    form.elements['start_date'].value = new Date().toISOString().slice(0, 10);
    form.elements['members'].value = Auth.user.email;
    delete form.elements['trip_id'].dataset.touched;
    document.querySelector('#modal-new-trip .modal-header h2').textContent = '新增 Trip';
    document.querySelector('#modal-new-trip [type="submit"]').textContent = '建立';
    this.openModal('modal-new-trip');
  },

  // 編輯既有 trip（reuse new-trip modal）
  openEditTripModal(tripId) {
    const t = Trips.list.find(x => x.trip_id === tripId);
    if (!t) { this.toast('找不到該 trip'); return; }
    const form = document.getElementById('new-trip-form');
    form.reset();
    this._editingTripId = tripId;
    form.elements['trip_id'].value = t.trip_id;
    form.elements['trip_id'].disabled = true;  // ID 不能改
    form.elements['name'].value = t.name;
    form.elements['start_date'].value = t.start_date;
    form.elements['end_date'].value = t.end_date;
    try {
      const members = JSON.parse(t.members || '[]');
      form.elements['members'].value = Array.isArray(members) ? members.join('\n') : '';
    } catch {
      form.elements['members'].value = '';
    }
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
      if (totalAmount <= 0) {
        this.toast('金額要 > 0');
        return;
      }

      // 收集 splits
      const rowsEl = document.getElementById('split-rows');
      const rows = Array.from(rowsEl.querySelectorAll('.split-row'));
      const checkedRows = rows.filter(r => r.querySelector('input[type="checkbox"]').checked);
      if (checkedRows.length === 0) {
        this.toast('至少勾一個分帳人');
        return;
      }

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
        } else {
          emptyEmails.push(email);
        }
      });

      const remaining = totalAmount - filledTotal;
      if (remaining < -0.01) {
        this.toast(`已填超過總額`);
        return;
      }
      if (emptyEmails.length === 0 && Math.abs(remaining) > 0.01) {
        this.toast(`已填合計 ${filledTotal} ≠ 總額 ${totalAmount}`);
        return;
      }

      // 把剩餘金額均分給空欄位的人，最後一人吸收 rounding 差
      if (emptyEmails.length > 0) {
        const perEmpty = remaining / emptyEmails.length;
        emptyEmails.forEach((email, i) => {
          let share;
          if (i === emptyEmails.length - 1) {
            const used = splits.reduce((s, x) => s + x.share, 0) + (perEmpty * (emptyEmails.length - 1));
            share = Math.round((totalAmount - used) * 100) / 100;
          } else {
            share = Math.round(perEmpty * 100) / 100;
          }
          splits.push({ email, share });
        });
      }

      const data = {
        date: form.elements['date'].value,
        payer: form.elements['payer'].value,
        amount: totalAmount,
        currency: form.elements['currency'].value,
        category: form.elements['category'].value,
        description: form.elements['description'].value,
        splits,
      };

      if (this._editingExpenseId) {
        await Expenses.update(this._editingExpenseId, data);
        this.toast('✅ 已更新支出');
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
      const data = {
        date: form.elements['date'].value,
        mood: form.elements['mood'].value,
        content: form.elements['content'].value.trim(),
        location: form.elements['location'].value.trim(),
        place: this._selectedPlace,
        photos: files,
      };
      if (!data.content) {
        this.toast('內容不能空白');
        return;
      }

      if (this._editingDiaryId) {
        await Diaries.update(this._editingDiaryId, data);
        this.toast('✅ 已更新日記');
      } else {
        await Diaries.create(data, (cur, total) => {
          submitBtn.textContent = `上傳照片 ${cur}/${total}...`;
        });
        this.toast('✅ 已記錄日記' + (files.length ? `（${files.length} 張照片）` : ''));
      }
      this.closeModal('modal-diary');
      this.renderDiaryFilters();
      this.renderDiaries();
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
      const members = form.elements['members'].value
        .split(/[,，\n]/).map(s => s.trim()).filter(s => s);
      if (members.length === 0) {
        this.toast('至少填一個成員 email');
        return;
      }

      if (this._editingTripId) {
        // 編輯模式
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
        // 新增模式
        const tripId = form.elements['trip_id'].value.trim().toLowerCase();
        if (!/^[a-z0-9-]+$/.test(tripId)) {
          this.toast('Trip ID 只能用英文小寫、數字、減號');
          return;
        }
        if (Trips.list.find(t => t.trip_id === tripId)) {
          this.toast('Trip ID 已存在，換一個');
          return;
        }
        await Trips.create(
          tripId,
          form.elements['name'].value.trim(),
          form.elements['start_date'].value,
          form.elements['end_date'].value,
          members,
        );
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

  // ===== Edit / Delete / Pin actions =====

  async deleteExpense(id) {
    if (!confirm('確定刪除這筆支出？')) return;
    try {
      this.toast('刪除中...');
      await Expenses.delete(id);
      this.toast('✅ 已刪除');
      this.renderExpenses();
      this.renderSettlement();
    } catch (err) {
      console.error(err);
      this.toast('刪除失敗：' + err.message);
    }
  },

  async deleteDiary(id) {
    if (!confirm('確定刪除這篇日記？（照片不會刪）')) return;
    try {
      this.toast('刪除中...');
      await Diaries.delete(id);
      this.toast('✅ 已刪除');
      this.renderDiaryFilters();
      this.renderDiaries();
    } catch (err) {
      console.error(err);
      this.toast('刪除失敗：' + err.message);
    }
  },

  async togglePin(id) {
    try {
      const wasPinned = await Diaries.togglePinned(id);
      this.toast(wasPinned ? '⭐ 已置頂' : '☆ 取消置頂');
      this.renderDiaries();
    } catch (err) {
      console.error(err);
      this.toast('操作失敗：' + err.message);
    }
  },

  // 照片 thumbnail 載入失敗時改用 Drive API blob URL
  async handleImgError(img) {
    if (img.dataset.fallbackTried === '1') return;
    img.dataset.fallbackTried = '1';
    const id = img.dataset.photoId;
    if (!id) return;
    try {
      img.src = await API.fetchDriveBlobUrl(id);
    } catch (err) {
      console.warn('Image fallback failed:', err);
    }
  },

  // Trip 地圖：當前 trip 所有有座標的日記點在 Google Map 上
  async initOrRefreshMap() {
    const mapEl = document.getElementById('trip-map');
    const emptyEl = document.getElementById('trip-map-empty');

    const diariesWithCoords = Diaries.list.map(d => {
      if (d.location && d.location.startsWith('{')) {
        try {
          const info = JSON.parse(d.location);
          if (info && info.lat && info.lng) {
            return { ...info, diary: d };
          }
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

    try {
      await Maps.load();
    } catch (err) {
      mapEl.innerHTML = `<div class="list-empty">地圖載入失敗：${err.message}</div>`;
      return;
    }

    if (!this._map) {
      this._map = new google.maps.Map(mapEl, {
        zoom: 12,
        center: { lat: diariesWithCoords[0].lat, lng: diariesWithCoords[0].lng },
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
      });
    }

    if (this._mapMarkers) {
      this._mapMarkers.forEach(m => m.setMap(null));
    }
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
        <div style="max-width:220px; font-family:inherit;">
          <div style="font-weight:600; font-size:14px;">${this.escapeHtml(loc.diary.mood || '')} ${this.escapeHtml(this.nameOf(loc.diary.author))}</div>
          <div style="font-size:12px; color:#6b7280;">${loc.diary.date} · ${this.escapeHtml(loc.name)}</div>
          <div style="margin-top:6px; font-size:13px; white-space:pre-wrap;">${this.escapeHtml((loc.diary.content || '').slice(0, 200))}${(loc.diary.content || '').length > 200 ? '...' : ''}</div>
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

    if (diariesWithCoords.length > 1) {
      this._map.fitBounds(bounds);
    } else {
      this._map.setCenter({ lat: diariesWithCoords[0].lat, lng: diariesWithCoords[0].lng });
      this._map.setZoom(14);
    }
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

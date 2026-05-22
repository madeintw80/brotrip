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

  // 把 Places Autocomplete 綁到 input element
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

  async init() {
    await Auth.init();
    this.bindUI();
    document.getElementById('loading').classList.add('hidden');
    document.getElementById('login-screen').classList.remove('hidden');
  },

  bindUI() {
    // 登入
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

    // 登出
    document.getElementById('logout-btn').addEventListener('click', () => {
      if (confirm('登出？')) {
        Auth.logout();
        location.reload();
      }
    });

    // Tab 切換
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
      else this.openDiaryModal();
    });

    // Trip 切換
    document.getElementById('trip-switch').addEventListener('click', () => {
      this.openTripsModal();
    });

    // 新增 trip
    document.getElementById('new-trip-btn').addEventListener('click', () => {
      this.closeModal('modal-trips');
      this.openNewTripModal();
    });

    // 關閉 modal
    document.querySelectorAll('.modal-close, .btn-cancel').forEach(btn => {
      btn.addEventListener('click', () => {
        const modal = btn.closest('.modal');
        if (modal) modal.classList.add('hidden');
      });
    });

    // 點 modal 背景關閉
    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', e => {
        if (e.target === modal) modal.classList.add('hidden');
      });
    });

    // Forms
    document.getElementById('expense-form').addEventListener('submit', e => this.handleExpenseSubmit(e));
    document.getElementById('diary-form').addEventListener('submit', e => this.handleDiarySubmit(e));
    document.getElementById('new-trip-form').addEventListener('submit', e => this.handleNewTripSubmit(e));

    // Photo lightbox — 點日記照片放大顯示
    const lightbox = document.getElementById('photo-lightbox');
    document.getElementById('diary-list').addEventListener('click', e => {
      const img = e.target.closest('.diary-photos img');
      if (img && img.dataset.photoId) {
        document.getElementById('lightbox-img').src = API.driveImageUrl(img.dataset.photoId, 1600);
        lightbox.showModal();
      }
    });
    document.getElementById('lightbox-close').addEventListener('click', () => lightbox.close());
    lightbox.addEventListener('click', e => {
      if (e.target === lightbox) lightbox.close();
    });

    // Trip ID 自動產生 slug
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
    this.renderDiaries();
  },

  switchTab(tab) {
    this.currentTab = tab;
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.getElementById('tab-expenses').classList.toggle('hidden', tab !== 'expenses');
    document.getElementById('tab-diaries').classList.toggle('hidden', tab !== 'diaries');
  },

  // ===== Render =====

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

    // 總花費摘要
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
      return `
        <div class="list-item">
          <div class="row">
            <span>${this.escapeHtml(e.category || '')} ${this.escapeHtml(e.description || '(無說明)')}</span>
            <span class="expense-amount">${e.currency || 'TWD'} ${amt.toLocaleString()}</span>
          </div>
          <div class="meta">${e.date} · 由 ${this.nameOf(e.payer)} 付</div>
        </div>
      `;
    }).join('');
  },

  renderDiaries() {
    const el = document.getElementById('diary-list');
    if (Diaries.list.length === 0) {
      el.innerHTML = '<div class="list-empty">還沒有日記，點右下角 + 新增</div>';
      return;
    }
    el.innerHTML = Diaries.list.map(d => {
      let photoIds = [];
      try { photoIds = JSON.parse(d.photo_ids || '[]'); } catch {}
      const photosHtml = photoIds.length ? `
        <div class="diary-photos">
          ${photoIds.map(id => `<img src="${API.driveImageUrl(id)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-photo-id="${id}">`).join('')}
        </div>` : '';
      // 解析 location（兼容純文字跟 JSON 兩種格式）
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

      return `
        <div class="diary-item">
          <div class="diary-header">
            <div>
              <span class="diary-mood">${this.escapeHtml(d.mood || '')}</span>
              <strong>${this.nameOf(d.author)}</strong>
            </div>
            <div class="diary-meta">${d.date}${locHtml}</div>
          </div>
          <div class="diary-content">${this.escapeHtml(d.content || '')}</div>
          ${photosHtml}
        </div>
      `;
    }).join('');
  },

  escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  },

  // ===== Modals =====

  openModal(id) { document.getElementById(id).classList.remove('hidden'); },
  closeModal(id) { document.getElementById(id).classList.add('hidden'); },

  openExpenseModal() {
    const form = document.getElementById('expense-form');
    form.reset();
    form.elements['date'].value = new Date().toISOString().slice(0, 10);

    const members = Trips.getMembers();
    if (members.length === 0) {
      this.toast('當前 trip 沒有成員，請先編輯 trip');
      return;
    }

    // 付款人 dropdown
    form.elements['payer'].innerHTML = members.map(m =>
      `<option value="${this.escapeAttr(m)}" ${m === Auth.user.email ? 'selected' : ''}>${this.nameOf(m)}</option>`
    ).join('');

    // 分帳人 checkboxes（預設全選）+ 比例 inputs
    const checksEl = document.getElementById('split-checkboxes');
    checksEl.innerHTML = members.map((m, idx) => `
      <div class="checkbox-row">
        <input type="checkbox" id="split-${idx}" name="split" value="${this.escapeAttr(m)}" checked>
        <label for="split-${idx}">${this.nameOf(m)}</label>
      </div>
    `).join('');

    const ratiosEl = document.getElementById('split-ratios');
    ratiosEl.innerHTML = members.map((m, idx) => `
      <div class="checkbox-row">
        <label for="ratio-${idx}" style="flex:1;">${this.nameOf(m)}</label>
        <input type="number" id="ratio-${idx}" data-email="${this.escapeAttr(m)}" value="1" min="0" step="0.5">
      </div>
    `).join('');

    this.openModal('modal-expense');
  },

  async openDiaryModal() {
    const form = document.getElementById('diary-form');
    form.reset();
    form.elements['date'].value = new Date().toISOString().slice(0, 10);
    this._selectedPlace = null;

    // 嘗試啟用 Google Places Autocomplete（沒 API key 會 fallback 純文字輸入）
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

    this.openModal('modal-diary');
  },

  openTripsModal() {
    const el = document.getElementById('trip-list');
    if (Trips.list.length === 0) {
      el.innerHTML = '<div class="list-empty">還沒有任何 trip</div>';
    } else {
      el.innerHTML = Trips.list.map(t => `
        <div class="trip-item ${Trips.current && t.trip_id === Trips.current.trip_id ? 'current' : ''}" data-trip-id="${this.escapeAttr(t.trip_id)}">
          <div>
            <div><strong>${this.escapeHtml(t.name)}</strong></div>
            <div class="dates">${t.start_date} ~ ${t.end_date}</div>
          </div>
          <span>→</span>
        </div>
      `).join('');
      el.querySelectorAll('.trip-item').forEach(item => {
        item.addEventListener('click', async () => {
          Trips.setCurrent(item.dataset.tripId);
          this.closeModal('modal-trips');
          await this.refreshAll();
        });
      });
    }
    this.openModal('modal-trips');
  },

  openNewTripModal() {
    const form = document.getElementById('new-trip-form');
    form.reset();
    form.elements['start_date'].value = new Date().toISOString().slice(0, 10);
    // 預填自己 email
    form.elements['members'].value = Auth.user.email;
    delete form.elements['trip_id'].dataset.touched;
    this.openModal('modal-new-trip');
  },

  escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;');
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
      const checked = Array.from(form.querySelectorAll('input[name="split"]:checked')).map(i => i.value);
      if (checked.length === 0) {
        this.toast('至少選一個分帳人');
        return;
      }
      // 取 ratio inputs
      const splits = checked.map(email => {
        const ratioInput = form.querySelector(`#split-ratios input[data-email="${email.replace(/"/g, '\\"')}"]`);
        return {
          email,
          ratio: ratioInput ? (parseFloat(ratioInput.value) || 1) : 1,
        };
      });

      const data = {
        date: form.elements['date'].value,
        payer: form.elements['payer'].value,
        amount: parseFloat(form.elements['amount'].value),
        currency: form.elements['currency'].value,
        category: form.elements['category'].value,
        description: form.elements['description'].value,
        splits,
      };
      if (!data.amount || data.amount <= 0) {
        this.toast('金額要 > 0');
        return;
      }

      await Expenses.create(data);
      this.closeModal('modal-expense');
      this.toast('✅ 已記錄支出');
      this.renderExpenses();
      this.renderSettlement();
    } catch (err) {
      console.error(err);
      this.toast('儲存失敗：' + err.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = origText;
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
        place: this._selectedPlace,  // Places Autocomplete 選的地點（含座標）
        photos: files,
      };
      if (!data.content) {
        this.toast('內容不能空白');
        return;
      }

      await Diaries.create(data, (cur, total) => {
        submitBtn.textContent = `上傳照片 ${cur}/${total}...`;
      });
      this.closeModal('modal-diary');
      this.toast('✅ 已記錄日記' + (files.length ? `（${files.length} 張照片）` : ''));
      this.renderDiaries();
    } catch (err) {
      console.error(err);
      this.toast('儲存失敗：' + err.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '儲存';
    }
  },

  async handleNewTripSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const submitBtn = form.querySelector('[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = '建立中...';

    try {
      const members = form.elements['members'].value
        .split(/[,，\n]/).map(s => s.trim()).filter(s => s);
      if (members.length === 0) {
        this.toast('至少填一個成員 email');
        return;
      }
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
    } catch (err) {
      console.error(err);
      this.toast('建立失敗：' + err.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = '建立';
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

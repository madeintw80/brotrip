// Google Identity Services (GIS) OAuth 封裝
// 用 popup mode 拿 access token，不需要 redirect URI
// localStorage 存 access_token + user，下次開 app 1 小時內不用重登
// v3.0.0-M4：移除白名單，任何 Google 帳號可登入（資料隔離靠 Drive ACL + 群組系統）

const Auth = {
  user: null,
  accessToken: null,
  tokenClient: null,
  expiresAt: 0,

  init() {
    return new Promise((resolve) => {
      const wait = () => {
        if (window.google && window.google.accounts && window.google.accounts.oauth2) {
          this.tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CONFIG.CLIENT_ID,
            scope: CONFIG.SCOPES,
            callback: () => {},
          });
          this.restoreSession();
          resolve();
        } else {
          setTimeout(wait, 100);
        }
      };
      wait();
    });
  },

  restoreSession() {
    try {
      const savedUser = localStorage.getItem('brotrip_user');
      if (savedUser) {
        // M4: 不再做白名單檢查，任何登入過的帳號都可恢復 session
        this.user = JSON.parse(savedUser);
      }
      const savedToken = localStorage.getItem('brotrip_token');
      if (savedToken) {
        const { accessToken, expiresAt } = JSON.parse(savedToken);
        if (accessToken && expiresAt > Date.now() + 60000) {
          this.accessToken = accessToken;
          this.expiresAt = expiresAt;
          return true;
        }
      }
    } catch (err) {
      console.warn('restoreSession failed:', err);
    }
    return false;
  },

  saveToken() {
    if (this.accessToken && this.expiresAt) {
      try {
        localStorage.setItem('brotrip_token', JSON.stringify({
          accessToken: this.accessToken,
          expiresAt: this.expiresAt,
        }));
      } catch {}
    }
  },

  // v3.8.1: opts.forceSelectAccount=true → 強制 Google 顯示「帳戶選擇器」
  //   (給「換帳號重登」用 — 登入用錯 Gmail 的朋友救急流程)
  // v3.8.4: resolve 物件多帶 missingScopes (granular consent 朋友可能取消勾選 Drive)
  // v3.9.13: 續登輕量化 — 決定這次要用哪種 prompt，避免「續登每次都跳完整 Drive 授權畫面」
  //   的痛點（iPhone 主畫面 PWA 每小時 token 過期，每次重登都要重新同意超煩）：
  //     - 換帳號           → select_account（要選帳號）
  //     - 已登入過此帳號   → ''（空 prompt，已授權過不用再同意，Google 會走輕量路徑秒回）
  //     - 首次登入         → consent（完整同意，確保拿到 drive + spreadsheets scope）
  //   「已登入過」用 localStorage 的 brotrip_user 判斷（restoreSession 也讀這把）。
  async login(opts = {}) {
    let prompt, allowFallback;
    if (opts.forceSelectAccount) {
      prompt = 'select_account';
      allowFallback = false;
    } else if (localStorage.getItem('brotrip_user')) {
      // 續登：先試輕量空 prompt，萬一拿不到（少數環境）再 fallback 回可靠的 consent
      prompt = '';
      allowFallback = true;
    } else {
      // 首登：一定要 consent，確保 granular consent 拿到 Drive + Sheets 權限
      prompt = 'consent';
      allowFallback = false;
    }
    return this._requestToken(prompt, allowFallback);
  },

  // 實際向 GIS 要 token。prompt 決定授權畫面強度；allowFallback=true 時，
  // 輕量 prompt 拿不到 token 會自動退回 consent（保證不會比舊版更難登入）。
  _requestToken(prompt, allowFallback) {
    return new Promise((resolve, reject) => {
      this.tokenClient.callback = async (resp) => {
        if (resp.error) {
          // 輕量續登失敗（例如環境拿不到 Google session）→ 退回可靠的完整同意流程
          if (allowFallback) {
            this._requestToken('consent', false).then(resolve, reject);
          } else {
            reject(resp);
          }
          return;
        }
        this.accessToken = resp.access_token;
        this.expiresAt = Date.now() + (resp.expires_in * 1000) - 30000;
        this.saveToken();

        // v3.8.4: 檢查 token 是否有 drive + spreadsheets scope
        //   Google granular consent (2022+) 允許用戶個別取消勾選 scope
        //   如果朋友取消勾選 Drive → BroTrip 仍拿到 token 但所有 Drive API 都會 403
        //   → 看起來像「找不到群組」但其實是「沒授權看 Drive」
        const grantedScope = resp.scope || '';
        const requiredScopes = [
          'https://www.googleapis.com/auth/drive',
          'https://www.googleapis.com/auth/spreadsheets',
        ];
        const missingScopes = requiredScopes.filter(s => !grantedScope.includes(s));

        try {
          const userInfo = await this.fetchUserInfo();
          this.user = userInfo;
          localStorage.setItem('brotrip_user', JSON.stringify(this.user));
          resolve({ ...this.user, missingScopes });
        } catch (err) {
          reject(err);
        }
      };
      this.tokenClient.requestAccessToken({ prompt });
    });
  },

  async fetchUserInfo() {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${this.accessToken}` }
    });
    if (!r.ok) throw new Error('userinfo failed');
    return await r.json();
  },

  async ensureToken() {
    if (this.accessToken && Date.now() < this.expiresAt) {
      return this.accessToken;
    }
    // ⭐ v2.0.2 silent refresh 加 retry（iOS PWA 對 GIS popup 不穩，第一次常 fail）
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await this._silentRefresh();
      } catch (err) {
        lastErr = err;
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 1200));
        }
      }
    }
    // v3.9.13: silent refresh 全失敗（iPhone 主畫面 PWA 的常態）→ 廣播事件通知 app
    //   顯示友善的「重新連線」banner。不論是背景載入或使用者按「新增」觸發 ensureToken，
    //   都會走到這裡 → 統一引導續登，而不是各自冒出冷冰冰的錯誤 toast。
    try {
      window.dispatchEvent(new CustomEvent('brotrip:auth-expired'));
    } catch {}
    throw lastErr || new Error('silent refresh failed');
  },

  _silentRefresh() {
    return new Promise((resolve, reject) => {
      this.tokenClient.callback = (resp) => {
        if (resp.error) {
          reject(resp);
          return;
        }
        this.accessToken = resp.access_token;
        this.expiresAt = Date.now() + (resp.expires_in * 1000) - 30000;
        this.saveToken();
        resolve(this.accessToken);
      };
      this.tokenClient.requestAccessToken({ prompt: '' });
    });
  },

  logout() {
    if (this.accessToken) {
      try { google.accounts.oauth2.revoke(this.accessToken, () => {}); } catch {}
    }
    this.accessToken = null;
    this.user = null;
    this.expiresAt = 0;
    localStorage.removeItem('brotrip_user');
    localStorage.removeItem('brotrip_token');
    // v1.8.3: 不再清 data cache。原因：
    //   - 資料屬於 trip 不屬於個人，下個登入的人也是同個 5 人，cache 仍然有用
    //   - 避免「resetApp → logout → 清掉剛改的暱稱」（sheet 還沒 propagate 就丟）
    //   - 真要換帳號 / 清 cache：Chrome 設定清網站資料
  },

  isLoggedIn() {
    return !!this.accessToken && Date.now() < this.expiresAt;
  },
};

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
  async login(opts = {}) {
    return new Promise((resolve, reject) => {
      this.tokenClient.callback = async (resp) => {
        if (resp.error) {
          reject(resp);
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
      const prompt = opts.forceSelectAccount ? 'select_account' : 'consent';
      this.tokenClient.requestAccessToken({ prompt });
    });
  },

  // v3.8.4: 檢查當前 token 是否有必要 scope (給 ensureToken 後 verify 用)
  // 注意：silent refresh 沒辦法重 check，只能拿到 access_token 當時的 scope
  hasRequiredScopes() {
    // 我們不在 access_token 本身存 scope 資訊（GIS API 不直接提供 inspect）
    // 唯一可靠方式是 login() 當下檢查 resp.scope
    // 這 helper 留給未來想做更嚴格 check 用
    return true;
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

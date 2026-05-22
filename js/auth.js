// Google Identity Services (GIS) OAuth 封裝
// 用 popup mode 拿 access token，不需要 redirect URI

const Auth = {
  user: null,         // { email, name, picture }
  accessToken: null,
  tokenClient: null,
  expiresAt: 0,

  // 等 GIS library 載入完成
  init() {
    return new Promise((resolve) => {
      const wait = () => {
        if (window.google && window.google.accounts && window.google.accounts.oauth2) {
          this.tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CONFIG.CLIENT_ID,
            scope: CONFIG.SCOPES,
            callback: () => {},  // 動態覆寫
          });
          resolve();
        } else {
          setTimeout(wait, 100);
        }
      };
      wait();
    });
  },

  // 主動登入（用戶按按鈕觸發）
  async login() {
    return new Promise((resolve, reject) => {
      this.tokenClient.callback = async (resp) => {
        if (resp.error) {
          reject(resp);
          return;
        }
        this.accessToken = resp.access_token;
        // 早 30 秒視為過期（避免邊界 race）
        this.expiresAt = Date.now() + (resp.expires_in * 1000) - 30000;
        try {
          const userInfo = await this.fetchUserInfo();
          this.user = userInfo;
          localStorage.setItem('brotrip_user', JSON.stringify(this.user));
          resolve(this.user);
        } catch (err) {
          reject(err);
        }
      };
      // prompt='consent' 第一次要、之後 silent 用空字串
      this.tokenClient.requestAccessToken({ prompt: 'consent' });
    });
  },

  // 拿用戶基本資料
  async fetchUserInfo() {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${this.accessToken}` }
    });
    if (!r.ok) throw new Error('userinfo failed');
    return await r.json();
  },

  // 確保 token 還沒過期；過期就重新拿（silent）
  async ensureToken() {
    if (this.accessToken && Date.now() < this.expiresAt) {
      return this.accessToken;
    }
    return new Promise((resolve, reject) => {
      this.tokenClient.callback = (resp) => {
        if (resp.error) {
          reject(resp);
          return;
        }
        this.accessToken = resp.access_token;
        this.expiresAt = Date.now() + (resp.expires_in * 1000) - 30000;
        resolve(this.accessToken);
      };
      // 第二次以後用空 prompt（silent）
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
  },

  isLoggedIn() {
    return !!this.accessToken && Date.now() < this.expiresAt;
  },
};

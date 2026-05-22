// Google Identity Services (GIS) OAuth 封裝
// 用 popup mode 拿 access token，不需要 redirect URI
// localStorage 存 access_token + user，下次開 app 1 小時內不用重登

const Auth = {
  user: null,
  accessToken: null,
  tokenClient: null,
  expiresAt: 0,

  // 等 GIS library 載入完成，同時嘗試從 localStorage 恢復 session
  init() {
    return new Promise((resolve) => {
      const wait = () => {
        if (window.google && window.google.accounts && window.google.accounts.oauth2) {
          this.tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CONFIG.CLIENT_ID,
            scope: CONFIG.SCOPES,
            callback: () => {},  // 動態覆寫
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

  // 從 localStorage 還原 user + token（如果還沒過期）
  restoreSession() {
    try {
      const savedUser = localStorage.getItem('brotrip_user');
      if (savedUser) {
        this.user = JSON.parse(savedUser);
      }
      const savedToken = localStorage.getItem('brotrip_token');
      if (savedToken) {
        const { accessToken, expiresAt } = JSON.parse(savedToken);
        // 還有 60 秒以上才算有效（避免邊界 race）
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

  // 把 token 存進 localStorage 給下次 reload 用
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

  // 主動登入（用戶按按鈕觸發）
  async login() {
    return new Promise((resolve, reject) => {
      this.tokenClient.callback = async (resp) => {
        if (resp.error) {
          reject(resp);
          return;
        }
        this.accessToken = resp.access_token;
        this.expiresAt = Date.now() + (resp.expires_in * 1000) - 30000;
        this.saveToken();
        try {
          const userInfo = await this.fetchUserInfo();
          this.user = userInfo;
          localStorage.setItem('brotrip_user', JSON.stringify(this.user));
          resolve(this.user);
        } catch (err) {
          reject(err);
        }
      };
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

  // 確保 token 還沒過期；過期就 silent 重新拿（不需用戶互動，但可能 popup 一閃）
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
  },

  isLoggedIn() {
    return !!this.accessToken && Date.now() < this.expiresAt;
  },
};

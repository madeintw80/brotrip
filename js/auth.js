// Google Identity Services (GIS) OAuth 封裝
// 用 popup mode 拿 access token，不需要 redirect URI
// localStorage 存 access_token + user，下次開 app 1 小時內不用重登
// v1.3.0：加白名單，限 CONFIG.ALLOWED_MEMBERS 5 人

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

  // 檢查 email 是否在白名單
  isAllowed(email) {
    return CONFIG.ALLOWED_MEMBERS && CONFIG.ALLOWED_MEMBERS.some(m => m.email === email);
  },

  restoreSession() {
    try {
      const savedUser = localStorage.getItem('brotrip_user');
      if (savedUser) {
        const u = JSON.parse(savedUser);
        if (this.isAllowed(u.email)) {
          this.user = u;
        } else {
          // 不在白名單，清掉 session
          localStorage.removeItem('brotrip_user');
          localStorage.removeItem('brotrip_token');
          return false;
        }
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
          // 白名單檢查
          if (!this.isAllowed(userInfo.email)) {
            try { google.accounts.oauth2.revoke(this.accessToken, () => {}); } catch {}
            this.accessToken = null;
            this.expiresAt = 0;
            localStorage.removeItem('brotrip_token');
            reject(new Error(`此 app 只限 5 位指定成員使用，你的 email (${userInfo.email}) 不在名單`));
            return;
          }
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
    // 清資料 cache（換帳號就不該看到舊資料）
    if (typeof Cache !== 'undefined') Cache.clear();
  },

  isLoggedIn() {
    return !!this.accessToken && Date.now() < this.expiresAt;
  },
};

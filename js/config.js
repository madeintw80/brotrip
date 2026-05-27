// BroTrip 設定檔
// CLIENT_ID 是 public（OAuth 本來就公開），可 commit 到 GitHub
const CONFIG = {
  VERSION: '3.0.0-M5.0',
  CLIENT_ID: '38081255296-ojiesn8jsdlkrsa5snlue0s3tprro3rq.apps.googleusercontent.com',
  // SHEET_ID / ROOT_FOLDER_ID / PHOTOS_FOLDER_ID 留著供 Phase 1 → Phase 2 auto-migration 用
  // M4.2: 不再被任何 UI / auth 直接讀，純粹給 groups.js 啟動時 migrate 一次
  SHEET_ID: '1vG0BdeLeCwcPlBeoSt5HjB5bgwzUMOPyXRrXJzgOhNE',
  ROOT_FOLDER_ID: '1A9T5NcIcOc6J6PesXZSI67XMgPQVJUcc',
  PHOTOS_FOLDER_ID: '1TA636Zwq4hpCRF21Jke1X_4vMogOknIj',
  SCOPES: 'openid email profile https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets',
  MAPS_API_KEY: 'AIzaSyCABUgvcdGtD3CdD--Nvmn7AYUhn8jbWdQ',
  // Legacy SHEET_TAB_IDS — auto-migration 給 tgl_legacy 群組用
  // 新群組透過 Groups.create() 動態生成自己的 sheetTabIds
  SHEET_TAB_IDS: {
    Trips: 0,
    Expenses: 1198895549,
    Diaries: 516494452,
    Members: 921939877,
    Nicknames: 757362992,
    Comments: 326413720,
    Notifications: 1132460894,
    Itineraries: 1833642077,
    Settlements: 1965782035,
  },
  // M4.2: ALLOWED_MEMBERS 已徹底移除
  //   - 權限改靠 Drive ACL + 邀請碼（Phase 2 設計）
  //   - 成員列表改讀每群組各自的 Members sheet
  //   - 順便解決朋友 email 出現在 public repo 的隱私問題
};

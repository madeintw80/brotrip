// BroTrip 設定檔
// CLIENT_ID 是 public（OAuth 本來就公開），可 commit 到 GitHub
const CONFIG = {
  VERSION: '1.8.8',
  CLIENT_ID: '38081255296-ojiesn8jsdlkrsa5snlue0s3tprro3rq.apps.googleusercontent.com',
  SHEET_ID: '1vG0BdeLeCwcPlBeoSt5HjB5bgwzUMOPyXRrXJzgOhNE',
  ROOT_FOLDER_ID: '1A9T5NcIcOc6J6PesXZSI67XMgPQVJUcc',
  PHOTOS_FOLDER_ID: '1TA636Zwq4hpCRF21Jke1X_4vMogOknIj',
  SCOPES: 'openid email profile https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets',
  MAPS_API_KEY: 'AIzaSyCABUgvcdGtD3CdD--Nvmn7AYUhn8jbWdQ',
  // Sheet tab IDs (給 deleteRow / updateRow 用)
  SHEET_TAB_IDS: {
    Trips: 0,
    Expenses: 1198895549,
    Diaries: 516494452,
    Members: 921939877,
    Nicknames: 757362992,
    Comments: 326413720,
    Notifications: 1132460894,
  },
  // 白名單：只有這 5 人能用，其他 Gmail 登入直接擋
  ALLOWED_MEMBERS: [
    { email: 'madeintw80@gmail.com', name: '魏德睿' },
    { email: 'william19wang@gmail.com', name: '王聖典' },
    { email: 'hungoverture@gmail.com', name: '蔡泓' },
    { email: 'denny41301@gmail.com', name: '陳旻均' },
    { email: 'ssssss30180@gmail.com', name: '李佳霖' },
  ],
};

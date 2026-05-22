// BroTrip 設定檔
// CLIENT_ID 是 public（OAuth 本來就公開），可 commit 到 GitHub
const CONFIG = {
  CLIENT_ID: '38081255296-ojiesn8jsdlkrsa5snlue0s3tprro3rq.apps.googleusercontent.com',
  SHEET_ID: '1vG0BdeLeCwcPlBeoSt5HjB5bgwzUMOPyXRrXJzgOhNE',
  ROOT_FOLDER_ID: '1A9T5NcIcOc6J6PesXZSI67XMgPQVJUcc',
  PHOTOS_FOLDER_ID: '1TA636Zwq4hpCRF21Jke1X_4vMogOknIj',
  SCOPES: 'openid email profile https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets',
  MAPS_API_KEY: '',  // Google Maps API Key — 用戶申請後填這裡，空字串時 fallback 純文字地點
};

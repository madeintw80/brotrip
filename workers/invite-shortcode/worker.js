// BroTrip 邀請碼 backend — Cloudflare Workers
//
// 功能：
//   POST /codes        body: { s, f, n, c }     → 寫 KV，回 { code: '8 字短碼' }
//   GET  /codes/:code                            → 讀 KV，回 { s, f, n, c, created_at }
//   GET  /health                                 → 健康檢查 (回 "ok")
//
// KV binding name: INVITES (在 Workers 設定加綁定)
// KV key format: "code:<short_code>" → JSON string
//
// 安全性：
//   - 不公開 list (只能 code → data，不能 enumerate)
//   - 8 字 base62 → 62^8 = 218 兆組合，brute force 不切實際
//   - 即使有人 brute force 拿到 sheetId/folderId，仍被 Drive ACL 擋，無法 access
//   - CORS 允許 BroTrip 來源 (madeintw80.github.io) + localhost (dev)

const ALLOWED_ORIGINS = [
  'https://madeintw80.github.io',
  'http://localhost:8080',  // dev
  'http://localhost:3000',  // dev
];

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; // 去掉 0/O/1/l/I 易混淆字
const CODE_LENGTH = 8;

function genCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
  }
  return code;
}

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // GET /health — 簡單健康檢查
    if (url.pathname === '/health') {
      return new Response('ok', { status: 200, headers: corsHeaders(origin) });
    }

    // POST /codes — 建立新短碼
    if (request.method === 'POST' && url.pathname === '/codes') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'invalid_json' }, 400, origin);
      }

      // 必要欄位 check
      const { s, f, n, c } = body || {};
      if (!s || !f || !n) {
        return json({ error: 'missing_fields', required: ['s', 'f', 'n'] }, 400, origin);
      }

      // 防 abuse：sheetId / folderId 長度合理性 check (Google IDs 通常 25-50 字)
      if (typeof s !== 'string' || s.length < 20 || s.length > 80) {
        return json({ error: 'invalid_sheet_id' }, 400, origin);
      }
      if (typeof f !== 'string' || f.length < 20 || f.length > 80) {
        return json({ error: 'invalid_folder_id' }, 400, origin);
      }
      if (typeof n !== 'string' || n.length > 100) {
        return json({ error: 'invalid_name' }, 400, origin);
      }

      // 生成短碼 (撞號重試 5 次，理論上不會撞)
      let code;
      for (let attempt = 0; attempt < 5; attempt++) {
        code = genCode();
        const existing = await env.INVITES.get(`code:${code}`);
        if (!existing) break;
        code = null;
      }
      if (!code) {
        return json({ error: 'code_generation_failed' }, 500, origin);
      }

      // 寫 KV (預設永不過期；若想加 TTL: { expirationTtl: 86400 * 365 })
      const payload = {
        s, f, n,
        c: c || '',
        created_at: new Date().toISOString(),
      };
      await env.INVITES.put(`code:${code}`, JSON.stringify(payload));

      return json({ code }, 200, origin);
    }

    // GET /codes/:code — 查短碼
    if (request.method === 'GET' && url.pathname.startsWith('/codes/')) {
      const code = url.pathname.slice('/codes/'.length).trim();
      if (!code || code.length !== CODE_LENGTH) {
        return json({ error: 'invalid_code_format' }, 400, origin);
      }
      const raw = await env.INVITES.get(`code:${code}`);
      if (!raw) {
        return json({ error: 'code_not_found' }, 404, origin);
      }
      try {
        return json(JSON.parse(raw), 200, origin);
      } catch {
        return json({ error: 'corrupted_data' }, 500, origin);
      }
    }

    // 其他路徑
    return json({ error: 'not_found', endpoints: ['POST /codes', 'GET /codes/:code', 'GET /health'] }, 404, origin);
  },
};

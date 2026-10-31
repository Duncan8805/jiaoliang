// 交糧帳 API：App ⇄ 這支 Worker ⇄ TiDB
// POST /login  { password }                      → { token }
// POST /sync   { since, device, push: [...] }    → { results, records, farmers, settings, maxNo, since }
import { connect } from '@tidbcloud/serverless';

const padNo = n => String(n).padStart(6, '0');
const enc = new TextEncoder();
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    if (!cors) return json({ error: '不允許的來源' }, 403);
    if (req.method !== 'POST') return json({ error: 'Not found' }, 404, cors);

    const path = new URL(req.url).pathname;
    try {
      const body = await req.json();
      if (path === '/login') return await login(body, env, cors);
      if (!(await checkToken(req.headers.get('Authorization'), env))) return json({ error: '請重新登入' }, 401, cors);
      if (path === '/sync') return json(await sync(body, env), 200, cors);
      return json({ error: 'Not found' }, 404, cors);
    } catch (e) {
      console.error(e);
      return json({ error: '伺服器錯誤，稍後會自動重試' }, 500, cors);
    }
  },
};

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
  if (!origin || !allowed.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}

// ---------- 登入 ----------
async function hmac(env, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(env.TOKEN_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}
// 長度相同才比、逐字比完，避免從回應時間猜出密碼
function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function login(body, env, cors) {
  const ok = same(await hmac(env, 'pw:' + String(body.password || '')), await hmac(env, 'pw:' + env.APP_PASSWORD));
  if (!ok) {
    await new Promise(r => setTimeout(r, 1000)); // 拖慢亂猜密碼
    return json({ error: '密碼錯誤' }, 401, cors);
  }
  const iat = String(Date.now());
  return json({ token: `${iat}.${await hmac(env, 'tk:' + iat)}` }, 200, cors);
}

// 憑證不會過期；要讓所有裝置登出，就換掉 TOKEN_SECRET
async function checkToken(header, env) {
  const m = /^Bearer (\d+)\.([\w-]+)$/.exec(header || '');
  return !!m && same(m[2], await hmac(env, 'tk:' + m[1]));
}

// ---------- 同步 ----------
// 免費方案每個請求最多 50 次對外連線，每句 SQL 算一次：上傳到預算用完就停，剩下的 App 下一輪再送
const PUSH_BUDGET = 38;

async function sync(body, env) {
  const conn = connect({ url: env.DATABASE_URL });
  let used = 0;
  const db = { execute: (sql, args) => { used++; return conn.execute(sql, args); } };
  // 往回多抓 60 秒：避免漏掉「開始得早、寫完得晚」的資料（重複拉到沒關係，App 會照版本合併）
  const [{ s: since }] = await db.execute("SELECT DATE_FORMAT(NOW(6) - INTERVAL 60 SECOND, '%Y-%m-%d %H:%i:%s.%f') AS s");

  const device = String(body.device || '').slice(0, 64);
  const results = [];
  for (const item of body.push || []) {
    if (used > PUSH_BUDGET - 9) break; // 一張傳票最壞要 9 句（含撞號重試）；沒處理到的不會出現在 results
    if (item.kind === 'record') results.push(await pushRecord(db, item, device));
    else if (item.kind === 'farmer') results.push(await pushFarmer(db, item));
    else if (item.kind === 'settings') results.push(await pushSettings(db, item));
  }

  const prev = body.since || '1970-01-01 00:00:00';
  const records = await db.execute('SELECT id, no, device, data, deleted FROM records WHERE updated_at > ?', [prev]);
  const farmers = await db.execute('SELECT name, data, deleted FROM farmers WHERE updated_at > ?', [prev]);
  const [settings] = await db.execute('SELECT data FROM settings WHERE id = 1 AND updated_at > ?', [prev]);
  const [{ m }] = await db.execute('SELECT COALESCE(MAX(no), 0) AS m FROM records');

  return {
    results,
    records: records.map(r => ({ ...r.data, id: r.id, no: padNo(r.no), device: r.device, deleted: !!r.deleted })),
    farmers: farmers.map(f => ({ ...f.data, name: f.name, deleted: !!f.deleted })),
    settings: settings ? settings.data : null,
    maxNo: Number(m),
    since,
  };
}

const isDup = (e, key) => /Duplicate entry/i.test(e.message) && e.message.includes(key);

// 傳票：已存在就更新內容（單號以雲端為準）；新的就收下它的單號，撞號就改成下一個空號
async function pushRecord(db, item, device) {
  const id = String(item.id);
  const data = { ...item.data };
  delete data.deleted;
  const cols = [data.date || '', data.name || '', data.period || ''];

  for (let attempt = 0; attempt < 3; attempt++) {
    const [row] = await db.execute('SELECT no FROM records WHERE id = ?', [id]);
    if (row) {
      data.no = padNo(row.no);
      await db.execute(
        'UPDATE records SET data = ?, date = ?, name = ?, period = ?, deleted = ?, updated_at = NOW(6) WHERE id = ?',
        [JSON.stringify(data), ...cols, item.deleted ? 1 : 0, id]);
      return { kind: 'record', id, no: data.no };
    }
    if (item.deleted) return { kind: 'record', id, no: null }; // 雲端沒有、本機也刪了，不用處理

    let no = parseInt(item.data.no, 10) || 0;
    if (attempt > 0 || no <= 0) {
      const [{ m }] = await db.execute('SELECT COALESCE(MAX(no), 0) AS m FROM records');
      no = Number(m) + 1;
    }
    data.no = padNo(no);
    try {
      await db.execute(
        'INSERT INTO records (id, no, device, date, name, period, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(6))',
        [id, no, device, ...cols, JSON.stringify(data)]);
      return { kind: 'record', id, no: data.no };
    } catch (e) {
      // 撞號 → 下一輪改用最大號 + 1；同一張同時上傳兩次 → 下一輪走更新
      if (!isDup(e, 'uniq_no') && !isDup(e, 'PRIMARY')) throw e;
    }
  }
  throw new Error('單號分配重試太多次');
}

async function pushFarmer(db, item) {
  const name = String(item.name || '').trim();
  if (!name) return { kind: 'farmer', name, ok: false };
  const data = { ...item.data, name };
  delete data.deleted;
  await db.execute(
    `INSERT INTO farmers (name, data, deleted, updated_at) VALUES (?, ?, ?, NOW(6))
     ON DUPLICATE KEY UPDATE data = VALUES(data), deleted = VALUES(deleted), updated_at = NOW(6)`,
    [name, JSON.stringify(data), item.deleted ? 1 : 0]);
  return { kind: 'farmer', name, ok: true };
}

async function pushSettings(db, item) {
  await db.execute(
    `INSERT INTO settings (id, data, updated_at) VALUES (1, ?, NOW(6))
     ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = NOW(6)`,
    [JSON.stringify(item.data || {})]);
  return { kind: 'settings', ok: true };
}

const http = require('http');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

// ===== НАСТРОЙКИ =====
const PORT          = Number(process.env.PORT) || 3000;
const ADMIN_KEY     = process.env.VOID_ADMIN_KEY || '';
const ADMIN_NICK    = 'Void';                        // единственный админ-аккаунт
const ADMIN_PASS    = process.env.VOID_ADMIN_PASSWORD || '';
const MAX_BODY      = 16 * 1024;        // максимум тела HTTP-запроса
const MAX_TEXT      = 4000;             // максимум длины НЕшифрованного сообщения
const MAX_STICKER   = 128 * 1024;       // картинка-стикер приходит как data:URI
// После E2E сервер не может отличить текст от стикера — всё это шифротекст,
// поэтому лимит общий и с запасом на base64 (+33%)
const MAX_E2E       = 260 * 1024;
const MAX_KEY       = 4 * 1024;         // публичный ключ / зашифрованный приватный
const MAX_KEY_BODY  = 16 * 1024;
const MAX_AVATAR    = 96 * 1024;        // аватар тоже data:URI
const MAX_AVATAR_BODY = 128 * 1024;     // тело запроса с аватаром
const MAX_PAYLOAD   = 512 * 1024;       // максимум размера WS-кадра (шифротекст крупнее)
const MAX_PEERS     = 16;               // максимум участников LAN-комнаты
const MAX_ROOMS     = 500;              // максимум одновременных LAN-комнат
const PING_INTERVAL = 30000;
const PENDING_BUFFER_LIMIT = 2 * 1024 * 1024;  // предел исходящего буфера при догрузке накопленного
const TTL_DELIVERED = 30 * 86400000;    // храним доставленные 30 дней
const TTL_PENDING   = 90 * 86400000;    // храним недоставленные 90 дней

// ===== СОСТОЯНИЕ =====
const rooms  = {};   // LAN сигналинг: roomId -> { peerId: ws }
const online = {};   // Личные чаты: nick -> ws

// ===== БАЗА ДАННЫХ =====
const db = new Database(path.join(__dirname, 'void.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    nick TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_nick TEXT NOT NULL,
    to_nick TEXT NOT NULL,
    text TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    delivered INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_users_nick_nocase ON users(nick COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_messages_inbox    ON messages(to_nick, delivered);
  CREATE INDEX IF NOT EXISTS idx_messages_from     ON messages(from_nick);
  CREATE INDEX IF NOT EXISTS idx_messages_ts       ON messages(timestamp);
`);

// Миграция: у существующих баз этих колонок нет, CREATE TABLE их не добавит
{
  const mcols = db.prepare('PRAGMA table_info(messages)').all().map(c => c.name);
  // Опознаватель сообщения: нужен, чтобы удалять и править его у обеих сторон.
  // Значение случайное и о содержимом ничего не говорит.
  if (!mcols.includes('mid')) db.exec('ALTER TABLE messages ADD COLUMN mid TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_mid ON messages(mid)');

  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!cols.includes('banned'))     db.exec('ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0');
  if (!cols.includes('is_admin'))   db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0');
  if (!cols.includes('banned_at'))  db.exec('ALTER TABLE users ADD COLUMN banned_at INTEGER');
  if (!cols.includes('ban_reason')) db.exec('ALTER TABLE users ADD COLUMN ban_reason TEXT');
  // Аккаунты по сид-фразе: ищем владельца по одной только фразе, без ника
  if (!cols.includes('seed_lookup')) db.exec('ALTER TABLE users ADD COLUMN seed_lookup TEXT');
  // Аватар виден собеседникам, поэтому живёт на сервере, а не только локально
  if (!cols.includes('avatar')) db.exec('ALTER TABLE users ADD COLUMN avatar TEXT');
  // Сквозное шифрование: публичный ключ открыт, приватный лежит зашифрованным
  // паролем владельца — сервер расшифровать его не может
  if (!cols.includes('public_key'))      db.exec('ALTER TABLE users ADD COLUMN public_key TEXT');
  if (!cols.includes('enc_private_key')) db.exec('ALTER TABLE users ADD COLUMN enc_private_key TEXT');
  // Двухфакторная защита: pending — секрет в процессе настройки, secret —
  // подтверждённый и работающий, last — последний использованный шаг времени
  if (!cols.includes('totp_secret'))  db.exec('ALTER TABLE users ADD COLUMN totp_secret TEXT');
  if (!cols.includes('totp_pending')) db.exec('ALTER TABLE users ADD COLUMN totp_pending TEXT');
  if (!cols.includes('totp_last'))    db.exec('ALTER TABLE users ADD COLUMN totp_last INTEGER');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_seed ON users(seed_lookup) WHERE seed_lookup IS NOT NULL');
}

const qUserByNick  = db.prepare('SELECT nick, password_hash, banned, is_admin, ban_reason FROM users WHERE nick = ? COLLATE NOCASE');
const qNickExists  = db.prepare('SELECT nick, banned FROM users WHERE nick = ? COLLATE NOCASE');
const qInsertUser  = db.prepare('INSERT INTO users (nick, password_hash) VALUES (?, ?)');
const qInsertSeed  = db.prepare('INSERT INTO users (nick, password_hash, seed_lookup) VALUES (?, ?, ?)');
const qSetAvatar   = db.prepare('UPDATE users SET avatar = ? WHERE nick = ?');
const qSetKeys     = db.prepare('UPDATE users SET public_key = ?, enc_private_key = ? WHERE nick = ?');
const qGetPubKey   = db.prepare('SELECT nick, public_key FROM users WHERE nick = ? COLLATE NOCASE');
const qGetMyKeys   = db.prepare('SELECT public_key, enc_private_key FROM users WHERE nick = ?');
const qPurgeMsgs   = db.prepare('DELETE FROM messages');
const qGetAvatar   = db.prepare('SELECT nick, avatar FROM users WHERE nick = ? COLLATE NOCASE');
const qUserBySeed  = db.prepare('SELECT nick, password_hash, banned, is_admin, ban_reason FROM users WHERE seed_lookup = ?');
const qUpdateHash  = db.prepare('UPDATE users SET password_hash = ? WHERE nick = ?');
const qSearchUsers = db.prepare("SELECT nick FROM users WHERE nick LIKE ? ESCAPE '\\' ORDER BY nick LIMIT 10");
const qInsertMsg   = db.prepare('INSERT INTO messages (from_nick, to_nick, text, timestamp, delivered, mid) VALUES (?, ?, ?, ?, ?, ?)');
// Править и удалять может только автор — отсюда условие по from_nick
// Сверяем и отправителя, и получателя: иначе запросом «изменить письмо для Kim»
// можно было испортить своё же неотправленное письмо Тому
const qDropByMid   = db.prepare('DELETE FROM messages WHERE mid = ? AND from_nick = ? AND to_nick = ?');
const qEditByMid   = db.prepare('UPDATE messages SET text = ? WHERE mid = ? AND from_nick = ? AND to_nick = ?');
const qMidExists   = db.prepare('SELECT 1 FROM messages WHERE mid = ? LIMIT 1');
const qGetTotp     = db.prepare('SELECT totp_secret, totp_pending, totp_last FROM users WHERE nick = ?');
const qSetPending  = db.prepare('UPDATE users SET totp_pending = ? WHERE nick = ?');
const qEnableTotp  = db.prepare('UPDATE users SET totp_secret = ?, totp_pending = NULL, totp_last = ? WHERE nick = ?');
const qDisableTotp = db.prepare('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_last = NULL WHERE nick = ?');
const qTotpLast    = db.prepare('UPDATE users SET totp_last = ? WHERE nick = ?');
const qPending     = db.prepare('SELECT id, from_nick, text, timestamp, mid FROM messages WHERE to_nick = ? AND delivered = 0 ORDER BY timestamp');
const qMarkOne     = db.prepare('UPDATE messages SET delivered = 1 WHERE id = ?');
// Счётчик сообщений считается одним проходом по таблице. Раньше здесь был
// коррелированный подзапрос с OR — он сканировал messages целиком для КАЖДОГО
// пользователя, и на живой базе список открывался несколько секунд.
const qListUsers   = db.prepare(`
  SELECT u.nick, u.created_at, u.banned, u.is_admin, u.banned_at, u.ban_reason,
         COALESCE(c.cnt, 0) AS messages
  FROM users u
  LEFT JOIN (
    SELECT nick, SUM(cnt) AS cnt FROM (
      SELECT from_nick AS nick, COUNT(*) AS cnt FROM messages GROUP BY from_nick
      UNION ALL
      SELECT to_nick   AS nick, COUNT(*) AS cnt FROM messages GROUP BY to_nick
    ) GROUP BY nick
  ) c ON c.nick = u.nick
  ORDER BY u.is_admin DESC, u.nick COLLATE NOCASE
`);
const qSetBan      = db.prepare('UPDATE users SET banned = ?, banned_at = ?, ban_reason = ? WHERE nick = ?');
const qDeleteUser  = db.prepare('DELETE FROM users WHERE nick = ?');
const qDeleteMsgs  = db.prepare('DELETE FROM messages WHERE from_nick = ? OR to_nick = ?');

// ===== ПАРОЛИ =====
// Новый формат: s2$<salt>$<key> (scrypt). Старый: голый sha256-hex — принимаем
// и прозрачно переводим на scrypt при первом успешном входе.
const LEGACY_HASH_RE = /^[a-f0-9]{64}$/;

function legacyHash(nick, pass) {
  return crypto.createHash('sha256').update(nick + ':' + pass).digest('hex');
}

function scryptHash(pass) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(pass, salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve('s2$' + salt.toString('hex') + '$' + key.toString('hex'));
    });
  });
}

function scryptVerify(pass, stored) {
  return new Promise(resolve => {
    const parts = stored.split('$');
    if (parts.length !== 3) return resolve(false);
    let salt, expected;
    try {
      salt = Buffer.from(parts[1], 'hex');
      expected = Buffer.from(parts[2], 'hex');
    } catch (e) { return resolve(false); }
    crypto.scrypt(pass, salt, expected.length, (err, key) => {
      if (err) return resolve(false);
      resolve(key.length === expected.length && crypto.timingSafeEqual(key, expected));
    });
  });
}

// Возвращает { nick, banned, is_admin } с каноническим ником либо null.
async function verifyUser(nick, password) {
  if (typeof nick !== 'string' || typeof password !== 'string') return null;
  nick = nick.trim();
  if (!nick || !password) return null;

  const row = qUserByNick.get(nick);
  if (!row) {
    // Считаем впустую, чтобы по времени ответа нельзя было перебирать ники.
    await scryptHash(password).catch(() => {});
    return null;
  }
  const info = { nick: row.nick, banned: !!row.banned, is_admin: !!row.is_admin, ban_reason: row.ban_reason || null };

  if (LEGACY_HASH_RE.test(row.password_hash)) {
    const a = Buffer.from(legacyHash(row.nick, password), 'hex');
    const b = Buffer.from(row.password_hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try { qUpdateHash.run(await scryptHash(password), row.nick); }
    catch (e) { console.error('[auth] Не удалось обновить хеш:', e.message); }
    return info;
  }

  return (await scryptVerify(password, row.password_hash)) ? info : null;
}

// ===== ОДНОРАЗОВЫЕ КОДЫ (TOTP, RFC 6238) =====
// Тот самый шестизначный код из Google Authenticator. Считается из общего
// секрета и текущего времени, поэтому приложению не нужен ни интернет,
// ни аккаунт Google.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0, value = 0; const out = [];
  for (const ch of String(str).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

// Код для конкретного 30-секундного шага
function totpCode(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const num = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(num % 1000000).padStart(6, '0');
}

// Принимаем соседние шаги: часы на телефоне и сервере расходятся на секунды.
// Использованный шаг запоминаем, чтобы один код нельзя было применить дважды.
function totpVerify(secret, code, lastStep) {
  const c = String(code || '');
  if (!/^[0-9]{6}$/.test(c)) return null;
  const now = Math.floor(Date.now() / 30000);
  for (let d = -1; d <= 1; d++) {
    const step = now + d;
    if (lastStep != null && step <= lastStep) continue;
    const expected = totpCode(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return step;
  }
  return null;
}

// Ввёл код — получил пропуск на полчаса. Без этого код пришлось бы вводить
// на каждое действие: он одноразовый, повторно тот же не примут.
const ADMIN_SESSION_TTL = 30 * 60 * 1000;
const adminSessions = new Map();   // токен -> { nick, expires }

function newAdminSession(nick) {
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, { nick, expires: Date.now() + ADMIN_SESSION_TTL });
  return token;
}

function checkAdminSession(token, nick) {
  if (typeof token !== 'string' || !token) return false;
  const sess = adminSessions.get(token);
  if (!sess) return false;
  if (sess.nick !== nick || sess.expires < Date.now()) { adminSessions.delete(token); return false; }
  return true;
}

const sessionSweep = setInterval(() => {
  const now = Date.now();
  for (const [t, sess] of adminSessions) if (sess.expires < now) adminSessions.delete(t);
}, 5 * 60 * 1000);
sessionSweep.unref();

// Разрывает живое соединение пользователя — после бана или удаления
// он не должен оставаться подключённым до следующего обрыва.
// note — текст причины, который увидит сам пользователь
function kickUser(nick, reason, note) {
  const ws = online[nick];
  if (!ws) return false;
  try {
    ws.send(JSON.stringify({ type: 'kicked', reason, note: note || null }));
    ws.close(4003, reason);
  } catch (e) {}
  delete online[nick];
  return true;
}

// Провижининг админа. Пароль берём только из окружения — в репозитории
// его быть не должно. Если аккаунт занят обычным пользователем, пересоздаём.
function ensureAdmin() {
  if (!ADMIN_PASS) {
    const row = qUserByNick.get(ADMIN_NICK);
    if (!row || !row.is_admin) {
      console.warn('[admin] VOID_ADMIN_PASSWORD не задан — админ-аккаунт не создан.');
      console.warn('[admin] Задай пароль: pm2 set void-signal:VOID_ADMIN_PASSWORD <пароль>');
    }
    return Promise.resolve();
  }
  if (ADMIN_PASS.length < 12) {
    console.warn('[admin] VOID_ADMIN_PASSWORD короче 12 символов — админ не создан.');
    return Promise.resolve();
  }
  return scryptHash(ADMIN_PASS).then(hash => {
    const existing = qUserByNick.get(ADMIN_NICK);

    // Аккаунт уже наш — только освежаем пароль. Раньше здесь было безусловное
    // удаление, и каждый перезапуск сервера стирал переписку админа, аватар
    // и ключи шифрования: после рестарта ему никто не мог написать.
    if (existing && existing.is_admin) {
      qUpdateHash.run(hash, existing.nick);
      if (existing.banned) qSetBan.run(0, null, null, existing.nick);
      console.log('[admin] Админ-аккаунт', existing.nick, 'на месте, пароль обновлён');
      return;
    }

    // Ник занят обычным пользователем — вот теперь действительно сносим
    if (existing) {
      qDeleteMsgs.run(existing.nick, existing.nick);
      qDeleteUser.run(existing.nick);
      kickUser(existing.nick, 'admin-reset');
      console.log('[admin] Ник', existing.nick, 'был занят обычным аккаунтом — освобождён');
    }
    db.prepare('INSERT INTO users (nick, password_hash, banned, is_admin) VALUES (?, ?, 0, 1)')
      .run(ADMIN_NICK, hash);
    console.log('[admin] Админ-аккаунт', ADMIN_NICK, 'создан');
  }).catch(e => console.error('[admin] Не удалось создать админа:', e.message));
}

function listUsers() {
  return qListUsers.all().map(u => ({
    nick: u.nick,
    banned: !!u.banned,
    admin: !!u.is_admin,
    online: !!online[u.nick],
    messages: u.messages,
    createdAt: u.created_at,
    bannedAt: u.banned_at || null,
    banReason: u.ban_reason || null
  }));
}

// Проверка прав администратора для /api/admin/*.
// Возвращает { ok } либо { reason: 'auth' | 'totp' } — клиенту важно
// различать «неверный пароль» и «нужен код», иначе он не поймёт, что спросить.
async function requireAdmin(body) {
  const u = await verifyUser(body && body.admin, body && body.password);
  if (!u || !u.is_admin || u.banned) return { reason: 'auth' };

  const row = qGetTotp.get(u.nick);
  if (row && row.totp_secret) {
    // Действующий пропуск — код не спрашиваем
    if (checkAdminSession(body && body.session, u.nick)) return { ok: true, user: u };

    const step = totpVerify(row.totp_secret, body && body.code, row.totp_last);
    if (step === null) return { reason: 'totp' };
    qTotpLast.run(step, u.nick);
    return { ok: true, user: u, session: newAdminSession(u.nick) };
  }
  return { ok: true, user: u };
}

// ===== ЛИМИТЫ ЗАПРОСОВ =====
const buckets = new Map();

function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter(t => now - t < windowMs);
  if (hits.length >= limit) { buckets.set(key, hits); return false; }
  hits.push(now);
  buckets.set(key, hits);
  return true;
}

const bucketSweep = setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of buckets) {
    if (!hits.length || now - hits[hits.length - 1] > 3600000) buckets.delete(key);
  }
}, 300000);
bucketSweep.unref();

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function clientIp(req) {
  const peer = req.socket.remoteAddress || '';
  // Заголовку верим ТОЛЬКО если запрос пришёл от nginx с этой же машины.
  // Раньше верили всегда, и любой, кто достучится до порта напрямую в обход
  // nginx, мог подставить произвольный адрес и обойти все ограничения.
  if (LOOPBACK.has(peer)) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string') {
      const parts = xff.split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
  }
  return peer || 'unknown';
}

// ===== HTTP API =====
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch (e) { res.writeHead(400); res.end('{}'); return; }

  const json = (code, data) => {
    if (res.headersSent) return;
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };

  const readBody = (cb, maxBody) => {
    const limit = maxBody || MAX_BODY;
    let body = '', aborted = false;
    req.on('data', c => {
      if (aborted) return;
      body += c;
      if (body.length > limit) {
        aborted = true;
        json(413, { error: 'Слишком большой запрос' });
        req.destroy();
      }
    });
    req.on('end', () => {
      if (aborted) return;
      let data;
      try { data = JSON.parse(body); } catch (e) { return json(400, { error: 'Bad request' }); }
      if (!data || typeof data !== 'object') return json(400, { error: 'Bad request' });
      Promise.resolve()
        .then(() => cb(data))
        .catch(err => { console.error('[http]', err.message); json(500, { error: 'Ошибка сервера' }); });
    });
    req.on('error', () => { aborted = true; });
  };

  // POST /api/register
  if (req.method === 'POST' && url.pathname === '/api/register') {
    if (!rateLimit('reg:' + clientIp(req), 10, 600000)) {
      return json(429, { error: 'Слишком много попыток, подожди' });
    }
    readBody(async (body) => {
      const nick = typeof body.nick === 'string' ? body.nick.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (nick.length < 2 || nick.length > 16 || password.length < 6 || password.length > 200) {
        return json(400, { error: 'Неверные данные' });
      }
      if (!/^[a-zA-Z0-9_]+$/.test(nick)) {
        return json(400, { error: 'Ник: только латиница, цифры и _' });
      }
      if (qNickExists.get(nick)) return json(409, { error: 'Ник уже занят' });
      try {
        qInsertUser.run(nick, await scryptHash(password));
        json(200, { ok: true });
      } catch (e) {
        json(409, { error: 'Ник уже занят' });
      }
    });
    return;
  }

  // POST /api/login
  if (req.method === 'POST' && url.pathname === '/api/login') {
    if (!rateLimit('login:' + clientIp(req), 20, 600000)) {
      return json(429, { error: 'Слишком много попыток, подожди' });
    }
    readBody(async (body) => {
      const u = await verifyUser(body.nick, body.password);
      if (!u) return json(401, { error: 'Неверный ник или пароль' });
      if (u.banned) return json(403, { error: 'Аккаунт заблокирован', reason: u.ban_reason });
      json(200, { ok: true, nick: u.nick, admin: u.is_admin });
    });
    return;
  }

  // ===== ВХОД ПО СИД-ФРАЗЕ =====
  // Клиент никогда не присылает саму фразу — только производный от неё токен.
  // Ключ шифрования переписки выводится из фразы отдельной функцией, поэтому
  // сервер не может его получить.
  if (req.method === 'POST' && url.pathname === '/api/seed/register') {
    if (!rateLimit('reg:' + clientIp(req), 10, 600000)) {
      return json(429, { error: 'Слишком много попыток, подожди' });
    }
    readBody(async (body) => {
      const nick  = typeof body.nick === 'string' ? body.nick.trim() : '';
      const token = typeof body.token === 'string' ? body.token : '';
      if (nick.length < 2 || nick.length > 16) return json(400, { error: 'Неверные данные' });
      if (!/^[a-zA-Z0-9_]+$/.test(nick)) return json(400, { error: 'Ник: только латиница, цифры и _' });
      if (token.length < 32 || token.length > 200) return json(400, { error: 'Неверная сид-фраза' });

      const lookup = crypto.createHash('sha256').update(token).digest('hex');
      if (qUserBySeed.get(lookup)) return json(409, { error: 'Эта сид-фраза уже используется' });
      if (qNickExists.get(nick))   return json(409, { error: 'Ник уже занят' });
      try {
        qInsertSeed.run(nick, await scryptHash(token), lookup);
        json(200, { ok: true, nick });
      } catch (e) {
        json(409, { error: 'Ник уже занят' });
      }
    });
    return;
  }

  // Ник возвращает сервер: по фразе он определяется однозначно,
  // запоминать его пользователю не нужно.
  if (req.method === 'POST' && url.pathname === '/api/seed/login') {
    if (!rateLimit('login:' + clientIp(req), 20, 600000)) {
      return json(429, { error: 'Слишком много попыток, подожди' });
    }
    readBody(async (body) => {
      const token = typeof body.token === 'string' ? body.token : '';
      if (!token) return json(400, { error: 'Неверная сид-фраза' });
      const lookup = crypto.createHash('sha256').update(token).digest('hex');
      const row = qUserBySeed.get(lookup);
      if (!row) return json(404, { error: 'Аккаунт с такой фразой не найден' });
      if (!(await scryptVerify(token, row.password_hash))) {
        return json(401, { error: 'Неверная сид-фраза' });
      }
      if (row.banned) return json(403, { error: 'Аккаунт заблокирован', reason: row.ban_reason || null });
      json(200, { ok: true, nick: row.nick });
    });
    return;
  }

  // ===== КЛЮЧИ СКВОЗНОГО ШИФРОВАНИЯ =====
  // Публичный ключ открыт всем — по нему собеседник шифрует сообщение.
  // Приватный приходит УЖЕ зашифрованным паролем владельца: сервер хранит его
  // только чтобы аккаунт открывался на новом устройстве, прочитать не может.
  if (req.method === 'POST' && url.pathname === '/api/keys/set') {
    if (!rateLimit('keys:' + clientIp(req), 40, 600000)) {
      return json(429, { error: 'Слишком часто, подожди' });
    }
    readBody(async (body) => {
      const u = await verifyUser(body.nick, body.password);
      if (!u) return json(401, { error: 'Неверный ник или пароль' });
      if (u.banned) return json(403, { error: 'Аккаунт заблокирован' });
      const pub = body.publicKey, priv = body.encPrivateKey;
      if (typeof pub !== 'string' || typeof priv !== 'string' || !pub || !priv) {
        return json(400, { error: 'Нужны оба ключа' });
      }
      if (pub.length > MAX_KEY || priv.length > MAX_KEY) {
        return json(413, { error: 'Ключ слишком большой' });
      }
      qSetKeys.run(pub, priv, u.nick);
      console.log('[e2e] Ключи сохранены для', u.nick);
      json(200, { ok: true, nick: u.nick });
    }, MAX_KEY_BODY);
    return;
  }

  // Свой зашифрованный приватный ключ — для входа на новом устройстве
  if (req.method === 'POST' && url.pathname === '/api/keys/mine') {
    if (!rateLimit('keys:' + clientIp(req), 40, 600000)) {
      return json(429, { error: 'Слишком часто, подожди' });
    }
    readBody(async (body) => {
      const u = await verifyUser(body.nick, body.password);
      if (!u) return json(401, { error: 'Неверный ник или пароль' });
      if (u.banned) return json(403, { error: 'Аккаунт заблокирован' });
      const row = qGetMyKeys.get(u.nick) || {};
      json(200, { ok: true, publicKey: row.public_key || null, encPrivateKey: row.enc_private_key || null });
    });
    return;
  }

  // Публичные ключи собеседников — пачкой, как аватары
  if (req.method === 'POST' && url.pathname === '/api/keys/get') {
    if (!rateLimit('pub:' + clientIp(req), 120, 60000)) {
      return json(429, { error: 'Слишком часто, подожди' });
    }
    readBody((body) => {
      const nicks = Array.isArray(body.nicks) ? body.nicks.slice(0, 50) : [];
      const out = {};
      for (const n of nicks) {
        if (typeof n !== 'string' || !n.trim()) continue;
        const row = qGetPubKey.get(n.trim());
        if (row) out[row.nick] = row.public_key || null;
      }
      json(200, { ok: true, keys: out });
    });
    return;
  }

  // ===== АВАТАРЫ =====
  // Аватар публичный по смыслу: его должны видеть собеседники.
  // Читать может кто угодно, менять — только владелец аккаунта.
  if (req.method === 'POST' && url.pathname === '/api/avatar') {
    if (!rateLimit('avatar:' + clientIp(req), 30, 600000)) {
      return json(429, { error: 'Слишком часто, подожди' });
    }
    readBody(async (body) => {
      const u = await verifyUser(body.nick, body.password);
      if (!u) return json(401, { error: 'Неверный ник или пароль' });
      if (u.banned) return json(403, { error: 'Аккаунт заблокирован' });

      const avatar = body.avatar;
      if (avatar === null || avatar === '') {
        qSetAvatar.run(null, u.nick);
        return json(200, { ok: true, nick: u.nick, avatar: null });
      }
      if (typeof avatar !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(avatar)) {
        return json(400, { error: 'Нужна картинка' });
      }
      if (avatar.length > MAX_AVATAR) return json(413, { error: 'Картинка слишком большая' });
      qSetAvatar.run(avatar, u.nick);
      console.log('[avatar] Обновлён у', u.nick, '(' + Math.round(avatar.length / 1024) + ' КБ)');
      json(200, { ok: true, nick: u.nick });
    }, MAX_AVATAR_BODY);
    return;
  }

  // Пачкой: клиенту нужны аватары всех собеседников сразу
  if (req.method === 'POST' && url.pathname === '/api/avatars') {
    // Запрос может вернуть до 50 картинок, поэтому лимит строже остальных:
    // без него это самый дешёвый способ забить канал сервера
    if (!rateLimit('avget:' + clientIp(req), 60, 60000)) {
      return json(429, { error: 'Слишком часто, подожди' });
    }
    readBody((body) => {
      const nicks = Array.isArray(body.nicks) ? body.nicks.slice(0, 50) : [];
      const out = {};
      for (const n of nicks) {
        if (typeof n !== 'string' || !n.trim()) continue;
        const row = qGetAvatar.get(n.trim());
        if (row) out[row.nick] = row.avatar || null;
      }
      json(200, { ok: true, avatars: out });
    });
    return;
  }

  // ===== АДМИН =====
  if (req.method === 'POST' && url.pathname.startsWith('/api/admin/')) {
    if (!rateLimit('admin:' + clientIp(req), 60, 600000)) {
      return json(429, { error: 'Слишком много запросов' });
    }
    const action = url.pathname.slice('/api/admin/'.length);

    readBody(async (body) => {
      const check = await requireAdmin(body);
      if (!check.ok) {
        if (check.reason === 'totp') {
          return json(403, { error: 'Нужен код подтверждения', needCode: true });
        }
        console.warn('[admin] Отказано в доступе с', clientIp(req));
        return json(403, { error: 'Нет прав администратора' });
      }
      const admin = check.user;
      // Новый пропуск отдаём один раз — при следующем запросе клиент пришлёт его сам
      const issued = check.session || null;
      const withSession = (code, data) => json(code, issued ? { ...data, session: issued } : data);

      if (action === 'users') return withSession(200, { ok: true, users: listUsers() });

      // --- Двухфакторная защита ---
      if (action === 'totp-status') {
        const row = qGetTotp.get(admin.nick) || {};
        return withSession(200, { ok: true, enabled: !!row.totp_secret });
      }

      // Готовим новый секрет. Пока он в pending, вход по-прежнему без кода —
      // включится только после того, как пользователь докажет, что код читает
      if (action === 'totp-setup') {
        const secret = base32Encode(crypto.randomBytes(20));
        qSetPending.run(secret, admin.nick);
        const uri = 'otpauth://totp/' + encodeURIComponent('Void:' + admin.nick) +
                    '?secret=' + secret + '&issuer=Void&algorithm=SHA1&digits=6&period=30';
        console.log('[totp] Подготовлен новый секрет для', admin.nick);
        return withSession(200, { ok: true, secret, uri });
      }

      if (action === 'totp-enable') {
        const row = qGetTotp.get(admin.nick) || {};
        if (!row.totp_pending) return json(400, { error: 'Сначала запроси настройку' });
        const step = totpVerify(row.totp_pending, body.setupCode, null);
        if (step === null) return json(400, { error: 'Код не подходит' });
        qEnableTotp.run(row.totp_pending, step, admin.nick);
        console.log('[totp] Включена для', admin.nick);
        return json(200, { ok: true, enabled: true, session: newAdminSession(admin.nick) });
      }

      if (action === 'totp-disable') {
        const row = qGetTotp.get(admin.nick) || {};
        if (!row.totp_secret) return json(200, { ok: true, enabled: false });
        qDisableTotp.run(admin.nick);
        for (const [t, sess] of adminSessions) if (sess.nick === admin.nick) adminSessions.delete(t);
        console.log('[totp] Выключена для', admin.nick);
        return json(200, { ok: true, enabled: false });
      }

      // Полная очистка переписки на сервере. Локальные копии у пользователей
      // остаются — сервер их не контролирует.
      if (action === 'purge-messages') {
        const removed = qPurgeMsgs.run().changes;
        console.log('[admin] PURGE: удалено сообщений с сервера:', removed);
        return withSession(200, { ok: true, removed, users: listUsers() });
      }

      const targetNick = typeof body.nick === 'string' ? body.nick.trim() : '';
      if (!targetNick) return json(400, { error: 'Не указан ник' });
      const target = qUserByNick.get(targetNick);
      if (!target) return json(404, { error: 'Пользователь не найден' });
      if (target.is_admin) return json(400, { error: 'Нельзя трогать админ-аккаунт' });

      // Свежий список возвращаем прямо в ответе: иначе клиенту нужен второй
      // запрос, а он снова считает scrypt — действие ощущалось медленным.
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) || null : null;

      if (action === 'ban') {
        if (target.banned) return json(200, { ok: true, nick: target.nick, banned: true, note: 'Уже заблокирован', users: listUsers() });
        qSetBan.run(1, Date.now(), reason, target.nick);
        const kicked = kickUser(target.nick, 'banned', reason);
        console.log('[admin] BAN', target.nick, reason ? '(' + reason + ')' : '', kicked ? '| отключён' : '');
        return withSession(200, { ok: true, nick: target.nick, banned: true, kicked, users: listUsers() });
      }

      if (action === 'unban') {
        if (!target.banned) return json(200, { ok: true, nick: target.nick, banned: false, note: 'Не был заблокирован', users: listUsers() });
        qSetBan.run(0, null, null, target.nick);
        console.log('[admin] UNBAN', target.nick);
        return withSession(200, { ok: true, nick: target.nick, banned: false, users: listUsers() });
      }

      if (action === 'delete') {
        // Полное удаление: ник освобождается и может быть занят заново.
        // Причину успеваем показать пользователю до отключения, а в базе её
        // хранить негде — аккаунта не остаётся, поэтому пишем в лог сервера.
        const msgs = qDeleteMsgs.run(target.nick, target.nick).changes;
        qDeleteUser.run(target.nick);
        const kicked = kickUser(target.nick, 'deleted', reason);
        console.log('[admin] DELETE', target.nick, reason ? '(' + reason + ')' : '', '| сообщений удалено:', msgs);
        return json(200, { ok: true, nick: target.nick, deleted: true, messagesDeleted: msgs, kicked, users: listUsers() });
      }

      json(404, { error: 'Неизвестное действие' });
    });
    return;
  }

  // GET /api/search?q=...
  if (req.method === 'GET' && url.pathname === '/api/search') {
    if (!rateLimit('search:' + clientIp(req), 60, 60000)) {
      return json(429, { error: 'Слишком часто, подожди' });
    }
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 2 || q.length > 32) return json(200, { users: [] });
    const pattern = '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
    json(200, { users: qSearchUsers.all(pattern).map(u => u.nick) });
    return;
  }

  // GET /api/status — состояние сервера. Ники отдаём только по админ-ключу.
  if (req.method === 'GET' && url.pathname === '/api/status') {
    const data = {
      ok: true,
      online: Object.keys(online).length,
      rooms: Object.keys(rooms).length,
      uptime: Math.round(process.uptime())
    };
    if (ADMIN_KEY && url.searchParams.get('key') === ADMIN_KEY) {
      data.onlineNicks = Object.keys(online);
      data.roomIds = Object.keys(rooms);
    }
    json(200, data);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end('{}');
});

// ===== WEBSOCKET =====
const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });

// Heartbeat: пинг каждые 30с, убиваем клиентов без ответа
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { ws.terminate(); }
  });
}, PING_INTERVAL);

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const ip = clientIp(req);
  let roomId = null, peerId = null, nick = null;

  const send = obj => {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify(obj)); } catch (e) {}
    }
  };

  // Выйти из LAN-комнаты. Проверка на идентичность сокета обязательна: слот
  // мог быть уже перехвачен новым подключением с тем же peerId.
  const leaveRoom = () => {
    if (roomId && peerId && rooms[roomId] && rooms[roomId][peerId] === ws) {
      delete rooms[roomId][peerId];
      broadcast(roomId, peerId, { type: 'peer-left', peer: peerId });
      if (!Object.keys(rooms[roomId]).length) delete rooms[roomId];
    }
    roomId = null;
    peerId = null;
  };

  const goOffline = () => {
    if (nick && online[nick] === ws) {
      delete online[nick];
      console.log('[close]', nick, 'offline | online:', Object.keys(online).length);
    }
    nick = null;
  };

  ws.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;

    try {
      // Клиентский keepalive ping — просто игнорируем
      if (msg.type === 'ping') return;

      // --- Авторизация для личных чатов ---
      if (msg.type === 'auth') {
        if (!rateLimit('wsauth:' + ip, 20, 600000)) {
          send({ type: 'auth-fail', error: 'rate-limit' });
          return;
        }
        const u = await verifyUser(msg.nick, msg.password);
        if (ws.readyState !== 1) return;  // сокет закрылся, пока считался scrypt
        if (!u) {
          console.log('[auth] FAIL for', msg.nick);
          send({ type: 'auth-fail' });
          return;
        }
        if (u.banned) {
          // auth-fail без reason клиент попытается «починить» авторегистрацией,
          // поэтому причину указываем явно
          console.log('[auth] BANNED', u.nick);
          send({ type: 'auth-fail', error: 'banned', note: u.ban_reason });
          ws.close(4003, 'banned');
          return;
        }
        const canon = u.nick;

        goOffline();                      // сбрасываем прошлую личность этого сокета
        const prev = online[canon];
        if (prev && prev !== ws) {        // повторный вход под тем же ником — рвём старую сессию
          try { prev.send(JSON.stringify({ type: 'session-replaced' })); prev.close(4001, 'session replaced'); }
          catch (e) {}
        }
        nick = canon;
        online[nick] = ws;
        send({ type: 'auth-ok', nick, admin: u.is_admin });
        console.log('[auth] OK for', nick, '| online:', Object.keys(online).length);

        // Доставить накопленные сообщения (помечаем каждое по id, а не пачкой:
        // иначе пришедшее в этот момент новое сообщение было бы потеряно)
        const pending = qPending.all(nick);
        if (pending.length) {
          console.log('[auth] Delivering', pending.length, 'pending messages to', nick);
          let sentCount = 0;
          for (const m of pending) {
            if (ws.readyState !== 1) break;
            // Не заваливаем сокет: если исходящий буфер уже распух, остальное
            // подождёт следующего подключения — оно не потеряется
            if (ws.bufferedAmount > PENDING_BUFFER_LIMIT) {
              console.warn('[auth] Буфер переполнен, остаток догоним позже:', pending.length - sentCount);
              break;
            }
            try {
              ws.send(JSON.stringify({ type: 'dm', from: m.from_nick, text: m.text, timestamp: m.timestamp, mid: m.mid }));
            } catch (e) {
              console.error('[auth] Обрыв при доставке накопленного:', e.message);
              break;
            }
            qMarkOne.run(m.id);
            sentCount++;
          }
        }
        return;
      }

      // --- Личное сообщение ---
      if (msg.type === 'dm') {
        if (!nick) { send({ type: 'dm-error', error: 'not-authed' }); return; }

        const to   = typeof msg.to === 'string' ? msg.to.trim() : '';
        const text = typeof msg.text === 'string' ? msg.text : '';
        if (!to || !text) return;
        // При сквозном шифровании сервер видит только шифротекст и не может
        // отличить сообщение от стикера, поэтому лимит для них общий.
        const isE2E = text.startsWith('{"v":1');
        const limit = isE2E ? MAX_E2E : (text.startsWith('__STICKER__') ? MAX_STICKER : MAX_TEXT);
        if (text.length > limit) { send({ type: 'dm-error', to, error: 'too-long' }); return; }
        if (!rateLimit('dm:' + nick, 60, 10000)) { send({ type: 'dm-error', to, error: 'rate-limit' }); return; }

        // Приводим ник получателя к каноническому виду: поиск нечувствителен к
        // регистру, поэтому без этого сообщение легло бы в несуществующий ящик.
        const target = qNickExists.get(to);
        if (!target) { send({ type: 'dm-error', to, error: 'no-such-user' }); return; }
        if (target.banned) { send({ type: 'dm-error', to, error: 'user-banned' }); return; }

        const toNick = target.nick;
        const timestamp = Date.now();
        // Повторный опознаватель сломал бы правку и удаление: они задели бы
        // сразу два сообщения, поэтому при совпадении выдаём свой
        let mid = typeof msg.mid === 'string' && msg.mid.length >= 8 && msg.mid.length <= 40 ? msg.mid : null;
        if (!mid || qMidExists.get(mid)) mid = crypto.randomUUID();
        const recipientWs = online[toNick];
        // Помечаем доставленным только если запись в сокет реально удалась:
        // раньше при сбое отправки сообщение считалось доставленным и пропадало
        let live = false;
        if (recipientWs && recipientWs.readyState === 1) {
          try {
            recipientWs.send(JSON.stringify({ type: 'dm', from: nick, text, timestamp, mid }));
            live = true;
          } catch (e) {
            console.error('[dm] Не удалось отправить', toNick + ':', e.message);
          }
        }
        qInsertMsg.run(nick, toNick, text, timestamp, live ? 1 : 0, mid);
        console.log(live ? '[dm] Delivered' : '[dm] Stored (offline)', nick, '->', toNick);
        send({ type: 'dm-ack', to: toNick, timestamp, delivered: live ? 1 : 0 });
        return;
      }

      // --- Удаление сообщения у обеих сторон ---
      if (msg.type === 'dm-delete') {
        if (!nick) return;
        if (!rateLimit('dmmod:' + nick, 60, 10000)) { send({ type: 'dm-error', error: 'rate-limit' }); return; }
        const to = typeof msg.to === 'string' ? msg.to.trim() : '';
        const mid = typeof msg.mid === 'string' ? msg.mid : '';
        if (!to || !mid) return;
        const target = qNickExists.get(to);
        if (!target) return;
        // Если сообщение ещё не доставлено, оно просто исчезнет из очереди
        qDropByMid.run(mid, nick, target.nick);
        const ws2 = online[target.nick];
        if (ws2 && ws2.readyState === 1) {
          try { ws2.send(JSON.stringify({ type: 'dm-delete', from: nick, mid })); } catch (e) {}
        }
        console.log('[dm] Deleted', nick, '->', target.nick);
        return;
      }

      // --- Изменение текста сообщения ---
      if (msg.type === 'dm-edit') {
        if (!nick) return;
        if (!rateLimit('dmmod:' + nick, 60, 10000)) { send({ type: 'dm-error', error: 'rate-limit' }); return; }
        const to = typeof msg.to === 'string' ? msg.to.trim() : '';
        const mid = typeof msg.mid === 'string' ? msg.mid : '';
        const text = typeof msg.text === 'string' ? msg.text : '';
        if (!to || !mid || !text) return;
        const limit = text.startsWith('{"v":1') ? MAX_E2E : MAX_TEXT;
        if (text.length > limit) { send({ type: 'dm-error', to, error: 'too-long' }); return; }
        const target = qNickExists.get(to);
        if (!target) return;
        qEditByMid.run(text, mid, nick, target.nick);
        const ws2 = online[target.nick];
        if (ws2 && ws2.readyState === 1) {
          try { ws2.send(JSON.stringify({ type: 'dm-edit', from: nick, mid, text })); } catch (e) {}
        }
        console.log('[dm] Edited', nick, '->', target.nick);
        return;
      }

      // --- LAN сигналинг ---
      if (msg.type === 'join') {
        const room = typeof msg.room === 'string' ? msg.room.trim().slice(0, 64) : '';
        if (!room) return;
        if (roomId) leaveRoom();   // повторный join на том же сокете — не плодим призраков
        if (!rooms[room] && Object.keys(rooms).length >= MAX_ROOMS) {
          send({ type: 'error', error: 'server-busy' });
          return;
        }

        roomId = room;
        peerId = (typeof msg.peer === 'string' && msg.peer.trim())
          ? msg.peer.trim().slice(0, 64)
          : crypto.randomBytes(4).toString('hex');
        if (!rooms[roomId]) rooms[roomId] = {};

        const stale = rooms[roomId][peerId];
        if (!stale && Object.keys(rooms[roomId]).length >= MAX_PEERS) {
          send({ type: 'error', error: 'room-full' });
          roomId = null; peerId = null;
          return;
        }
        // Тот же peerId уже в комнате (например, хост перезагрузил страницу) —
        // старый сокет мёртв или лишний, забираем слот себе.
        if (stale && stale !== ws) { try { stale.close(4002, 'peer replaced'); } catch (e) {} }

        rooms[roomId][peerId] = ws;
        send({ type: 'joined', peer: peerId, peers: Object.keys(rooms[roomId]).filter(p => p !== peerId) });
        broadcast(roomId, peerId, { type: 'peer-joined', peer: peerId });
        return;
      }

      if (msg.type === 'leave') { leaveRoom(); return; }

      // Ретрансляция offer/answer/ice внутри комнаты
      if (typeof msg.to === 'string' && roomId && rooms[roomId]) {
        const target = rooms[roomId][msg.to];
        if (target && target !== ws && target.readyState === 1) {
          try { target.send(JSON.stringify({ ...msg, from: peerId })); } catch (e) {}
        }
      }
    } catch (e) {
      console.error('[ws] Error:', e.message);
    }
  });

  ws.on('error', e => console.error('[ws] Socket error:', e.message));
  ws.on('close', () => { leaveRoom(); goOffline(); });
});

function broadcast(roomId, fromPeer, msg) {
  if (!rooms[roomId]) return;
  const payload = JSON.stringify(msg);
  Object.entries(rooms[roomId]).forEach(([id, client]) => {
    if (id !== fromPeer && client.readyState === 1) {
      try { client.send(payload); } catch (e) {}
    }
  });
}

// ===== ОЧИСТКА СТАРЫХ СООБЩЕНИЙ =====
// Без неё void.db растёт бесконечно.
const cleanup = setInterval(() => {
  try {
    const now = Date.now();
    const a = db.prepare('DELETE FROM messages WHERE delivered = 1 AND timestamp < ?').run(now - TTL_DELIVERED);
    const b = db.prepare('DELETE FROM messages WHERE delivered = 0 AND timestamp < ?').run(now - TTL_PENDING);
    if (a.changes || b.changes) console.log('[cleanup] Удалено сообщений:', a.changes + b.changes);
  } catch (e) {
    console.error('[cleanup]', e.message);
  }
}, 6 * 3600000);
cleanup.unref();

// ===== УСТОЙЧИВОСТЬ =====
server.on('error', e => console.error('[http] Server error:', e.message));
wss.on('error', e => console.error('[ws] Server error:', e.message));
process.on('unhandledRejection', e => console.error('[fatal] Unhandled rejection:', e && e.message));
// После необработанной ошибки состояние процесса неизвестно. Раньше он
// продолжал работать как ни в чём не бывало; теперь корректно закрываемся,
// а pm2 поднимет заново.
process.on('uncaughtException', e => {
  console.error('[fatal] Uncaught exception:', e && e.stack);
  shutdown('uncaughtException');
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[shutdown]', signal);
  clearInterval(heartbeat);
  clearInterval(cleanup);
  clearInterval(sessionSweep);
  wss.clients.forEach(c => { try { c.close(1001, 'server restart'); } catch (e) {} });
  const closeDb = () => { try { if (db.open) db.close(); } catch (e) {} };
  server.close(() => { closeDb(); process.exit(0); });
  // Если соединения зависли, всё равно закрываем базу перед выходом
  setTimeout(() => { closeDb(); process.exit(0); }, 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Слушаем только после того, как админ-аккаунт готов: иначе первые запросы
// попадали в окно, когда его ещё нет
ensureAdmin().finally(() => {
  server.listen(PORT, () => console.log('VOID server running on :' + PORT));
});

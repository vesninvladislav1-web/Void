const http = require('http');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

// ===== НАСТРОЙКИ =====
const PORT          = Number(process.env.PORT) || 3000;
const ADMIN_KEY     = process.env.VOID_ADMIN_KEY || '';
const MAX_BODY      = 16 * 1024;        // максимум тела HTTP-запроса
const MAX_TEXT      = 4000;             // максимум длины сообщения
const MAX_PAYLOAD   = 256 * 1024;       // максимум размера WS-кадра
const MAX_PEERS     = 16;               // максимум участников LAN-комнаты
const MAX_ROOMS     = 500;              // максимум одновременных LAN-комнат
const PING_INTERVAL = 30000;
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
  CREATE INDEX IF NOT EXISTS idx_messages_ts       ON messages(timestamp);
`);

const qUserByNick  = db.prepare('SELECT nick, password_hash FROM users WHERE nick = ? COLLATE NOCASE');
const qNickExists  = db.prepare('SELECT nick FROM users WHERE nick = ? COLLATE NOCASE');
const qInsertUser  = db.prepare('INSERT INTO users (nick, password_hash) VALUES (?, ?)');
const qUpdateHash  = db.prepare('UPDATE users SET password_hash = ? WHERE nick = ?');
const qSearchUsers = db.prepare("SELECT nick FROM users WHERE nick LIKE ? ESCAPE '\\' ORDER BY nick LIMIT 10");
const qInsertMsg   = db.prepare('INSERT INTO messages (from_nick, to_nick, text, timestamp, delivered) VALUES (?, ?, ?, ?, ?)');
const qPending     = db.prepare('SELECT id, from_nick, text, timestamp FROM messages WHERE to_nick = ? AND delivered = 0 ORDER BY timestamp');
const qMarkOne     = db.prepare('UPDATE messages SET delivered = 1 WHERE id = ?');

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

// Возвращает канонический ник (как он записан в БД) либо null.
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

  if (LEGACY_HASH_RE.test(row.password_hash)) {
    const a = Buffer.from(legacyHash(row.nick, password), 'hex');
    const b = Buffer.from(row.password_hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try { qUpdateHash.run(await scryptHash(password), row.nick); }
    catch (e) { console.error('[auth] Не удалось обновить хеш:', e.message); }
    return row.nick;
  }

  return (await scryptVerify(password, row.password_hash)) ? row.nick : null;
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

function clientIp(req) {
  // nginx дописывает реальный IP в конец X-Forwarded-For, поэтому берём
  // последний элемент — подделать его клиент не может.
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') {
    const parts = xff.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
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

  const readBody = (cb) => {
    let body = '', aborted = false;
    req.on('data', c => {
      if (aborted) return;
      body += c;
      if (body.length > MAX_BODY) {
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
      const canon = await verifyUser(body.nick, body.password);
      if (canon) json(200, { ok: true, nick: canon });
      else json(401, { error: 'Неверный ник или пароль' });
    });
    return;
  }

  // GET /api/search?q=...
  if (req.method === 'GET' && url.pathname === '/api/search') {
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
        const canon = await verifyUser(msg.nick, msg.password);
        if (ws.readyState !== 1) return;  // сокет закрылся, пока считался scrypt
        if (!canon) {
          console.log('[auth] FAIL for', msg.nick);
          send({ type: 'auth-fail' });
          return;
        }

        goOffline();                      // сбрасываем прошлую личность этого сокета
        const prev = online[canon];
        if (prev && prev !== ws) {        // повторный вход под тем же ником — рвём старую сессию
          try { prev.send(JSON.stringify({ type: 'session-replaced' })); prev.close(4001, 'session replaced'); }
          catch (e) {}
        }
        nick = canon;
        online[nick] = ws;
        send({ type: 'auth-ok', nick });
        console.log('[auth] OK for', nick, '| online:', Object.keys(online).length);

        // Доставить накопленные сообщения (помечаем каждое по id, а не пачкой:
        // иначе пришедшее в этот момент новое сообщение было бы потеряно)
        const pending = qPending.all(nick);
        if (pending.length) {
          console.log('[auth] Delivering', pending.length, 'pending messages to', nick);
          for (const m of pending) {
            if (ws.readyState !== 1) break;
            send({ type: 'dm', from: m.from_nick, text: m.text, timestamp: m.timestamp });
            qMarkOne.run(m.id);
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
        if (text.length > MAX_TEXT) { send({ type: 'dm-error', to, error: 'too-long' }); return; }
        if (!rateLimit('dm:' + nick, 60, 10000)) { send({ type: 'dm-error', to, error: 'rate-limit' }); return; }

        // Приводим ник получателя к каноническому виду: поиск нечувствителен к
        // регистру, поэтому без этого сообщение легло бы в несуществующий ящик.
        const target = qNickExists.get(to);
        if (!target) { send({ type: 'dm-error', to, error: 'no-such-user' }); return; }

        const toNick = target.nick;
        const timestamp = Date.now();
        const recipientWs = online[toNick];
        const live = recipientWs && recipientWs.readyState === 1;
        if (live) {
          try { recipientWs.send(JSON.stringify({ type: 'dm', from: nick, text, timestamp })); }
          catch (e) {}
        }
        qInsertMsg.run(nick, toNick, text, timestamp, live ? 1 : 0);
        console.log(live ? '[dm] Delivered' : '[dm] Stored (offline)', nick, '->', toNick);
        send({ type: 'dm-ack', to: toNick, timestamp, delivered: live ? 1 : 0 });
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
process.on('uncaughtException', e => console.error('[fatal] Uncaught exception:', e && e.stack));

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[shutdown]', signal);
  clearInterval(heartbeat);
  clearInterval(cleanup);
  wss.clients.forEach(c => { try { c.close(1001, 'server restart'); } catch (e) {} });
  server.close(() => { try { db.close(); } catch (e) {} process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

server.listen(PORT, () => console.log('VOID server running on :' + PORT));

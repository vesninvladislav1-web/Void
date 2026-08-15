const http = require('http');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

// ===== БАЗА ДАННЫХ =====
const db = new Database(path.join(__dirname, 'void.db'));
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
`);

function hashPw(nick, pass) {
  return crypto.createHash('sha256').update(nick + ':' + pass).digest('hex');
}

// ===== HTTP API =====
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');

  const json = (code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  const readBody = (cb) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { cb(JSON.parse(body)); }
      catch(e) { json(400, { error: 'Bad request' }); }
    });
  };

  // POST /api/register
  if (req.method === 'POST' && url.pathname === '/api/register') {
    readBody(({ nick, password }) => {
      if (!nick || !password || nick.length < 2 || nick.length > 16 || password.length < 6) {
        return json(400, { error: 'Неверные данные' });
      }
      if (!/^[a-zA-Z0-9_]+$/.test(nick)) {
        return json(400, { error: 'Ник: только латиница, цифры и _' });
      }
      try {
        db.prepare('INSERT INTO users (nick, password_hash) VALUES (?, ?)').run(nick, hashPw(nick, password));
        json(200, { ok: true });
      } catch(e) {
        json(409, { error: 'Ник уже занят' });
      }
    });
    return;
  }

  // POST /api/login
  if (req.method === 'POST' && url.pathname === '/api/login') {
    readBody(({ nick, password }) => {
      const user = db.prepare('SELECT nick FROM users WHERE nick = ? AND password_hash = ?').get(nick, hashPw(nick, password));
      if (user) json(200, { ok: true });
      else json(401, { error: 'Неверный ник или пароль' });
    });
    return;
  }

  // GET /api/search?q=...
  if (req.method === 'GET' && url.pathname === '/api/search') {
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 2) return json(200, { users: [] });
    const users = db.prepare("SELECT nick FROM users WHERE nick LIKE ? LIMIT 10").all(`%${q}%`);
    json(200, { users: users.map(u => u.nick) });
    return;
  }

  // GET /api/status — проверка работы сервера
  if (req.method === 'GET' && url.pathname === '/api/status') {
    json(200, { ok: true, online: Object.keys(online), rooms: Object.keys(rooms) });
    return;
  }

  res.writeHead(404); res.end('{}');
});

// ===== WEBSOCKET =====
const wss = new WebSocketServer({ server });
const rooms = {};    // LAN сигналинг: roomId -> { peerId: ws }
const online = {};   // Личные чаты: nick -> ws

// Heartbeat: пинг каждые 30с, убиваем клиентов без ответа
const PING_INTERVAL = 30000;
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, PING_INTERVAL);

wss.on('close', () => clearInterval(heartbeat));

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let roomId = null, peerId = null, nick = null;

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);

      // Клиентский keepalive ping — просто игнорируем
      if (msg.type === 'ping') return;

      // --- Авторизация для личных чатов ---
      if (msg.type === 'auth') {
        const user = db.prepare('SELECT nick FROM users WHERE nick = ? AND password_hash = ?')
          .get(msg.nick, hashPw(msg.nick, msg.password));
        if (!user) {
          console.log('[auth] FAIL for', msg.nick);
          ws.send(JSON.stringify({ type: 'auth-fail' }));
          return;
        }
        nick = user.nick;
        online[nick] = ws;
        ws.send(JSON.stringify({ type: 'auth-ok', nick }));
        console.log('[auth] OK for', nick, '| online:', Object.keys(online));
        // Доставить накопленные сообщения
        const pending = db.prepare(
          'SELECT id, from_nick, text, timestamp FROM messages WHERE to_nick = ? AND delivered = 0 ORDER BY timestamp'
        ).all(nick);
        if (pending.length) {
          console.log('[auth] Delivering', pending.length, 'pending messages to', nick);
          pending.forEach(m => {
            ws.send(JSON.stringify({ type: 'dm', from: m.from_nick, text: m.text, timestamp: m.timestamp }));
          });
          db.prepare('UPDATE messages SET delivered = 1 WHERE to_nick = ? AND delivered = 0').run(nick);
        }
        return;
      }

      // --- Личное сообщение ---
      if (msg.type === 'dm' && nick) {
        const { to, text } = msg;
        if (!to || !text) return;
        const timestamp = Date.now();
        const payload = JSON.stringify({ type: 'dm', from: nick, text, timestamp });
        const recipientWs = online[to];
        if (recipientWs && recipientWs.readyState === 1) {
          recipientWs.send(payload);
          db.prepare('INSERT INTO messages (from_nick, to_nick, text, timestamp, delivered) VALUES (?, ?, ?, ?, 1)')
            .run(nick, to, text, timestamp);
          console.log('[dm] Delivered', nick, '->', to);
        } else {
          db.prepare('INSERT INTO messages (from_nick, to_nick, text, timestamp, delivered) VALUES (?, ?, ?, ?, 0)')
            .run(nick, to, text, timestamp);
          console.log('[dm] Stored (offline)', nick, '->', to);
        }
        return;
      }

      // --- LAN сигналинг ---
      if (msg.type === 'join') {
        roomId = msg.room;
        peerId = msg.peer || Math.random().toString(36).slice(2, 8);
        if (!rooms[roomId]) rooms[roomId] = {};
        rooms[roomId][peerId] = ws;
        ws.send(JSON.stringify({ type: 'joined', peer: peerId, peers: Object.keys(rooms[roomId]).filter(p => p !== peerId) }));
        broadcast(roomId, peerId, { type: 'peer-joined', peer: peerId });
        return;
      }
      if (msg.to && roomId && rooms[roomId]?.[msg.to]) {
        rooms[roomId][msg.to].send(JSON.stringify({ ...msg, from: peerId }));
      }
    } catch(e) { console.error('[ws] Error:', e.message); }
  });

  ws.on('close', () => {
    if (roomId && peerId && rooms[roomId]) {
      delete rooms[roomId][peerId];
      broadcast(roomId, peerId, { type: 'peer-left', peer: peerId });
      if (!Object.keys(rooms[roomId]).length) delete rooms[roomId];
    }
    if (nick && online[nick] === ws) {
      delete online[nick];
      console.log('[close]', nick, 'offline | online:', Object.keys(online));
    }
  });
});

function broadcast(roomId, fromPeer, msg) {
  if (!rooms[roomId]) return;
  Object.entries(rooms[roomId]).forEach(([id, client]) => {
    if (id !== fromPeer && client.readyState === 1) client.send(JSON.stringify(msg));
  });
}

server.listen(3000, () => console.log('VOID server running on :3000'));

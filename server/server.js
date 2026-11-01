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

  res.writeHead(404); res.end('{}');
});

// ===== WEBSOCKET =====
// maxPayload: игра шлёт пакеты по сотне байт — мегабайтный «пакет» не принимаем
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
// LAN сигналинг: roomId -> Map(peerId -> ws). Map, а не {} — ник «__proto__» или «constructor» не ломает сервер
const rooms = new Map();
const online = new Map();   // Личные чаты: nick -> ws
const okId = s => typeof s === 'string' && s.length > 0 && s.length <= 64;

// Живы ли соединения: раз в 30 с ping; кто не ответил pong — обрыв (телефон потерял сеть, вкладку убили).
// Без этого «мёртвые» соединения висели бы часами, и другие игроки видели бы призраков.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  }
}, 30000);

wss.on('connection', ws => {
  let roomId = null, peerId = null, nick = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // выйти из комнаты: только если в комнате под этим ид — именно это соединение
  // (иначе закрытие старого, оборванного соединения выкинуло бы из комнаты новое, с тем же ид)
  const leave = () => {
    const room = roomId !== null && rooms.get(roomId);
    if (room && room.get(peerId) === ws) {
      room.delete(peerId);
      broadcast(roomId, peerId, { type: 'peer-left', peer: peerId });
      if (!room.size) rooms.delete(roomId);
    }
    roomId = null; peerId = null;
  };

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);

      // --- Авторизация для личных чатов ---
      if (msg.type === 'auth') {
        const user = db.prepare('SELECT nick FROM users WHERE nick = ? AND password_hash = ?')
          .get(msg.nick, hashPw(msg.nick, msg.password));
        if (!user) { ws.send(JSON.stringify({ type: 'auth-fail' })); return; }
        nick = user.nick;
        online.set(nick, ws);
        ws.send(JSON.stringify({ type: 'auth-ok', nick }));
        // Доставить накопленные сообщения
        const pending = db.prepare(
          'SELECT id, from_nick, text, timestamp FROM messages WHERE to_nick = ? AND delivered = 0 ORDER BY timestamp'
        ).all(nick);
        pending.forEach(m => {
          ws.send(JSON.stringify({ type: 'dm', from: m.from_nick, text: m.text, timestamp: m.timestamp }));
        });
        if (pending.length) {
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
        const dst = online.get(to);
        if (dst && dst.readyState === 1) {
          dst.send(payload);
          db.prepare('INSERT INTO messages (from_nick, to_nick, text, timestamp, delivered) VALUES (?, ?, ?, ?, 1)')
            .run(nick, to, text, timestamp);
        } else {
          db.prepare('INSERT INTO messages (from_nick, to_nick, text, timestamp, delivered) VALUES (?, ?, ?, ?, 0)')
            .run(nick, to, text, timestamp);
        }
        return;
      }

      // --- LAN сигналинг ---
      if (msg.type === 'join') {
        if (!okId(msg.room)) return;
        leave();                                   // повторный join с того же соединения — из прежней комнаты выходим
        let room = rooms.get(msg.room);
        if (!room) rooms.set(msg.room, room = new Map());
        // ид занят живым соединением — даём новый (игра возьмёт его из ответа 'joined'); чужой ид так не перехватить
        let id = okId(msg.peer) ? msg.peer : null;
        const was = id && room.get(id);
        if (!id || (was && was !== ws && was.readyState === 1)) id = Math.random().toString(36).slice(2, 12);
        else if (was && was !== ws) { try { was.terminate(); } catch (e) {} }   // висело мёртвое — убираем
        roomId = msg.room; peerId = id;
        room.set(peerId, ws);
        ws.send(JSON.stringify({ type: 'joined', peer: peerId, peers: [...room.keys()].filter(p => p !== peerId) }));
        broadcast(roomId, peerId, { type: 'peer-joined', peer: peerId });
        return;
      }
      if (okId(msg.to) && roomId !== null) {
        const dst = rooms.get(roomId)?.get(msg.to);
        if (dst && dst !== ws && dst.readyState === 1) dst.send(JSON.stringify({ ...msg, from: peerId }));
      }
    } catch(e) {}
  });

  ws.on('close', () => {
    leave();
    if (nick && online.get(nick) === ws) online.delete(nick);
  });
  ws.on('error', () => {});                        // обрыв посреди пакета — не роняем сервер
});

function broadcast(roomId, fromPeer, msg) {
  const room = rooms.get(roomId);
  if (!room) return;
  const data = JSON.stringify(msg);
  for (const [id, client] of room) if (id !== fromPeer && client.readyState === 1) client.send(data);
}

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => console.log('VOID server running on :' + PORT));

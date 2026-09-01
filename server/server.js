const http = require('http');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ===== НАСТРОЙКИ =====
const PORT          = Number(process.env.PORT) || 3000;
const ADMIN_KEY     = process.env.VOID_ADMIN_KEY || '';
const ADMIN_NICK    = 'Void';                        // единственный админ-аккаунт
const ADMIN_PASS    = process.env.VOID_ADMIN_PASSWORD || '';
// Смена пароля существующего админа — только по явной просьбе. Раньше пароль
// переписывался при каждом запуске, и один неверный запуск молча отбирал
// доступ к аккаунту: снаружи всё выглядело исправным, а войти было нельзя.
const ADMIN_RESET   = /^(1|true|yes)$/i.test(process.env.VOID_ADMIN_RESET || '');
const MAX_BODY      = 16 * 1024;        // максимум тела HTTP-запроса
const MAX_TEXT      = 4000;             // максимум длины НЕшифрованного сообщения
const MAX_STICKER   = 128 * 1024;       // картинка-стикер приходит как data:URI
// После E2E сервер не может отличить текст от стикера — всё это шифротекст,
// поэтому лимит общий и с запасом на base64 (+33%)
const MAX_E2E       = 260 * 1024;
const MAX_KEY       = 4 * 1024;         // публичный ключ / зашифрованный приватный
const MAX_KEY_BODY  = 16 * 1024;
const MAX_AVATAR    = 96 * 1024;        // аватар тоже data:URI
const MAX_EVIDENCE      = 3;            // сколько скриншотов можно приложить к бану
const MAX_EVIDENCE_SIZE = 200 * 1024;   // на каждый
const MAX_BAN_BODY      = 1024 * 1024;  // тело запроса на блокировку
// Вложения: файл шифруется на устройстве, сервер хранит непрозрачные байты.
// Приём идёт потоком прямо в файл, поэтому предел размера больше не упирается
// в оперативную память: раньше файл жил в ней трижды — склеенной строкой,
// копией после разбора JSON и распакованным буфером.
const MAX_BLOB      = 25 * 1024 * 1024;
const MAX_BLOB_BODY = 5 * 1024 * 1024;   // только для старого способа, через JSON
const BLOB_QUOTA    = 500 * 1024 * 1024; // сколько вложений держим на аккаунт
const TTL_BLOB      = 30 * 86400000;
const MAX_AVATAR_BODY = 128 * 1024;     // тело запроса с аватаром
const MAX_PAYLOAD   = 512 * 1024;       // максимум размера WS-кадра (шифротекст крупнее)
const MAX_PEERS     = 16;               // максимум участников LAN-комнаты
const MAX_ROOMS     = 500;              // максимум одновременных LAN-комнат
const PING_INTERVAL = 30000;
const PENDING_BUFFER_LIMIT = 2 * 1024 * 1024;  // предел исходящего буфера при догрузке накопленного
// Доставленное письмо уже лежит в телефоне получателя, и серверу оно больше
// не нужно — кроме одного случая: второе устройство, которое было выключено.
// Двух суток на это хватает («забыл ноутбук на работе»), а след в базе
// сжимается в пятнадцать раз. Прочесть эти записи всё равно нельзя, но по
// ним видно, кто с кем и когда разговаривает, — а это иногда говорит о
// человеке больше самих слов.
const TTL_DELIVERED = 2 * 86400000;     // доставленные — двое суток
// Недоставленное трогать нельзя: его ещё никто не получил, и удалить значит
// потерять письмо. Здесь срок остаётся длинным намеренно.
const TTL_PENDING   = 90 * 86400000;    // недоставленные — 90 дней

// ===== СОСТОЯНИЕ =====
const rooms  = {};   // LAN сигналинг: roomId -> { peerId: ws }
// Раньше здесь был один сокет на аккаунт, и вход со второго устройства
// выбивал первое. Теперь у ника набор подключений — по одному на устройство.
const online = {};   // nick -> Set(ws)

// ===== БАЗА ДАННЫХ =====
const db = new Database(path.join(__dirname, 'void.db'));
db.pragma('journal_mode = WAL');

// Вложения лежат отдельными файлами, а не внутри базы. Так база остаётся
// маленькой (её удобно копировать), а приём файла не требует держать его
// в памяти целиком. ВАЖНО: резервная копия теперь должна включать и этот
// каталог, одного void.db больше не достаточно.
const BLOB_DIR = process.env.VOID_BLOB_DIR || path.join(__dirname, 'blobs');
const BLOB_TMP = path.join(BLOB_DIR, 'tmp');
try { fs.mkdirSync(BLOB_TMP, { recursive: true }); }
catch (e) { console.error('[blob] Не удалось создать каталог вложений:', e.message); }
// Недописанные куски от прерванных загрузок пережить перезапуск не должны
try { for (const f of fs.readdirSync(BLOB_TMP)) fs.unlinkSync(path.join(BLOB_TMP, f)); } catch (e) {}
const blobPath = id => path.join(BLOB_DIR, id);
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
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS blobs (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    data BLOB NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_blobs_owner ON blobs(owner);
  CREATE INDEX IF NOT EXISTS idx_blobs_ts ON blobs(created_at);
  CREATE TABLE IF NOT EXISTS push_subs (
    nick TEXT NOT NULL,
    device_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (nick, device_id)
  );
  CREATE INDEX IF NOT EXISTS idx_push_nick ON push_subs(nick);
  CREATE TABLE IF NOT EXISTS devices (
    nick TEXT NOT NULL,
    device_id TEXT NOT NULL,
    name TEXT,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    PRIMARY KEY (nick, device_id)
  );
  CREATE INDEX IF NOT EXISTS idx_devices_nick ON devices(nick);
  -- Чёрный список. owner решил не получать ничего от target.
  -- Хранится на сервере, а не на устройстве, потому что отсекать сообщения
  -- надо до доставки — иначе они всё равно приходили бы и будили телефон.
  CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_invites_owner ON invites(owner);
  CREATE TABLE IF NOT EXISTS blocks (
    owner TEXT NOT NULL,
    target TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (owner, target)
  );
  CREATE INDEX IF NOT EXISTS idx_blocks_owner  ON blocks(owner);
  CREATE INDEX IF NOT EXISTS idx_blocks_target ON blocks(target);
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
  // Отметка о прочтении. Нужна, чтобы отправитель видел вторую галочку даже
  // если его не было в сети в момент прочтения.
  if (!mcols.includes('read')) db.exec('ALTER TABLE messages ADD COLUMN read INTEGER DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_mid ON messages(mid)');

  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
  if (!cols.includes('banned'))     db.exec('ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0');
  if (!cols.includes('is_admin'))   db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0');
  if (!cols.includes('banned_at'))  db.exec('ALTER TABLE users ADD COLUMN banned_at INTEGER');
  if (!cols.includes('ban_reason')) db.exec('ALTER TABLE users ADD COLUMN ban_reason TEXT');
  // Скриншоты-доказательства к блокировке. Лежат отдельно от списка аккаунтов
  // и запрашиваются по одному аккаунту, иначе список весил бы мегабайты.
  if (!cols.includes('ban_evidence')) db.exec('ALTER TABLE users ADD COLUMN ban_evidence TEXT');
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
  // Когда человек был на связи в последний раз. Показывать это или нет —
  // выбирает он сам, поэтому рядом лежит его решение.
  if (!cols.includes('last_seen'))     db.exec('ALTER TABLE users ADD COLUMN last_seen INTEGER');
  if (!cols.includes('hide_presence')) db.exec('ALTER TABLE users ADD COLUMN hide_presence INTEGER DEFAULT 0');
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
const qMarkRead    = db.prepare('UPDATE messages SET read = 1 WHERE mid = ? AND to_nick = ? AND from_nick = ?');
// При входе отдаём отправителю, что из написанного им уже прочли
const qReadSync    = db.prepare(`
  SELECT mid, to_nick FROM messages
  WHERE from_nick = ? AND read = 1 AND mid IS NOT NULL
  ORDER BY timestamp DESC LIMIT 500
`);
// IP-адреса намеренно не сохраняем: в политике конфиденциальности написано,
// что они в базу не попадают. Хватает названия устройства и времени.
const qPutBlob     = db.prepare('INSERT INTO blobs (id, owner, data, size, created_at) VALUES (?, ?, ?, ?, ?)');
const qGetBlob     = db.prepare('SELECT data, size FROM blobs WHERE id = ?');
const qDropBlobsOf = db.prepare('DELETE FROM blobs WHERE owner = ?');
// Вложения, лежащие файлами. Столбец добавляется на ходу: у уже работающего
// сервера база создана без него, а ронять её ради этого незачем.
try { db.exec('ALTER TABLE blobs ADD COLUMN on_disk INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
const qPutBlobDisk = db.prepare("INSERT INTO blobs (id, owner, data, size, created_at, on_disk) VALUES (?, ?, X'', ?, ?, 1)");
const qBlobMeta    = db.prepare('SELECT size, on_disk FROM blobs WHERE id = ?');
const qBlobIdsOf   = db.prepare('SELECT id FROM blobs WHERE owner = ? AND on_disk = 1');
const qBlobIdsOld  = db.prepare('SELECT id FROM blobs WHERE on_disk = 1 AND created_at < ?');
const qBlobIdsAll  = db.prepare('SELECT id FROM blobs WHERE on_disk = 1');

// Удаление файлов вложений. Строку в базе снимает вызывающий: файл без строки
// — мусор, который никто не найдёт, а строка без файла — битая ссылка.
function dropBlobFiles(ids) {
  let убрано = 0;
  for (const { id } of ids) {
    try { fs.unlinkSync(blobPath(id)); убрано++; }
    catch (e) { if (e.code !== 'ENOENT') console.warn('[blob] Не удалось удалить', id, e.message); }
  }
  return убрано;
}
const qBlobUsage   = db.prepare('SELECT COALESCE(SUM(size), 0) AS total FROM blobs WHERE owner = ?');
const qGetSetting  = db.prepare('SELECT value FROM settings WHERE key = ?');
const qSetSetting  = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
const qAddPush     = db.prepare(`
  INSERT INTO push_subs (nick, device_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(nick, device_id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth
`);
const qPushOf      = db.prepare('SELECT device_id, endpoint, p256dh, auth FROM push_subs WHERE nick = ?');
const qDropPush    = db.prepare('DELETE FROM push_subs WHERE nick = ? AND device_id = ?');
const qDropPushAll = db.prepare('DELETE FROM push_subs WHERE nick = ?');
const qUpsertDevice = db.prepare(`
  INSERT INTO devices (nick, device_id, name, created_at, last_seen) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(nick, device_id) DO UPDATE SET last_seen = excluded.last_seen, name = excluded.name
`);
// Устройство, однажды подтверждённое кодом, больше его не спрашивает. Иначе
// код требовался бы при каждом обрыве связи: сокет переподключается сам.
// Отозвать доверие можно там же, где и устройство, — оно исчезает вместе с ним.
try { db.exec('ALTER TABLE devices ADD COLUMN totp_ok INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
const qTrustDevice = db.prepare('UPDATE devices SET totp_ok = 1 WHERE nick = ? AND device_id = ?');
const qDeviceTrust = db.prepare('SELECT totp_ok FROM devices WHERE nick = ? AND device_id = ?');
const qUntrustAll  = db.prepare('UPDATE devices SET totp_ok = 0 WHERE nick = ?');

// Нужен ли этому устройству код прямо сейчас
function нуженКод(nick, deviceId) {
  const row = qGetTotp.get(nick);
  if (!row || !row.totp_secret) return false;          // двухфакторка выключена
  if (!deviceId) return true;                          // устройство не назвалось
  const d = qDeviceTrust.get(nick, deviceId);
  return !(d && d.totp_ok);
}

// Проверяет код и, если он верный, запоминает устройство как доверенное
function принятьКод(nick, deviceId, code) {
  const row = qGetTotp.get(nick);
  if (!row || !row.totp_secret) return true;
  const step = totpVerify(row.totp_secret, code, row.totp_last);
  if (step === null) return false;
  qTotpLast.run(step, nick);
  if (deviceId) {
    // Строки устройства может ещё не быть: при входе она появляется позже,
    // уже на сокете. Заводим сразу, чтобы доверие было куда записать.
    try { qUpsertDevice.run(nick, deviceId, 'Устройство', Date.now(), Date.now()); } catch (e) {}
    qTrustDevice.run(nick, deviceId);
  }
  return true;
}

// Приглашение живёт неделю: за это время им либо воспользуются, либо оно
// потеряется в переписке, и пусть лучше протухнет само.
const TTL_INVITE   = 7 * 86400000;
const qPutInvite   = db.prepare('INSERT INTO invites (code, owner, created_at) VALUES (?, ?, ?)');
const qGetInvite   = db.prepare('SELECT owner, created_at FROM invites WHERE code = ?');
const qDropInvite  = db.prepare('DELETE FROM invites WHERE code = ?');
// Оставляем человеку не больше десяти живых приглашений: старые вытесняются
const qDropOldInvites = db.prepare(`
  DELETE FROM invites WHERE owner = ? AND code NOT IN (
    SELECT code FROM invites WHERE owner = ? ORDER BY created_at DESC LIMIT 9
  )
`);
const qDropInvitesOf  = db.prepare('DELETE FROM invites WHERE owner = ?');

const qListDevices = db.prepare('SELECT device_id, name, created_at, last_seen FROM devices WHERE nick = ? ORDER BY last_seen DESC');
const qDropDevice  = db.prepare('DELETE FROM devices WHERE nick = ? AND device_id = ?');
const qDropDevices = db.prepare('DELETE FROM devices WHERE nick = ?');
const qSetPassword = db.prepare('UPDATE users SET password_hash = ?, enc_private_key = ? WHERE nick = ?');
const qTouchSeen   = db.prepare('UPDATE users SET last_seen = ? WHERE nick = ?');
const qPresence    = db.prepare('SELECT nick, last_seen, hide_presence FROM users WHERE nick = ? COLLATE NOCASE');
const qSetHide     = db.prepare('UPDATE users SET hide_presence = ? WHERE nick = ?');
const qGetHide     = db.prepare('SELECT hide_presence FROM users WHERE nick = ?');
const qBlockAdd    = db.prepare('INSERT OR IGNORE INTO blocks (owner, target, created_at) VALUES (?, ?, ?)');
const qBlockDrop   = db.prepare('DELETE FROM blocks WHERE owner = ? AND target = ?');
const qBlockList   = db.prepare('SELECT target, created_at FROM blocks WHERE owner = ? ORDER BY created_at DESC');
const qBlockCheck  = db.prepare('SELECT 1 FROM blocks WHERE owner = ? AND target = ? LIMIT 1');
const qBlockCount  = db.prepare('SELECT COUNT(*) AS n FROM blocks WHERE owner = ?');
const qBlockWipe   = db.prepare('DELETE FROM blocks WHERE owner = ? OR target = ?');
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
  SELECT u.nick, u.created_at, u.banned, u.is_admin, u.banned_at, u.ban_reason, u.ban_evidence,
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
const qSetBan      = db.prepare('UPDATE users SET banned = ?, banned_at = ?, ban_reason = ?, ban_evidence = ? WHERE nick = ?');
const qGetEvidence = db.prepare('SELECT ban_evidence FROM users WHERE nick = ?');
const qDeleteUser  = db.prepare('DELETE FROM users WHERE nick = ?');
const qDeleteMsgs  = db.prepare('DELETE FROM messages WHERE from_nick = ? OR to_nick = ?');

function addOnline(nick, ws) {
  if (!online[nick]) online[nick] = new Set();
  online[nick].add(ws);
}
function removeOnline(nick, ws) {
  const set = online[nick];
  if (!set) return;
  set.delete(ws);
  if (!set.size) delete online[nick];
}
function socketsOf(nick) { return online[nick] ? [...online[nick]] : []; }
function isOnline(nick) { return !!(online[nick] && online[nick].size); }
function deviceCount(nick) { return online[nick] ? online[nick].size : 0; }

// Заблокировал ли `owner` человека по имени `target`.
// Ники сравниваем в том виде, в каком они лежат в таблице аккаунтов,
// поэтому вызывающий обязан подставлять канонические.
function isBlocked(owner, target) {
  try { return !!qBlockCheck.get(owner, target); } catch (e) { return false; }
}

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
    if (parts.length !== 3 || parts[0] !== 's2') return resolve(false);
    // Проверка формата не придирка. Buffer.from(x, 'hex') на нешестнадцатеричной
    // строке молча обрывается на первом плохом знаке и может вернуть пустой
    // буфер. Тогда ниже сравнивались бы два пустых буфера — то есть подошёл бы
    // ЛЮБОЙ пароль. Такую строку в базу пишем не мы, но одной испорченной
    // записи хватило бы, чтобы аккаунт открылся настежь.
    if (!/^[0-9a-f]{32}$/.test(parts[1]) || !/^[0-9a-f]{128}$/.test(parts[2])) {
      console.error('[auth] Хеш испорчен, вход запрещён');
      return resolve(false);
    }
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
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

// ===== УВЕДОМЛЕНИЯ ПРИ ЗАКРЫТОМ ПРИЛОЖЕНИИ (Web Push) =====
// Написано вручную, без сторонних библиотек: приложение про приватность,
// и тянуть ради этого чужой код с его зависимостями не хочется.
// Правильность сверена с эталонной реализацией в тестах.
const b64url = buf => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = str => Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function hmac(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }

// Ключи VAPID — по ним служба доставки понимает, что запрос от нашего сервера
function generateVapid() {
  const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = kp.publicKey.export({ type: 'spki', format: 'der' }).subarray(-65);
  const jwk = kp.privateKey.export({ format: 'jwk' });
  return { publicKey: b64url(pub), privateKey: jwk.d };
}

function vapidPrivateKey(d) {
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d, x: '', y: '' },
    format: 'jwk'
  });
}

// Подпись доступа: ES256 в компактном формате, как требует стандарт
function vapidToken(audience, privJwkD, pubKey, subject) {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64url(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject
  }));
  const input = header + '.' + payload;

  // Восстанавливаем ключ из приватной части: публичную часть выводим сами
  const priv = crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: privJwkD, x: b64url(pubKey.subarray(1, 33)), y: b64url(pubKey.subarray(33, 65)) },
    format: 'jwk'
  });
  // Подпись приходит в формате DER, а нужен «сырой» r||s
  const der = crypto.sign('sha256', Buffer.from(input), priv);
  const sig = derToRaw(der);
  return input + '.' + b64url(sig);
}

function derToRaw(der) {
  let off = 2;
  if (der[1] & 0x80) off = 2 + (der[1] & 0x7f);
  const readInt = () => {
    const len = der[off + 1];
    let val = der.subarray(off + 2, off + 2 + len);
    off += 2 + len;
    while (val.length > 32 && val[0] === 0) val = val.subarray(1);
    return Buffer.concat([Buffer.alloc(32 - val.length), val]);
  };
  const r = readInt(), sVal = readInt();
  return Buffer.concat([r, sVal]);
}

// Шифрование содержимого (RFC 8291 + RFC 8188, aes128gcm).
// Служба доставки видит только шифротекст — прочитать сообщение она не может.
function encryptPush(plaintext, p256dhB64, authB64) {
  const uaPublic = unb64url(p256dhB64);
  const authSecret = unb64url(authB64);
  const salt = crypto.randomBytes(16);

  const eph = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const asPublic = eph.publicKey.export({ type: 'spki', format: 'der' }).subarray(-65);

  const uaKey = crypto.createPublicKey({
    key: Buffer.concat([
      Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'),
      uaPublic
    ]),
    format: 'der', type: 'spki'
  });
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: uaKey });

  const prkKey = hmac(authSecret, shared);
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])
  ]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);

  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([Buffer.from(plaintext, 'utf8'), Buffer.from([2])]);
  const ct = Buffer.concat([cipher.update(body), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096, 0);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

// Ключи создаются один раз при первом запуске и хранятся в базе. Иначе при
// каждом перезапуске все подписки пришлось бы оформлять заново.
const PUSH_SUBJECT = process.env.VOID_PUSH_SUBJECT || 'mailto:admin@voidm.site';
let vapidKeys = null;

function initPush() {
  try {
    const pub = qGetSetting.get('vapid_public');
    const priv = qGetSetting.get('vapid_private');
    if (pub && priv) {
      vapidKeys = { publicKey: pub.value, privateKey: priv.value };
      console.log('[push] Ключи взяты из базы');
      return;
    }
    vapidKeys = generateVapid();
    qSetSetting.run('vapid_public', vapidKeys.publicKey);
    qSetSetting.run('vapid_private', vapidKeys.privateKey);
    console.log('[push] Созданы новые ключи');
  } catch (e) {
    console.error('[push] Не удалось подготовить ключи:', e.message);
  }
}

// Отправка одного уведомления. Возвращает false, если подписка больше не жива.
async function sendPush(sub, payload) {
  if (!vapidKeys) return true;
  let origin;
  try { origin = new URL(sub.endpoint).origin; }
  catch (e) { return false; }

  try {
    const body = encryptPush(JSON.stringify(payload), sub.p256dh, sub.auth);
    const token = vapidToken(origin, vapidKeys.privateKey, unb64url(vapidKeys.publicKey), PUSH_SUBJECT);
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': 'vapid t=' + token + ', k=' + vapidKeys.publicKey,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'TTL': '86400',
        'Urgency': 'high'
      },
      body
    });
    // Служба сообщает, что подписка мертва — убираем её, чтобы не долбиться
    if (res.status === 404 || res.status === 410) return false;
    if (!res.ok) console.warn('[push] Служба доставки ответила', res.status);
    return true;
  } catch (e) {
    console.warn('[push] Ошибка отправки:', e.message);
    return true;   // сеть могла моргнуть, подписку не выбрасываем
  }
}

// Уведомляем все устройства человека. Вызывается, только когда его нет
// на связи: если приложение открыто, оно покажет уведомление само.
async function notifyOffline(nick, payload) {
  if (!vapidKeys || isOnline(nick)) return;
  let subs = [];
  try { subs = qPushOf.all(nick); } catch (e) { return; }
  if (!subs.length) return;
  for (const sub of subs) {
    const alive = await sendPush(sub, payload);
    if (!alive) {
      try { qDropPush.run(nick, sub.device_id); } catch (e) {}
      console.log('[push] Подписка устарела, удалена:', nick);
    }
  }
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
  const list = socketsOf(nick);
  if (!list.length) return false;
  for (const ws of list) {
    try {
      ws.send(JSON.stringify({ type: 'kicked', reason, note: note || null }));
      ws.close(4003, reason);
    } catch (e) {}
  }
  delete online[nick];
  return true;
}

// Отключить одно конкретное устройство
function kickDevice(nick, deviceId, reason) {
  let hit = false;
  for (const ws of socketsOf(nick)) {
    if (ws.deviceId !== deviceId) continue;
    hit = true;
    try {
      ws.send(JSON.stringify({ type: 'kicked', reason: reason || 'device-revoked' }));
      ws.close(4004, 'device revoked');
    } catch (e) {}
    removeOnline(nick, ws);
  }
  return hit;
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

    // Аккаунт уже наш. Пароль трогаем только если об этом попросили явно.
    // Раньше здесь было безусловное удаление, и каждый перезапуск стирал
    // переписку админа, аватар и ключи; потом — безусловная смена пароля,
    // из-за которой запуск с неверной переменной отбирал доступ.
    if (existing && existing.is_admin) {
      if (existing.banned) qSetBan.run(0, null, null, null, existing.nick);
      if (!ADMIN_RESET) {
        console.log('[admin] Админ-аккаунт', existing.nick, 'на месте, пароль не тронут');
        console.log('[admin] Сменить пароль: VOID_ADMIN_RESET=1 VOID_ADMIN_PASSWORD=<новый> при запуске');
        return;
      }
      qUpdateHash.run(hash, existing.nick);
      console.log('[admin] Админ-аккаунт', existing.nick, '— пароль изменён по просьбе (VOID_ADMIN_RESET)');
      return;
    }

    // Ник занят обычным пользователем — вот теперь действительно сносим
    if (existing) {
      qDeleteMsgs.run(existing.nick, existing.nick);
      qBlockWipe.run(existing.nick, existing.nick);
      qDeleteUser.run(existing.nick);
      kickUser(existing.nick, 'admin-reset');
      console.log('[admin] Ник', existing.nick, 'был занят обычным аккаунтом — освобождён');
    }
    db.prepare('INSERT INTO users (nick, password_hash, banned, is_admin) VALUES (?, ?, 0, 1)')
      .run(ADMIN_NICK, hash);
    console.log('[admin] Админ-аккаунт', ADMIN_NICK, 'создан');
  }).catch(e => console.error('[admin] Не удалось создать админа:', e.message));
}

function countEvidence(raw) {
  if (!raw) return 0;
  try { const a = JSON.parse(raw); return Array.isArray(a) ? a.length : 0; }
  catch (e) { return 0; }
}

// Отсеиваем всё, что не является картинкой, и держим объём в рамках
function cleanEvidence(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  // Сначала отсеиваем негодное и только потом ограничиваем количество:
  // при обратном порядке мусор в начале списка съедал бы места настоящих картинок
  for (const item of list.slice(0, 50)) {
    if (out.length >= MAX_EVIDENCE) break;
    if (typeof item !== 'string') continue;
    if (!/^data:image\/(png|jpeg|webp);base64,/.test(item)) continue;
    if (item.length > MAX_EVIDENCE_SIZE) continue;
    out.push(item);
  }
  return out;
}

function listUsers() {
  return qListUsers.all().map(u => ({
    nick: u.nick,
    banned: !!u.banned,
    admin: !!u.is_admin,
    online: isOnline(u.nick),
    devices: deviceCount(u.nick),
    messages: u.messages,
    createdAt: u.created_at,
    bannedAt: u.banned_at || null,
    banReason: u.ban_reason || null,
    // Только количество: сами картинки запрашиваются отдельно
    evidence: countEvidence(u.ban_evidence)
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
  // x-void-nick / x-void-pass носят учётные данные при потоковой загрузке:
  // тело там занято самим файлом, класть их туда больше некуда
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-void-nick, x-void-pass');
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

      const dev = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 64) : '';
      if (нуженКод(u.nick, dev)) {
        // Пароль верный, но этого устройства сервер ещё не знает.
        // Просим код отдельным ответом, чтобы клиент показал поле.
        if (!body.code) return json(401, { error: 'Нужен код из приложения', needCode: true });
        if (!принятьКод(u.nick, dev, body.code)) {
          return json(401, { error: 'Код не подходит', needCode: true });
        }
      }
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

      // Тот же барьер, что и на входе по паролю. Через интерфейс код на такой
      // аккаунт не включить, но дверь всё равно должна быть заперта на оба
      // замка: иначе включивший код через API вошёл бы мимо него по фразе.
      const dev = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 64) : '';
      if (нуженКод(row.nick, dev)) {
        if (!body.code) return json(401, { error: 'Нужен код из приложения', needCode: true });
        if (!принятьКод(row.nick, dev, body.code)) {
          return json(401, { error: 'Код не подходит', needCode: true });
        }
      }
      json(200, { ok: true, nick: row.nick });
    });
    return;
  }

  // ===== ВЛОЖЕНИЯ =====
  // Файл приходит уже зашифрованным ключом переписки. Сервер хранит набор
  // байтов и не знает ни имени файла, ни его содержимого — всё это лежит
  // внутри зашифрованного сообщения.
  if (req.method === 'POST' && url.pathname === '/api/blob/put') {
    if (!rateLimit('blobput:' + clientIp(req), 60, 600000)) {
      return json(429, { error: 'Слишком часто, подожди' });
    }

    // Новый способ: сырые байты в теле, учётные данные в заголовках.
    // Файл нигде не собирается целиком — ни строкой, ни буфером.
    if (String(req.headers['content-type'] || '').startsWith('application/octet-stream')) {
      // Пока не повешен обработчик 'data', поток стоит на месте: успеваем
      // проверить пароль, не приняв ни байта от неизвестного.
      (async () => {
        // Отказ на середине загрузки. Порядок важен: сперва ответ, и только
        // после того, как он ушёл в сеть, — обрыв. Наоборот нельзя: клиент
        // получит сброс соединения и покажет «нет связи» вместо причины.
        const отказать = (код, текст) => {
          req.pause();                       // остальное тело нам уже не нужно
          res.setHeader('Connection', 'close');
          json(код, { error: текст });
          res.on('finish', () => req.destroy());
        };

        const u = await verifyUser(req.headers['x-void-nick'], req.headers['x-void-pass']);
        if (!u) return отказать(401, 'Неверный ник или пароль');
        if (u.banned) return отказать(403, 'Аккаунт заблокирован');

        const занято = qBlobUsage.get(u.nick).total;
        const остаток = Math.min(MAX_BLOB, BLOB_QUOTA - занято);
        if (остаток <= 0) return отказать(413, 'Превышен объём вложений');

        const id = crypto.randomBytes(24).toString('hex');
        const времянка = path.join(BLOB_TMP, id);
        const поток = fs.createWriteStream(времянка);
        let принято = 0, сорвалось = false;

        const сдаться = (код, текст) => {
          if (сорвалось) return;
          сорвалось = true;
          поток.destroy();
          try { fs.unlinkSync(времянка); } catch (e) {}
          отказать(код, текст);
        };

        req.on('data', кусок => {
          if (сорвалось) return;
          принято += кусок.length;
          // Обрываем на превышении, а не после: иначе предел ничего не защищает
          if (принято > остаток) {
            return сдаться(413, принято > MAX_BLOB ? 'Файл слишком большой' : 'Превышен объём вложений');
          }
          if (!поток.write(кусок)) { req.pause(); поток.once('drain', () => req.resume()); }
        });

        req.on('error', () => сдаться(400, 'Загрузка прервалась'));

        req.on('end', () => {
          if (сорвалось) return;
          поток.end(() => {
            if (!принято) { try { fs.unlinkSync(времянка); } catch (e) {} return json(400, { error: 'Пустое вложение' }); }
            try {
              fs.renameSync(времянка, blobPath(id));
              qPutBlobDisk.run(id, u.nick, принято, Date.now());
            } catch (e) {
              try { fs.unlinkSync(времянка); } catch (e2) {}
              console.error('[blob] Не удалось сохранить:', e.message);
              return json(500, { error: 'Ошибка сервера' });
            }
            console.log('[blob] Принято потоком', Math.round(принято / 1024), 'КБ от', u.nick);
            json(200, { ok: true, id, size: принято });
          });
        });
      })().catch(err => { console.error('[blob]', err.message); json(500, { error: 'Ошибка сервера' }); });
      return;
    }

    // Старый способ: base64 внутри JSON. Оставлен, чтобы вкладка, открытая
    // до обновления, не сломалась на первой же отправке.
    readBody(async (body) => {
      const u = await verifyUser(body.nick, body.password);
      if (!u) return json(401, { error: 'Неверный ник или пароль' });
      if (u.banned) return json(403, { error: 'Аккаунт заблокирован' });

      const b64 = typeof body.data === 'string' ? body.data : '';
      if (!b64) return json(400, { error: 'Пустое вложение' });
      let buf;
      try { buf = Buffer.from(b64, 'base64'); } catch (e) { return json(400, { error: 'Испорченное вложение' }); }
      if (!buf.length || buf.length > MAX_BLOB) {
        return json(413, { error: 'Файл слишком большой' });
      }
      // Ограничиваем общий объём на аккаунт, иначе диск можно забить
      const used = qBlobUsage.get(u.nick).total;
      if (used + buf.length > BLOB_QUOTA) {
        return json(413, { error: 'Превышен объём вложений' });
      }

      const id = crypto.randomBytes(24).toString('hex');
      qPutBlob.run(id, u.nick, buf, buf.length, Date.now());
      console.log('[blob] Принято', Math.round(buf.length / 1024), 'КБ от', u.nick);
      json(200, { ok: true, id, size: buf.length });
    }, MAX_BLOB_BODY);
    return;
  }

  // Опознаватель вложения — случайные 24 байта, угадать его нельзя.
  // Вход по аккаунту всё равно требуем, чтобы вложения нельзя было выкачивать
  // без учётной записи.
  if (req.method === 'POST' && url.pathname === '/api/blob/get') {
    if (!rateLimit('blobget:' + clientIp(req), 300, 600000)) {
      return json(429, { error: 'Слишком часто, подожди' });
    }
    readBody(async (body) => {
      const u = await verifyUser(body.nick, body.password);
      if (!u) return json(401, { error: 'Неверный ник или пароль' });
      if (u.banned) return json(403, { error: 'Аккаунт заблокирован' });

      const id = typeof body.id === 'string' ? body.id : '';
      if (!/^[0-9a-f]{48}$/.test(id)) return json(400, { error: 'Неверный опознаватель' });
      const мета = qBlobMeta.get(id);
      if (!мета) return json(404, { error: 'Вложение не найдено' });

      // Вложение лежит файлом — отдаём его потоком, не поднимая в память
      if (мета.on_disk) {
        const файл = blobPath(id);
        if (!fs.existsSync(файл)) return json(404, { error: 'Вложение не найдено' });
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': мета.size,
          'Cache-Control': 'no-store'
        });
        const поток = fs.createReadStream(файл);
        поток.on('error', () => res.destroy());
        res.on('close', () => поток.destroy());
        поток.pipe(res);
        return;
      }

      // Вложения, залитые до перехода на файлы, так и лежат в базе
      const row = qGetBlob.get(id);
      if (!row) return json(404, { error: 'Вложение не найдено' });
      json(200, { ok: true, data: Buffer.from(row.data).toString('base64'), size: row.size });
    });
    return;
  }

  // ===== ССЫЛКИ-ПРИГЛАШЕНИЯ =====
  // Позвать человека в Void было нельзя никак: приходилось диктовать адрес,
  // он заводил аккаунт, придумывал ник и сообщал его обратно. Четыре шага и
  // анкета вместо разговора. Теперь — одна ссылка: открыл и уже переписываешься.
  //
  // Опознаватель случайный и длинный: по ссылке переходят, её не набирают
  // руками, поэтому короткой её делать нельзя — короткую подберут.
  if (req.method === 'POST' && url.pathname === '/api/invite/new') {
    if (!rateLimit('invnew:' + clientIp(req), 30, 600000)) {
      return json(429, { error: 'Слишком часто, подожди' });
    }
    readBody(async (body) => {
      const u = await verifyUser(body.nick, body.password);
      if (!u) return json(401, { error: 'Неверный ник или пароль' });
      if (u.banned) return json(403, { error: 'Аккаунт заблокирован' });
      // Больше десятка живых приглашений одному человеку незачем
      try { qDropOldInvites.run(u.nick, u.nick); } catch (e) {}
      const код = crypto.randomBytes(16).toString('hex');
      qPutInvite.run(код, u.nick, Date.now());
      json(200, { ok: true, code: код, ttl: TTL_INVITE });
    });
    return;
  }

  // Открыли ссылку: говорим, кто зовёт. Приглашение при этом не тратится —
  // человек ещё ничего не решил, а показать имя надо до всякого согласия.
  if (req.method === 'POST' && url.pathname === '/api/invite/peek') {
    if (!rateLimit('invpeek:' + clientIp(req), 60, 600000)) {
      return json(429, { error: 'Слишком часто, подожди' });
    }
    readBody(async (body) => {
      const код = typeof body.code === 'string' ? body.code : '';
      if (!/^[0-9a-f]{32}$/.test(код)) return json(400, { error: 'Неверная ссылка' });
      const пр = qGetInvite.get(код);
      if (!пр || Date.now() - пр.created_at > TTL_INVITE) {
        return json(404, { error: 'Ссылка не действует — попроси новую' });
      }
      const кто = qUserByNick.get(пр.owner);
      if (!кто || кто.banned) return json(404, { error: 'Ссылка не действует' });
      json(200, { ok: true, from: кто.nick });
    });
    return;
  }

  // Согласился: приглашение гасится, чтобы по одной ссылке не заходила толпа
  if (req.method === 'POST' && url.pathname === '/api/invite/take') {
    if (!rateLimit('invtake:' + clientIp(req), 30, 600000)) {
      return json(429, { error: 'Слишком часто, подожди' });
    }
    readBody(async (body) => {
      const код = typeof body.code === 'string' ? body.code : '';
      if (!/^[0-9a-f]{32}$/.test(код)) return json(400, { error: 'Неверная ссылка' });
      const пр = qGetInvite.get(код);
      if (!пр || Date.now() - пр.created_at > TTL_INVITE) {
        return json(404, { error: 'Ссылка не действует — попроси новую' });
      }
      const кто = qUserByNick.get(пр.owner);
      if (!кто || кто.banned) return json(404, { error: 'Ссылка не действует' });
      qDropInvite.run(код);
      console.log('[invite] Приглашение от', кто.nick, 'принято');
      json(200, { ok: true, from: кто.nick });
    });
    return;
  }

  // ===== ПЕРЕВОД СТАРОГО ПАРОЛЯ НА ПРОПУСК =====
  // Раньше клиент присылал сам пароль, и им же был зашифрован закрытый ключ,
  // лежащий тут в базе. Сервер, записавший присланное, мог расшифровать всё.
  // Теперь клиент шлёт производное значение с другой солью — по нему ключ от
  // переписки не вывести. Но у заведённых раньше аккаунтов в базе лежит хеш
  // от старого пароля, и перевести их можно только один раз предъявив его.
  // После этого пароль на сервер не уходит больше никогда.
  if (req.method === 'POST' && url.pathname === '/api/account/upgrade-auth') {
    if (!rateLimit('upgrade:' + clientIp(req), 20, 600000)) {
      return json(429, { error: 'Слишком часто, подожди' });
    }
    readBody(async (body) => {
      const u = await verifyUser(body.nick, body.password);
      if (!u) return json(401, { error: 'Неверный ник или пароль' });
      if (u.banned) return json(403, { error: 'Аккаунт заблокирован' });
      const секрет = typeof body.newSecret === 'string' ? body.newSecret : '';
      if (!/^[0-9a-f]{64}$/.test(секрет)) return json(400, { error: 'Неверный пропуск' });
      try {
        qUpdateHash.run(await scryptHash(секрет), u.nick);
        console.log('[auth] Аккаунт переведён на пропуск:', u.nick);
      } catch (e) {
        console.error('[auth] Не удалось перевести:', e.message);
        return json(500, { error: 'Ошибка сервера' });
      }
      json(200, { ok: true });
    });
    return;
  }

  // ===== ВХОД ПО КОДУ (двухфакторная защита) =====
  // Тот же RFC 6238, что и у администратора, только теперь доступен всем.
  // Номер телефона для этого не нужен: код считает приложение на устройстве,
  // ему не нужны ни сеть, ни оператор, ни наша база с чьими-то номерами.
  if (req.method === 'POST' && url.pathname.startsWith('/api/totp/')) {
    if (!rateLimit('totp:' + clientIp(req), 30, 600000)) {
      return json(429, { error: 'Слишком часто, подожди' });
    }
    const действие = url.pathname.slice('/api/totp/'.length);
    readBody(async (body) => {
      const u = await verifyUser(body.nick, body.password);
      if (!u) return json(401, { error: 'Неверный ник или пароль' });
      if (u.banned) return json(403, { error: 'Аккаунт заблокирован' });
      const dev = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 64) : '';
      const row = qGetTotp.get(u.nick) || {};

      if (действие === 'status') {
        return json(200, { ok: true, enabled: !!row.totp_secret });
      }

      // Секрет живёт в pending, пока человек не докажет, что читает коды.
      // До этого вход остаётся прежним — ошибка при настройке не запирает.
      if (действие === 'setup') {
        if (row.totp_secret) return json(400, { error: 'Уже включено' });
        const secret = base32Encode(crypto.randomBytes(20));
        qSetPending.run(secret, u.nick);
        const uri = 'otpauth://totp/' + encodeURIComponent('Void:' + u.nick) +
                    '?secret=' + secret + '&issuer=Void&algorithm=SHA1&digits=6&period=30';
        return json(200, { ok: true, secret, uri });
      }

      if (действие === 'enable') {
        if (!row.totp_pending) return json(400, { error: 'Сначала запроси настройку' });
        const step = totpVerify(row.totp_pending, body.code, null);
        if (step === null) return json(400, { error: 'Код не подходит' });
        qEnableTotp.run(row.totp_pending, step, u.nick);
        // Устройство, с которого включили, доверяем сразу — иначе человек
        // тут же оказался бы заперт снаружи собственной настройкой.
        if (dev) {
          try { qUpsertDevice.run(u.nick, dev, 'Устройство', Date.now(), Date.now()); } catch (e) {}
          qTrustDevice.run(u.nick, dev);
        }
        console.log('[totp] Включена для', u.nick);
        return json(200, { ok: true, enabled: true });
      }

      // Выключить можно только с кодом на руках: иначе укравший пароль
      // просто снял бы вторую дверь и вошёл.
      if (действие === 'disable') {
        if (!row.totp_secret) return json(200, { ok: true, enabled: false });
        const step = totpVerify(row.totp_secret, body.code, row.totp_last);
        if (step === null) return json(400, { error: 'Код не подходит' });
        qTotpLast.run(step, u.nick);
        qDisableTotp.run(u.nick);
        qUntrustAll.run(u.nick);
        console.log('[totp] Выключена для', u.nick);
        return json(200, { ok: true, enabled: false });
      }

      return json(404, { error: 'Неизвестное действие' });
    });
    return;
  }

  // Показывать ли, когда я был в сети
  if (req.method === 'POST' && url.pathname === '/api/account/privacy') {
    if (!rateLimit('priv:' + clientIp(req), 30, 600000)) {
      return json(429, { error: 'Слишком часто, подожди' });
    }
    readBody(async (body) => {
      const u = await verifyUser(body.nick, body.password);
      if (!u) return json(401, { error: 'Неверный ник или пароль' });
      if (typeof body.hidePresence === 'boolean') {
        qSetHide.run(body.hidePresence ? 1 : 0, u.nick);
        console.log('[privacy]', u.nick, body.hidePresence ? 'скрыл статус' : 'показывает статус');
      }
      const row = qGetHide.get(u.nick) || {};
      json(200, { ok: true, hidePresence: !!row.hide_presence });
    });
    return;
  }

  // ===== ЧЁРНЫЙ СПИСОК =====
  // Один вход на все три действия: показать список, добавить, убрать.
  // Список отдаём только владельцу — узнать, кто тебя заблокировал, нельзя.
  if (req.method === 'POST' && url.pathname === '/api/account/blocks') {
    if (!rateLimit('blocks:' + clientIp(req), 120, 600000)) {
      return json(429, { error: 'Слишком часто, подожди' });
    }
    readBody(async (body) => {
      const u = await verifyUser(body.nick, body.password);
      if (!u) return json(401, { error: 'Неверный ник или пароль' });
      if (u.banned) return json(403, { error: 'Аккаунт заблокирован' });

      const action = typeof body.action === 'string' ? body.action : 'list';
      const rawTarget = typeof body.target === 'string' ? body.target.trim() : '';

      if (action === 'add' || action === 'remove') {
        if (!rawTarget) return json(400, { error: 'Не указан ник' });
        // Приводим к каноническому виду: иначе «vasya» и «Vasya» дали бы
        // две разные записи, и блокировка обходилась бы сменой регистра
        const t = qNickExists.get(rawTarget);
        if (!t) return json(404, { error: 'Такого ника нет' });
        if (t.nick === u.nick) return json(400, { error: 'Себя блокировать незачем' });

        if (action === 'add') {
          if (qBlockCount.get(u.nick).n >= 500) return json(400, { error: 'Список переполнен' });
          qBlockAdd.run(u.nick, t.nick, Date.now());
          console.log('[blocks]', u.nick, 'заблокировал', t.nick);
        } else {
          qBlockDrop.run(u.nick, t.nick);
          console.log('[blocks]', u.nick, 'разблокировал', t.nick);
        }
      } else if (action !== 'list') {
        return json(400, { error: 'Неизвестное действие' });
      }

      json(200, { ok: true, blocked: qBlockList.all(u.nick).map(r => ({ nick: r.target, at: r.created_at })) });
    });
    return;
  }

  // ===== УВЕДОМЛЕНИЯ =====
  // Открытый ключ нужен браузеру, чтобы оформить подписку. Он публичный.
  if (req.method === 'GET' && url.pathname === '/api/push/key') {
    return json(200, { ok: true, key: vapidKeys ? vapidKeys.publicKey : null });
  }

  if (req.method === 'POST' && url.pathname === '/api/push/subscribe') {
    if (!rateLimit('push:' + clientIp(req), 30, 600000)) {
      return json(429, { error: 'Слишком часто, подожди' });
    }
    readBody(async (body) => {
      const u = await verifyUser(body.nick, body.password);
      if (!u) return json(401, { error: 'Неверный ник или пароль' });
      if (u.banned) return json(403, { error: 'Аккаунт заблокирован' });

      const sub = body.subscription || {};
      const dev = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 64) : '';
      const endpoint = typeof sub.endpoint === 'string' ? sub.endpoint : '';
      const keys = sub.keys || {};
      if (!dev || !endpoint || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') {
        return json(400, { error: 'Неполные данные подписки' });
      }
      if (endpoint.length > 700 || !/^https:\/\//.test(endpoint)) {
        return json(400, { error: 'Неверный адрес подписки' });
      }
      qAddPush.run(u.nick, dev, endpoint, keys.p256dh, keys.auth, Date.now());
      console.log('[push] Подписка оформлена:', u.nick);
      json(200, { ok: true });
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/push/unsubscribe') {
    readBody(async (body) => {
      const u = await verifyUser(body.nick, body.password);
      if (!u) return json(401, { error: 'Неверный ник или пароль' });
      const dev = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 64) : '';
      const removed = dev ? qDropPush.run(u.nick, dev).changes : qDropPushAll.run(u.nick).changes;
      json(200, { ok: true, removed });
    });
    return;
  }

  // ===== УДАЛЕНИЕ СОБСТВЕННОГО АККАУНТА =====
  // Требование Google Play: пользователь должен уметь удалить аккаунт сам,
  // без обращения к разработчику. Нужен только пароль владельца.
  if (req.method === 'POST' && url.pathname === '/api/account/delete') {
    if (!rateLimit('acctdel:' + clientIp(req), 5, 600000)) {
      return json(429, { error: 'Слишком много попыток, подожди' });
    }
    readBody(async (body) => {
      const u = await verifyUser(body.nick, body.password);
      if (!u) return json(401, { error: 'Неверный ник или пароль' });
      // Админ-аккаунт восстанавливается при запуске сервера, удалять его так
      // бессмысленно — только запутает
      if (u.is_admin) return json(400, { error: 'Этот аккаунт удалить нельзя' });

      const msgs = qDeleteMsgs.run(u.nick, u.nick).changes;
      qDropDevices.run(u.nick);
      qDropPushAll.run(u.nick);
      dropBlobFiles(qBlobIdsOf.all(u.nick));
      qDropBlobsOf.run(u.nick);
      try { qDropInvitesOf.run(u.nick); } catch (e) {}
      qBlockWipe.run(u.nick, u.nick);
      qDeleteUser.run(u.nick);
      kickUser(u.nick, 'deleted');
      console.log('[account] Удалён самим владельцем:', u.nick, '| сообщений удалено:', msgs);
      json(200, { ok: true, nick: u.nick, messagesDeleted: msgs });
    });
    return;
  }

  // ===== СМЕНА ПАРОЛЯ =====
  // Из пароля выводится ключ, которым зашифрован закрытый ключ переписки,
  // поэтому вместе с новым паролем клиент присылает его перешифрованную копию.
  // Сервер по-прежнему не может её прочитать — он лишь заменяет одну на другую.
  if (req.method === 'POST' && url.pathname === '/api/account/password') {
    if (!rateLimit('pwch:' + clientIp(req), 10, 600000)) {
      return json(429, { error: 'Слишком много попыток, подожди' });
    }
    readBody(async (body) => {
      const u = await verifyUser(body.nick, body.password);
      if (!u) return json(401, { error: 'Текущий пароль неверный' });
      if (u.banned) return json(403, { error: 'Аккаунт заблокирован' });

      const next = typeof body.newPassword === 'string' ? body.newPassword : '';
      if (next.length < 6 || next.length > 200) {
        return json(400, { error: 'Новый пароль: от 6 символов' });
      }
      if (next === body.password) {
        return json(400, { error: 'Новый пароль совпадает со старым' });
      }
      const encPriv = typeof body.encPrivateKey === 'string' ? body.encPrivateKey : null;
      if (encPriv !== null && encPriv.length > MAX_KEY) {
        return json(413, { error: 'Ключ слишком большой' });
      }

      const current = qGetMyKeys.get(u.nick) || {};
      // Если клиент прислал перешифрованный ключ — ставим его, иначе оставляем
      // прежний (он есть у аккаунтов, которые ещё не заводили ключи)
      qSetPassword.run(await scryptHash(next), encPriv !== null ? encPriv : (current.enc_private_key || null), u.nick);
      console.log('[account] Пароль изменён:', u.nick);
      json(200, { ok: true, nick: u.nick });
    }, MAX_KEY_BODY);
    return;
  }

  // ===== УСТРОЙСТВА НА АККАУНТЕ =====
  if (req.method === 'POST' && url.pathname === '/api/account/devices') {
    if (!rateLimit('dev:' + clientIp(req), 60, 600000)) {
      return json(429, { error: 'Слишком часто, подожди' });
    }
    readBody(async (body) => {
      const u = await verifyUser(body.nick, body.password);
      if (!u) return json(401, { error: 'Неверный ник или пароль' });
      if (u.banned) return json(403, { error: 'Аккаунт заблокирован' });
      const live = new Set(socketsOf(u.nick).map(w => w.deviceId));
      json(200, {
        ok: true,
        devices: qListDevices.all(u.nick).map(d => ({
          id: d.device_id,
          name: d.name || 'Устройство',
          online: live.has(d.device_id),
          firstSeen: d.created_at,
          lastSeen: d.last_seen
        }))
      });
    });
    return;
  }

  // Отключить устройство: оно потеряет связь и исчезнет из списка
  if (req.method === 'POST' && url.pathname === '/api/account/devices/revoke') {
    if (!rateLimit('dev:' + clientIp(req), 60, 600000)) {
      return json(429, { error: 'Слишком часто, подожди' });
    }
    readBody(async (body) => {
      const u = await verifyUser(body.nick, body.password);
      if (!u) return json(401, { error: 'Неверный ник или пароль' });
      if (u.banned) return json(403, { error: 'Аккаунт заблокирован' });
      const id = typeof body.deviceId === 'string' ? body.deviceId : '';
      if (!id) return json(400, { error: 'Не указано устройство' });

      const removed = qDropDevice.run(u.nick, id).changes;
      try { qDropPush.run(u.nick, id); } catch (e) {}   // и уведомления на него
      const kicked = kickDevice(u.nick, id, 'device-revoked');
      console.log('[device] Отключено', id.slice(0, 8), 'у', u.nick, kicked ? '(было на связи)' : '');
      json(200, { ok: true, removed: removed > 0, kicked });
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
    // К блокировке прикладываются скриншоты, поэтому её тело крупнее прочих
    const bodyLimit = action === 'ban' ? MAX_BAN_BODY : MAX_BODY;

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

      // Состояние сервера. Всё это раньше выяснялось через ssh: сколько места
      // на диске, не распухла ли база, прошла ли ночная копия. Данных о людях
      // здесь намеренно нет — только цифры о самой машине.
      if (action === 'health') {
        const б = п => { try { return fs.statSync(п).size; } catch (e) { return 0; } };
        const базаБайт = б(path.join(__dirname, 'void.db')) +
                         б(path.join(__dirname, 'void.db-wal')) +
                         б(path.join(__dirname, 'void.db-shm'));

        let диск = null;
        try {
          const s = fs.statfsSync(__dirname);
          диск = { всего: s.blocks * s.bsize, свободно: s.bavail * s.bsize };
        } catch (e) {}

        // Последняя резервная копия. Каталог задаётся при запуске скрипта,
        // поэтому проверяем и переменную окружения, и привычные места.
        let копия = null;
        const где = [process.env.VOID_BACKUP_DIR, '/var/backups/void',
                     path.join(__dirname, 'backups')].filter(Boolean);
        for (const каталог of где) {
          try {
            const папки = fs.readdirSync(каталог)
              .filter(и => /^\d{4}-\d{2}-\d{2}-\d{6}$/.test(и)).sort();
            if (!папки.length) continue;
            const п = path.join(каталог, папки[папки.length - 1]);
            копия = { когда: fs.statSync(п).mtimeMs, сколько: папки.length, где: каталог };
            break;
          } catch (e) {}
        }

        const счёт = зпр => { try { return db.prepare(зпр).get().c; } catch (e) { return null; } };
        return withSession(200, { ok: true, health: {
          аптайм: Math.round(process.uptime()),
          память: process.memoryUsage().rss,
          узел: process.version,
          диск,
          базаБайт,
          вложения: { штук: счёт('SELECT COUNT(*) c FROM blobs'),
                      байт: (() => { try { return db.prepare('SELECT COALESCE(SUM(size),0) c FROM blobs').get().c; } catch (e) { return 0; } })() },
          письма: { доставленных: счёт('SELECT COUNT(*) c FROM messages WHERE delivered = 1'),
                    ждут:        счёт('SELECT COUNT(*) c FROM messages WHERE delivered = 0') },
          аккаунтов: счёт('SELECT COUNT(*) c FROM users'),
          наСвязи: Object.values(online).reduce((s, набор) => s + набор.size, 0),
          копия,
          сроки: { доставленные: TTL_DELIVERED, недоставленные: TTL_PENDING, вложения: TTL_BLOB }
        } });
      }

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
        dropBlobFiles(qBlobIdsAll.all());
        const blobs = db.prepare('DELETE FROM blobs').run().changes;
        if (blobs) console.log('[admin] PURGE: удалено вложений:', blobs);
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
        if (target.banned) return withSession(200, { ok: true, nick: target.nick, banned: true, note: 'Уже заблокирован', users: listUsers() });
        const shots = cleanEvidence(body.evidence);
        qSetBan.run(1, Date.now(), reason, shots.length ? JSON.stringify(shots) : null, target.nick);
        // Доказательства получателю не отправляем: они для журнала модерации,
        // ему достаточно причины
        const kicked = kickUser(target.nick, 'banned', reason);
        console.log('[admin] BAN', target.nick, reason ? '(' + reason + ')' : '',
                    shots.length ? '| скриншотов: ' + shots.length : '', kicked ? '| отключён' : '');
        return withSession(200, { ok: true, nick: target.nick, banned: true, kicked, evidence: shots.length, users: listUsers() });
      }

      // Картинки отдаём по одному аккаунту — в общий список они не влезают
      if (action === 'ban-evidence') {
        const row = qGetEvidence.get(target.nick) || {};
        let shots = [];
        try { shots = row.ban_evidence ? JSON.parse(row.ban_evidence) : []; } catch (e) {}
        return withSession(200, { ok: true, nick: target.nick, evidence: Array.isArray(shots) ? shots : [] });
      }

      if (action === 'unban') {
        if (!target.banned) return withSession(200, { ok: true, nick: target.nick, banned: false, note: 'Не был заблокирован', users: listUsers() });
        qSetBan.run(0, null, null, null, target.nick);
        console.log('[admin] UNBAN', target.nick);
        return withSession(200, { ok: true, nick: target.nick, banned: false, users: listUsers() });
      }

      if (action === 'delete') {
        // Полное удаление: ник освобождается и может быть занят заново.
        // Причину успеваем показать пользователю до отключения, а в базе её
        // хранить негде — аккаунта не остаётся, поэтому пишем в лог сервера.
        const msgs = qDeleteMsgs.run(target.nick, target.nick).changes;
        qDropDevices.run(target.nick);
        qDropPushAll.run(target.nick);
        dropBlobFiles(qBlobIdsOf.all(target.nick));
        qDropBlobsOf.run(target.nick);
        qBlockWipe.run(target.nick, target.nick);
        qDeleteUser.run(target.nick);
        const kicked = kickUser(target.nick, 'deleted', reason);
        console.log('[admin] DELETE', target.nick, reason ? '(' + reason + ')' : '', '| сообщений удалено:', msgs);
        return json(200, { ok: true, nick: target.nick, deleted: true, messagesDeleted: msgs, kicked, users: listUsers() });
      }

      json(404, { error: 'Неизвестное действие' });
    }, bodyLimit);
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
    if (nick) {
      // Запоминаем момент ухода, чтобы собеседник видел «был недавно»
      try { qTouchSeen.run(Date.now(), nick); } catch (e) {}
      removeOnline(nick, ws);
      console.log('[close]', nick, '| всего онлайн:', Object.keys(online).length);
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

        // Двухфакторка проверяется и здесь, а не только на входе по HTTP:
        // иначе её обходили бы, подключаясь к сокету напрямую с одним паролем.
        {
          const dev0 = msg.device && typeof msg.device === 'object' ? msg.device : {};
          const devId = typeof dev0.id === 'string' ? dev0.id.slice(0, 64) : '';
          if (нуженКод(canon, devId) && !принятьКод(canon, devId, msg.code)) {
            console.log('[auth] Нужен код:', canon);
            send({ type: 'auth-fail', error: 'totp' });
            return;
          }
        }

        goOffline();                      // сбрасываем прошлую личность этого сокета
        nick = canon;

        // Запоминаем устройство. Вход со второго устройства больше не выбивает
        // первое — оба остаются на связи, как в обычном мессенджере.
        const dev = msg.device && typeof msg.device === 'object' ? msg.device : {};
        ws.deviceId = typeof dev.id === 'string' && dev.id.length >= 8 && dev.id.length <= 64
          ? dev.id : crypto.randomUUID();
        const devName = typeof dev.name === 'string' ? dev.name.trim().slice(0, 60) : '';
        const nowTs = Date.now();
        try { qUpsertDevice.run(nick, ws.deviceId, devName || 'Устройство', nowTs, nowTs); }
        catch (e) { console.error('[device]', e.message); }

        addOnline(nick, ws);
        try { qTouchSeen.run(nowTs, nick); } catch (e) {}
        send({ type: 'auth-ok', nick, admin: u.is_admin, device: ws.deviceId });
        console.log('[auth] OK for', nick, '|', devName || 'устройство', '| всего онлайн:', Object.keys(online).length);

        // Что из написанного этим человеком уже прочитали, пока его не было
        const readRows = qReadSync.all(nick);
        if (readRows.length) {
          send({ type: 'dm-read-sync', items: readRows.map(r => ({ mid: r.mid, peer: r.to_nick })) });
        }

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

        // Получатель внёс отправителя в чёрный список. Письмо не доставляется и
        // не сохраняется — оно не долежит до разблокировки. Отправителю об этом
        // не сообщаем: иначе блокировка сама себя выдавала бы, и человек просто
        // завёл бы второй ник. Для него всё выглядит как «ушло, но не прочли».
        if (isBlocked(toNick, nick)) {
          const ts = Date.now();
          // На другие свои устройства отголосок всё же шлём: это его
          // собственный текст, и на втором телефоне переписка должна совпадать
          const selfEcho = JSON.stringify({ type: 'dm-echo', to: toNick, text, timestamp: ts,
            mid: typeof msg.mid === 'string' ? msg.mid : crypto.randomUUID() });
          for (const ows of socketsOf(nick)) {
            if (ows === ws || ows.readyState !== 1) continue;
            try { ows.send(selfEcho); } catch (e) {}
          }
          console.log('[dm] Dropped (blocked)', nick, '->', toNick);
          send({ type: 'dm-ack', to: toNick, timestamp: ts, delivered: 0 });
          return;
        }

        const timestamp = Date.now();
        // Повторный опознаватель сломал бы правку и удаление: они задели бы
        // сразу два сообщения, поэтому при совпадении выдаём свой
        let mid = typeof msg.mid === 'string' && msg.mid.length >= 8 && msg.mid.length <= 40 ? msg.mid : null;
        if (!mid || qMidExists.get(mid)) mid = crypto.randomUUID();
        // Помечаем доставленным только если запись хотя бы в один сокет удалась:
        // раньше при сбое отправки сообщение считалось доставленным и пропадало
        const payload = JSON.stringify({ type: 'dm', from: nick, text, timestamp, mid });
        let live = false;
        for (const rws of socketsOf(toNick)) {
          if (rws.readyState !== 1) continue;
          try { rws.send(payload); live = true; }
          catch (e) { console.error('[dm] Не удалось отправить', toNick + ':', e.message); }
        }

        // Отголосок на другие устройства отправителя: иначе на втором телефоне
        // не было бы того, что он написал с первого
        const echo = JSON.stringify({ type: 'dm-echo', to: toNick, text, timestamp, mid });
        for (const ows of socketsOf(nick)) {
          if (ows === ws || ows.readyState !== 1) continue;
          try { ows.send(echo); } catch (e) {}
        }

        qInsertMsg.run(nick, toNick, text, timestamp, live ? 1 : 0, mid);
        console.log(live ? '[dm] Delivered' : '[dm] Stored (offline)', nick, '->', toNick);
        // Приложение закрыто — доводим до сведения уведомлением.
        // Текст зашифрован и серверу неизвестен, поэтому шлём только имя.
        if (!live) notifyOffline(toNick, { from: nick, at: timestamp });
        send({ type: 'dm-ack', to: toNick, timestamp, delivered: live ? 1 : 0 });
        return;
      }

      // --- Кто из собеседников на связи ---
      if (msg.type === 'presence') {
        if (!nick) return;
        if (!rateLimit('presence:' + nick, 120, 60000)) return;
        const nicks = Array.isArray(msg.nicks)
          ? msg.nicks.filter(n => typeof n === 'string' && n.trim()).slice(0, 50)
          : [];
        const items = [];
        for (const n of nicks) {
          const row = qPresence.get(n.trim());
          if (!row) continue;
          // Человек мог закрыть свой статус или занести спрашивающего
          // в чёрный список — в обоих случаях не говорим ничего
          if (row.hide_presence || isBlocked(row.nick, nick)) {
            items.push({ nick: row.nick, hidden: true });
            continue;
          }
          items.push({ nick: row.nick, online: isOnline(row.nick), lastSeen: row.last_seen || null });
        }
        send({ type: 'presence', items });
        return;
      }

      // --- Прочитано ---
      if (msg.type === 'dm-read') {
        if (!nick) return;
        if (!rateLimit('dmread:' + nick, 120, 10000)) return;
        const to = typeof msg.to === 'string' ? msg.to.trim() : '';
        const mids = Array.isArray(msg.mids)
          ? msg.mids.filter(m => typeof m === 'string' && m.length <= 40).slice(0, 200)
          : [];
        if (!to || !mids.length) return;
        const target = qNickExists.get(to);
        if (!target) return;

        // Помечаем только письма, написанные этим автором именно читателю
        for (const m of mids) { try { qMarkRead.run(m, nick, target.nick); } catch (e) {} }

        // Сообщаем автору на все его устройства
        const note = JSON.stringify({ type: 'dm-read', from: nick, mids });
        for (const w of socketsOf(target.nick)) {
          if (w.readyState === 1) { try { w.send(note); } catch (e) {} }
        }
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
        const delMsg = JSON.stringify({ type: 'dm-delete', from: nick, mid });
        for (const w of socketsOf(target.nick)) { if (w.readyState === 1) { try { w.send(delMsg); } catch (e) {} } }
        // и на прочие устройства автора
        const delEcho = JSON.stringify({ type: 'dm-delete-echo', to: target.nick, mid });
        for (const w of socketsOf(nick)) { if (w !== ws && w.readyState === 1) { try { w.send(delEcho); } catch (e) {} } }
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
        const editMsg = JSON.stringify({ type: 'dm-edit', from: nick, mid, text });
        for (const w of socketsOf(target.nick)) { if (w.readyState === 1) { try { w.send(editMsg); } catch (e) {} } }
        const editEcho = JSON.stringify({ type: 'dm-edit-echo', to: target.nick, mid, text });
        for (const w of socketsOf(nick)) { if (w !== ws && w.readyState === 1) { try { w.send(editEcho); } catch (e) {} } }
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
function подмести() {
  try {
    const now = Date.now();
    const a = db.prepare('DELETE FROM messages WHERE delivered = 1 AND timestamp < ?').run(now - TTL_DELIVERED);
    const b = db.prepare('DELETE FROM messages WHERE delivered = 0 AND timestamp < ?').run(now - TTL_PENDING);
    try { db.prepare('DELETE FROM invites WHERE created_at < ?').run(now - TTL_INVITE); } catch (e) {}
    dropBlobFiles(qBlobIdsOld.all(now - TTL_BLOB));
    const c = db.prepare('DELETE FROM blobs WHERE created_at < ?').run(now - TTL_BLOB);
    if (a.changes || b.changes) console.log('[cleanup] Удалено сообщений:', a.changes + b.changes);
    if (c.changes) console.log('[cleanup] Удалено вложений:', c.changes);
  } catch (e) {
    console.error('[cleanup]', e.message);
  }
}

// Подметаем сразу при запуске, а не через шесть часов: иначе после каждого
// перезапуска просроченные записи ещё полсмены лежат в базе.
подмести();
const cleanup = setInterval(подмести, 6 * 3600000);
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
initPush();
ensureAdmin().finally(() => {
  server.listen(PORT, () => console.log('VOID server running on :' + PORT));
});

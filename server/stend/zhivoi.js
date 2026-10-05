#!/usr/bin/env node
// Живой стенд: настоящий клиент Void на настоящем сервере, управляемый из
// командной строки. Нужен, чтобы проверять то, что видно только вживую —
// nginx, сертификаты, доставку писем через настоящий сервер, — и чтобы
// владелец мог переписываться с проверяющим аккаунтом.
//
// Ничего своего здесь не шифруется и не отправляется: скрипт открывает
// index.html в безголовом Chromium и жмёт те же функции, что и человек.
// Регистрация, ключи, сквозное шифрование — всё делает сам клиент.
//
//   VOID_PASS=... node zhivoi.js читать
//   VOID_PASS=... node zhivoi.js написать "текст"
//   VOID_PASS=... node zhivoi.js голосовое запись.webm [секунд]
//   VOID_PASS=... node zhivoi.js файл путь/к/файлу
//   VOID_PASS=... node zhivoi.js снимок
//   VOID_PASS=... node zhivoi.js завести          (создать аккаунт, один раз)
//
// Переменные: VOID_NICK (по умолчанию claude_code), VOID_PASS (обязательно,
// в репозитории его нет и быть не должно), VOID_TO (кому писать, по
// умолчанию Void), VOID_URL (по умолчанию https://voidm.site),
// CHROME_PATH (если Chromium лежит не там, где ищет playwright).
//
// Установка рядом со скриптом: npm i playwright ws
// (package.json в репозитории не хранится — см. .gitignore).
//
// Почему история не видна между запусками: каждый запуск — чистое
// устройство. Сервер отдаёт только то, что накопилось, пока нас не было;
// своё отправленное после выхода не видно. Так устроен Void, не скрипт.
const { chromium } = require('playwright');
const http = require('http'), tls = require('tls'), fs = require('fs'), path = require('path');
const WebSocket = require('ws');

const НИК   = process.env.VOID_NICK || 'claude_code';
const ПАРОЛЬ = process.env.VOID_PASS || '';
const КОМУ  = process.env.VOID_TO || 'Void';
const САЙТ  = (process.env.VOID_URL || 'https://voidm.site').replace(/\/$/, '');
const [КОМАНДА, ...АРГ] = process.argv.slice(2);

if (!ПАРОЛЬ) { console.error('Нужен VOID_PASS'); process.exit(2); }
if (!КОМАНДА) { console.error('Команда: читать | написать | голосовое | файл | снимок | завести'); process.exit(2); }

// ===== ПРОКСИ =====
// Если наружу можно только через HTTPS-прокси (так устроен стенд у Claude),
// браузер не может держать через него WebSocket: рукопожатие получает 404.
// Тогда сокет подменяется — страница думает, что у неё WebSocket, а кадры
// ходят через Node, который сам строит туннель CONNECT и TLS до сервера.
// Без прокси подмена не нужна, браузер соединяется сам.
const ПРОКСИ = process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : null;
const CA = process.env.NODE_EXTRA_CA_CERTS && fs.existsSync(process.env.NODE_EXTRA_CA_CERTS)
  ? fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS) : undefined;

function черезПрокси(хост, порт) {
  return new Promise((готово, беда) => {
    const з = http.request({ host: ПРОКСИ.hostname, port: Number(ПРОКСИ.port), method: 'CONNECT',
                             path: хост + ':' + порт, headers: { Host: хост + ':' + порт } });
    з.on('connect', (ответ, сокет) => {
      if (ответ.statusCode !== 200) return беда(new Error('CONNECT ' + ответ.statusCode));
      const т = tls.connect({ socket: сокет, servername: хост, ca: CA }, () => готово(т));
      т.on('error', беда);
    });
    з.on('error', беда);
    з.setTimeout(10000, () => беда(new Error('прокси молчит')));
    з.end();
  });
}

async function подменитьСокет(p, журнал) {
  const сокеты = {};
  const событие = (id, тип, данные) =>
    p.evaluate(([id, тип, данные]) => window.__wsEvent(id, тип, данные), [id, тип, данные || '']).catch(() => {});
  await p.exposeFunction('__wsOpen', async (id, url) => {
    try {
      const u = new URL(url);
      const т = await черезПрокси(u.hostname, u.port || 443);
      const w = new WebSocket(url, { createConnection: () => т, headers: { Origin: САЙТ } });
      сокеты[id] = w;
      w.on('open', () => событие(id, 'open'));
      w.on('message', d => { const s = d.toString(); журнал.push('← ' + s.slice(0, 70)); событие(id, 'message', s); });
      w.on('close', () => { событие(id, 'close'); delete сокеты[id]; });
      w.on('error', e => { журнал.push('сокет: ' + e.message); событие(id, 'error'); });
    } catch (e) { журнал.push('сокет не открылся: ' + e.message); событие(id, 'error'); событие(id, 'close'); }
  });
  await p.exposeFunction('__wsSend', (id, данные) => { журнал.push('→ ' + String(данные).slice(0, 60)); сокеты[id]?.send(данные); });
  await p.exposeFunction('__wsClose', id => { try { сокеты[id]?.close(); } catch (e) {} });
  await p.addInitScript(() => {
    let n = 0; const все = {};
    class Подмена {
      constructor(url) { this.url = url; this.readyState = 0; this.id = ++n; все[this.id] = this;
        this.onopen = this.onmessage = this.onclose = this.onerror = null; window.__wsOpen(this.id, url); }
      send(d) { window.__wsSend(this.id, typeof d === 'string' ? d : String(d)); }
      close() { this.readyState = 2; window.__wsClose(this.id); }
      addEventListener(t, f) { this['on' + t] = f; }
    }
    Подмена.CONNECTING = 0; Подмена.OPEN = 1; Подмена.CLOSING = 2; Подмена.CLOSED = 3;
    window.WebSocket = Подмена;
    window.__wsEvent = (id, тип, данные) => {
      const s = все[id]; if (!s) return;
      if (тип === 'open') { s.readyState = 1; s.onopen && s.onopen({}); }
      else if (тип === 'message') { s.onmessage && s.onmessage({ data: данные }); }
      else if (тип === 'close') { s.readyState = 3; s.onclose && s.onclose({ code: 1000 }); }
      else if (тип === 'error') { s.onerror && s.onerror({}); }
    };
  });
  return () => { for (const w of Object.values(сокеты)) { try { w.terminate(); } catch (e) {} } };
}

// ===== ВХОД =====
async function открыть() {
  const запуск = { args: ['--disable-http2', '--disable-quic'] };
  if (process.env.CHROME_PATH) запуск.executablePath = process.env.CHROME_PATH;
  if (ПРОКСИ) { запуск.proxy = { server: ПРОКСИ.origin }; запуск.args.push('--ignore-certificate-errors'); }
  const b = await chromium.launch(запуск);
  // Service worker блокируем: он перезагружает страницу, когда видит новую
  // версию, и делает это посреди регистрации
  const ctx = await b.newContext({ viewport: { width: 390, height: 820 }, ignoreHTTPSErrors: !!ПРОКСИ, serviceWorkers: 'block' });
  const p = await ctx.newPage();
  const ошибки = [], журнал = [];
  p.on('pageerror', e => ошибки.push(String(e)));
  p.on('console', m => { const t = m.text(); if (/\[DM\]/.test(t)) журнал.push(t.slice(0, 100)); });
  const закрытьСокеты = ПРОКСИ ? await подменитьСокет(p, журнал) : () => {};
  await p.goto(САЙТ + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(2500);
  return { b, p, ошибки, журнал, закрыть: async () => { закрытьСокеты(); await b.close(); } };
}

async function войти(p, завести) {
  await p.evaluate(async ([н, пар, завести]) => {
    if (завести) {
      showSimpleRegForm();
      document.getElementById('sreg-nick').value = н;
      document.getElementById('sreg-pass').value = пар;
      const п2 = document.getElementById('sreg-pass2'); if (п2) п2.value = пар;
      await registerSimple();
    } else {
      showSimpleLoginForm();
      document.getElementById('slogin-nick').value = н;
      document.getElementById('slogin-pass').value = пар;
      await loginSimple();
    }
  }, [НИК, ПАРОЛЬ, !!завести]);
  await p.waitForTimeout(4000);
  for (let i = 0; i < 6 && await p.evaluate(() => document.getElementById('onboarding')?.style.display === 'flex'); i++) {
    await p.click('#ob-next-btn'); await p.waitForTimeout(500);
  }
  await p.waitForTimeout(завести ? 5000 : 2000);
  await p.evaluate(() => document.getElementById('fraza-overlay')?.remove());
  for (let i = 0; i < 20 && !(await p.evaluate(() => dmWsAuthOk)); i++) await p.waitForTimeout(1000);
  const кто = await p.evaluate(() => ({ я: myName, связь: dmWsAuthOk }));
  if (!кто.я || !кто.связь) throw new Error('Не вошёл: ' + JSON.stringify(кто));
  // Сервер отдаёт накопившееся сразу после auth-ok — даём ему досказать
  await p.waitForTimeout(4000);
  return кто;
}

async function открытьЧат(p) {
  await p.evaluate(н => { if (!chats[н]) chats[н] = { messages: [], color: '#FF6B4A', unread: 0 }; openChat(н); }, КОМУ);
  await p.waitForTimeout(2000);
}

// Ждём, пока последнее письмо перестанет быть «ждущим»
async function дождатьсяОтправки(p) {
  for (let i = 0; i < 15; i++) {
    const п = await p.evaluate(н => { const м = chats[н]?.messages || []; const п = м[м.length - 1] || {}; return { mid: !!п.mid, pending: !!п.pending, неУшло: !!п.неУшло }; }, КОМУ);
    if (п.mid && !п.pending) return п;
    await new Promise(r => setTimeout(r, 1000));
  }
  return await p.evaluate(н => { const м = chats[н]?.messages || []; const п = м[м.length - 1] || {}; return { mid: !!п.mid, pending: !!п.pending, неУшло: !!п.неУшло, тост: document.querySelector('.toast')?.textContent || '' }; }, КОМУ);
}

async function прочитать(p) {
  return p.evaluate(async () => {
    const из = {};
    for (const [кто, чат] of Object.entries(chats)) {
      из[кто] = [];
      for (const м of чат.messages) {
        let т = м.system ? '[система] ' + м.text : await decryptText(м.enc);
        const мета = м.system ? null : parseFileMeta(stripFwd(т).body);
        if (мета) т = (м.isVoice ? '[голосовое ' + (мета.dur || '?') + ' с]' : '[файл ' + (мета.name || '') + ', ' + (мета.size || 0) + ' Б]');
        else if (т.startsWith('__STICKER__')) т = '[стикер]';
        else if (т.startsWith('__SOS__')) т = '[аварийный сигнал]';
        из[кто].push({ от: м.own ? 'я' : кто, текст: т, когда: new Date(м.timestamp).toISOString(), прочитано: !!м.read });
      }
    }
    return из;
  });
}

// ===== КОМАНДЫ =====
(async () => {
  const с = await открыть();
  const { p } = с;
  try {
    const кто = await войти(p, КОМАНДА === 'завести');
    console.log('вошёл как @' + кто.я);

    if (КОМАНДА === 'читать' || КОМАНДА === 'завести') {
      console.log(JSON.stringify(await прочитать(p), null, 1));
    } else if (КОМАНДА === 'написать') {
      const текст = АРГ.join(' ');
      if (!текст) throw new Error('Пустое письмо');
      await открытьЧат(p);
      await p.fill('#msg-input', текст);
      await p.press('#msg-input', 'Enter');
      console.log('отправка:', JSON.stringify(await дождатьсяОтправки(p)));
    } else if (КОМАНДА === 'голосовое' || КОМАНДА === 'файл') {
      const файл = АРГ[0];
      if (!файл || !fs.existsSync(файл)) throw new Error('Нет файла: ' + файл);
      const голос = КОМАНДА === 'голосовое';
      const секунд = Number(АРГ[1]) || 2;
      const байты = fs.readFileSync(файл).toString('base64');
      const имя = голос ? 'Голосовое.' + path.extname(файл).slice(1) : path.basename(файл);
      const mime = голос ? 'audio/' + (path.extname(файл).slice(1) === 'ogg' ? 'ogg' : 'webm')
                         : ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.mp4': 'video/mp4', '.pdf': 'application/pdf', '.txt': 'text/plain' }[path.extname(файл).toLowerCase()] || 'application/octet-stream');
      await открытьЧат(p);
      // Ровно то, что делает клиент после остановки записи или выбора файла
      await p.evaluate(async ([б64, имя, mime, голос, секунд]) => {
        const байты = Uint8Array.from(atob(б64), c => c.charCodeAt(0));
        const file = new File([байты], имя, { type: mime });
        await sendFile({ target: { files: [file], value: '' } }, голос ? { dur: секунд, voice: 1 } : undefined);
      }, [байты, имя, mime, голос, секунд]);
      console.log('отправка:', JSON.stringify(await дождатьсяОтправки(p)));
    } else if (КОМАНДА === 'снимок') {
      await открытьЧат(p);
      await p.screenshot({ path: 'snimok.png', clip: { x: 0, y: 0, width: 390, height: 820 } });
      console.log('снимок: snimok.png');
    } else {
      throw new Error('Не знаю команду ' + КОМАНДА);
    }
    if (с.ошибки.length) console.log('ошибки страницы:', с.ошибки.slice(0, 3).join(' | '));
  } catch (e) {
    console.log('НЕ ВЫШЛО: ' + (e.message || e));
    console.log('журнал:\n' + с.журнал.slice(-12).join('\n'));
    process.exitCode = 1;
  } finally {
    await с.закрыть();
  }
})();

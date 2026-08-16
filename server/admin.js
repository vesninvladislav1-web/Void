#!/usr/bin/env node
// Управление аккаунтами VOID.
//
//   node admin.js list
//   node admin.js ban <ник> [причина]
//   node admin.js unban <ник>
//   node admin.js delete <ник>
//
// Пароль админа берётся из VOID_ADMIN_PASSWORD, иначе спрашивается в терминале.
// Работает через API, поэтому забаненный сразу отключается от сервера.

const readline = require('readline');

const HOST  = process.env.VOID_API || 'http://127.0.0.1:3000';
const NICK  = process.env.VOID_ADMIN_NICK || 'Void';
const [, , cmd, target, ...rest] = process.argv;

function askPassword() {
  if (process.env.VOID_ADMIN_PASSWORD) return Promise.resolve(process.env.VOID_ADMIN_PASSWORD);
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onData = c => {
      // Прячем ввод: перерисовываем строку без символов пароля
      if (['\n', '\r', ''].includes(c.toString())) return;
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write('Пароль админа: ');
    };
    process.stdin.on('data', onData);
    rl.question('Пароль админа: ', answer => {
      process.stdin.removeListener('data', onData);
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function call(action, body) {
  let res;
  try {
    res = await fetch(HOST + '/api/admin/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    console.error('Сервер недоступен по адресу ' + HOST + ' — запущен ли void-signal?');
    process.exit(1);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Ошибка: ' + (data.error || res.status));
    process.exit(1);
  }
  return data;
}

function usage() {
  console.log([
    'Использование:',
    '  node admin.js list                     список всех аккаунтов',
    '  node admin.js ban <ник> [причина]      заблокировать (ник остаётся занят)',
    '  node admin.js unban <ник>              разблокировать',
    '  node admin.js delete <ник>             удалить полностью вместе с перепиской'
  ].join('\n'));
}

(async () => {
  if (!cmd || !['list', 'ban', 'unban', 'delete'].includes(cmd)) { usage(); process.exit(1); }
  if (cmd !== 'list' && !target) { usage(); process.exit(1); }

  const password = await askPassword();
  const auth = { admin: NICK, password };

  if (cmd === 'list') {
    const { users } = await call('users', auth);
    if (!users.length) { console.log('Аккаунтов нет.'); return; }
    const pad = (s, n) => String(s).padEnd(n);
    console.log(pad('НИК', 18) + pad('СТАТУС', 16) + pad('СЕТЬ', 9) + 'СООБЩЕНИЙ');
    console.log('-'.repeat(56));
    users.forEach(u => {
      const state = u.admin ? 'админ' : u.banned ? 'ЗАБЛОКИРОВАН' : 'активен';
      console.log(pad(u.nick, 18) + pad(state, 16) + pad(u.online ? 'онлайн' : '—', 9) + u.messages);
      if (u.banned && u.banReason) console.log('  причина: ' + u.banReason);
    });
    return;
  }

  if (cmd === 'delete') {
    // Необратимо — просим подтвердить явным вводом ника
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(r =>
      rl.question('Удалить "' + target + '" НАВСЕГДА вместе с перепиской? Введи ник для подтверждения: ', a => { rl.close(); r(a); })
    );
    if (answer.trim() !== target) { console.log('Отменено.'); return; }
    const r = await call('delete', { ...auth, nick: target });
    console.log('Удалён: ' + r.nick + ' (сообщений удалено: ' + r.messagesDeleted + ')');
    return;
  }

  if (cmd === 'ban') {
    const r = await call('ban', { ...auth, nick: target, reason: rest.join(' ') || null });
    console.log(r.note ? r.nick + ': ' + r.note : 'Заблокирован: ' + r.nick + (r.kicked ? ' (отключён от сервера)' : ''));
    return;
  }

  const r = await call('unban', { ...auth, nick: target });
  console.log(r.note ? r.nick + ': ' + r.note : 'Разблокирован: ' + r.nick);
})().catch(e => { console.error(e.message); process.exit(1); });

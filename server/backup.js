// Резервная копия Void.
//
//   node server/backup.js [куда] [сколько хранить]
//   node server/backup.js /var/backups/void 7
//
// Копировать void.db простым cp нельзя: база работает в режиме WAL, и часть
// свежих записей в этот момент лежит не в ней, а в void.db-wal. Скопированный
// на ходу файл может оказаться битым. Поэтому база снимается через штатный
// механизм SQLite, который дожидается согласованного состояния.
//
// Вложения с сегодняшнего дня лежат отдельными файлами в server/blobs, и одной
// базы для восстановления больше не достаточно. Они складываются жёсткими
// ссылками: файл вложения никогда не меняется — его либо добавляют, либо
// удаляют, — поэтому ссылка на него всегда верна, места не занимает и
// копируется мгновенно. Если ссылку сделать нельзя (копия на другом диске),
// файл честно копируется.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const КУДА = process.argv[2] || path.join(__dirname, 'backups');
const ХРАНИТЬ = Number(process.argv[3]) || 7;
const БАЗА = path.join(__dirname, 'void.db');
const ВЛОЖЕНИЯ = process.env.VOID_BLOB_DIR || path.join(__dirname, 'blobs');

const метка = () => {
  const d = new Date(), дв = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${дв(d.getMonth() + 1)}-${дв(d.getDate())}-${дв(d.getHours())}${дв(d.getMinutes())}${дв(d.getSeconds())}`;
};

const размер = байт => байт > 1073741824 ? (байт / 1073741824).toFixed(2) + ' ГБ'
                     : байт > 1048576   ? (байт / 1048576).toFixed(1) + ' МБ'
                     : (байт / 1024).toFixed(0) + ' КБ';

async function main() {
  if (!fs.existsSync(БАЗА)) { console.error('Базы нет:', БАЗА); process.exit(1); }

  const папка = path.join(КУДА, метка());
  if (fs.existsSync(папка)) { console.error('Такая копия уже есть:', папка); process.exit(1); }
  fs.mkdirSync(папка, { recursive: true });

  // ===== база =====
  const db = new Database(БАЗА, { readonly: true });
  await db.backup(path.join(папка, 'void.db'));
  db.close();
  const базаБайт = fs.statSync(path.join(папка, 'void.db')).size;
  console.log('база:', размер(базаБайт));

  // ===== вложения =====
  let файлов = 0, вложБайт = 0, скопировано = 0;
  if (fs.existsSync(ВЛОЖЕНИЯ)) {
    const куда = path.join(папка, 'blobs');
    fs.mkdirSync(куда, { recursive: true });
    for (const имя of fs.readdirSync(ВЛОЖЕНИЯ)) {
      const откуда = path.join(ВЛОЖЕНИЯ, имя);
      let st;
      try { st = fs.statSync(откуда); } catch (e) { continue; }
      if (!st.isFile()) continue;          // tmp — каталог недописанных загрузок
      try {
        fs.linkSync(откуда, path.join(куда, имя));
      } catch (e) {
        fs.copyFileSync(откуда, path.join(куда, имя));
        скопировано++;
      }
      файлов++; вложБайт += st.size;
    }
  }
  console.log('вложений:', файлов, 'на', размер(вложБайт) +
    (скопировано ? ` (из них скопировано полностью: ${скопировано})` : ' (жёсткими ссылками, места не заняли)'));

  // ===== чистка старых =====
  const копии = fs.readdirSync(КУДА)
    .filter(и => /^\d{4}-\d{2}-\d{2}-\d{6}$/.test(и))
    .sort();
  const лишние = копии.slice(0, Math.max(0, копии.length - ХРАНИТЬ));
  for (const и of лишние) {
    fs.rmSync(path.join(КУДА, и), { recursive: true, force: true });
    console.log('удалена старая копия:', и);
  }

  console.log('готово:', папка);
  console.log('копий хранится:', Math.min(копии.length, ХРАНИТЬ), 'из', ХРАНИТЬ);
}

main().catch(err => { console.error('Копия не удалась:', err.message); process.exit(1); });

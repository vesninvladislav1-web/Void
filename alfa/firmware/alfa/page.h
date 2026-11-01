// Страничка, которую отдаёт плата: http://alfa.local
// Вид — приборная панель Альфы: круглый прибор со стрелкой (время прогрева), окошко одометра
// с семисегментными цифрами (рисуются сами, без шрифтов из интернета), контрольные лампы,
// кнопки как на руле. Карта поездок — Leaflet и OpenStreetMap (телефон в домашнем Wi-Fi, интернет есть).
#pragma once
const char PAGE_HTML[] PROGMEM = R"rawliteral(<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#34373B">
<title>Альфа</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&display=swap">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<style>
  :root {
    --пластик: #34373B; --пластик-шов: #26282B; --шкала: #0E0F10; --хром-светлый: #D6DADE; --хром-тёмный: #6C7177;
    --стрелка: #FF5A1F; --жк: #A3B38C; --жк-сегмент: #1E2A1B; --текст: #E9ECEE; --тихий: #9BA1A7;
    --зелёная: #3BE36E; --янтарная: #FFB21E; --красная: #FF3B30; --синяя: #3D8BFF;
    --шрифт: 'Barlow Condensed', 'Roboto Condensed', 'Arial Narrow', system-ui, sans-serif;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin: 0; color: var(--текст); font: 500 17px/1.35 var(--шрифт); letter-spacing: .2px;
    background: var(--пластик) radial-gradient(120% 60% at 50% 0%, #3E4246 0%, var(--пластик) 60%);
    padding: calc(14px + env(safe-area-inset-top)) 16px 28px; min-height: 100vh; }
  main { max-width: 460px; margin: 0 auto; }
  :focus-visible { outline: 3px solid var(--янтарная); outline-offset: 3px; }

  /* ---------- прибор ---------- */
  .прибор { position: relative; width: min(100%, 340px); aspect-ratio: 1; margin: 4px auto 0; }
  .прибор svg { width: 100%; height: 100%; display: block; }
  #стрелка { transform-origin: 150px 150px; transition: transform .8s cubic-bezier(.3, 1.4, .5, 1); }
  @media (prefers-reduced-motion: reduce) { #стрелка { transition: none; } }
  .окно { position: absolute; left: 50%; top: 59%; transform: translateX(-50%); width: 37%; padding: 6px 8px 5px;
    background: var(--жк); border-radius: 4px; box-shadow: inset 0 2px 6px rgba(0,0,0,.45), 0 0 0 2px #1A1C1E; text-align: right; }
  .окно .стр { display: flex; justify-content: space-between; align-items: center; gap: 6px; color: var(--жк-сегмент); font-size: 12px; font-weight: 600; }
  .окно svg.цифры { height: 22px; width: auto; }
  .окно .стр + .стр svg.цифры { height: 15px; }
  .режим { text-align: center; font-size: 22px; font-weight: 700; margin: 4px 0 0; min-height: 1.3em; }
  .режим.грею { color: var(--зелёная); }
  .причина { text-align: center; color: var(--тихий); min-height: 1.35em; margin: 0 0 10px; }

  /* ---------- лампы ---------- */
  .лампы { display: flex; justify-content: center; gap: 18px; padding: 10px 0 14px; border-top: 1px solid var(--пластик-шов); border-bottom: 1px solid #45494E; }
  .лампа { display: flex; flex-direction: column; align-items: center; gap: 4px; font-size: 13px; color: var(--тихий); min-width: 54px; }
  .лампа i { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; font: 700 16px/1 var(--шрифт); font-style: normal;
    background: #1B1D1F; color: #3A3E42; box-shadow: inset 0 1px 3px rgba(0,0,0,.7); }
  .лампа.горит i { color: #0B0C0D; box-shadow: 0 0 12px var(--свет), inset 0 0 6px rgba(255,255,255,.5); background: var(--свет); }
  .лампа[hidden] { display: none; }

  /* ---------- руль: стартер и выключатель ---------- */
  .руль { display: grid; grid-template-columns: 1.4fr 1fr; gap: 12px; margin: 18px 0 6px; }
  .руль button { height: 64px; border: 0; border-radius: 12px; font: 700 20px var(--шрифт); cursor: pointer; }
  #грей { background: linear-gradient(#4A4E53, #2B2E31); color: var(--текст); box-shadow: inset 0 1px 0 rgba(255,255,255,.12), 0 3px 0 #1A1C1E; }
  #грей:active { transform: translateY(2px); box-shadow: inset 0 1px 0 rgba(255,255,255,.1), 0 1px 0 #1A1C1E; }
  #стоп { background: linear-gradient(#FF4D3A, #C42418); color: #fff; box-shadow: inset 0 1px 0 rgba(255,255,255,.3), 0 3px 0 #7E140C; }
  #стоп:active { transform: translateY(2px); box-shadow: 0 1px 0 #7E140C; }
  button:disabled { opacity: .4; cursor: default; }
  .подсказка { color: var(--тихий); font-size: 14px; margin: 0 0 6px; }

  /* ---------- разделы ---------- */
  h2 { font: 700 21px var(--шрифт); margin: 26px 0 8px; padding-top: 14px; border-top: 1px solid var(--пластик-шов); box-shadow: 0 -1px 0 #45494E; }
  .то { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; align-items: center; padding: 9px 0; }
  .то + .то { border-top: 1px dashed #4A4E53; }
  .то .имя { font-size: 18px; } .то .когда { color: var(--тихий); font-size: 14px; }
  .то.скоро .когда { color: var(--янтарная); } .то.пора .когда { color: var(--красная); font-weight: 700; }
  .то .шкала { grid-column: 1 / -1; height: 4px; background: #232528; border-radius: 2px; overflow: hidden; }
  .то .шкала b { display: block; height: 100%; background: var(--зелёная); }
  .то.скоро .шкала b { background: var(--янтарная); } .то.пора .шкала b { background: var(--красная); }
  .то button, .мал { height: 36px; padding: 0 14px; border-radius: 8px; border: 1px solid #5A5F65; background: transparent; color: var(--текст); font: 600 16px var(--шрифт); cursor: pointer; }
  .поездка { width: 100%; text-align: left; display: grid; grid-template-columns: auto 1fr; gap: 0 14px; align-items: baseline; padding: 10px 0; background: none; border: 0; color: inherit; font: inherit; cursor: pointer; }
  .поездка + .поездка { border-top: 1px dashed #4A4E53; }
  .поездка strong { font-size: 24px; font-weight: 700; min-width: 70px; } .поездка span { color: var(--тихий); }
  .пусто { color: var(--тихий); }
  #карта { height: 320px; border-radius: 10px; margin-top: 10px; display: none; box-shadow: 0 0 0 2px #1A1C1E; }
  details { margin-top: 24px; border-top: 1px solid var(--пластик-шов); box-shadow: 0 -1px 0 #45494E; padding-top: 12px; }
  summary { font-size: 19px; font-weight: 700; cursor: pointer; }
  .поле { display: flex; gap: 10px; align-items: center; margin: 10px 0; }
  .поле input[type=password], select { background: #1E2022; color: var(--текст); border: 1px solid #55595E; border-radius: 8px; height: 42px; padding: 0 10px; font: 600 17px var(--шрифт); }
  .поле input[type=password] { flex: 1; }
  input[type=checkbox] { width: 22px; height: 22px; accent-color: var(--янтарная); }
</style></head><body><main>

<div class="прибор" role="img" aria-label="Прибор: стрелка показывает, сколько минут прогрева осталось; в окошке пробег и моточасы">
  <svg viewBox="0 0 300 300" id="прибор"></svg>
  <div class="окно">
    <div class="стр"><span>км</span><span id="км"></span></div>
    <div class="стр"><span>ч</span><span id="часы"></span></div>
  </div>
</div>
<p class="режим" id="режим" role="status">Жду ответа от Альфы</p>
<p class="причина" id="причина"></p>

<div class="лампы">
  <div class="лампа" id="лN" style="--свет: var(--зелёная)"><i>N</i>нейтраль</div>
  <div class="лампа" id="лУпал" style="--свет: var(--красная)"><i>!</i>лежит</div>
  <div class="лампа" id="лGPS" style="--свет: var(--синяя)"><i>⌖</i><span id="спутники">GPS</span></div>
  <div class="лампа" id="лВорота" style="--свет: var(--янтарная)" hidden><i>▮</i>ворота</div>
  <div class="лампа" id="лАКБ" style="--свет: var(--янтарная)"><i>+</i><span id="акб">АКБ</span></div>
</div>

<div class="руль">
  <button id="грей">Прогреть 3 мин</button>
  <button id="стоп">Заглушить</button>
</div>
<p class="подсказка">Заводится только на нейтрали, стоя на подножке. Заглушить может кто угодно, завести — только с PIN.</p>

<h2>Обслуживание</h2>
<div id="то"></div>

<h2>Поездки</h2>
<div id="поездки"><p class="пусто">Загружаю журнал…</p></div>
<div id="карта"></div>

<details>
  <summary>Настройки</summary>
  <div class="поле"><input id="пин" type="password" inputmode="numeric" placeholder="PIN" aria-label="PIN"><button class="мал" id="пинКн">Запомнить PIN</button></div>
  <label class="поле">Прогрев <select id="минут"><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select> мин</label>
  <label class="поле"><input type="checkbox" id="ворота"> Не заводить при закрытых воротах гаража (нужен геркон)</label>
  <label class="поле"><input type="checkbox" id="подсос"> Стоит серва подсоса</label>
</details>
</main>

<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script>
const $ = id => document.getElementById(id);

// ---------- семисегментные цифры, как в окошке одометра: горящие сегменты тёмные, погасшие — бледные ----------
const СЕГ = { '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', '-': 'g', ' ': '' };
const ФОРМА = { a: '2,1 12,1 10,3 4,3', b: '12.5,1.5 12.5,11 11,12 10.5,3.5', c: '12.5,13 12.5,22.5 10.5,20.5 11,14', d: '2,23 12,23 10,21 4,21',
  e: '1.5,13 3,14 3.5,20.5 1.5,22.5', f: '1.5,1.5 3.5,3.5 3,10 1.5,11', g: '2.5,12 4,11 10,11 11.5,12 10,13 4,13' };
function цифры(текст, знаков) {
  const с = String(текст).padStart(знаков, ' ').slice(-знаков); let x = 0, о = '';
  for (let i = 0; i < с.length; i++) {
    const ch = с[i]; if (ch === '.') { о += `<circle cx="${x - 1.2}" cy="22.3" r="1.2" fill="currentColor"/>`; continue; }
    const горят = СЕГ[ch] || '';
    for (const s of 'abcdefg') о += `<polygon points="${ФОРМА[s].split(' ').map(p => { const [a, b] = p.split(','); return (+a + x) + ',' + b; }).join(' ')}" fill="currentColor" opacity="${горят.includes(s) ? 1 : .09}"/>`;
    x += 15;
  }
  return `<svg class="цифры" viewBox="0 0 ${x} 24" style="color: var(--жк-сегмент)">${о}</svg>`;
}

// ---------- прибор: шкала 0–5 минут прогрева на 270°, стрелка ----------
(function шкала() {
  const c = 150, R = 128; let о = '';
  о += `<defs><linearGradient id="хром" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#D6DADE"/><stop offset=".5" stop-color="#8D9298"/><stop offset="1" stop-color="#5E6369"/></linearGradient>
        <radialGradient id="лицо" cx=".5" cy=".38" r=".7"><stop offset="0" stop-color="#1D2023"/><stop offset="1" stop-color="#0E0F10"/></radialGradient></defs>`;
  о += `<circle cx="${c}" cy="${c}" r="146" fill="url(#хром)"/><circle cx="${c}" cy="${c}" r="138" fill="#1A1C1E"/><circle cx="${c}" cy="${c}" r="135" fill="url(#лицо)"/>`;
  const угол = м => (-135 + м / 5 * 270) * Math.PI / 180;
  for (let i = 0; i <= 20; i++) {
    const м = i / 4, a = угол(м), большая = i % 4 === 0, r1 = большая ? R - 16 : R - 9;
    о += `<line x1="${c + Math.sin(a) * r1}" y1="${c - Math.cos(a) * r1}" x2="${c + Math.sin(a) * R}" y2="${c - Math.cos(a) * R}" stroke="#F2F4F5" stroke-width="${большая ? 3.2 : 1.6}" stroke-linecap="round"/>`;
    if (большая) о += `<text x="${c + Math.sin(a) * (R - 32)}" y="${c - Math.cos(a) * (R - 32) + 8}" fill="#F2F4F5" font-family="Barlow Condensed, Arial Narrow, sans-serif" font-weight="600" font-size="24" text-anchor="middle">${м}</text>`;
  }
  о += `<text x="${c}" y="${c - 44}" fill="#9BA1A7" font-family="Barlow Condensed, Arial Narrow, sans-serif" font-size="15" text-anchor="middle">мин прогрева</text>`;
  о += `<text x="${c}" y="${c - 26}" fill="#F2F4F5" font-family="Barlow Condensed, Arial Narrow, sans-serif" font-weight="700" font-size="17" letter-spacing="3" text-anchor="middle">АЛЬФА</text>`;
  о += `<g id="стрелка" transform="rotate(-135 ${c} ${c})"><polygon points="${c - 3.5},${c + 18} ${c + 3.5},${c + 18} ${c + 1},${c - R + 10} ${c - 1},${c - R + 10}" fill="var(--стрелка)"/></g>`;
  о += `<circle cx="${c}" cy="${c}" r="11" fill="#2A2D30" stroke="#55595E" stroke-width="2"/>`;
  $('прибор').innerHTML = о;
})();
function стрелка(минут) { $('стрелка').setAttribute('transform', `rotate(${-135 + Math.max(0, Math.min(5, минут)) / 5 * 270} 150 150)`); }

// ---------- связь с платой ----------
let пин = ''; try { пин = localStorage.getItem('альфа.пин') || ''; } catch (e) {} $('пин').value = пин;
let настройкиПришли = false;
async function пост(путь, пар = {}) {
  const q = new URLSearchParams(Object.assign({ pin: пин }, пар));
  const о = await fetch(путь + '?' + q, { method: 'POST' }).catch(() => null);
  if (!о) return 'Альфа не отвечает. Проверь, что телефон в домашнем Wi-Fi.';
  if (о.status === 403) return 'PIN не подошёл. Введи его в настройках внизу.';
  return о.text();
}
const лампа = (id, горит) => $(id).classList.toggle('горит', !!горит);

async function обновить() {
  const о = await fetch('/api/state').then(r => r.json()).catch(() => null);
  if (!о) { $('режим').textContent = 'Альфа не отвечает'; $('причина').textContent = 'Телефон должен быть в домашнем Wi-Fi.'; return; }
  const мин = с => Math.floor(с / 60) + ':' + String(с % 60).padStart(2, '0');
  $('режим').textContent = о.warm === 'running' ? 'Греется, осталось ' + мин(о.left) : о.warm === 'starting' ? 'Заводится' : о.engine ? 'Мотор работает' : 'Заглушена';
  $('режим').className = 'режим' + (о.warm === 'running' ? ' грею' : '');
  $('причина').textContent = о.reason || '';
  стрелка(о.warm === 'running' ? о.left / 60 : 0);
  $('км').innerHTML = цифры(Math.floor(о.km).toString().padStart(5, '0'), 5);
  $('часы').innerHTML = цифры(о.hours.toFixed(1), 5);
  лампа('лN', о.neutral);
  лампа('лУпал', о.tilt >= 40); $('лУпал').hidden = о.tilt < 0;
  лампа('лGPS', о.gps); $('спутники').textContent = о.gps ? о.sats + ' спутн.' : 'GPS';
  $('лВорота').hidden = о.gate === 'off'; лампа('лВорота', о.gate === 'closed');
  лампа('лАКБ', о.volt < 11.8); $('акб').textContent = о.volt + ' В';
  $('грей').disabled = о.warm !== 'off';
  if (!настройкиПришли) { настройкиПришли = true; $('минут').value = о.settings.warm; $('ворота').checked = о.settings.gate; $('подсос').checked = о.settings.choke; подписьКнопки(); }
  $('то').innerHTML = о.service.map((с, i) => {
    const прКм = о.km - с.doneKm, прЧ = о.hours - с.doneHours;
    const доля = Math.max(с.km ? прКм / с.km : 0, с.hours ? прЧ / с.hours : 0);
    const ост = [с.km ? Math.max(0, Math.round(с.km - прКм)) + ' км' : '', с.hours ? Math.max(0, Math.round(с.hours - прЧ)) + ' ч' : ''].filter(Boolean).join(' или ');
    const кл = доля >= 1 ? 'пора' : доля > 0.8 ? 'скоро' : '';
    return `<div class="то ${кл}"><div><div class="имя">${с.name}</div><div class="когда">${доля >= 1 ? 'Пора сделать' : 'Через ' + ост}</div></div><button data-i="${i}">Сделано</button><div class="шкала"><b style="width:${Math.min(100, доля * 100)}%"></b></div></div>`;
  }).join('');
}
function подписьКнопки() { $('грей').textContent = 'Прогреть ' + $('минут').value + ' мин'; }

$('то').addEventListener('click', async e => { const i = e.target.dataset && e.target.dataset.i; if (i === undefined) return; if (confirm('Отметить, что сделано сейчас?')) { $('причина').textContent = await пост('/api/service', { i }); обновить(); } });
$('грей').addEventListener('click', async () => { if (!confirm('Нейтраль, на подножке, рядом никого? Прогреть ' + $('минут').value + ' мин?')) return; $('причина').textContent = await пост('/api/warm', { min: $('минут').value }); });
$('стоп').addEventListener('click', async () => { $('причина').textContent = await пост('/api/stop'); });
$('пинКн').addEventListener('click', () => { пин = $('пин').value.trim(); try { localStorage.setItem('альфа.пин', пин); } catch (e) {} $('причина').textContent = 'PIN запомнен'; });
for (const [id, к] of [['минут', 'warm'], ['ворота', 'gate'], ['подсос', 'choke']])
  $(id).addEventListener('change', async () => { const э = $(id); if (id === 'минут') подписьКнопки(); $('причина').textContent = await пост('/api/settings', { [к]: э.type === 'checkbox' ? (э.checked ? 1 : 0) : э.value }); });

// ---------- поездки ----------
let карта = null, линия = null;
async function поездки() {
  const т = await fetch('/api/trips').then(r => r.text()).catch(() => '');
  const ряды = т.trim().split('\n').filter(Boolean).map(с => с.split(',')).reverse();
  if (!ряды.length) { $('поездки').innerHTML = '<p class="пусто">Поездок пока нет. Заведи ключом и прокатись — трек запишется сам.</p>'; return; }
  $('поездки').innerHTML = ряды.map(([id, когда, км, макс, сек]) => `<button class="поездка" data-id="${+id}"><strong>${(+км).toFixed(1)} км</strong><span>до ${+макс} км/ч, ${Math.round(+сек / 60)} мин<br>${когда || 'время не определилось'}</span></button>`).join('');
}
$('поездки').addEventListener('click', async e => {
  const эл = e.target.closest('.поездка'); if (!эл || !window.L) return;
  const т = await fetch('/api/trip?id=' + эл.dataset.id).then(r => r.text()).catch(() => '');
  const точки = т.trim().split('\n').slice(1).map(с => с.split(',')).map(([, lat, lon]) => [+lat, +lon]).filter(([a, b]) => a && b);
  if (!точки.length) return;
  $('карта').style.display = 'block';
  if (!карта) { карта = L.map('карта'); L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(карта); }
  if (линия) линия.remove();
  линия = L.polyline(точки, { color: '#FF5A1F', weight: 4 }).addTo(карта);
  карта.fitBounds(линия.getBounds(), { padding: [20, 20] });
  $('карта').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
});
обновить(); поездки(); setInterval(обновить, 1000);
</script>
</body></html>)rawliteral";

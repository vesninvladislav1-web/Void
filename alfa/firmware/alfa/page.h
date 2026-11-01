// Страничка, которую отдаёт плата: http://alfa.local
// Карта поездок — Leaflet и OpenStreetMap (телефон в домашнем Wi-Fi, интернет есть).
#pragma once
const char PAGE_HTML[] PROGMEM = R"rawliteral(<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1A120C">
<title>Альфа</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<style>
  :root { --фон:#1A120C; --лист:#2A1E14; --текст:#F2E6CC; --тускл:#B9A887; --жёлт:#E8C84A; --красн:#D8342A; --зел:#4CAF50; }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  body { margin:0; background:var(--фон); color:var(--текст); font:15px/1.4 system-ui,sans-serif; padding:calc(12px + env(safe-area-inset-top)) 16px 24px; }
  h1 { margin:0 0 6px; color:var(--жёлт); font-size:22px; letter-spacing:1px; }
  h2 { margin:18px 0 6px; font-size:15px; color:var(--жёлт); letter-spacing:1px; }
  .лист { background:var(--лист); border-radius:14px; padding:10px 14px; margin:8px 0; }
  .сетка { display:grid; grid-template-columns:1fr 1fr; gap:6px 12px; }
  small { color:var(--тускл); display:block; font-size:11px; letter-spacing:1px; } b { font-size:19px; }
  .ряд { display:flex; gap:8px; flex-wrap:wrap; margin:8px 0; }
  button { border:0; border-radius:14px; height:52px; padding:0 16px; font:800 15px system-ui,sans-serif; cursor:pointer; flex:1; }
  button:disabled { opacity:.35; }
  .жёлт { background:var(--жёлт); color:#1E140A; } .серый { background:#3A2C20; color:var(--текст); } .красн { background:var(--красн); color:#fff; }
  #статус { font-size:24px; font-weight:900; } #статус.грею { color:var(--зел); } #причина { color:var(--тускл); min-height:1.3em; }
  .усл span { display:inline-block; margin:2px 6px 2px 0; padding:2px 8px; border-radius:10px; background:#3A2C20; font-size:13px; }
  .усл .да { background:#2E4A2E; } .усл .нет { background:#4A2020; }
  .то { margin:6px 0; } .то .полоса { height:8px; border-radius:4px; background:#3A2C20; overflow:hidden; margin:3px 0; }
  .то .полоса i { display:block; height:100%; background:var(--зел); } .то.скоро .полоса i { background:var(--жёлт); } .то.пора .полоса i { background:var(--красн); }
  .то .стр { display:flex; justify-content:space-between; align-items:center; gap:8px; } .то button { flex:0 0 auto; height:32px; font-size:12px; border-radius:10px; }
  .поездка { padding:8px 0; border-bottom:1px solid #3A2C20; cursor:pointer; } .поездка:last-child { border:0; }
  #карта { height:320px; border-radius:14px; margin-top:8px; display:none; }
  label { display:flex; align-items:center; gap:8px; margin:6px 0; }
  input[type=password] { background:#120C08; color:var(--текст); border:1px solid #4A3A2A; border-radius:10px; height:44px; padding:0 12px; font-size:16px; flex:1; }
</style></head><body>
<h1>АЛЬФА</h1>

<div class="лист">
  <div id="статус">…</div>
  <div id="причина"></div>
  <div class="усл" id="усл"></div>
</div>

<div class="ряд">
  <button class="жёлт" id="грей">ПРОГРЕВ</button>
  <button class="красн" id="стоп">СТОП</button>
</div>

<div class="лист сетка">
  <div><small>ПРОБЕГ</small><b id="км">—</b></div>
  <div><small>МОТОЧАСЫ</small><b id="часы">—</b></div>
  <div><small>АКБ</small><b id="акб">—</b></div>
  <div><small>GPS</small><b id="гпс">—</b></div>
</div>

<h2>ОБСЛУЖИВАНИЕ</h2>
<div class="лист" id="то"></div>

<h2>ПОЕЗДКИ</h2>
<div class="лист" id="поездки"><small>Загружаю…</small></div>
<div id="карта"></div>

<h2>НАСТРОЙКИ</h2>
<div class="лист">
  <div class="ряд"><input id="пин" type="password" inputmode="numeric" placeholder="PIN"><button class="серый" id="пинКн" style="flex:0 0 auto">ЗАПОМНИТЬ</button></div>
  <label>Прогрев, минут: <select id="минут"><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select></label>
  <label><input type="checkbox" id="ворота"> Не заводить, если ворота гаража закрыты (нужен геркон)</label>
  <label><input type="checkbox" id="подсос"> Есть серва подсоса</label>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script>
const $ = id => document.getElementById(id);
let пин = ''; try { пин = localStorage.getItem('альфа.пин') || ''; } catch (e) {} $('пин').value = пин;
let настройкиПришли = false;
async function пост(путь, пар = {}) {
  const q = new URLSearchParams(Object.assign({ pin: пин }, пар));
  const о = await fetch(путь + '?' + q, { method: 'POST' }).catch(() => null);
  if (!о) return 'Нет связи с Альфой';
  if (о.status === 403) return 'Неверный PIN — введи внизу, в настройках';
  return о.text();
}
const усл = (т, ок) => `<span class="${ок ? 'да' : 'нет'}">${т}</span>`;
async function обновить() {
  const о = await fetch('/api/state').then(r => r.json()).catch(() => null);
  if (!о) { $('статус').textContent = 'НЕТ СВЯЗИ'; return; }
  const мин = с => Math.floor(с / 60) + ':' + String(с % 60).padStart(2, '0');
  $('статус').textContent = о.warm === 'running' ? 'ГРЕЮ · ' + мин(о.left) : о.warm === 'starting' ? 'ЗАВОЖУ…' : о.engine ? 'МОТОР РАБОТАЕТ' : 'ЗАГЛУШЕН';
  $('статус').className = о.warm === 'running' ? 'грею' : '';
  $('причина').textContent = о.reason;
  $('усл').innerHTML = усл('Нейтраль', о.neutral) + (о.tilt >= 0 ? усл('Стоит ровно (' + о.tilt + '°)', о.tilt < 40) : '') + (о.gate !== 'off' ? усл('Ворота ' + (о.gate === 'open' ? 'открыты' : 'закрыты'), о.gate === 'open') : '');
  $('км').textContent = о.km + ' км'; $('часы').textContent = о.hours + ' ч';
  $('акб').textContent = о.volt + ' В'; $('гпс').textContent = о.gps ? о.sats + ' спутн.' : 'ищет';
  $('грей').disabled = о.warm !== 'off';
  if (!настройкиПришли) { настройкиПришли = true; $('минут').value = о.settings.warm; $('ворота').checked = о.settings.gate; $('подсос').checked = о.settings.choke; }
  // обслуживание: сколько прошло с последнего раза
  $('то').innerHTML = о.service.map((с, i) => {
    const прКм = о.km - с.doneKm, прЧ = о.hours - с.doneHours;
    const доля = Math.max(с.km ? прКм / с.km : 0, с.hours ? прЧ / с.hours : 0);
    const ост = [с.km ? Math.max(0, Math.round(с.km - прКм)) + ' км' : '', с.hours ? Math.max(0, Math.round(с.hours - прЧ)) + ' ч' : ''].filter(Boolean).join(' или ');
    const кл = доля >= 1 ? 'пора' : доля > 0.8 ? 'скоро' : '';
    return `<div class="то ${кл}"><div class="стр"><span>${с.name}<br><small>${доля >= 1 ? 'ПОРА!' : 'через ' + ост}</small></span><button class="серый" data-i="${i}">СДЕЛАЛ</button></div><div class="полоса"><i style="width:${Math.min(100, доля * 100)}%"></i></div></div>`;
  }).join('');
}
$('то').addEventListener('click', async e => { const i = e.target.dataset && e.target.dataset.i; if (i === undefined) return; if (confirm('Отметить: сделано сейчас?')) { $('причина').textContent = await пост('/api/service', { i }); обновить(); } });
$('грей').addEventListener('click', async () => { if (!confirm('Нейтраль, стоит на подножке, рядом никого? Греть ' + $('минут').value + ' мин?')) return; $('причина').textContent = await пост('/api/warm', { min: $('минут').value }); });
$('стоп').addEventListener('click', async () => { $('причина').textContent = await пост('/api/stop'); });
$('пинКн').addEventListener('click', () => { пин = $('пин').value.trim(); try { localStorage.setItem('альфа.пин', пин); } catch (e) {} $('причина').textContent = 'PIN запомнил'; });
for (const [id, к] of [['минут', 'warm'], ['ворота', 'gate'], ['подсос', 'choke']])
  $(id).addEventListener('change', async () => { const э = $(id); $('причина').textContent = await пост('/api/settings', { [к]: э.type === 'checkbox' ? (э.checked ? 1 : 0) : э.value }); });

// поездки: список и карта
let карта = null, линия = null;
async function поездки() {
  const т = await fetch('/api/trips').then(r => r.text()).catch(() => '');
  const ряды = т.trim().split('\n').filter(Boolean).map(с => с.split(',')).reverse();
  if (!ряды.length) { $('поездки').innerHTML = '<small>Пока ни одной поездки</small>'; return; }
  $('поездки').innerHTML = ряды.map(([id, когда, км, макс, сек]) => `<div class="поездка" data-id="${+id}"><b>${(+км).toFixed(1)} км</b> · макс ${+макс} км/ч · ${Math.round(+сек / 60)} мин<small>${когда || 'без времени'}</small></div>`).join('');
}
$('поездки').addEventListener('click', async e => {
  const эл = e.target.closest('.поездка'); if (!эл || !window.L) return;
  const т = await fetch('/api/trip?id=' + эл.dataset.id).then(r => r.text()).catch(() => '');
  const точки = т.trim().split('\n').slice(1).map(с => с.split(',')).map(([, lat, lon]) => [+lat, +lon]).filter(([a, b]) => a && b);
  if (!точки.length) return;
  $('карта').style.display = 'block';
  if (!карта) { карта = L.map('карта'); L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(карта); }
  if (линия) линия.remove();
  линия = L.polyline(точки, { color: '#E8C84A', weight: 4 }).addTo(карта);
  карта.fitBounds(линия.getBounds(), { padding: [20, 20] });
  $('карта').scrollIntoView({ behavior: 'smooth' });
});
обновить(); поездки(); setInterval(обновить, 1000);
</script>
</body></html>)rawliteral";

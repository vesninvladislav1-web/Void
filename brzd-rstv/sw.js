// Бороздиновский: игра запоминается в телефоне — после первого запуска с интернетом открывается и без сети.
// Страница (index.html) — сначала из сети (так после deploy у всех сразу новая версия), нет сети — из памяти.
// Остальное (модели, текстуры, шрифты, three.js) — сразу из памяти, а свежая копия тихо докачивается в фоне.
// Связь онлайна (WebSocket) и чужие сайты сюда не попадают.
const КЭШ = 'brzd-v1';
const ОСНОВА = ['./', './index.html', './manifest.json', './three.min.js', './three-gltf.js', './icon-192.png', './icon-512.png',
  './fonts/ruslan-cyrillic.woff2', './fonts/rubik-cyrillic.woff2', './fonts/rubik-latin.woff2', './fonts/ptserif-i-cyrillic.woff2'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(КЭШ).then(к => к.addAll(ОСНОВА)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ключи => Promise.all(ключи.filter(к => к.startsWith('brzd-') && к !== КЭШ).map(к => caches.delete(к)))));
  self.clients.claim();
});

const сЗапасом = (обещание, мс) => Promise.race([обещание, new Promise((_, нет) => setTimeout(() => нет(new Error('долго')), мс))]);

self.addEventListener('fetch', e => {
  const з = e.request, url = new URL(з.url);
  if (з.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith(new URL('./', location).pathname)) return;
  const страница = з.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');
  if (страница) {
    // сеть (до 6 с) → память; ответ из сети кладём в память для офлайна
    e.respondWith(сЗапасом(fetch(з), 6000).then(о => { if (о.ok) { const к = о.clone(); caches.open(КЭШ).then(c => c.put('./index.html', к)); } return о; })
      .catch(() => caches.match('./index.html').then(о => о || caches.match(з))));
    return;
  }
  // остальное: из памяти сразу, свежая копия — в фоне
  e.respondWith(caches.open(КЭШ).then(c => c.match(з).then(есть => {
    const сеть = fetch(з).then(о => { if (о.ok && о.status === 200) c.put(з, о.clone()); return о; }).catch(() => есть);
    if (есть) { e.waitUntil(сеть.catch(() => {})); return есть; }
    return сеть;
  })));
});

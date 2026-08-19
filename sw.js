const CACHE = 'void-v8';
const ASSETS = ['./', './index.html', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.matchAll({ includeUncontrolled: true }))
      .then(clients => clients.forEach(c => c.postMessage({ type: 'RELOAD' })))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// ===== УВЕДОМЛЕНИЯ ПРИ ЗАКРЫТОМ ПРИЛОЖЕНИИ =====
// Сюда попадаем, даже когда приложение выгружено из памяти.
// Содержимое уведомления зашифровано, служба доставки его не читала.
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) {}
  const from = typeof data.from === 'string' ? data.from : '';

  e.waitUntil((async () => {
    // Если приложение открыто и на виду — оно покажет уведомление само,
    // второе было бы лишним
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clients.some(c => c.visibilityState === 'visible')) return;

    await self.registration.showNotification(
      from ? '@' + from : 'Void',
      {
        body: 'Новое сообщение',
        icon: './icon-192.png',
        badge: './icon-192.png',
        // Уведомления от одного человека схлопываются в одно
        tag: from ? 'void-dm-' + from : 'void-dm',
        renotify: true,
        data: { peer: from },
        vibrate: [80, 40, 80]
      }
    );
  })());
});

// Нажатие на уведомление: разворачиваем приложение и открываем нужный чат
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const peer = (e.notification.data && e.notification.data.peer) || '';
  e.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clients) {
      if ('focus' in c) {
        await c.focus();
        c.postMessage({ type: 'OPEN_CHAT', peer });
        return;
      }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow('./' + (peer ? '#chat=' + encodeURIComponent(peer) : ''));
    }
  })());
});

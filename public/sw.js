// Service worker: нужен для push-уведомлений и установки на экран «Домой».
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data.json(); } catch { data = { title: 'Порядок', body: event.data?.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Порядок', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { link: data.link || '' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = '/' + (event.notification.data?.link || '');
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { await c.focus(); c.navigate?.(url); return; }
    }
    await self.clients.openWindow(url);
  })());
});

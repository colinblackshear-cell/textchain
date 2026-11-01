// Service worker for the members' web app: shows push notifications for new group messages.
// Reactions are never pushed by the server, so they can't buzz anyone.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'New message', body: event.data?.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'New message', {
    body: data.body || '',
    tag: data.tag,
    renotify: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find((c) => new URL(c.url).pathname === url);
    if (open) return open.focus();
    return self.clients.openWindow(url);
  })());
});

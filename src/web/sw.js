/* Home Pharmacy Service Worker — Offline App-Shell Cache & Web Push Reminders (F39, F41) */
const CACHE_NAME = 'home-pharmacy-shell-v4';
const SHELL_ASSETS = ['./', './index.html', './app.js', './theme.css', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Never intercept or cache private API, OAuth, MCP, cross-origin, or token-bearing URLs
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.searchParams.has('token') ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/mcp') ||
    url.pathname.startsWith('/oauth/') ||
    url.pathname.startsWith('/.well-known/')
  ) {
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic' && !url.search) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match('./index.html'))),
  );
});

self.addEventListener('push', (event) => {
  let payload = { title: 'Home Pharmacy Reminder', body: 'Check your scheduled protocol slot.' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    if (event.data) payload.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag || 'home-pharmacy-reminder',
      data: payload.data || { url: '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
      return null;
    }),
  );
});

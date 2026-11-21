// Utopinn minimal service worker — exists so the app is installable as a PWA.
// No offline caching: the app is server-authoritative and useless without it,
// so every request passes straight through.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

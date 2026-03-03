// Minimal service worker — required for PWA installability.
// No caching strategy needed since this tool is always online.
self.addEventListener('install',  e => self.skipWaiting());
self.addEventListener('activate', e => self.clients.claim());

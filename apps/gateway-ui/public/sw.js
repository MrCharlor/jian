self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  // Remove the offline cache from earlier installations; no private or static data is cached.
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key.startsWith('jian-offline-')).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

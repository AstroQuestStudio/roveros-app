// sw.js — service worker : garde tous les fichiers de l'application en cache pour qu'elle
// fonctionne hors ligne une fois ouverte. Stratégie : on répond depuis le cache, et on
// rafraîchit le cache en arrière-plan quand le réseau répond (la version à jour sert à l'ouverture suivante).
// Quand vous modifiez un fichier, changez VERSION ci-dessous pour renouveler le cache.

const VERSION = 'roveros-v6';
const FICHIERS = [
  './', 'index.html', 'manifest.webmanifest', 'css/style.css',
  'js/app.js', 'js/bord.js', 'js/carte.js', 'js/faux-rover.js', 'js/icones.js', 'js/inclinaison.js',
  'js/manettes.js', 'js/protocole.js', 'js/qr.js', 'js/reglages.js', 'js/transport.js',
  'js/diagnostic.js', 'js/trace.js', 'js/latence.js', 'js/lissage.js', 'js/contours.js', 'js/patrouille.js', 'js/materiel.js', 'js/carte-globale.js', 'js/repere.js', 'js/gabarit.js', 'js/vitesse.js', 'js/transport-ble.js', 'js/transport-demo.js', 'js/transport-ws.js', 'js/utile.js',
  'css/polices/geist-latin-wght-normal.woff2', 'css/polices/geist-mono-latin-wght-normal.woff2',
  'icones/icone.svg', 'icones/icone-192.png', 'icones/icone-512.png', 'icones/icone-masquable-512.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(VERSION).then((c) => c.addAll(FICHIERS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((cles) => Promise.all(cles.filter((c) => c !== VERSION).map((c) => caches.delete(c))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  ev.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const memo = await cache.match(req, { ignoreSearch: true });
      const reseau = fetch(req).then((rep) => {
        if (rep.ok) cache.put(req, rep.clone());
        return rep;
      }).catch(() => memo);
      return memo || reseau;
    }),
  );
});

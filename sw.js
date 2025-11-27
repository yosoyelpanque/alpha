/* * sw.js
 * Service Worker para funcionamiento Offline (PWA).
 * Estrategia: Cache First (Intenta caché, si falla va a red) para assets estáticos.
 * Network First (Intenta red, si falla va a caché) para otros recursos si fuera necesario.
 */

const CACHE_NAME = 'inventario-pro-v7.4-cache';

// Lista de archivos requeridos para que la app funcione offline
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './css/styles.css',
    './js/app.js',
    './js/state.js',
    './js/ui.js',
    './js/logic.js',
    './js/files.js',
    './manifest.json',
    // Iconos y Logo (Asegúrate de tener estos archivos reales)
    './logo.png', 
    // Librerías externas (CDN) - Para offline real, deberías descargarlas y servirlas localmente
    // O permitir que el SW las cachee en la primera carga
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
    'https://cdn.tailwindcss.com',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css',
    'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
    'https://unpkg.com/html5-qrcode',
    'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
    'https://cdn.jsdelivr.net/npm/interactjs/dist/interact.min.js'
];

// Instalación: Abre la caché y guarda los archivos estáticos
self.addEventListener('install', (event) => {
    console.log('[Service Worker] Instalando...');
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[Service Worker] Cacheando archivos de la app shell');
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
    self.skipWaiting(); // Fuerza al SW a activarse inmediatamente
});

// Activación: Limpia cachés antiguas si cambia la versión
self.addEventListener('activate', (event) => {
    console.log('[Service Worker] Activando...');
    event.waitUntil(
        caches.keys().then((keyList) => {
            return Promise.all(keyList.map((key) => {
                if (key !== CACHE_NAME) {
                    console.log('[Service Worker] Eliminando caché antigua:', key);
                    return caches.delete(key);
                }
            }));
        })
    );
    return self.clients.claim();
});

// Fetch: Intercepta peticiones
self.addEventListener('fetch', (event) => {
    // Ignorar peticiones que no sean GET (POST, etc.) o esquemas no soportados (chrome-extension)
    if (event.request.method !== 'GET' || !event.request.url.startsWith('http')) return;

    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            // 1. Estrategia: Cache First (Si está en caché, úsalo)
            if (cachedResponse) {
                return cachedResponse;
            }

            // 2. Si no, ve a la red
            return fetch(event.request).then((networkResponse) => {
                // Verificar si la respuesta es válida
                if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
                    return networkResponse;
                }

                // 3. Cachear dinámicamente nuevos recursos (opcional pero recomendado)
                // Clonar la respuesta porque el stream solo se puede leer una vez
                const responseToCache = networkResponse.clone();

                caches.open(CACHE_NAME).then((cache) => {
                    cache.put(event.request, responseToCache);
                });

                return networkResponse;
            }).catch(() => {
                // Fallback offline (opcional: mostrar página "sin conexión")
                console.log('[Service Worker] Fallo en red y no está en caché:', event.request.url);
            });
        })
    );
});
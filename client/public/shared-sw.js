/*
 * Offline support for the PUBLIC shared-trip page only.
 *
 * Registered from SharedTripPage (never by the authenticated app). The fetch
 * handler is scoped hard: it only ever answers same-origin GETs for
 *   - /shared/* navigations              (network-first, cached shell offline)
 *   - /api/shared/<token> + /api/branding (network-first, cached JSON offline,
 *                                          marked X-Shared-Cache: hit)
 *   - /assets/* (hashed, immutable)       (cache-first)
 *   - /icons/*, /fonts/*                  (stale-while-revalidate)
 * Everything else — including every authenticated API call and the shared
 * file-bytes route (sensitive documents must never persist in Cache Storage) —
 * passes through untouched.
 */
const CACHE = 'trek-shared-v1';

const SNAPSHOT_RE = /^\/api\/shared\/[^/]+$/;
const ASSET_RE = /^\/assets\//;
const SWR_RE = /^\/(icons|fonts)\//;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith('trek-shared-') && k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

/* The page posts {type:'precache', urls:[…]} after first load so the shell,
 * its hashed assets and the trip snapshot are cached on the FIRST visit —
 * without this, offline would only work from the second visit on. */
self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'precache' || !Array.isArray(msg.urls)) return;
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      for (const raw of msg.urls.slice(0, 60)) {
        try {
          const url = new URL(String(raw), self.location.origin);
          if (url.origin !== self.location.origin) continue;
          const existing = await cache.match(url.pathname);
          if (existing && ASSET_RE.test(url.pathname)) continue; // hashed → immutable
          const res = await fetch(url.pathname, { credentials: 'same-origin' });
          if (res.ok) await stampAndCache(cache, url.pathname, res);
        } catch {
          /* best effort — offline precache never breaks the page */
        }
      }
    })
  );
});

async function stampAndCache(cache, request, response) {
  try {
    const headers = new Headers(response.headers);
    headers.set('X-Shared-Cached-At', new Date().toISOString());
    const body = await response.clone().blob();
    await cache.put(request, new Response(body, { status: response.status, statusText: response.statusText, headers }));
  } catch {
    /* best effort */
  }
}

function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(request).then(
      (res) => {
        clearTimeout(timer);
        resolve(res);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function fromCacheMarked(cache, request) {
  const hit = await cache.match(request);
  if (!hit) return null;
  const headers = new Headers(hit.headers);
  headers.set('X-Shared-Cache', 'hit');
  return new Response(await hit.blob(), { status: hit.status, statusText: hit.statusText, headers });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Shared page shell: fresh deploys win online; cached shell offline.
  if (req.mode === 'navigate' && url.pathname.startsWith('/shared/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const res = await fetch(req);
          if (res.ok) await stampAndCache(cache, url.pathname, res);
          return res;
        } catch {
          const hit = await fromCacheMarked(cache, url.pathname);
          return hit || new Response('Offline', { status: 503 });
        }
      })()
    );
    return;
  }

  // Trip snapshot + branding JSON: network first (short timeout), cached copy
  // offline — marked so the page can show its "offline copy from <date>" banner.
  if (SNAPSHOT_RE.test(url.pathname) || url.pathname === '/api/branding') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const res = await fetchWithTimeout(req, 4000);
          if (res.ok) await stampAndCache(cache, url.pathname, res);
          return res;
        } catch {
          const hit = await fromCacheMarked(cache, url.pathname);
          return (
            hit ||
            new Response(JSON.stringify({ error: 'offline' }), {
              status: 503,
              headers: { 'content-type': 'application/json' },
            })
          );
        }
      })()
    );
    return;
  }

  // Hashed build assets: immutable → cache-first.
  if (ASSET_RE.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(url.pathname);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(url.pathname, res.clone());
        return res;
      })()
    );
    return;
  }

  // Icons/fonts: stale-while-revalidate (unhashed URLs may be rebranded).
  if (SWR_RE.test(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(url.pathname);
        const refresh = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(url.pathname, res.clone());
            return res;
          })
          .catch(() => null);
        return hit || (await refresh) || new Response('', { status: 504 });
      })()
    );
  }
});

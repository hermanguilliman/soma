/**
 * radio-browser.info reverse proxy (Cloudflare Worker).
 *
 * Why it exists
 * -------------
 * The whole radio-browser API currently lives on a single server in Germany
 * (`all.api.radio-browser.info` → 91.98.4.78), so on networks that block it —
 * e.g. Russia — the "Всё радио" catalogue disappears while the audio streams
 * (hosted elsewhere) keep working. This tiny worker relays the JSON API and
 * adds CORS headers, giving the static site a reachable endpoint.
 *
 * Deploy
 * ------
 *   Option A — dashboard: create a Worker, paste this file, Deploy.
 *   Option B — CLI:
 *       cd proxy
 *       npx wrangler deploy
 *
 * Then open the site, switch to "Всё радио" → "Адрес API …" and paste the
 * worker URL (e.g. https://radio-browser-proxy.<account>.workers.dev).
 * It is stored in the browser only; you can also share it as `?rb=<url>`.
 *
 * Only read-only `/json/*` GET requests are relayed, with a short edge cache.
 */

const UPSTREAM = 'https://all.api.radio-browser.info';
const ALLOWED_PREFIX = '/json/';
const CACHE_TTL = 300; // seconds
const CONTACT = 'https://soma.guilliman.ru';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = corsOrigin(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'GET') {
      return json({ error: 'method not allowed' }, 405, origin);
    }
    if (!url.pathname.startsWith(ALLOWED_PREFIX)) {
      return json({ error: 'not found' }, 404, origin);
    }

    const target = new URL(url.pathname + url.search, UPSTREAM);

    let upstream;
    try {
      upstream = await fetch(target, {
        headers: {
          Accept: 'application/json',
          // radio-browser asks clients to identify themselves.
          'User-Agent': `soma-guilliman-proxy/1.0 (+${CONTACT})`,
        },
        // Cheap, volatile data — let Cloudflare absorb the traffic.
        cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
      });
    } catch {
      return json({ error: 'upstream unavailable' }, 502, origin);
    }

    const headers = new Headers(corsHeaders(origin));
    headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json');
    headers.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
    headers.set('X-Proxy', 'radio-browser');

    return new Response(upstream.body, { status: upstream.status, headers });
  },
};

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

/** Reflecting "*" by default; set ALLOWED_ORIGINS to lock it down. */
function corsOrigin(request, env) {
  const allowlist = String(env?.ALLOWED_ORIGINS ?? '')
    .split(',').map((item) => item.trim()).filter(Boolean);
  if (allowlist.length === 0) return '*';
  const origin = request.headers.get('Origin') ?? '';
  return allowlist.includes(origin) ? origin : allowlist[0];
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });
}

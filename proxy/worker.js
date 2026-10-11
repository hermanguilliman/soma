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
 * The site ships with this worker baked in as its default endpoint, so no
 * configuration is needed. It is also locked to the site's own origin: any
 * request without a matching Origin/Referer is rejected, so the URL being
 * publicly known does not turn the relay into an open proxy.
 *
 * Deploy
 * ------
 *   Option A — dashboard: create a Worker, paste this file, Deploy.
 *   Option B — CLI:
 *       cd proxy
 *       npx wrangler deploy
 *
 * To lock it to a different origin, set the ALLOWED_ORIGINS var (comma-separated)
 * in the dashboard or wrangler.toml. Only read-only `/json/*` GET requests are
 * relayed, with a short edge cache.
 */

const UPSTREAM = 'https://all.api.radio-browser.info';
const ALLOWED_PREFIX = '/json/';
const CACHE_TTL = 300; // seconds
const CONTACT = 'https://soma.guilliman.ru';

// Browsers always send Origin (and/or Referer) on cross-origin requests; only
// these callers may use the relay. Override via the ALLOWED_ORIGINS var.
const DEFAULT_ALLOWED_ORIGINS = [
  'https://soma.guilliman.ru',
  'https://hermanguilliman.github.io',
  'http://localhost:8087',
  'http://127.0.0.1:8087',
];

export default {
  async fetch(request, env) {
    const allowed = allowedOrigins(env);
    const caller = requestOrigin(request);

    // Keep the relay from becoming an open proxy: require a known caller.
    if (!caller || !allowed.includes(caller)) {
      return json({ error: 'forbidden origin' }, 403, allowed[0] ?? '*');
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(caller) });
    }
    if (request.method !== 'GET') {
      return json({ error: 'method not allowed' }, 405, caller);
    }

    const url = new URL(request.url);
    if (!url.pathname.startsWith(ALLOWED_PREFIX)) {
      return json({ error: 'not found' }, 404, caller);
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
      return json({ error: 'upstream unavailable' }, 502, caller);
    }

    const headers = new Headers(corsHeaders(caller));
    headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json');
    headers.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
    headers.set('X-Proxy', 'radio-browser');

    // Buffer the body rather than streaming it: the payloads are small and a
    // buffered reply avoids any chunked-transfer edge cases through the browser.
    const body = await upstream.arrayBuffer();
    return new Response(body, { status: upstream.status, headers });
  },
};

function allowedOrigins(env) {
  const raw = String(env?.ALLOWED_ORIGINS ?? '').trim();
  if (raw) return raw.split(',').map((item) => item.trim()).filter(Boolean);
  return DEFAULT_ALLOWED_ORIGINS;
}

/** Origin the caller claims — the Origin header, else the origin part of Referer. */
function requestOrigin(request) {
  const origin = request.headers.get('Origin');
  if (origin) return origin;

  const referer = request.headers.get('Referer');
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch { /* malformed — fall through */ }
  }
  return '';
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });
}

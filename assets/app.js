/* ============================================================
   Guilliman's Radio (soma.guilliman.ru) — client-side playlist builder.
   Sources:
     1. SomaFM — fetch channels.xml, pick stream quality (mp3 / aac / aacp),
        resolve every .pls into a direct stream URL.
     2. Всё радио — query the world radio catalogue for ready-made streams.
   Renders an M3U8 playlist (BOM + EXTINF).
   ============================================================ */

'use strict';

/* ------------------------------------------------ config --- */

const CHANNELS_URL = 'https://api.somafm.com/channels.xml';
const songsUrl = (id) => `https://somafm.com/songs/${encodeURIComponent(id)}.json`;

const KINDS = {
  mp3:  { key: 'mp3',  tag: 'fastpls',    fmt: 'mp3',  label: 'MP3, 128 kbps',  short: 'MP3 128' },
  aac:  { key: 'aac',  tag: 'highestpls', fmt: 'aac',  label: 'AAC, ~130 kbps', short: 'AAC 130' },
  aacp: { key: 'aacp', tag: 'fastpls',    fmt: 'aacp', label: 'AAC+, 64 kbps',  short: 'AAC+ 64' },
};
const KIND_ORDER = ['mp3', 'aac', 'aacp'];

const CACHE_KEY = 'soma.streams.v1';
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const KIND_KEY = 'soma.kind';
const VOLUME_KEY = 'soma.volume';
const FAVORITES_KEY = 'soma.favorites.v1';
const CONCURRENCY = 6;
const NOW_PLAYING_INTERVAL = 20_000;
const ICY_INTERVAL = 30_000;         // how often to re-read a stream's ICY title

/* --------------------------------------- radio-browser.info --- */

// Official public catalogue endpoint — a single server in DE, reachable from
// most networks but blocked on some (e.g. Russia), where the bundled reverse
// proxy (see proxy/worker.js) takes over. The official server is tried first so
// a client that can reach it never touches the worker; the proxy is only a
// fallback, and the endpoint that answered is remembered between visits so the
// probe is not repeated on every page load.
//
// The built-in proxy host is stored base64-encoded so it is not trivially
// greppable in the public source; it is locked to this site's origin server-side.
const RB_API_OFFICIAL = 'https://all.api.radio-browser.info';
const RB_API_PROXY = (() => {
  try {
    return atob('aHR0cHM6Ly9yYWRpby1icm93c2VyLXByb3h5LmdlbnRsZW1hbnRsZW1hbi53b3JrZXJzLmRldg==');
  } catch {
    return '';                        // no atob (unlikely) — official server only
  }
})();
// Endpoints in preference order: official server first, bundled proxy as backup.
const RB_API_BUILTIN = [RB_API_OFFICIAL, RB_API_PROXY].filter(Boolean);
const RB_API_MEMO_KEY = 'soma.rb.endpoint.v1';    // last endpoint that answered
const RB_API_MEMO_TTL_MS = 12 * 60 * 60 * 1000;   // re-check the preference twice a day
const RB_API_TIMEOUT = 10_000;                    // default per-request timeout
const RB_API_PROBE_TIMEOUT = 3000;                // direct endpoint must answer fast to win

const RB_PAGE_SIZE = 100;                // stations per request — big replies stall on flaky links
const RB_FACET_LIMIT = 80;               // entries offered by the tag / country pickers
const RB_FACET_KEY = 'soma.rb.facets.v1';
const RB_FACET_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SOURCE_KEY = 'soma.source';

const SOURCES = {
  somafm: {
    id: 'somafm',
    label: 'SomaFM',
    pageTitle: 'Актуальный плейлист SomaFM',
    file: 'SomaFM.m3u8',
    searchPlaceholder: 'Поиск: название, жанр, описание…',
    nowPrefix: 'Играет',
    listenersTitle: 'слушателей',
    album: 'SomaFM (soma.guilliman.ru)',
    cols: { title: 'Станция', genre: 'Жанр', now: 'Сейчас играет', listeners: 'Слушат.' },
    sortLabels: { title: 'станции', genre: 'жанру', now: 'текущему треку', listeners: 'слушателям' },
  },
  radiobrowser: {
    id: 'radiobrowser',
    label: 'Всё радио',
    pageTitle: 'Всё радио',
    file: 'Radio.m3u8',
    searchPlaceholder: 'Поиск по названию станции…',
    nowPrefix: 'Страна',
    listenersTitle: 'голосов',
    album: "Guilliman's Radio (soma.guilliman.ru)",
    cols: { title: 'Станция', genre: 'Теги', now: 'Страна', listeners: 'Голоса' },
    sortLabels: { title: 'станции', genre: 'тегам', now: 'стране', listeners: 'голосам' },
  },
  favorites: {
    id: 'favorites',
    label: 'Любимое',
    pageTitle: 'Любимые станции',
    file: 'Favorites.m3u8',
    searchPlaceholder: 'Поиск по любимым станциям…',
    nowPrefix: 'Детали',
    listenersTitle: 'рейтинг',
    album: "Guilliman's Radio (soma.guilliman.ru)",
    cols: { title: 'Станция', genre: 'Жанр', now: 'Детали', listeners: 'Рейтинг' },
    sortLabels: { title: 'станции', genre: 'жанру', now: 'деталям', listeners: 'рейтингу' },
  },
};

/* ------------------------------------------------- state --- */

const state = {
  source: 'somafm',
  kind: 'mp3',
  channels: [],
  streams: new Map(),          // `${kind}|${plsUrl}` -> direct stream url
  loading: true,
  error: null,
  resolve: { generation: 0, done: 0, total: 0, active: false },
  query: '',
  sort: { key: 'listeners', dir: 'desc' },
  limit: 0,
  rb: { stations: [], key: '', facets: false, api: '' },  // radio-browser result cache
  favorites: [],               // saved station snapshots (both sources)
  rbTag: '',
  rbCountry: '',
  rbLimit: 60,
  currentId: null,
  playing: false,
  now: null,                   // { current, recent }
};

/* -------------------------------------------------- dom --- */

const $ = (id) => document.getElementById(id);
const el = {
  stats: { channels: $('statChannels'), quality: $('statQuality'), streams: $('statStreams') },
  pageTitle: $('pageTitle'),
  sources: $('sources'),
  statusLine: $('statusLine'),
  somafmControls: $('somafmControls'),
  rbControls: $('rbControls'),
  kinds: $('kinds'),
  limit: $('limit'),
  rbFilters: $('rbFilters'),
  rbTag: $('rbTag'),
  rbCountry: $('rbCountry'),
  rbLimit: $('rbLimit'),
  download: $('download'),
  downloadLabel: $('downloadLabel'),
  copy: $('copy'),
  search: $('search'),
  tablehead: $('tablehead'),
  count: $('count'),
  grid: $('grid'),
  emptyBox: $('emptyBox'),
  emptyTitle: $('emptyTitle'),
  emptyHint: $('emptyHint'),
  errorBox: $('errorBox'),
  errorMessage: $('errorMessage'),
  retry: $('retry'),
  toast: $('toast'),
  audio: $('audio'),
  station: {
    dialog: $('stationDialog'),
    title: $('detailTitle'),
    meta: $('detailMeta'),
    logo: $('detailLogo'),
    fallback: $('detailFallback'),
    rows: $('detailRows'),
    play: $('detailPlay'),
    fav: $('detailFav'),
    copy: $('detailCopy'),
    homepage: $('detailHomepage'),
    close: $('detailClose'),
  },
  player: {
    logo: $('playerLogo'),
    fallback: $('playerFallback'),
    title: $('playerTitle'),
    now: $('playerNow'),
    toggle: $('toggle'),
    prev: $('prev'),
    next: $('next'),
    mute: $('mute'),
    volume: $('volume'),
    format: $('playerFormat'),
  },
};

/** Consecutive playback failures — used to stop the quality-fallback loop. */
let failedAttempts = 0;

/** Monotonic id for radio-browser requests — drops stale out-of-order responses. */
let rbRequestSeq = 0;

/* ------------------------------------------------ helpers --- */
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const cleanTitle = (title, maxLen = 200) =>
  String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLen);

const streamKey = (kind, pls) => `${kind}|${pls}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function debounce(fn, ms) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Russian plural form: 1 станция / 2 станции / 5 станций */
function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

const stationsWord = (n) => plural(n, 'станция', 'станции', 'станций');

const fmtNum = (n) => new Intl.NumberFormat('ru-RU').format(Number(n) || 0);

/** Keep the station card readable and concise: a few rows as <dl>. */
const detailRow = (label, value) => `
  <div class="station-detail__row">
    <dt>${esc(label)}</dt>
    <dd>${value}</dd>
  </div>`;

/** "2024-01-20 08:00:00" (UTC, catalogue format) → a friendlier line. */
function fmtChecked(text, ok) {
  const base = ok ? 'онлайн' : 'офлайн';
  if (!text) return base;
  const date = new Date(String(text).replace(' ', 'T') + 'Z');
  if (Number.isNaN(date.getTime())) return base;
  const diff = Date.now() - date.getTime();
  const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (diff < 3600_000) return ok ? 'онлайн · только что' : base;
  if (diff < 86_400_000) return ok ? `онлайн · ${Math.max(1, Math.floor(diff / 3600_000))} ч назад` : base;
  const day = date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  return ok ? `онлайн · ${day}, ${time}` : base;
}

async function fetchWithRetry(url, { retries = 2, timeout = 15_000, accept = null } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: accept ?? '*/*' } });
      clearTimeout(timer);
      if (!response.ok) {
        const err = new Error(`HTTP ${response.status}`);
        err.status = response.status;
        throw err;
      }
      return response;
    } catch (err) {
      lastError = err;
      // 4xx errors will not fix themselves
      if (err.status >= 400 && err.status < 500) break;
      if (attempt < retries) await sleep(400 * 2 ** attempt + Math.random() * 300);
    }
  }
  throw lastError ?? new Error('fetch failed');
}

/** channels.xml declares ISO-8859-1 — honour the encoding from the raw bytes. */
function decodeXmlBuffer(buffer) {
  const head = new TextDecoder('latin1').decode(buffer.slice(0, 160));
  const declared = /encoding\s*=\s*["']([\w.-]+)["']/i.exec(head)?.[1];
  try {
    return new TextDecoder(declared ?? 'utf-8').decode(buffer);
  } catch {
    return new TextDecoder().decode(buffer);
  }
}

/* ------------------------------------------------- cache --- */

const loadCache = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
    if (!raw || typeof raw.t !== 'number' || Date.now() - raw.t > CACHE_TTL_MS) return;
    for (const [key, url] of Object.entries(raw.m ?? {})) {
      if (typeof url === 'string') state.streams.set(key, url);
    }
  } catch {
    /* corrupted cache — ignore */
  }
};

const saveCache = debounce(() => {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), m: Object.fromEntries(state.streams) }));
  } catch {
    /* quota exceeded — ignore, it is only a cache */
  }
}, 400);

/* -------------------------------------------- favorites --- */

/** Restore saved stations from localStorage, keeping only well-formed entries. */
function loadFavorites() {
  try {
    const saved = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? '[]');
    state.favorites = Array.isArray(saved)
      ? saved.filter((ch) => ch && typeof ch.id === 'string'
          && (ch.source === 'somafm' || ch.source === 'radiobrowser'))
      : [];
  } catch {
    state.favorites = [];   // corrupted storage — start clean
  }
}

function saveFavorites() {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(state.favorites));
  } catch {
    /* quota exceeded — favorites just won't persist */
  }
}

const isFavorite = (id) => state.favorites.some((ch) => ch.id === id);

/**
 * Snapshot a channel so a favorite keeps working even before its source list is
 * (re)loaded — it carries everything the card and player need: title, logo,
 * stream / .pls map, codec, country…
 */
const favoriteSnapshot = (channel) => ({ ...channel });

function toggleFavorite(id) {
  const channel = byId(id);
  if (!channel) return;
  const wasFav = isFavorite(id);

  if (wasFav) {
    state.favorites = state.favorites.filter((ch) => ch.id !== id);
  } else {
    state.favorites.unshift(favoriteSnapshot(channel));
  }
  saveFavorites();
  toast(wasFav ? 'Убрано из любимого' : 'Добавлено в любимое');

  // On the favorites tab the list itself changed — repaint the whole thing.
  if (state.source === 'favorites') {
    render();
    updatePlayButtons();
    return;
  }
  // Elsewhere only the star that was clicked changes: keep focus and scroll.
  const btn = el.grid.querySelector(`.card[data-id="${CSS.escape(id)}"] .card__fav`);
  if (btn) paintFavButton(btn, !wasFav, channel.title);
}

function paintFavButton(btn, isFav, title) {
  btn.setAttribute('aria-pressed', String(isFav));
  btn.setAttribute('aria-label', `${isFav ? 'Убрать из любимого' : 'Добавить в любимое'}: ${title}`);
  btn.setAttribute('title', isFav ? 'Убрать из любимого' : 'В любимое');
}

/** Sync the star inside the station dialog with the current favorite state. */
function paintDetailFav(channel) {
  const isFav = isFavorite(channel.id);
  el.station.fav.setAttribute('aria-pressed', String(isFav));
  el.station.fav.textContent = isFav ? 'В любимом' : 'В любимое';
}

/* --------------------------------------------- fetching --- */

async function loadChannels() {
  state.loading = true;
  state.error = null;
  state.channels = [];
  state.currentId = null;
  setStatus('Загрузка каналов…', 'is-busy');
  el.errorBox.hidden = true;
  el.grid.innerHTML = skeletons(8);
  updateStats();
  updateButtons();

  try {
    const response = await fetchWithRetry(CHANNELS_URL, { accept: 'application/xml,text/xml,*/*' });
    const text = decodeXmlBuffer(await response.arrayBuffer());
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) throw new Error('channels.xml не удалось разобрать');

    state.channels = parseChannels(doc);
    if (state.channels.length === 0) throw new Error('в XML не найдено ни одного канала');
  } catch (err) {
    if (state.source !== 'somafm') return;   // user switched while we were loading
    state.loading = false;
    state.error = err;
    setStatus('Ошибка загрузки', '');
    el.errorMessage.textContent = String(err?.message ?? err);
    el.errorBox.hidden = false;
    el.grid.innerHTML = '';
    updateStats();
    updateButtons();
    return;
  }

  state.loading = false;
  if (state.source !== 'somafm') return;     // user switched while we were loading
  render();
  updateButtons();
  resolveAll();
}

function parseChannels(doc) {
  const channels = [];
  for (const node of doc.querySelectorAll('channel')) {
    const text = (tag) => node.querySelector(tag)?.textContent?.trim() ?? '';
    const pls = {};
    for (const kindKey of KIND_ORDER) {
      const kind = KINDS[kindKey];
      const match = Array.from(node.children).find(
        (child) => child.tagName === kind.tag && child.getAttribute('format') === kind.fmt,
      );
      pls[kindKey] = match?.textContent?.trim() || null;
    }
    const title = cleanTitle(text('title') || node.getAttribute('id') || 'Без названия');
    if (!KIND_ORDER.some((key) => pls[key])) continue;
    channels.push({
      id: node.getAttribute('id') || title.toLowerCase().replace(/\W+/g, '-'),
      source: 'somafm',
      title,
      description: cleanTitle(text('description'), 240),
      genre: cleanTitle(text('genre'), 60).split('|')[0] || '—',
      image: text('largeimage') || text('image'),
      listeners: Number.parseInt(text('listeners'), 10) || 0,
      lastPlaying: cleanTitle(text('lastPlaying'), 160),
      pls,
    });
  }
  return channels;
}

/* -------------------------------------- radio-browser.info --- */

const currentList = () => {
  if (state.source === 'somafm') return state.channels;
  if (state.source === 'favorites') return state.favorites;
  return state.rb.stations;
};

/** The one stream quality used for a SomaFM channel, preferring the active one. */
function kindForChannel(channel, preferred = state.kind) {
  if (channel?.pls?.[preferred]) return preferred;
  return KIND_ORDER.find((kind) => channel?.pls?.[kind]) ?? null;
}

/** Is a channel's stream already resolved (SomaFM) or direct (radio-browser)? */
function streamReadyFor(channel) {
  if (channel.source === 'radiobrowser') return Boolean(channel.stream);
  const kind = kindForChannel(channel);
  return Boolean(kind && state.streams.has(streamKey(kind, channel.pls[kind])));
}

/** Views that may contain SomaFM channels and therefore need .pls resolution. */
const viewResolvesStreams = () => state.source === 'somafm' || state.source === 'favorites';

/** Signature of the active radio-browser request — used to skip redundant reloads. */
const rbKey = () =>
  `${state.query.trim().toLowerCase()}|${state.rbTag}|${state.rbCountry}|${state.rbLimit}`;

/** The catalogue base that last answered, remembered between visits (TTL-bounded). */
function rememberedRbBase() {
  try {
    const raw = JSON.parse(localStorage.getItem(RB_API_MEMO_KEY) ?? 'null');
    if (!raw || typeof raw.b !== 'string') return '';
    if (Date.now() - (raw.t ?? 0) > RB_API_MEMO_TTL_MS) return '';
    return RB_API_BUILTIN.includes(raw.b) ? raw.b : '';
  } catch {
    return '';
  }
}

/** Preferred endpoint right now: the session winner, else the remembered one. */
const preferredRbBase = () => state.rb.api || rememberedRbBase() || RB_API_BUILTIN[0] || '';

/** API bases to try, in order: the preferred endpoint first, the rest as backup. */
function rbApiBases() {
  const preferred = preferredRbBase();
  return preferred
    ? [preferred, ...RB_API_BUILTIN.filter((base) => base !== preferred)]
    : [...RB_API_BUILTIN];
}

/** Remember which endpoint answered so future visits skip a dead one. */
function rememberRbBase(base) {
  try {
    localStorage.setItem(RB_API_MEMO_KEY, JSON.stringify({ b: base, t: Date.now() }));
  } catch { /* storage disabled / full — the session pick is enough */ }
}

/** Drop the remembered endpoint after a total failure, so the next try re-probes. */
function forgetRbBase() {
  try {
    localStorage.removeItem(RB_API_MEMO_KEY);
  } catch { /* ignore */ }
}

/**
 * Decide once per session which endpoint to use. The preferred endpoint is
 * probed with a lightweight request; the direct official server must answer
 * quickly (RB_API_PROBE_TIMEOUT) to be worth it, while the proxy gets the full
 * timeout because it is the fallback of last resort. The winner is remembered
 * for the session and between visits. Best-effort: if nothing answers, the
 * normal request path below will retry and surface the real error.
 */
async function probeRbEndpoint() {
  if (state.rb.api) return;                  // already decided this session
  for (const base of rbApiBases()) {
    const timeout = base === RB_API_OFFICIAL ? RB_API_PROBE_TIMEOUT : RB_API_TIMEOUT;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`${base}/json/tags?limit=1`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) continue;
      await response.json();                 // only trust a real JSON reply
      state.rb.api = base;
      rememberRbBase(base);
      return;
    } catch {
      /* blocked / timed out — try the next endpoint */
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Fetch and parse a radio-browser JSON path. The primary endpoint is retried a
 * few times because a flaky link often drops a request with no useful error —
 * only a hang — and a fresh attempt usually goes through; the remaining
 * endpoints are then tried once each as backups. A single timeout covers the
 * whole request (headers *and* body), so a stalled reply fails over instead of
 * hanging. The endpoint that answered is remembered for the session.
 */
async function rbFetchJson(path, options = {}) {
  const bases = rbApiBases();
  const timeout = options.timeout ?? RB_API_TIMEOUT;
  const attempts = Math.max(1, options.attempts ?? 2);
  let lastError = null;

  for (let i = 0; i < bases.length; i++) {
    const base = bases[i];
    const tries = i === 0 ? attempts : 1;   // retry the primary endpoint, fall back once elsewhere
    for (let attempt = 0; attempt < tries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(`${base}${path}`, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          const err = new Error(`HTTP ${response.status}`);
          err.status = response.status;
          throw err;
        }
        const data = await response.json();     // still inside the timeout window
        clearTimeout(timer);
        state.rb.api = base;                    // remember the winner for this session
        rememberRbBase(base);                   // …and for the next visit
        return data;
      } catch (err) {
        clearTimeout(timer);
        lastError = err;
        // A client error (4xx) will not improve on retry — move on to the next base.
        if (err.status >= 400 && err.status < 500) break;
        if (attempt < tries - 1) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  }

  state.rb.api = '';
  forgetRbBase();
  throw lastError ?? new Error('каталог радио недоступен');
}

/** Turn a catalogue failure into an actionable message. */
function rbErrorMessage(err) {
  if (err?.name === 'AbortError') {
    return 'Сервер не ответил вовремя. Каталог радио временно недоступен — попробуйте позже.';
  }
  if (!err?.status) {
    return 'Не удалось соединиться: каталог радио недоступен из вашей сети. Попробуйте позже.';
  }
  return String(err?.message ?? err);
}

function rbSearchPath(limit, offset = 0) {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    hidebroken: 'true',        // only stations that passed their last health check
    order: 'votes',
    reverse: 'true',
  });
  const query = state.query.trim();
  if (query) params.set('name', query);
  if (state.rbTag) params.set('tag', state.rbTag);
  if (state.rbCountry) params.set('countrycode', state.rbCountry);
  return `/json/stations/search?${params.toString()}`;
}

/**
 * Load up to state.rbLimit stations, paging through the catalogue. A single
 * 200-station reply is by far the most likely to stall, so large requests are
 * split into RB_PAGE_SIZE chunks that survive the link and can be retried on
 * their own. `onPage` fires after each page so the list fills in progressively;
 * if a later page never arrives we keep the pages already fetched instead of
 * throwing the whole list away.
 */
async function rbFetchStations(onPage) {
  const total = state.rbLimit;
  const seen = new Set();
  const stations = [];

  for (let offset = 0; offset < total; offset += RB_PAGE_SIZE) {
    const limit = Math.min(RB_PAGE_SIZE, total - offset);
    let page;
    try {
      page = await rbFetchJson(rbSearchPath(limit, offset), { timeout: 9_000, attempts: 3 });
    } catch (err) {
      if (stations.length) break;   // keep the partial top list rather than show nothing
      throw err;
    }
    if (!Array.isArray(page)) throw new Error('Каталог вернул неожиданный ответ');
    for (const station of page) {
      const uuid = station.stationuuid;
      if (uuid) {
        if (seen.has(uuid)) continue;   // pages can overlap while votes shift
        seen.add(uuid);
      }
      stations.push(station);
    }
    if (onPage) onPage(stations.slice(0, total));
    if (page.length < limit) break;   // catalogue exhausted
  }

  return stations.slice(0, total);
}

/** Map a radio-browser station onto the shared channel shape used by the UI. */
function normalizeRb(station) {
  const tags = String(station.tags ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  const format = [station.codec, station.bitrate ? `${station.bitrate}k` : ''].filter(Boolean).join(' ');
  const details = [station.country, format].filter(Boolean).join(' · ');
  return {
    id: `rb:${station.stationuuid}`,
    source: 'radiobrowser',
    uuid: station.stationuuid,
    title: cleanTitle(station.name || station.stationuuid || 'Без названия'),
    description: cleanTitle(tags.join(', '), 240),
    genre: cleanTitle(tags.slice(0, 2).join(', ') || station.country || '—', 60),
    image: station.favicon || '',
    listeners: Number.parseInt(station.votes, 10) || 0,
    lastPlaying: cleanTitle(details, 80),
    stream: station.url_resolved || station.url || '',
    country: station.country || '',
    state: station.state || '',
    language: station.language || '',
    codec: station.codec || '',
    bitrate: Number.parseInt(station.bitrate, 10) || 0,
    homepage: station.homepage || '',
    url: station.url || '',
    clickcount: Number.parseInt(station.clickcount, 10) || 0,
    clicktrend: Number.parseInt(station.clicktrend, 10) || 0,
    checkedOk: station.lastcheckok === 1,
    checkedAt: station.lastchecktime || '',
    hls: station.hls === 1,
  };
}

async function loadRb() {
  const key = rbKey();
  const seq = ++rbRequestSeq;
  state.loading = true;
  state.error = null;
  setStatus('Загрузка станций…', 'is-busy');
  el.errorBox.hidden = true;
  el.grid.innerHTML = skeletons(8);
  updateStats();
  updateButtons();

  try {
    await probeRbEndpoint();
    try {
      await loadRbFacets();
    } catch {
      /* pickers stay empty — search still works without them */
    }
    const data = await rbFetchStations((partial) => {
      if (seq !== rbRequestSeq) return;      // a newer request superseded this one
      state.rb.stations = partial.map(normalizeRb).filter((station) => station.stream);
      render();
    });
    if (seq !== rbRequestSeq) return;        // a newer request superseded this one
    state.rb.stations = data.map(normalizeRb).filter((station) => station.stream);
    state.rb.key = key;
  } catch (err) {
    if (seq !== rbRequestSeq || state.source !== 'radiobrowser') return;   // superseded / switched away
    state.loading = false;
    state.error = err;
    setStatus('Ошибка загрузки', '');
    el.errorMessage.textContent = rbErrorMessage(err);
    el.errorBox.hidden = false;
    el.grid.innerHTML = '';
    updateStats();
    updateButtons();
    return;
  }

  if (seq !== rbRequestSeq || state.source !== 'radiobrowser') return;
  state.loading = false;
  render();
  updateButtons();
}

/** Populate the genre / country pickers once, then keep them in localStorage. */
async function loadRbFacets() {
  if (state.rb.facets) return;

  try {
    const cached = JSON.parse(localStorage.getItem(RB_FACET_KEY) ?? 'null');
    if (cached && Date.now() - cached.t < RB_FACET_TTL_MS
      && Array.isArray(cached.tags) && Array.isArray(cached.countries)) {
      fillFacets(cached.tags, cached.countries);
      state.rb.facets = true;
      return;
    }
  } catch { /* corrupted cache — refetch below */ }

  const [tags, countries] = await Promise.all([
    rbFetchJson(`/json/tags?order=stationcount&reverse=true&limit=${RB_FACET_LIMIT}`),
    rbFetchJson(`/json/countries?order=stationcount&reverse=true&limit=${RB_FACET_LIMIT}`),
  ]);

  const tagList = Array.isArray(tags) ? tags.map((tag) => tag.name).filter(Boolean) : [];
  const countryList = Array.isArray(countries)
    ? countries
      .map((country) => ({ code: country.iso_3166_1 || '', name: country.name }))
      .filter((country) => country.code)
    : [];

  fillFacets(tagList, countryList);
  state.rb.facets = true;
  try {
    localStorage.setItem(RB_FACET_KEY, JSON.stringify({
      t: Date.now(), tags: tagList, countries: countryList,
    }));
  } catch { /* quota exceeded — it is only a convenience cache */ }
}

function fillFacets(tags, countries) {
  fillSelect(el.rbTag, tags.map((name) => ({ value: name, label: name })), state.rbTag);
  fillSelect(el.rbCountry, countries.map((c) => ({ value: c.code, label: c.name })), state.rbCountry);
}

/** Replace a select's options, keeping its placeholder and current value. */
function fillSelect(select, options, selected = '') {
  const placeholder = select.querySelector('option');
  select.replaceChildren(placeholder, ...options.map((option) => {
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.label;
    return node;
  }));
  select.value = selected;
}

function reloadCurrent() {
  if (state.source === 'radiobrowser') void loadRb();
  else if (state.source === 'favorites') { render(); resolveAll(state.favorites); }
  else void loadChannels();
}

/* ------------------------------------------- resolving --- */

async function resolvePls(plsUrl) {
  try {
    const response = await fetchWithRetry(plsUrl, { retries: 1, timeout: 12_000 });
    const body = await response.text();
    const match = /^file1\s*=\s*(.+)$/im.exec(body);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/** Resolve every .pls of the current quality with a small worker pool. */
function resolveAll(list = state.channels) {
  const generation = ++state.resolve.generation;
  const kind = state.kind;
  const targets = list.filter((ch) => ch.pls && ch.pls[kind]);
  const pending = targets.filter((ch) => !state.streams.has(streamKey(kind, ch.pls[kind])));

  state.resolve.done = targets.length - pending.length;
  state.resolve.total = targets.length;
  state.resolve.active = pending.length > 0;

  paintResolveProgress();
  if (!state.resolve.active) {
    syncStatus();
    return;
  }

  setStatus(`Резолв потоков 0/${pending.length}…`, 'is-busy');
  let cursor = 0;

  const worker = async () => {
    while (generation === state.resolve.generation) {
      const index = cursor;
      cursor += 1;
      if (index >= pending.length) return;
      const channel = pending[index];
      const url = await resolvePls(channel.pls[kind]);
      if (generation !== state.resolve.generation) return;
      if (url) state.streams.set(streamKey(kind, channel.pls[kind]), url);
      state.resolve.done += 1;
      saveCache();
      paintResolveProgress();
      if (state.resolve.done >= state.resolve.total) {
        state.resolve.active = false;
        syncStatus();
        updateButtons();
      }
    }
  };

  updateButtons();
  void Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

function paintResolveProgress() {
  const { done, total } = state.resolve;
  // The status line describes the active view — a background SomaFM resolve
  // must not clobber it once the user has switched to another source.
  if (state.resolve.active && viewResolvesStreams()) {
    setStatus(`Резолв потоков ${done}/${total}…`, 'is-busy');
  }
  updateStreamStat();
}

/* ------------------------------------------------ render --- */

function skeletons(count) {
  return Array.from({ length: count }, () => `
    <div class="card card--skeleton" aria-hidden="true">
      <span class="skel skel--num"></span>
      <div class="card__name">
        <span class="card__thumb skel skel--thumb"></span>
        <span class="skel skel--title"></span>
      </div>
      <span class="skel skel--genre"></span>
      <span class="skel skel--now"></span>
      <span class="skel skel--listeners"></span>
    </div>`).join('');
}

/** Column comparators — ascending; direction is applied by the caller. */
const SORTERS = {
  title: (a, b) => a.title.localeCompare(b.title, 'ru'),
  genre: (a, b) => a.genre.localeCompare(b.genre, 'ru') || a.title.localeCompare(b.title, 'ru'),
  now: (a, b) => String(a.lastPlaying ?? '').localeCompare(String(b.lastPlaying ?? ''), 'ru')
    || a.title.localeCompare(b.title, 'ru'),
  listeners: (a, b) => a.listeners - b.listeners || a.title.localeCompare(b.title, 'ru'),
};

const byListeners = (a, b) => b.listeners - a.listeners || a.title.localeCompare(b.title, 'ru');

function visibleChannels() {
  let list = currentList();
  const query = state.query.trim().toLowerCase();

  // SomaFM is filtered and scoped locally; radio-browser results already
  // come back filtered (query / tag / country) and ordered from the API.
  if (state.source === 'somafm') {
    list = list.filter((ch) => ch.pls[state.kind]);
    if (query) {
      list = list.filter((ch) =>
        `${ch.title} ${ch.genre} ${ch.description}`.toLowerCase().includes(query));
    }

    // "Топ-N по слушателям": scope is always the most-listened N,
    // then the chosen column order is applied on top of that slice.
    if (state.limit > 0) {
      list = [...list].sort(byListeners).slice(0, state.limit);
    }
  } else if (state.source === 'favorites') {
    // favorites mix both sources, so only the free-text search applies here
    if (query) {
      list = list.filter((ch) =>
        `${ch.title} ${ch.genre} ${ch.description}`.toLowerCase().includes(query));
    }
  }

  const { key, dir } = state.sort;
  const cmp = SORTERS[key] ?? SORTERS.listeners;
  const sign = dir === 'desc' ? -1 : 1;
  return [...list].sort((a, b) => sign * cmp(a, b));
}

/** Label of the "quality" stat — the active source's own flavour. */
const qualityStatText = () => {
  if (state.source === 'somafm') return KINDS[state.kind].short;
  if (state.source === 'favorites') return 'микс';
  return 'онлайн';
};

function render() {
  const list = visibleChannels();
  const total = currentList().length;
  el.grid.innerHTML = list.map((channel, index) => cardHtml(channel, index)).join('');
  armLogos(el.grid);
  const isEmpty = list.length === 0 && !state.loading && !state.error;
  el.emptyBox.hidden = !isEmpty;
  if (isEmpty) {
    const favEmpty = state.source === 'favorites' && !state.query.trim();
    el.emptyTitle.textContent = favEmpty ? 'В любимом пока пусто.' : 'Ничего не найдено.';
    el.emptyHint.textContent = favEmpty
      ? 'Отмечайте станции звёздочкой — они появятся здесь.'
      : 'Измените запрос или сбросьте фильтры.';
  }
  el.count.textContent = state.loading
    ? 'загрузка…'
    : `${list.length} из ${total}`;
  el.stats.channels.textContent = String(total || '—');
  el.stats.quality.textContent = qualityStatText();
  updateStreamStat();
  updateButtons(list.length);
  syncStatus();
  paintSortHeaders();
}

/** Keep rows of the table header in sync with the active column sort. */
function paintSortHeaders() {
  const dirWord = state.sort.dir === 'asc' ? 'по возрастанию' : 'по убыванию';
  const labels = SOURCES[state.source].sortLabels;
  for (const btn of el.tablehead.querySelectorAll('button.th[data-sort]')) {
    const active = btn.dataset.sort === state.sort.key;
    btn.setAttribute('aria-pressed', String(active));
    if (active) btn.dataset.dir = state.sort.dir;
    else delete btn.dataset.dir;
    btn.setAttribute('aria-label', active
      ? `Сортировка по ${labels[state.sort.key]}: ${dirWord}`
      : `Сортировать по ${labels[btn.dataset.sort]}`);
  }
}

function setSort(key) {
  if (state.sort.key === key) {
    state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    state.sort = { key, dir: key === 'listeners' ? 'desc' : 'asc' };
  }
  render();
  updatePlayButtons();
}

/** Text of the ready status — reflects the current playlist scope (search + limit). */
function readyStatusText() {
  const count = visibleChannels().length;
  if (state.source === 'radiobrowser') return `${count} ${stationsWord(count)} · радио готово`;
  if (state.source === 'favorites') return `${count} ${stationsWord(count)} · любимое готово`;
  return `${count} ${stationsWord(count)} · ${KINDS[state.kind].short} готов`;
}

/**
 * Keep the status line in sync with the current playlist.
 * Busy/loading/error texts are owned by their own code paths and left untouched.
 */
function syncStatus() {
  const resolving = viewResolvesStreams() && state.resolve.active;
  if (state.loading || state.error || resolving) return;
  setStatus(readyStatusText(), 'is-ok');
}

/* ----------------------------------------------- sources --- */

/** Point every source-dependent label and control at the active source. */
function applySourceChrome() {
  const meta = SOURCES[state.source];
  el.pageTitle.textContent = meta.pageTitle;
  el.search.placeholder = meta.searchPlaceholder;
  el.somafmControls.hidden = state.source !== 'somafm';
  el.rbControls.hidden = state.source !== 'radiobrowser';
  el.rbFilters.hidden = state.source !== 'radiobrowser';

  const input = el.sources.querySelector(`input[value="${state.source}"]`);
  if (input) input.checked = true;

  for (const btn of el.tablehead.querySelectorAll('button.th[data-sort]')) {
    const label = meta.cols[btn.dataset.sort];
    if (label && btn.firstChild) btn.firstChild.textContent = label;
  }

  updateStats();
  updateButtons();
  updatePlayerFormat();
}

function selectSource(source) {
  if (!SOURCES[source] || state.source === source) return;
  state.source = source;
  localStorage.setItem(SOURCE_KEY, source);
  state.error = null;
  applySourceChrome();

  if (source === 'somafm') {
    if (state.channels.length === 0) {
      void loadChannels();
      return;
    }
    state.loading = false;
    render();
    updateButtons();
    resolveAll();
    return;
  }

  if (source === 'favorites') {
    state.loading = false;
    render();
    updateButtons();
    resolveAll(state.favorites);   // fill in any SomaFM favorites' streams
    return;
  }

  // radio-browser results are already there and still match the filters
  if (state.rb.stations.length && state.rb.key === rbKey()) {
    state.loading = false;
    render();
    updateButtons();
    return;
  }
  void loadRb();
}

function cardHtml(ch, index) {
  const meta = SOURCES[ch.source] ?? SOURCES.somafm;
  const isCurrent = state.currentId === ch.id;
  const isLive = isCurrent && state.playing;
  const isFav = isFavorite(ch.id);
  const logo = ch.image
    ? `<img class="card__logo" data-logo src="${esc(ch.image)}" alt="" width="34" height="34" loading="lazy" data-letter="${esc(ch.title.slice(0, 1))}">`
    : `<span class="card__initial" aria-hidden="true">${esc(ch.title.slice(0, 1))}</span>`;
  const now = ch.lastPlaying ? esc(ch.lastPlaying) : '—';
  const listeners = Number(ch.listeners || 0);

  const info = ch.source === 'radiobrowser'
    ? `<button type="button" class="card__info" data-info aria-label="Подробнее о станции ${esc(ch.title)}">
         <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 7.2v3.5M8 5.1v.05" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
       </button>`
    : '';

  const fav = `<button type="button" class="card__fav" data-fav aria-pressed="${isFav}" aria-label="${isFav ? 'Убрать из любимого' : 'Добавить в любимое'}: ${esc(ch.title)}" title="${isFav ? 'Убрать из любимого' : 'В любимое'}">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6l1.9 3.85 4.25.62-3.07 3 .72 4.23L8 11.3l-3.8 2 .72-4.23-3.07-3 4.25-.62z"/></svg>
    </button>`;

  return `
    <div class="card${isCurrent ? ' is-playing' : ''}${isLive ? ' is-live' : ''}" data-id="${esc(ch.id)}">
      <div class="card__actions">${fav}${info}</div>
      <div class="card__main" tabindex="0" role="button" aria-pressed="${isLive}" aria-label="${isLive ? 'Пауза' : 'Слушать'} ${esc(ch.title)}">
        <span class="card__num" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
        <div class="card__name">
          <div class="card__thumb">${logo}</div>
          <h2 class="card__title">${esc(ch.title)}</h2>
          <span class="card__eq" aria-hidden="true"><i></i><i></i><i></i></span>
        </div>
        <span class="card__genre" title="${esc(ch.description || ch.genre)}">${esc(ch.genre)}</span>
        <span class="card__now"><b>${esc(meta.nowPrefix)}:</b> ${now}</span>
        <span class="card__listeners" title="${esc(meta.listenersTitle)}">${listeners}</span>
      </div>
    </div>`;
}

function armLogos(root) {
  root.querySelectorAll('img.card__logo').forEach((img) => {
    img.addEventListener('error', () => {
      const span = document.createElement('span');
      span.className = 'card__initial';
      span.textContent = img.dataset.letter || '◉';
      img.replaceWith(span);
    }, { once: true });
  });
}

/* ---------------------------------------- station detail --- */

async function copyText(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    toast(ok ? okMessage : 'Копирование не поддерживается браузером', !ok);
    return ok;
  }
}

let stationDetailsId = null;

/** Present the "Всё радио" station card. All data lives in the loaded list. */
function openStationDetails(id) {
  const channel = byId(id);
  if (!channel || channel.source !== 'radiobrowser') return;
  stationDetailsId = id;

  el.station.title.textContent = channel.title;
  el.station.meta.textContent = channel.genre && channel.genre !== '—'
    ? channel.genre
    : channel.country || 'Радиостанция';

  if (channel.image) {
    el.station.logo.hidden = false;
    el.station.fallback.hidden = true;
    el.station.logo.src = channel.image;
    el.station.logo.onerror = () => {
      el.station.logo.hidden = true;
      el.station.fallback.hidden = false;
    };
  } else {
    el.station.logo.hidden = true;
    el.station.fallback.hidden = false;
  }

  const rows = [];
  if (channel.description) rows.push(detailRow('Теги', esc(channel.description)));
  const geo = [channel.country, channel.state].filter(Boolean).join(', ');
  if (geo) rows.push(detailRow('Страна', esc(geo)));
  if (channel.language) rows.push(detailRow('Язык', esc(channel.language)));
  const format = [
    channel.codec,
    channel.bitrate ? `${channel.bitrate} kbps` : '',
    channel.hls ? 'HLS' : '',
  ].filter(Boolean).join(' · ');
  if (format) rows.push(detailRow('Формат', esc(format)));
  rows.push(detailRow('Голоса', esc(fmtNum(channel.listeners))));
  if (channel.clickcount) {
    const trend = channel.clicktrend
      ? ` · тренд ${fmtNum(Math.abs(channel.clicktrend))}${channel.clicktrend < 0 ? '↓' : '↑'}`
      : '';
    rows.push(detailRow('Прослушиваний', esc(`${fmtNum(channel.clickcount)}${trend}`)));
  }
  rows.push(detailRow('Проверка', esc(fmtChecked(channel.checkedAt, channel.checkedOk))));
  el.station.rows.innerHTML = rows.join('');

  if (channel.homepage) {
    el.station.homepage.href = channel.homepage;
    el.station.homepage.hidden = false;
  } else {
    el.station.homepage.hidden = true;
  }

  paintDetailFav(channel);
  el.station.dialog.showModal();
}

function closeStationDetails() {
  if (el.station.dialog.open) el.station.dialog.close();
}

function updateButtons(listLength = visibleChannels().length) {
  const resolving = viewResolvesStreams() && state.resolve.active;
  // direct stream URLs are the whole point — wait until the .pls round-trip is done
  const ready = !state.loading && !state.error && !resolving && listLength > 0;
  el.download.disabled = !ready;
  el.copy.disabled = !ready;
  el.downloadLabel.textContent = resolving
    ? `Резолв потоков… (${state.resolve.done}/${state.resolve.total})`
    : state.loading
      ? `Скачать ${SOURCES[state.source].file}`
      : `Скачать ${SOURCES[state.source].file} (${listLength})`;
}

function updateStreamStat() {
  if (state.source === 'radiobrowser') {
    // radio-browser ships direct (or pre-resolved) stream URLs
    el.stats.streams.textContent = String(state.rb.stations.length || '—');
    return;
  }
  if (state.source === 'favorites') {
    const total = state.favorites.length;
    const ready = state.favorites.filter(streamReadyFor).length;
    el.stats.streams.textContent = total ? `${ready}/${total}` : '—';
    return;
  }
  const total = state.channels.filter((ch) => ch.pls[state.kind]).length;
  const ready = state.channels.filter(
    (ch) => ch.pls[state.kind] && state.streams.has(streamKey(state.kind, ch.pls[state.kind])),
  ).length;
  el.stats.streams.textContent = `${ready}/${total}`;
}

function setStatus(text, modifier) {
  el.statusLine.textContent = text;
  el.statusLine.classList.toggle('is-busy', modifier === 'is-busy');
  el.statusLine.classList.toggle('is-ok', modifier === 'is-ok');
}

const updateStats = () => {
  el.stats.channels.textContent = String(currentList().length || '—');
  el.stats.quality.textContent = qualityStatText();
  updateStreamStat();
};

/* ------------------------------------------------ player --- */

const byId = (id) =>
  state.channels.find((ch) => ch.id === id)
  ?? state.rb.stations.find((ch) => ch.id === id)
  ?? state.favorites.find((ch) => ch.id === id)
  ?? null;

async function ensureStream(channel) {
  // radio-browser already gives us a direct stream URL
  if (channel.source === 'radiobrowser') {
    return channel.stream ? { url: channel.stream, kind: 'rb' } : null;
  }

  const order = [state.kind, ...KIND_ORDER.filter((key) => key !== state.kind)];
  for (const kind of order) {
    const pls = channel.pls[kind];
    if (!pls) continue;
    const key = streamKey(kind, pls);
    const cached = state.streams.get(key);
    if (cached) return { url: cached, kind };
    const resolved = await resolvePls(pls);
    if (resolved) {
      state.streams.set(key, resolved);
      saveCache();
      return { url: resolved, kind };
    }
  }
  return null;
}

async function changeQuality(newKind) {
  if (state.source !== 'somafm' || !KINDS[newKind] || state.kind === newKind) return;
  state.kind = newKind;
  localStorage.setItem(KIND_KEY, state.kind);

  const kindInput = el.kinds.querySelector(`input[value="${state.kind}"]`);
  if (kindInput) kindInput.checked = true;

  updatePlayerFormat();

  updateStats();
  render();
  resolveAll();

  if (state.currentId) {
    const channel = byId(state.currentId);
    if (channel) {
      setPlayerNow('Смена качества потока…');
      const stream = await ensureStream(channel);
      if (stream && state.currentId === channel.id) {
        const wasPlaying = state.playing || !el.audio.paused;
        el.audio.src = stream.url;
        if (wasPlaying) {
          try {
            await el.audio.play();
          } catch {
            // handle auto-play restrictions if any
          }
        }
        refreshNowPlaying();
        toast(`Качество изменено: ${KINDS[state.kind].label}`);
      }
    }
  }
}

/**
 * Best-effort click counter for the "Всё радио" catalogue: fires and forgets,
 * must never disturb the session's cached API base (flaky network is normal).
 */
function trackRbClick(channel) {
  if (channel.source !== 'radiobrowser' || !channel.uuid) return;
  const base = preferredRbBase();
  if (!base) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  fetch(`${base}/json/url/${encodeURIComponent(channel.uuid)}`, {
    signal: controller.signal,
    headers: { Accept: 'application/json' },
  }).catch(() => { /* click counter is best-effort */ }).finally(() => clearTimeout(timer));
}

async function playChannel(id) {
  const channel = byId(id);
  if (!channel) return;

  if (state.currentId === id && el.audio.src) {
    togglePlayback();
    return;
  }

  state.currentId = id;
  state.now = null;
  failedAttempts = 0;
  paintPlayerStation(channel);
  updatePlayButtons();
  setPlayerNow('Подключение к потоку…');

  const stream = await ensureStream(channel);
  if (!stream) {
    toast('Не удалось получить ссылку на поток', true);
    state.currentId = null;
    updatePlayButtons();
    return;
  }
  if (state.currentId !== id) return; // user switched while resolving

  el.audio.src = stream.url;
  trackRbClick(channel);
  try {
    await el.audio.play();
  } catch (err) {
    // AbortError = another play() superseded this one; not a real failure
    if (err?.name !== 'AbortError') {
      state.playing = false;
      updatePlayButtons();
      toast(
        err?.name === 'NotAllowedError'
          ? 'Браузер запретил автозапуск — нажмите «Слушать» ещё раз'
          : 'Не удалось начать воспроизведение',
        true,
      );
    }
  }
  refreshNowPlaying();
}

function togglePlayback() {
  if (!state.currentId) {
    const first = visibleChannels()[0];
    if (first) void playChannel(first.id);
    return;
  }
  if (el.audio.paused) void el.audio.play();
  else el.audio.pause();
}

function step(delta) {
  const list = visibleChannels();
  if (list.length === 0) return;
  const index = list.findIndex((ch) => ch.id === state.currentId);
  const next = list[(index + delta + list.length) % list.length] ?? list[0];
  void playChannel(next.id);
}

/** Codec + bitrate label for a station, e.g. "MP3 128". */
function channelFormat(channel) {
  if (channel.source === 'somafm') return KINDS[state.kind].short;
  const codec = String(channel.codec || '').trim().toUpperCase();
  const kbps = Number(channel.bitrate) || 0;
  if (codec && kbps) return `${codec} ${kbps}`;
  return codec || (kbps ? `${kbps} kbps` : '—');
}

/**
 * Show the current stream's real format in the player chip. SomaFM's quality is
 * chosen from the controls, while "Всё радио" carries its own codec/bitrate per
 * station — so the chip follows the station, not the active tab.
 */
function updatePlayerFormat() {
  if (!el.player.format) return;
  const channel = state.currentId ? byId(state.currentId) : null;
  el.player.format.textContent = channel
    ? channelFormat(channel)
    : (state.source === 'somafm' ? KINDS[state.kind].short : '—');
}

function paintPlayerStation(channel) {
  el.player.title.textContent = channel.title;
  el.player.fallback.hidden = Boolean(channel.image);
  el.player.logo.hidden = !channel.image;
  if (channel.image) {
    el.player.logo.src = channel.image;
    el.player.logo.alt = '';
    el.player.logo.onerror = () => {
      el.player.logo.hidden = true;
      el.player.fallback.hidden = false;
    };
  }
  updatePlayerFormat();
  updateMediaSession(channel);
}

function setPlayerNow(text) {
  el.player.now.textContent = text;
}

function updatePlayButtons() {
  const hasSource = Boolean(state.currentId);
  el.player.toggle.disabled = !hasSource;
  el.player.prev.disabled = !hasSource;
  el.player.next.disabled = !hasSource;
  document.body.classList.toggle('is-playing', state.playing);
  el.player.toggle.setAttribute('aria-label', state.playing ? 'Пауза' : 'Воспроизвести');

  for (const card of el.grid.querySelectorAll('.card')) {
    const current = card.dataset.id === state.currentId;
    const active = current && state.playing;
    card.classList.toggle('is-playing', current); // selected row
    card.classList.toggle('is-live', active);     // actually playing → animated
    const main = card.querySelector('.card__main');
    if (main) main.setAttribute('aria-pressed', String(active));
  }
}

function syncMuteUi() {
  const muted = el.audio.muted;
  document.body.classList.toggle('is-muted', muted);
  const label = muted ? 'Включить звук' : 'Выключить звук';
  el.player.mute.setAttribute('aria-label', label);
  el.player.mute.setAttribute('title', label);
}

/** Text of the currently playing track from either source, or '' if unknown. */
function currentTrackText() {
  const now = state.now;
  if (!now) return '';
  if (now.icy) return now.icy;
  if (now.current) return `${now.current.artist} — ${now.current.title}`;
  return '';
}

function updateMediaSession(channel) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  const meta = SOURCES[channel.source] ?? SOURCES.somafm;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: channel.title,
      artist: currentTrackText() || meta.label,
      album: meta.album,
      artwork: channel.image ? [{ src: channel.image, sizes: '256x256', type: 'image/png' }] : [],
    });
  } catch {
    /* media session is a progressive enhancement */
  }
}

let nowPlayingTimer = 0;

/**
 * Ask the bundled proxy to read the live stream's ICY "now playing" title.
 * The browser cannot do this itself (no CORS on the audio stream), so the
 * proxy is genuinely required here regardless of which catalogue endpoint the
 * client uses — unlike the JSON catalogue, which is fetched directly whenever
 * the official server is reachable. The title is best-effort: any failure just
 * returns '' and the caller falls back.
 */
async function fetchIcyTitle(channel) {
  if (!RB_API_PROXY || !channel.stream) return '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(`${RB_API_PROXY}/icy?url=${encodeURIComponent(channel.stream)}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return '';
    const data = await response.json().catch(() => null);
    return typeof data?.title === 'string' ? data.title.trim() : '';
  } catch {
    return ''; // offline / no metadata — keep the fallback line
  } finally {
    clearTimeout(timer);
  }
}

function refreshNowPlaying() {
  clearTimeout(nowPlayingTimer);
  const channel = byId(state.currentId);
  if (!channel) return;

  // radio-browser has no now-playing API; the stream itself may carry one.
  if (channel.source === 'radiobrowser') {
    const fallback = channel.genre && channel.genre !== '—'
      ? `${channel.genre} · прямой эфир`
      : 'Прямой эфир';
    // while polling, keep the last known title on screen instead of flickering
    if (!state.now?.icy) setPlayerNow(fallback);
    fetchIcyTitle(channel)
      .then((title) => {
        if (state.currentId !== channel.id) return;
        if (title) {
          state.now = { icy: title };
          setPlayerNow(title);
        } else if (!state.now?.icy) {
          setPlayerNow(fallback);
        }
        updateMediaSession(channel);
      })
      .catch(() => { /* keep the fallback — metadata is best-effort */ })
      .finally(() => {
        if (state.currentId === channel.id) {
          nowPlayingTimer = setTimeout(refreshNowPlaying, ICY_INTERVAL);
        }
      });
    return;
  }

  fetchWithRetry(songsUrl(channel.id), { retries: 0, timeout: 10_000, accept: 'application/json' })
    .then((response) => response.json())
    .then((data) => {
      const songs = Array.isArray(data?.songs) ? data.songs : [];
      if (!songs.length || state.currentId !== channel.id) return;
      const current = songs[0];
      const recent = songs[1];
      state.now = { current, recent };
      setPlayerNow(`${current.artist} — ${current.title}`);
      updateMediaSession(channel);
      const card = el.grid.querySelector(`[data-id="${CSS.escape(channel.id)}"] .card__now`);
      if (card) card.innerHTML = `<b>Играет:</b> ${esc(`${current.artist} — ${current.title}`)}`;
    })
    .catch(() => { /* offline / rate limited — keep the last known track */ })
    .finally(() => {
      if (state.currentId === channel.id) {
        nowPlayingTimer = setTimeout(refreshNowPlaying, NOW_PLAYING_INTERVAL);
      }
    });
}

/* --------------------------------------------- playlist --- */

function buildPlaylist(list) {
  const kindKey = state.kind;
  const kind = KINDS[kindKey];
  const stamp = new Date().toLocaleString('ru-RU', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const summary = state.source === 'somafm'
    ? `# Soma FM playlist: ${list.length} channels, ${kind.key} (${kind.label})`
    : state.source === 'favorites'
      ? `# Guilliman's Radio favorites: ${list.length} stations`
      : `# Guilliman's Radio playlist: ${list.length} stations`;
  const lines = [
    '#EXTM3U',
    summary,
    `# Generated by Guilliman's Radio on ${stamp}`,
  ];
  for (const channel of list) {
    lines.push(`#EXTINF:-1,${cleanTitle(channel.title)}`);
    if (channel.source === 'radiobrowser') {
      lines.push(channel.stream);
    } else {
      const kind = kindForChannel(channel, kindKey);
      const stream = kind ? state.streams.get(streamKey(kind, channel.pls[kind])) : null;
      lines.push(stream ?? (kind ? channel.pls[kind] : ''));
    }
  }
  return `${lines.join('\n')}\n`;
}

function downloadPlaylist() {
  const list = visibleChannels();
  if (list.length === 0) return;
  const text = '\uFEFF' + buildPlaylist(list); // BOM keeps titles correct in Windows players
  const blob = new Blob([text], { type: 'audio/x-mpegurl;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = SOURCES[state.source].file;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(`Плейлист сохранён: ${list.length} ${stationsWord(list.length)}`);
}

async function copyPlaylist() {
  const list = visibleChannels();
  if (list.length === 0) return;
  const text = buildPlaylist(list);
  try {
    await navigator.clipboard.writeText(text);
    toast(`Скопировано в буфер: ${list.length} ${stationsWord(list.length)}`);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    toast(ok ? `Скопировано: ${list.length} ${stationsWord(list.length)}` : 'Копирование не поддерживается браузером', !ok);
  }
}

/* ------------------------------------------------- toast --- */

let toastTimer = 0;

function toast(message, isError = false) {
  clearTimeout(toastTimer);
  el.toast.hidden = false;
  el.toast.textContent = message;
  el.toast.classList.toggle('is-error', isError);
  requestAnimationFrame(() => el.toast.classList.add('is-visible'));
  toastTimer = setTimeout(() => {
    el.toast.classList.remove('is-visible');
    setTimeout(() => { el.toast.hidden = true; }, 250);
  }, 3200);
}

/* ------------------------------------------------ events --- */

function bindEvents() {
  el.kinds.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== 'kind') return;
    void changeQuality(input.value);
  });

  el.sources.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== 'source') return;
    selectSource(input.value);
  });

  // radio-browser queries the network — debounce the free-text search
  const rbSearch = debounce(() => {
    if (state.source === 'radiobrowser') void loadRb();
  }, 450);

  el.search.addEventListener('input', () => {
    state.query = el.search.value;
    if (state.source === 'radiobrowser') {
      rbSearch();
      return;
    }
    render();
    updatePlayButtons();
  });

  el.rbTag.addEventListener('change', () => {
    state.rbTag = el.rbTag.value;
    void loadRb();
  });

  el.rbCountry.addEventListener('change', () => {
    state.rbCountry = el.rbCountry.value;
    void loadRb();
  });

  el.rbLimit.addEventListener('change', () => {
    state.rbLimit = Number.parseInt(el.rbLimit.value, 10) || 60;
    void loadRb();
  });

  el.tablehead.addEventListener('click', (event) => {
    const btn = event.target.closest('button.th[data-sort]');
    if (btn) setSort(btn.dataset.sort);
  });

  el.limit.addEventListener('change', () => {
    state.limit = Number.parseInt(el.limit.value, 10) || 0;
    render();
    updatePlayButtons();
  });

  el.grid.addEventListener('click', (event) => {
    const fav = event.target.closest('.card__fav');
    if (fav) {
      const card = fav.closest('.card');
      if (card?.dataset.id) toggleFavorite(card.dataset.id);
      return;
    }
    const info = event.target.closest('.card__info');
    if (info) {
      const card = info.closest('.card');
      if (card?.dataset.id) openStationDetails(card.dataset.id);
      return;
    }
    const card = event.target.closest('.card');
    if (!card || !card.dataset.id) return;
    if (state.currentId === card.dataset.id && el.audio.src) {
      togglePlayback();
      return;
    }
    void playChannel(card.dataset.id);
  });

  el.grid.addEventListener('keydown', (event) => {
    // the info / favorite buttons keep their own Enter/Space behaviour
    if (event.target.closest('.card__info') || event.target.closest('.card__fav')) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest('.card');
    if (!card || !card.dataset.id) return;
    event.preventDefault();
    if (state.currentId === card.dataset.id && el.audio.src) {
      togglePlayback();
      return;
    }
    void playChannel(card.dataset.id);
  });

  el.download.addEventListener('click', downloadPlaylist);
  el.copy.addEventListener('click', copyPlaylist);
  el.retry.addEventListener('click', reloadCurrent);

  el.player.toggle.addEventListener('click', togglePlayback);
  el.player.prev.addEventListener('click', () => step(-1));
  el.player.next.addEventListener('click', () => step(1));

  // station detail dialog
  el.station.close.addEventListener('click', closeStationDetails);
  el.station.dialog.addEventListener('click', (event) => {
    if (event.target === el.station.dialog) closeStationDetails();
  });
  el.station.play.addEventListener('click', () => {
    const id = stationDetailsId;
    closeStationDetails();
    if (id) void playChannel(id);
  });
  el.station.fav.addEventListener('click', () => {
    if (!stationDetailsId) return;
    toggleFavorite(stationDetailsId);
    const channel = byId(stationDetailsId);
    if (channel) paintDetailFav(channel);
  });
  el.station.copy.addEventListener('click', () => {
    if (!stationDetailsId) return;
    const channel = byId(stationDetailsId);
    if (!channel) return;
    const url = channel.stream || channel.url;
    if (url) void copyText(url, 'Ссылка на поток скопирована');
    else toast('Ссылка на поток недоступна', true);
  });

  el.audio.addEventListener('play', () => {
    state.playing = true;
    updatePlayButtons();
    refreshNowPlaying();
  });
  el.audio.addEventListener('playing', () => {
    failedAttempts = 0;
    state.playing = true;
    updatePlayButtons();
  });
  el.audio.addEventListener('pause', () => {
    state.playing = false;
    updatePlayButtons();
    clearTimeout(nowPlayingTimer);
  });
  el.audio.addEventListener('error', () => {
    if (!el.audio.currentSrc) return;
    state.playing = false;
    updatePlayButtons();

    const channel = byId(state.currentId);
    if (!channel) return;

    if (channel.source === 'radiobrowser') {
      toast('Поток недоступен. Попробуйте другую станцию.', true);
      return;
    }

    // a broken stream gets two more chances (other quality → other station),
    // then we stop instead of looping forever
    if (failedAttempts >= 2) {
      toast('Поток недоступен. Попробуйте другую станцию или качество.', true);
      return;
    }
    failedAttempts += 1;
    toast(`Поток недоступен — пробую другое качество (${failedAttempts}/3)`, true);

    // drop possibly broken urls from the cache and retry with another quality
    for (const kind of KIND_ORDER) {
      const pls = channel.pls[kind];
      if (pls) state.streams.delete(streamKey(kind, pls));
    }
    saveCache();
    state.currentId = null;
    void playChannel(channel.id);
  });

  // keep the mute button honest: icon (CSS), tooltip and a11y label
  el.player.volume.addEventListener('input', () => {
    const value = Number(el.player.volume.value) / 100;
    el.audio.volume = value;
    el.audio.muted = value === 0;
    syncMuteUi();
    localStorage.setItem(VOLUME_KEY, String(value));
  });

  el.player.mute.addEventListener('click', () => {
    el.audio.muted = !el.audio.muted;
    syncMuteUi();
  });

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', () => void el.audio.play());
      navigator.mediaSession.setActionHandler('pause', () => el.audio.pause());
      navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
      navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
    } catch {
      /* some browsers throw on unsupported actions */
    }
  }
}

/* -------------------------------------------------- init --- */

function init() {
  const savedSource = localStorage.getItem(SOURCE_KEY);
  if (savedSource && SOURCES[savedSource]) state.source = savedSource;

  const savedKind = localStorage.getItem(KIND_KEY);
  if (savedKind && KINDS[savedKind]) state.kind = savedKind;

  const kindInput = el.kinds.querySelector(`input[value="${state.kind}"]`);
  if (kindInput) kindInput.checked = true;

  updatePlayerFormat();

  state.rbLimit = Number.parseInt(el.rbLimit.value, 10) || 60;

  const savedVolume = Number.parseFloat(localStorage.getItem(VOLUME_KEY) ?? '');
  const volume = Number.isFinite(savedVolume) ? Math.min(Math.max(savedVolume, 0), 1) : 0.8;
  el.audio.volume = volume;
  el.player.volume.value = String(Math.round(volume * 100));
  el.audio.muted = volume === 0;
  syncMuteUi();

  loadCache();
  loadFavorites();
  bindEvents();
  applySourceChrome();
  updateStats();

  if (state.source === 'radiobrowser') {
    void loadRb();
  } else if (state.source === 'favorites') {
    state.loading = false;
    render();
    resolveAll(state.favorites);
  } else {
    void loadChannels();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}

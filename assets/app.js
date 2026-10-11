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
const CONCURRENCY = 6;
const NOW_PLAYING_INTERVAL = 20_000;

/* --------------------------------------- radio-browser.info --- */

// Official public catalogue endpoint — a single server in DE, reachable from
// most networks but blocked on some (e.g. Russia). A bundled reverse proxy
// (see proxy/worker.js) is tried first so the catalogue keeps working there;
// requests fall back to the official server (and back again) when an endpoint
// is unreachable.
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
// Endpoints to try, in priority order (proxy first, official server as backup).
const RB_API_BUILTIN = [RB_API_PROXY, RB_API_OFFICIAL].filter(Boolean);
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
  errorBox: $('errorBox'),
  errorMessage: $('errorMessage'),
  retry: $('retry'),
  toast: $('toast'),
  audio: $('audio'),
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
      quality: $('playerQuality'),
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

const currentList = () => (state.source === 'somafm' ? state.channels : state.rb.stations);

/** Signature of the active radio-browser request — used to skip redundant reloads. */
const rbKey = () =>
  `${state.query.trim().toLowerCase()}|${state.rbTag}|${state.rbCountry}|${state.rbLimit}`;

/** API bases to try, in order: built-in proxy → official server. */
function rbApiBases() {
  return [...RB_API_BUILTIN];
}

/**
 * Fetch and parse a radio-browser JSON path. Tries every known base in turn
 * (user override → built-in proxy → official server) and remembers the one that
 * answered. A single timeout covers the whole request — headers *and* body — so
 * a stalled response still falls through to the next endpoint instead of hanging.
 */
async function rbFetchJson(path, options = {}) {
  const bases = state.rb.api
    ? [state.rb.api, ...rbApiBases().filter((base) => base !== state.rb.api)]
    : rbApiBases();
  const timeout = options.timeout ?? 10_000;
  let lastError = null;

  for (const base of bases) {
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
      return data;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
    }
  }

  state.rb.api = '';
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

function rbSearchPath() {
  const params = new URLSearchParams({
    limit: String(state.rbLimit),
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
    codec: station.codec || '',
    bitrate: Number.parseInt(station.bitrate, 10) || 0,
    homepage: station.homepage || '',
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
    try {
      await loadRbFacets();
    } catch {
      /* pickers stay empty — search still works without them */
    }
    const data = await rbFetchJson(rbSearchPath(), { timeout: 12_000 });
    if (seq !== rbRequestSeq) return;        // a newer request superseded this one
    if (!Array.isArray(data)) throw new Error('Каталог вернул неожиданный ответ');
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
function resolveAll() {
  const generation = ++state.resolve.generation;
  const kind = state.kind;
  const targets = state.channels.filter((ch) => ch.pls[kind]);
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
  if (state.resolve.active && state.source === 'somafm') {
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

  // SomaFM is filtered and scoped locally; radio-browser results already
  // come back filtered (query / tag / country) and ordered from the API.
  if (state.source === 'somafm') {
    list = list.filter((ch) => ch.pls[state.kind]);
    const query = state.query.trim().toLowerCase();
    if (query) {
      list = list.filter((ch) =>
        `${ch.title} ${ch.genre} ${ch.description}`.toLowerCase().includes(query));
    }

    // "Топ-N по слушателям": scope is always the most-listened N,
    // then the chosen column order is applied on top of that slice.
    if (state.limit > 0) {
      list = [...list].sort(byListeners).slice(0, state.limit);
    }
  }

  const { key, dir } = state.sort;
  const cmp = SORTERS[key] ?? SORTERS.listeners;
  const sign = dir === 'desc' ? -1 : 1;
  return [...list].sort((a, b) => sign * cmp(a, b));
}

function render() {
  const list = visibleChannels();
  const total = currentList().length;
  el.grid.innerHTML = list.map((channel, index) => cardHtml(channel, index)).join('');
  armLogos(el.grid);
  el.emptyBox.hidden = !(list.length === 0 && !state.loading && !state.error);
  el.count.textContent = state.loading
    ? 'загрузка…'
    : `${list.length} из ${total}`;
  el.stats.channels.textContent = String(total || '—');
  el.stats.quality.textContent = state.source === 'somafm' ? KINDS[state.kind].short : 'онлайн';
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
  return `${count} ${stationsWord(count)} · ${KINDS[state.kind].short} готов`;
}

/**
 * Keep the status line in sync with the current playlist.
 * Busy/loading/error texts are owned by their own code paths and left untouched.
 */
function syncStatus() {
  const resolving = state.source === 'somafm' && state.resolve.active;
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
  const logo = ch.image
    ? `<img class="card__logo" data-logo src="${esc(ch.image)}" alt="" width="34" height="34" loading="lazy" data-letter="${esc(ch.title.slice(0, 1))}">`
    : `<span class="card__initial" aria-hidden="true">${esc(ch.title.slice(0, 1))}</span>`;
  const now = ch.lastPlaying ? esc(ch.lastPlaying) : '—';
  const listeners = Number(ch.listeners || 0);

  return `
    <div class="card${isCurrent ? ' is-playing' : ''}${isLive ? ' is-live' : ''}" data-id="${esc(ch.id)}" tabindex="0" role="button" aria-pressed="${isLive}" aria-label="${isLive ? 'Пауза' : 'Слушать'} ${esc(ch.title)}">
      <span class="card__num" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
      <div class="card__name">
        <div class="card__thumb">${logo}</div>
        <h2 class="card__title">${esc(ch.title)}</h2>
        <span class="card__eq" aria-hidden="true"><i></i><i></i><i></i></span>
      </div>
      <span class="card__genre" title="${esc(ch.description || ch.genre)}">${esc(ch.genre)}</span>
      <span class="card__now"><b>${esc(meta.nowPrefix)}:</b> ${now}</span>
      <span class="card__listeners" title="${esc(meta.listenersTitle)}">${listeners}</span>
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

function updateButtons(listLength = visibleChannels().length) {
  const resolving = state.source === 'somafm' && state.resolve.active;
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
  el.stats.quality.textContent = state.source === 'somafm' ? KINDS[state.kind].short : 'онлайн';
  updateStreamStat();
};

/* ------------------------------------------------ player --- */

const byId = (id) =>
  state.channels.find((ch) => ch.id === id)
  ?? state.rb.stations.find((ch) => ch.id === id)
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

  if (el.player.quality) {
    el.player.quality.textContent = KINDS[state.kind].short;
  }

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
    card.setAttribute('aria-pressed', String(active));
  }
}

function syncMuteUi() {
  const muted = el.audio.muted;
  document.body.classList.toggle('is-muted', muted);
  const label = muted ? 'Включить звук' : 'Выключить звук';
  el.player.mute.setAttribute('aria-label', label);
  el.player.mute.setAttribute('title', label);
}

function updateMediaSession(channel) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  const meta = SOURCES[channel.source] ?? SOURCES.somafm;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: channel.title,
      artist: state.now?.current ? `${state.now.current.artist} — ${state.now.current.title}` : meta.label,
      album: meta.album,
      artwork: channel.image ? [{ src: channel.image, sizes: '256x256', type: 'image/png' }] : [],
    });
  } catch {
    /* media session is a progressive enhancement */
  }
}

let nowPlayingTimer = 0;

function refreshNowPlaying() {
  clearTimeout(nowPlayingTimer);
  const channel = byId(state.currentId);
  if (!channel) return;

  // radio-browser has no now-playing API — show the station's flavour instead
  if (channel.source === 'radiobrowser') {
    setPlayerNow(channel.genre && channel.genre !== '—'
      ? `${channel.genre} · прямой эфир`
      : 'Прямой эфир');
    updateMediaSession(channel);
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
      const stream = state.streams.get(streamKey(kindKey, channel.pls[kindKey]));
      lines.push(stream ?? channel.pls[kindKey]);
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

  if (el.player.quality) {
    el.player.quality.addEventListener('click', () => {
      const currentIndex = KIND_ORDER.indexOf(state.kind);
      const nextKind = KIND_ORDER[(currentIndex + 1) % KIND_ORDER.length];
      void changeQuality(nextKind);
    });
  }

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
    const card = event.target.closest('.card');
    if (!card || !card.dataset.id) return;
    if (state.currentId === card.dataset.id && el.audio.src) {
      togglePlayback();
      return;
    }
    void playChannel(card.dataset.id);
  });

  el.grid.addEventListener('keydown', (event) => {
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

  if (el.player.quality) {
    el.player.quality.textContent = KINDS[state.kind].short;
  }

  state.rbLimit = Number.parseInt(el.rbLimit.value, 10) || 60;

  const savedVolume = Number.parseFloat(localStorage.getItem(VOLUME_KEY) ?? '');
  const volume = Number.isFinite(savedVolume) ? Math.min(Math.max(savedVolume, 0), 1) : 0.8;
  el.audio.volume = volume;
  el.player.volume.value = String(Math.round(volume * 100));
  el.audio.muted = volume === 0;
  syncMuteUi();

  loadCache();
  bindEvents();
  applySourceChrome();
  updateStats();

  if (state.source === 'radiobrowser') void loadRb();
  else void loadChannels();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}

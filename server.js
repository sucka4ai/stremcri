// server.js - Render-ready Cricfy Stremio addon (CommonJS)
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { addonBuilder } = require('stremio-addon-sdk');

const app = express();
app.use(cors());
app.use(express.json());

// --------- Config ----------
const PORT = process.env.PORT || 10000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || `http://localhost:${PORT}`;
const CHANNELS_SOURCE = process.env.CHANNELS_SOURCE || ''; // optional external JSON source (leave blank to use built-in)
const CHANNEL_CACHE_TTL = 60 * 1000; // 60s

// --------- Simple in-memory cache ----------
const cache = new Map();
function setCache(key, value, ttl = CHANNEL_CACHE_TTL) {
  cache.set(key, { value, expire: Date.now() + ttl });
}
function getCache(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expire) { cache.delete(key); return null; }
  return e.value;
}

// --------- Example fallback channels (you can replace URLs) ----------
const FALLBACK_CHANNELS = [
  { id: 'cricfy-001', name: 'Cricfy HD 1', poster: null, streamUrl: 'https://cricfy.live/ch1/index.m3u8', group: 'Live' },
  { id: 'cricfy-002', name: 'Cricfy HD 2', poster: null, streamUrl: 'https://cricfy.live/ch2/index.m3u8', group: 'Live' },
  { id: 'cricfy-003', name: 'Cricfy Backup', poster: null, streamUrl: 'https://cricfy.live/ch3/index.m3u8', group: 'Backup' }
];

// --------- Fetch channels (external or fallback) ----------
async function fetchChannels() {
  const cached = getCache('channels');
  if (cached) return cached;

  try {
    if (CHANNELS_SOURCE) {
      const res = await fetch(CHANNELS_SOURCE, { timeout: 10000 });
      const json = await res.json();
      // Expect json.channels array; normalize
      if (Array.isArray(json.channels)) {
        const normalized = json.channels.map((ch, i) => ({
          id: ch.id ? `cricfy_${ch.id}` : `cricfy_ext_${i}`,
          name: ch.name || ch.title || `Cricfy ${i}`,
          poster: ch.logo || ch.image || null,
          streamUrl: ch.url || ch.stream || null,
          group: ch['group-title'] || ch.group || 'Live'
        })).filter(c => c.streamUrl);
        setCache('channels', normalized);
        return normalized;
      }
    }
  } catch (err) {
    console.warn('Channels fetch failed:', err && err.message ? err.message : err);
  }

  setCache('channels', FALLBACK_CHANNELS);
  return FALLBACK_CHANNELS;
}

// --------- Utility: split multiple candidate URLs (comma separated) ----------
function parseCandidates(url) {
  if (!url) return [];
  return url.split(',').map(u => u.trim()).filter(Boolean);
}

// --------- Manifest ----------
const manifest = {
  id: 'com.cricfy.stremio',
  version: '1.0.1',
  name: 'Cricfy Live TV',
  description: 'Watch Cricfy live cricket streams in Stremio (proxied)',
  logo: 'https://i.imgur.com/9Qf2P0K.png',
  types: ['tv'],
  catalogs: [{ type: 'tv', id: 'cricfy_catalog', name: 'Cricfy Live TV' }],
  resources: ['catalog', 'stream', 'meta'],
  idPrefixes: ['cricfy']
};

const builder = new addonBuilder(manifest);

// --------- Catalog handler ----------
builder.defineCatalogHandler(async () => {
  const channels = await fetchChannels();
  const metas = channels.map(ch => ({
    id: ch.id,
    type: 'tv',
    name: ch.name,
    poster: ch.poster || 'https://i.imgur.com/FbP4Hru.png',
    posterShape: 'landscape'
  }));
  return { metas };
});

// --------- Meta handler ----------
builder.defineMetaHandler(async ({ id }) => {
  const channels = await fetchChannels();
  const ch = channels.find(c => c.id === id);
  if (!ch) return { meta: {} };
  return {
    meta: {
      id: ch.id,
      name: ch.name,
      type: 'tv',
      poster: ch.poster || 'https://i.imgur.com/FbP4Hru.png',
      background: ch.poster || null
    }
  };
});

// --------- Stream handler ----------
builder.defineStreamHandler(async ({ id }) => {
  const channels = await fetchChannels();
  const ch = channels.find(c => c.id === id);
  if (!ch) return { streams: [] };

  const candidates = parseCandidates(ch.streamUrl);
  // map candidates to proxied URLs (limit 3)
  const streams = candidates.slice(0, 3).map((u, i) => ({
    title: ch.name + (i > 0 ? ` (mirror ${i+1})` : ''),
    url: `${BASE_URL}/proxy?url=${encodeURIComponent(u)}`
  }));

  // if no candidates found but streamUrl exists, add it
  if (streams.length === 0 && ch.streamUrl) {
    streams.push({ title: ch.name, url: `${BASE_URL}/proxy?url=${encodeURIComponent(ch.streamUrl)}` });
  }

  return { streams };
});

// --------- Express endpoints & proxy ----------
app.get('/', (req, res) => {
  res.json({ addon: manifest.name, status: 'online', manifest: `${BASE_URL}/manifest.json` });
});
app.get('/health', (req, res) => res.json({ ok: true }));

// Proxy middleware: dynamic target via router function
app.use('/proxy', createProxyMiddleware({
  changeOrigin: true,
  secure: false,
  logLevel: 'warn',
  router: req => {
    const u = req.query.url || '';
    try { return decodeURIComponent(u); } catch (e) { return u; }
  },
  onError: (err, req, res) => {
    console.error('Proxy error:', err && err.message ? err.message : err);
    if (!res.headersSent) res.status(502).send('Bad gateway');
  },
  pathRewrite: { '^/proxy': '' }
}));

// Serve manifest
app.get('/manifest.json', (req, res) => res.json(builder.getManifest()));

// --------- Attach stremio router (robust handling) ----------
const addonInterface = builder.getInterface();
// Support flavors: some versions use .getRouter(), some expose .router
let stremioRouter = null;
if (typeof addonInterface.getRouter === 'function') {
  stremioRouter = addonInterface.getRouter();
} else if (addonInterface.router) {
  stremioRouter = addonInterface.router;
} else {
  console.error('ERROR: Could not find Stremio router on addonInterface. Please check stremio-addon-sdk version.');
  process.exit(1);
}
app.use(stremioRouter);

// --------- Start server ----------
app.listen(PORT, () => console.log(`${manifest.name} running on ${PORT} (BASE_URL=${BASE_URL})`));

/**
 * Cricfy Stremio Addon (Enhanced) - FINAL
 * Priority: Xtream M3U URL -> Optional ENV M3U -> Fallback streams
 * Categories auto-extracted, streams proxied, health-aware
 */

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const { parse } = require("iptv-playlist-parser");

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const PLAYLIST_URL = process.env.PLAYLIST_URL || "http://161.123.116.21/get.php?username=addi123&password=addi123&type=m3u_plus";
const PLAYLIST_TTL_MS = Number(process.env.PLAYLIST_TTL_MS || 60_000);
const HEALTH_INTERVAL_MS = Number(process.env.HEALTH_INTERVAL_MS || 30_000);

const app = express();
app.use(cors());
app.use(express.json());

// Proxy for streams
app.use(
  "/proxy",
  createProxyMiddleware({
    target: "http://localhost",
    changeOrigin: true,
    secure: false,
    pathRewrite: (path) => decodeURIComponent(path.replace("/proxy/", "")),
    onProxyReq: (proxyReq) => {
      proxyReq.setHeader("User-Agent", "Mozilla/5.0");
      proxyReq.setHeader("Referer", BASE_URL);
    }
  })
);

// Fallback channels
const STABLE_FALLBACK_CHANNELS = [
  { id: "fallback_1", name: "Fallback 1", url: "https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8", group: "Stable" },
  { id: "fallback_2", name: "Fallback 2", url: "https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8", group: "Stable" }
];

// Cache & health
let playlistCache = { ts: 0, items: [] };
const healthStatus = new Map();

// Utils
const now = () => Date.now();
function makeId(prefix, idx, url) {
  const encoded = Buffer.from(url).toString("base64").replace(/=+$/, "");
  return `${prefix}_${idx}_${encoded}`;
}
function splitCandidates(urlString) {
  if (!urlString) return [];
  const parts = urlString.split(/[,|;]/).map(s => s.trim()).filter(Boolean);
  return parts.length ? parts : [urlString];
}
async function probeUrl(url) {
  try {
    const res = await fetch(url, { method: "GET", timeout: 5000 });
    return { ok: res && res.status >= 200 && res.status < 400, status: res.status };
  } catch (e) { return { ok: false, status: 0 }; }
}

// Parse Xtream/ENV M3U
async function parsePlaylist(url) {
  try {
    const r = await fetch(url, { timeout: 20000 });
    const txt = await r.text();
    const pl = parse(txt);
    return pl.items
      .filter(i => i && i.url)
      .map((it, idx) => {
        const group = it.group || it.tvg?.group || "Unknown";
        const logo = it.tvg?.logo || null;
        const candidates = splitCandidates(it.url);
        return { id: makeId("ch", idx, it.url), name: it.name || `Channel ${idx+1}`, group, logo, candidates };
      });
  } catch (e) {
    console.warn("Playlist fetch/parse error:", e.message);
    return [];
  }
}

// Fetch playlist with priority
async function fetchPlaylist(force = false) {
  if (!force && playlistCache.ts && now() - playlistCache.ts < PLAYLIST_TTL_MS && playlistCache.items.length) {
    return playlistCache.items;
  }
  let items = [];
  try { items = await parsePlaylist(PLAYLIST_URL); } catch (e) { items = []; }

  if (!items || items.length === 0) {
    items = STABLE_FALLBACK_CHANNELS.map((ch, idx) => ({
      id: ch.id, name: ch.name, group: ch.group, logo: ch.logo || null, candidates: splitCandidates(ch.url)
    }));
  }

  playlistCache = { ts: now(), items };
  return items;
}

// Health checks
async function runHealthChecks() {
  try {
    const channels = await fetchPlaylist(false);
    const allCandidates = new Set();
    channels.forEach(c => (c.candidates || []).forEach(u => allCandidates.add(u)));
    const unique = Array.from(allCandidates);
    const concurrency = 6;
    for (let i = 0; i < unique.length; i += concurrency) {
      const slice = unique.slice(i, i + concurrency);
      await Promise.all(slice.map(async (u) => {
        const res = await probeUrl(u);
        healthStatus.set(u, { ok: !!res.ok, status: res.status || 0, lastChecked: now() });
      }));
    }
  } catch (e) { console.warn("Health check error:", e.message); }
}
setInterval(() => runHealthChecks().catch(() => {}), HEALTH_INTERVAL_MS);

// Choose best candidate
function chooseBest(candidates = []) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const scored = candidates.map(u => {
    const s = healthStatus.get(u) || { ok: null, lastChecked: 0 };
    const score = (s.ok ? 1000 : 0) - (s.lastChecked || 0)/1000;
    return { u, ok: !!s.ok, lastChecked: s.lastChecked, score };
  });
  scored.sort((a,b) => b.score - a.score);
  const healthy = scored.find(s => s.ok);
  return healthy ? healthy.u : scored[0].u;
}

// Live detection
function isLiveNow(ch) {
  const s = `${ch.name} ${ch.group}`.toLowerCase();
  return /live|vs|v |match|ipl|t20|odi|test|final|semi/.test(s);
}

// Build manifest
async function buildManifest() {
  const channels = await fetchPlaylist(false);
  const groups = [...new Set(channels.map(c => c.group || "Other"))].sort();
  const hasLive = channels.some(isLiveNow);
  const catalogs = [
    { type: "tv", id: "all_channels", name: "All Channels" },
    ...(hasLive ? [{ type: "tv", id: "live_now", name: "LIVE NOW" }] : []),
    ...groups.map(g => ({ type: "tv", id: `cat_${g.replace(/\s+/g,'_').toLowerCase()}`, name: g }))
  ];
  return {
    id: "com.sucka.cricfy",
    version: "1.2.1",
    name: "Cricfy TV (Enhanced)",
    description: "Cricfy + optional M3U + stable fallback. Auto categories, health & retries (no EPG).",
    logo: "https://i.imgur.com/9Qf2P0K.png",
    types: ["tv"],
    catalogs,
    resources: ["catalog","meta","stream"]
  };
}

// Build addon
let builder;
(async function initAddon() {
  const manifest = await buildManifest();
  builder = new addonBuilder(manifest);

  builder.defineCatalogHandler(async ({ id }) => {
    const channels = await fetchPlaylist(false);

    if (id === "all_channels") {
      return { metas: channels.map(ch => ({
        id: ch.id, type: "tv", name: ch.name,
        poster: ch.logo || "https://i.imgur.com/9Qf2P0K.png",
        posterShape: "landscape", description: ch.group
      }))};
    }

    if (id === "live_now") {
      const live = channels.filter(isLiveNow);
      return { metas: live.map(ch => ({ id: ch.id, type: "tv", name: ch.name, poster: ch.logo || "https://i.imgur.com/9Qf2P0K.png", description: ch.group })) };
    }

    const cat = id.replace(/^cat_/, "").replace(/_/g, " ");
    const filtered = channels.filter(c => (c.group || "Other").toLowerCase() === cat.toLowerCase());
    return { metas: filtered.map(ch => ({ id: ch.id, type: "tv", name: ch.name, poster: ch.logo || "https://i.imgur.com/9Qf2P0K.png", description: c.group })) };
  });

  builder.defineMetaHandler(async ({ id }) => {
    const channels = await fetchPlaylist(false);
    const ch = channels.find(c => c.id === id);
    if (!ch) return { meta: {} };
    return { meta: { id: ch.id, type: "tv", name: ch.name, poster: ch.logo || null, description: ch.group }};
  });

  builder.defineStreamHandler(async ({ id }) => {
    const channels = await fetchPlaylist(false);
    const ch = channels.find(c => c.id === id);
    if (!ch) return { streams: [] };
    const best = chooseBest(ch.candidates);
    if (!best) return { streams: [] };
    return { streams: [{ title: ch.name, url: `${BASE_URL}/proxy/${encodeURIComponent(best)}` }] };
  });

  // endpoints
  app.get("/", (req, res) => res.json({ status: "ok", name: manifest.name, manifest: `${BASE_URL}/manifest.json` }));
  app.get("/manifest.json", (req, res) => res.json(builder.getManifest()));
  app.get("/admin/channels", async (req, res) => {
    const items = await fetchPlaylist(false);
    const list = items.map(ch => ({
      id: ch.id, name: ch.name, group: ch.group, logo: ch.logo, candidates: ch.candidates,
      resolved: chooseBest(ch.candidates),
      health: (ch.candidates || []).map(u => ({ url: u, ...(healthStatus.get(u) || {}) }))
    }));
    res.json({ items, count: list.length, list });
  });
  app.post("/refresh", async (req,res) => { await fetchPlaylist(true); await runHealthChecks(); res.json({ refreshed: true, items: playlistCache.items.length }); });

  // Start server
  serveHTTP(builder.getInterface(), { port: PORT });
  console.log(`Cricfy TV (Enhanced) running on port ${PORT} (BASE_URL=${BASE_URL})`);
})();

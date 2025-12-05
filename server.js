/**
 * Enhanced Cricfy Stremio Addon (no EPG)
 * - Dynamic playlist parsing
 * - Auto categories (group-title)
 * - Playlist caching & background refresh
 * - Stream health checks & auto-retry of candidate URLs
 * - Proxy for .m3u8 with correct target placeholder
 * - Manual /refresh endpoint
 *
 * Configure:
 * - PLAYLIST_URL    : M3U playlist URL (env or change default)
 * - PLAYLIST_TTL_MS : cache TTL (default 60s)
 * - HEALTH_INTERVAL_MS : how often to check streams (default 30s)
 * - BASE_URL        : optional publicly-accessible base URL (Render sets RENDER_EXTERNAL_URL)
 */

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const { parse } = require("iptv-playlist-parser");

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const PLAYLIST_URL = process.env.PLAYLIST_URL || "https://cricfy.live/playlist.m3u"; // ← replace with working M3U
const PLAYLIST_TTL_MS = Number(process.env.PLAYLIST_TTL_MS) || 60 * 1000;
const HEALTH_INTERVAL_MS = Number(process.env.HEALTH_INTERVAL_MS) || 30 * 1000;
const MAX_HEALTH_CHECK_CONCURRENCY = 8; // safety

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------
// Proxy for stream URLs
// ---------------------------
app.use(
  "/proxy",
  createProxyMiddleware({
    // placeholder required by http-proxy-middleware
    target: "http://localhost",
    changeOrigin: true,
    secure: false,
    logLevel: "warn",
    pathRewrite: (path) => decodeURIComponent(path.replace("/proxy/", "")),
    onProxyReq: (proxyReq) => {
      proxyReq.setHeader("User-Agent", "Mozilla/5.0 (X11; Linux x86_64)");
      proxyReq.setHeader("Referer", "https://cricfy.live/");
    },
    onError: (err, req, res) => {
      console.error("Proxy error:", err && err.message ? err.message : err);
      if (!res.headersSent) res.status(502).send("Bad gateway");
    }
  })
);

// ---------------------------
// In-memory caches & health map
// ---------------------------
let playlistCache = { ts: 0, items: [] }; // {ts, items: [...]}
const healthStatus = new Map(); // key = candidateURL, value = { ok: true/false, lastChecked: ts, latency }

// ---------------------------
// Utilities
// ---------------------------
function now() { return Date.now(); }
function makeChannelId(idx, url) {
  return `cricfy_${idx}_${Buffer.from(url).toString("base64").replace(/=+$/,"")}`;
}

function splitCandidates(url) {
  // Accept comma-separated or pipe-separated lists; fallback to single URL
  if (!url) return [];
  const parts = url.split(/[,|;]/).map(s => s.trim()).filter(Boolean);
  return parts.length ? parts : [url];
}

async function probeUrl(url, timeoutMs = 5000) {
  // quick check to see if a stream responds
  try {
    const res = await fetch(url, { method: "GET", timeout: timeoutMs, redirect: "follow" });
    const ok = res && (res.status >= 200 && res.status < 400);
    const latency = res && res.headers && res.headers.get("x-response-time") ? Number(res.headers.get("x-response-time")) : null;
    return { ok, status: res ? res.status : 0, latency };
  } catch (err) {
    return { ok: false, status: 0, latency: null };
  }
}

// ---------------------------
// Fetch & parse playlist (with cache)
// ---------------------------
async function fetchPlaylist(force = false) {
  if (!force && (now() - playlistCache.ts) < PLAYLIST_TTL_MS && playlistCache.items.length) {
    return playlistCache.items;
  }

  try {
    const res = await fetch(PLAYLIST_URL, { timeout: 20000 });
    const text = await res.text();
    const pl = parse(text);

    const items = (pl.items || [])
      .filter(i => i && i.url)
      .map((it, idx) => {
        const group = it.group || it.tvg?.group || it.tvg?.groupTitle || "Other";
        const logo = it.tvg?.logo || it.logo || null;
        const name = it.name || it.tvg?.name || `Channel ${idx+1}`;
        const candidates = splitCandidates(it.url);

        return {
          id: makeChannelId(idx, it.url),
          name,
          candidates,
          url: candidates[0],
          group,
          logo
        };
      });

    playlistCache = { ts: now(), items };
    return items;
  } catch (err) {
    console.error("Playlist fetch/parse error:", err && err.message ? err.message : err);
    // return previous items if exist
    return playlistCache.items || [];
  }
}

// ---------------------------
// Health check worker
// - Periodically probes candidate urls and updates healthStatus map
// ---------------------------
let healthCheckerTimer = null;
let ongoingHealthChecks = 0;

async function runHealthChecks() {
  try {
    const channels = await fetchPlaylist(false);
    const candidates = [];

    channels.forEach(ch => {
      ch.candidates.forEach(c => candidates.push(c));
    });

    // dedupe
    const unique = [...new Set(candidates)];

    // probe sequentially with limited concurrency to avoid flooding
    for (let i = 0; i < unique.length; i += 1) {
      if (ongoingHealthChecks >= MAX_HEALTH_CHECK_CONCURRENCY) {
        // small delay loop
        await new Promise(r => setTimeout(r, 50));
        i--; // retry this index later
        continue;
      }

      const url = unique[i];
      ongoingHealthChecks++;
      (async (u) => {
        const start = now();
        const res = await probeUrl(u, 5000);
        const latency = res.latency || (now() - start);
        healthStatus.set(u, { ok: !!res.ok, status: res.status || 0, lastChecked: now(), latency });
        ongoingHealthChecks--;
      })(url);
    }
  } catch (e) {
    console.warn("Health check loop error:", e && e.message ? e.message : e);
  }
}

// start health checker interval
function startHealthChecker() {
  if (healthCheckerTimer) clearInterval(healthCheckerTimer);
  // run once immediately
  runHealthChecks();
  healthCheckerTimer = setInterval(runHealthChecks, HEALTH_INTERVAL_MS);
}

// ---------------------------
// Choose best candidate for a channel (prefer healthy)
// ---------------------------
function chooseBestCandidate(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  // prefer candidates with healthStatus.ok true
  const scored = candidates.map(u => {
    const s = healthStatus.get(u) || { ok: null, latency: null, lastChecked: 0 };
    const score = (s.ok ? 1000 : 0) - (s.latency || 0); // higher score = better
    return { u, ok: !!s.ok, latency: s.latency || 99999, lastChecked: s.lastChecked || 0, score };
  });

  // sort by score desc, lastChecked recent
  scored.sort((a,b) => b.score - a.score || b.lastChecked - a.lastChecked);

  // pick first that is marked ok; otherwise pick first candidate
  const healthy = scored.find(s => s.ok);
  if (healthy) return healthy.u;
  return scored[0] ? scored[0].u : null;
}

// ---------------------------
// Live-now detection (best-effort, no EPG)
// - checks for keywords in name or group
// ---------------------------
function isLiveNow(ch) {
  if (!ch || !ch.name) return false;
  const text = `${ch.name} ${ch.group} ${ch.url}`.toLowerCase();
  const keywords = ['live', 'match', 'vs', 'v ', 't20', 'odi', 'test', 'ipl', 'final', 'semi'];
  return keywords.some(k => text.includes(k));
}

// ---------------------------
// Build manifest with dynamic categories (called once at startup after initial fetch)
// ---------------------------
async function buildManifest() {
  const channels = await fetchPlaylist(false);
  const groups = [...new Set(channels.map(c => c.group || 'Other'))].sort();

  // add special LIVE NOW category if any channel appears live
  const hasLiveNow = channels.some(isLiveNow);
  const catalogs = [
    { type: "tv", id: "cricfy_all", name: "All Channels" },
    ...(hasLiveNow ? [{ type: "tv", id: "cricfy_live_now", name: "LIVE NOW" }] : []),
    ...groups.map(g => ({ type: "tv", id: `cricfy_${g.replace(/\s+/g,'_').toLowerCase()}`, name: g }))
  ];

  return {
    id: "com.sucka.cricfy",
    version: "1.2.0",
    name: "Cricfy TV (Enhanced)",
    description: "Cricfy IPTV with dynamic categories, health checks and retries (no EPG)",
    logo: "https://i.imgur.com/9Qf2P0K.png",
    types: ["tv"],
    catalogs,
    resources: ["catalog","meta","stream"]
  };
}

// ---------------------------
// Initialize addon (manifest + builder)
// ---------------------------
let builder;
let manifest;
(async function init() {
  // initial playlist fetch + health checks
  await fetchPlaylist(true);
  startHealthChecker();

  // build manifest from categories
  manifest = await buildManifest();
  builder = new addonBuilder(manifest);

  // CATALOG HANDLER
  builder.defineCatalogHandler(async ({ id }) => {
    const channels = await fetchPlaylist(false);

    if (id === "cricfy_all") {
      return { metas: channels.map((ch) => ({
        id: ch.id,
        type: "tv",
        name: ch.name,
        poster: ch.logo || "https://i.imgur.com/9Qf2P0K.png",
        posterShape: "landscape",
        description: ch.group
      }))};
    }

    if (id === "cricfy_live_now") {
      const live = channels.filter(isLiveNow);
      return { metas: live.map(ch => ({
        id: ch.id, type: "tv", name: ch.name,
        poster: ch.logo || "https://i.imgur.com/9Qf2P0K.png",
        posterShape: "landscape", description: ch.group
      }))};
    }

    // category catalogs
    const catName = id.replace(/^cricfy_/, "").replace(/_/g, " ");
    const filtered = channels.filter(c => (c.group || "Other").toLowerCase() === catName.toLowerCase());

    return { metas: filtered.map(ch => ({
      id: ch.id, type: "tv", name: ch.name,
      poster: ch.logo || "https://i.imgur.com/9Qf2P0K.png",
      posterShape: "landscape", description: ch.group
    }))};
  });

  // META HANDLER
  builder.defineMetaHandler(async ({ id }) => {
    const channels = await fetchPlaylist(false);
    const ch = channels.find(c => c.id === id);
    if (!ch) return { meta: {} };
    return { meta: {
      id: ch.id, type: "tv", name: ch.name,
      poster: ch.logo || "https://i.imgur.com/9Qf2P0K.png",
      background: ch.logo || null,
      description: ch.group
    }};
  });

  // STREAM HANDLER (choose best candidate auto)
  builder.defineStreamHandler(async ({ id }) => {
    const channels = await fetchPlaylist(false);
    const ch = channels.find(c => c.id === id);
    if (!ch) return { streams: [] };

    // pick best candidate based on healthStatus
    const best = chooseBestCandidate(ch.candidates);
    const finalUrl = best || ch.candidates[0] || ch.url;

    console.log(`Resolving stream for ${ch.name} -> ${finalUrl}`);

    return { streams: [
      { title: ch.name, url: `${BASE_URL}/proxy/${encodeURIComponent(finalUrl)}` }
    ]};
  });

  // EXPRESS ENDPOINTS (health, refresh)
  app.get("/", (req, res) => res.json({ status: "ok", name: manifest.name, manifest: `${BASE_URL}/manifest.json` }));
  app.get("/health", async (req, res) => {
    return res.json({ ok: true, playlistCachedAt: playlistCache.ts, channels: (playlistCache.items || []).length });
  });

  // manual refresh endpoint to force reload playlist & re-evaluate categories
  app.post("/refresh", async (req, res) => {
    try {
      await fetchPlaylist(true);
      await runHealthChecks();
      // optionally rebuild manifest if categories changed
      const newManifest = await buildManifest();
      // If categories changed, log and inform user - re-creation of builder at runtime is complex
      // We will not hot-swap builder to avoid breaking current stremio interface. Recommend redeploy if categories change drastically.
      return res.json({ refreshed: true, items: playlistCache.items.length });
    } catch (e) {
      return res.status(500).json({ refreshed: false, error: (e && e.message) || String(e) });
    }
  });

  // Serve manifest
  app.get("/manifest.json", (req, res) => res.json(builder.getManifest()));

  // Start the addon via serveHTTP (stremio-sdk v1.x style)
  serveHTTP(builder.getInterface(), { port: PORT });
  console.log(`${manifest.name} running on ${PORT} (BASE_URL=${BASE_URL})`);
})();


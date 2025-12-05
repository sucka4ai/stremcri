/**
 * Unified Cricfy Stremio Addon
 * - Priority C: auto-detect & scrape Cricfy domains for streams
 * - Fallback A: parse user-provided M3U (PLAYLIST_URL env)
 * - Fallback B: stable HLS fallback channels
 * - Dynamic categories, caching, health checks, proxying
 *
 * Paste this into server.js and deploy on Render.
 */

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const { parse } = require("iptv-playlist-parser");

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const PLAYLIST_URL = process.env.PLAYLIST_URL || ""; // optional user M3U
const PLAYLIST_TTL_MS = Number(process.env.PLAYLIST_TTL_MS || 60 * 1000);
const HEALTH_INTERVAL_MS = Number(process.env.HEALTH_INTERVAL_MS || 30 * 1000);

const app = express();
app.use(cors());
app.use(express.json());

// proxy middleware (placeholder target required)
app.use(
  "/proxy",
  createProxyMiddleware({
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

// ---------- Stable fallback channels (B) ----------
const STABLE_FALLBACK_CHANNELS = [
  // Add any tested HLS streams you want as fallback examples
  {
    id: "fallback_1",
    name: "Stable Sports 1",
    url: "https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8",
    group: "Stable"
  },
  {
    id: "fallback_2",
    name: "Stable Sports 2",
    url: "https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8",
    group: "Stable"
  }
];

// ---------- Cricfy domains to auto-detect (C) ----------
const CRICFY_DOMAINS = [
  "https://cricfy.live",
  "https://cricfy.world",
  "https://cricfy.xyz",
  "https://cricfy.fun",
  "https://cricfy.site",
  "https://stremcri.onrender.com" // keep your own as potential mirror if you add
];

// ---------- In-memory cache & health map ----------
let playlistCache = { ts: 0, items: [] }; // items: [{id,name,group,logo,candidates}]
const healthStatus = new Map(); // url -> { ok, status, lastChecked, latency }

// utils
const now = () => Date.now();
function makeId(prefix, idx, url) {
  const encoded = Buffer.from(url).toString("base64").replace(/=+$/,"");
  return `${prefix}_${idx}_${encoded}`;
}
function splitCandidates(urlString) {
  if (!urlString) return [];
  // split common separators
  const parts = urlString.split(/[,|;]/).map(s => s.trim()).filter(Boolean);
  return parts.length ? parts : [urlString];
}

// quick probe
async function probeUrl(url, timeout = 5000) {
  try {
    const res = await fetch(url, { method: "GET", timeout, redirect: "follow" });
    const ok = res && res.status >= 200 && res.status < 400;
    return { ok, status: res ? res.status : 0 };
  } catch (e) {
    return { ok: false, status: 0 };
  }
}

// ---------- Fetch + parse M3U (A) ----------
async function parseUserM3U(url) {
  try {
    const r = await fetch(url, { timeout: 20000 });
    const txt = await r.text();
    const pl = parse(txt);
    return pl.items
      .filter(i => i && i.url)
      .map((it, idx) => {
        const group = it.group || it.tvg?.group || "User Playlist";
        const logo = it.tvg?.logo || null;
        const candidates = splitCandidates(it.url);
        return {
          id: makeId("user", idx, it.url),
          name: it.name || it.tvg?.name || `User ${idx + 1}`,
          group,
          logo,
          candidates
        };
      });
  } catch (e) {
    console.warn("User M3U parse failed:", e && e.message ? e.message : e);
    return [];
  }
}

// ---------- Cricfy scraping (C) - multi-method attempts ----------
async function tryCricfyJsonApi(domain) {
  // Some Cricfy mirrors expose android/live.php or similar returning JSON
  const endpoints = [
    "/android/live.php",
    "/api/live.php",
    "/live.php",
    "/channels.json",
    "/channels.php"
  ];
  for (const ep of endpoints) {
    try {
      const url = domain.replace(/\/$/, "") + ep;
      const r = await fetch(url, { timeout: 10000 });
      if (!r.ok) continue;
      const txt = await r.text();
      // some return JSON, some HTML. Try to parse JSON if possible.
      try {
        const json = JSON.parse(txt);
        if (json && Array.isArray(json.channels)) {
          return json.channels.map((ch, idx) => {
            const url = ch.url || ch.stream || ch.link || null;
            const logo = ch.logo || ch.image || null;
            const name = ch.name || ch.title || `Cricfy ${idx+1}`;
            const group = ch['group-title'] || ch.group || 'Cricfy';
            return { id: makeId("cricfy", idx, url || name), name, group, logo, candidates: splitCandidates(url) };
          }).filter(c => c.candidates && c.candidates.length);
        }
      } catch (e) {
        // not JSON — ignore
      }
    } catch (e) {
      // ignore endpoint failure
    }
  }
  return [];
}

async function tryCricfyHtml(domain) {
  try {
    const r = await fetch(domain, { timeout: 10000, redirect: "follow" });
    if (!r.ok) return [];
    const txt = await r.text();
    // find .m3u8 or http(s) playlist links via regex
    const m3u8Matches = [...txt.matchAll(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi)].map(m => m[0]);
    const httpMatches = [...txt.matchAll(/https?:\/\/[^\s"'<>]+/gi)].map(m => m[0]);

    // prefer explicit .m3u8 matches
    const urls = m3u8Matches.length ? m3u8Matches : httpMatches;

    // build channel entries with simple heuristics
    const unique = Array.from(new Set(urls)).slice(0, 200); // limit
    return unique.map((u, idx) => ({
      id: makeId("cricfy_html", idx, u),
      name: `Cricfy Stream ${idx+1}`,
      group: "Cricfy",
      logo: null,
      candidates: splitCandidates(u)
    }));
  } catch (e) {
    return [];
  }
}

async function scrapeCricfyAuto() {
  // iterate domains, prefer JSON API, then HTML extraction
  for (const domain of CRICFY_DOMAINS) {
    try {
      // 1) try JSON-style endpoints
      const jsonList = await tryCricfyJsonApi(domain);
      if (jsonList && jsonList.length) {
        console.log(`Cricfy JSON source found on ${domain} -> ${jsonList.length} items`);
        return jsonList;
      }
      // 2) try HTML m3u8 extraction
      const htmlList = await tryCricfyHtml(domain);
      if (htmlList && htmlList.length) {
        console.log(`Cricfy HTML extraction found on ${domain} -> ${htmlList.length} items`);
        return htmlList;
      }
    } catch (e) {
      // ignore domain errors
    }
  }
  return [];
}

// ---------- Unified fetchPlaylist logic (C -> A -> B) ----------
async function fetchPlaylist(force = false) {
  if (!force && playlistCache.ts && (now() - playlistCache.ts) < PLAYLIST_TTL_MS && playlistCache.items.length) {
    return playlistCache.items;
  }

  // 1) Priority C: try Cricfy scraping
  let items = [];
  try {
    items = await scrapeCricfyAuto();
  } catch (e) {
    items = [];
  }

  // 2) Fallback A: user M3U if provided and no items or partially
  if ((items.length === 0 || PLAYLIST_URL) && PLAYLIST_URL) {
    try {
      const userItems = await parseUserM3U(PLAYLIST_URL);
      if (userItems && userItems.length) {
        console.log(`User M3U parsed ${userItems.length} items from PLAYLIST_URL`);
        // merge user items (prefer user categories under group "User Playlist")
        items = items.concat(userItems);
      }
    } catch (e) {
      // ignore
    }
  }

  // 3) Fallback B: include stable fallback streams if still empty
  if (!items || items.length === 0) {
    console.warn("No Cricfy or user playlist items found — using stable fallback channels.");
    items = STABLE_FALLBACK_CHANNELS.map((ch, idx) => ({
      id: ch.id || makeId("fallback", idx, ch.url),
      name: ch.name,
      group: ch.group || "Stable",
      logo: ch.logo || null,
      candidates: splitCandidates(ch.url)
    }));
  }

  // assign cache, timestamp
  playlistCache = { ts: now(), items };
  return items;
}

// ---------- Health checks ----------
async function runHealthChecks() {
  try {
    const channels = await fetchPlaylist(false);
    const allCandidates = new Set();
    channels.forEach(c => (c.candidates || []).forEach(u => allCandidates.add(u)));
    const unique = Array.from(allCandidates);

    // probe with limited concurrency
    const concurrency = 6;
    for (let i = 0; i < unique.length; i += concurrency) {
      const slice = unique.slice(i, i + concurrency);
      await Promise.all(slice.map(async (u) => {
        try {
          const res = await probeUrl(u, 5000);
          healthStatus.set(u, { ok: !!res.ok, status: res.status || 0, lastChecked: now() });
        } catch (e) {
          healthStatus.set(u, { ok: false, status: 0, lastChecked: now() });
        }
      }));
    }
  } catch (e) {
    console.warn("Health check error:", e && e.message ? e.message : e);
  }
}

// schedule health checks
setInterval(() => {
  runHealthChecks().catch(() => {});
}, HEALTH_INTERVAL_MS);

// run one at startup after initial fetch
(async () => {
  await fetchPlaylist(true);
  await runHealthChecks();
})();

// ---------- Choose best candidate ----------
function chooseBest(candidates = []) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const scored = candidates.map(u => {
    const s = healthStatus.get(u) || { ok: null, lastChecked: 0 };
    const score = (s.ok ? 1000 : 0) - (s.lastChecked || 0) / 1000;
    return { u, ok: !!s.ok, lastChecked: s.lastChecked || 0, score };
  });
  scored.sort((a,b) => b.score - a.score);
  const healthy = scored.find(s => s.ok);
  if (healthy) return healthy.u;
  return scored[0] ? scored[0].u : candidates[0];
}

// ---------- Live-now detection (best-effort) ----------
function isLiveNow(ch) {
  const s = `${ch.name} ${ch.group}`.toLowerCase();
  return /live|vs|v |match|ipl|t20|odi|test|final|semi/.test(s);
}

// ---------- dynamic manifest building ----------
async function buildManifest() {
  const channels = await fetchPlaylist(false);
  const groups = [...new Set(channels.map(c => c.group || "Other"))].sort();

  const hasLive = channels.some(isLiveNow);
  const catalogs = [
    { type: "tv", id: "cricfy_all", name: "All Channels" },
    ...(hasLive ? [{ type: "tv", id: "cricfy_live_now", name: "LIVE NOW" }] : []),
    ...groups.map(g => ({ type: "tv", id: `cricfy_${g.replace(/\s+/g,'_').toLowerCase()}`, name: g })),
    // include explicit user playlist catalog if PLAYLIST_URL provided
    ...(PLAYLIST_URL ? [{ type: "tv", id: "cricfy_user_playlist", name: "My Playlist" }] : [])
  ];

  return {
    id: "com.sucka.cricfy",
    version: "1.2.0",
    name: "Cricfy TV (Unified)",
    description: "Cricfy + optional M3U + stable fallback. Auto categories, health & retries (no EPG).",
    logo: "https://i.imgur.com/9Qf2P0K.png",
    types: ["tv"],
    catalogs,
    resources: ["catalog","meta","stream"]
  };
}

// ---------- Build addon and attach handlers ----------
let builder;
(async function initAddon() {
  const manifest = await buildManifest();
  builder = new addonBuilder(manifest);

  // catalog handler
  builder.defineCatalogHandler(async ({ id }) => {
    const channels = await fetchPlaylist(false);

    // All channels
    if (id === "cricfy_all") {
      return { metas: channels.map(ch => ({
        id: ch.id, type: "tv", name: ch.name,
        poster: ch.logo || "https://i.imgur.com/9Qf2P0K.png",
        posterShape: "landscape", description: ch.group
      }))};
    }

    // LIVE NOW
    if (id === "cricfy_live_now") {
      const live = channels.filter(isLiveNow);
      return { metas: live.map(ch => ({ id: ch.id, type: "tv", name: ch.name, poster: ch.logo || "https://i.imgur.com/9Qf2P0K.png", description: ch.group })) };
    }

    // User playlist catalog
    if (id === "cricfy_user_playlist") {
      const users = channels.filter(c => (c.group || "").toLowerCase().includes("user") || c.id.startsWith("user_"));
      return { metas: users.map(ch => ({ id: ch.id, type: "tv", name: ch.name, poster: ch.logo || "https://i.imgur.com/9Qf2P0K.png", description: ch.group })) };
    }

    // category catalogs by group
    const cat = id.replace(/^cricfy_/, "").replace(/_/g, " ");
    const filtered = channels.filter(c => (c.group || "Other").toLowerCase() === cat.toLowerCase());
    return { metas: filtered.map(ch => ({ id: ch.id, type: "tv", name: ch.name, poster: ch.logo || "https://i.imgur.com/9Qf2P0K.png", description: ch.group })) };
  });

  // meta handler
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

  // stream handler
  builder.defineStreamHandler(async ({ id }) => {
    const channels = await fetchPlaylist(false);
    const ch = channels.find(c => c.id === id);
    if (!ch) return { streams: [] };

    // choose best candidate (health-aware)
    const best = chooseBest(ch.candidates);
    const finalUrl = best || ch.candidates[0] || null;
    if (!finalUrl) return { streams: [] };

    console.log(`Resolved ${ch.name} -> ${finalUrl}`);

    return { streams: [
      { title: ch.name, url: `${BASE_URL}/proxy/${encodeURIComponent(finalUrl)}` }
    ]};
  });

  // endpoints
  app.get("/", (req, res) => res.json({ status: "ok", name: manifest.name, manifest: `${BASE_URL}/manifest.json` }));

  app.get("/manifest.json", (req, res) => res.json(builder.getManifest()));

  // admin debug: list channels & health
  app.get("/admin/channels", async (req, res) => {
    const items = await fetchPlaylist(false);
    const list = items.map(ch => ({
      id: ch.id, name: ch.name, group: ch.group, logo: ch.logo, candidates: ch.candidates,
      resolved: chooseBest(ch.candidates),
      health: (ch.candidates || []).map(u => ({ url: u, ...(healthStatus.get(u) || {}) }))
    }));
    res.json({ items, count: list.length, list });
  });

  // manual refresh
  app.post("/refresh", async (req, res) => {
    await fetchPlaylist(true);
    await runHealthChecks();
    res.json({ refreshed: true, items: playlistCache.items.length });
  });

  // start the addon server via SDK
  serveHTTP(builder.getInterface(), { port: PORT });
  console.log(`Cricfy Unified addon running on port ${PORT} (BASE_URL=${BASE_URL})`);
})();

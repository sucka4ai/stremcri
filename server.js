const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const { parseM3U } = require("@iptv/playlist");

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const PLAYLIST_URL = process.env.PLAYLIST_URL || "https://cricfy.live/playlist.m3u"; // Replace with actual M3U URL

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------
// Proxy for stream URLs
// ---------------------------
app.use(
  "/proxy",
  createProxyMiddleware({
    target: "http://localhost",
    changeOrigin: true,
    secure: false,
    pathRewrite: (path, req) => decodeURIComponent(path.replace("/proxy/", "")),
    onProxyReq: (proxyReq) => {
      proxyReq.setHeader("User-Agent", "Mozilla/5.0");
      proxyReq.setHeader("Referer", "https://cricfy.live/");
    },
    onError: (err, req, res) => {
      console.error("Proxy error:", err);
      if (!res.headersSent) res.status(502).send("Bad gateway");
    }
  })
);

// ---------------------------
// Fetch + parse channels dynamically
// ---------------------------
async function fetchChannels() {
  try {
    const res = await fetch(PLAYLIST_URL, { timeout: 15000 });
    const txt = await res.text();
    const playlist = parseM3U(txt);

    const channels = playlist.channels
      .filter(ch => ch.url) // ensure URL exists
      .map((ch, idx) => ({
        id: `cricfy_${idx}_${encodeURIComponent(ch.url)}`,
        name: ch.tvgName || ch.name || `Channel ${idx + 1}`,
        url: ch.url,
        group: ch.groupTitle || "Live",
        logo: ch.tvgLogo || null,
        extras: ch.extras || {}
      }));
    return channels;
  } catch (err) {
    console.warn("Failed to fetch/parse playlist:", err);
    return [];
  }
}

// ---------------------------
// Addon manifest
// ---------------------------
const manifest = {
  id: "com.sucka.cricfy",
  version: "1.0.6",
  name: "Cricfy TV Dynamic",
  description: "Cricfy live channels — dynamically fetched",
  logo: "https://i.imgur.com/9Qf2P0K.png",
  types: ["tv"],
  catalogs: [
    { type: "tv", id: "cricfy_catalog", name: "Cricfy Live Channels" }
  ],
  resources: ["catalog", "meta", "stream"]
};

const builder = new addonBuilder(manifest);

// ---------------------------
// Catalog handler
// ---------------------------
builder.defineCatalogHandler(async (args) => {
  const channels = await fetchChannels();
  const metas = channels.map(ch => ({
    id: ch.id,
    type: "tv",
    name: ch.name,
    poster: ch.logo || "https://i.imgur.com/9Qf2P0K.png",
    posterShape: "landscape",
    description: ch.group || "Live"
  }));
  return { metas };
});

// ---------------------------
// Meta handler
// ---------------------------
builder.defineMetaHandler(async ({ id }) => {
  const channels = await fetchChannels();
  const ch = channels.find(c => c.id === id);
  if (!ch) return { meta: {} };
  return {
    meta: {
      id: ch.id,
      type: "tv",
      name: ch.name,
      poster: ch.logo || "https://i.imgur.com/9Qf2P0K.png",
      background: ch.logo || null,
      description: ch.group || "Live"
    }
  };
});

// ---------------------------
// Stream handler
// ---------------------------
builder.defineStreamHandler(async ({ id }) => {
  const channels = await fetchChannels();
  const ch = channels.find(c => c.id === id);
  if (!ch) return { streams: [] };

  console.log("Serving stream:", ch.url);

  return {
    streams: [
      {
        title: ch.name,
        url: `${BASE_URL}/proxy/${encodeURIComponent(ch.url)}`
      }
    ]
  };
});

// ---------------------------
// Health & manifest endpoints
// ---------------------------
app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/", (req, res) => res.json({ addon: manifest.name, manifest: `${BASE_URL}/manifest.json` }));
app.get("/manifest.json", (req, res) => res.json(builder.getManifest()));

// ---------------------------
// Start the addon
// ---------------------------
serveHTTP(builder.getInterface(), { port: PORT });
console.log(`${manifest.name} running on port ${PORT} (BASE_URL=${BASE_URL})`);

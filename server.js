const express = require("express");
const cors = require("cors");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------
// Proxy for stream URLs
// ---------------------------
app.use(
  "/proxy",
  createProxyMiddleware({
    target: "http://localhost",  // placeholder target
    changeOrigin: true,
    secure: false,
    pathRewrite: (path, req) => {
      // remove /proxy/ from path
      return decodeURIComponent(path.replace("/proxy/", ""));
    },
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
// Channels list
// ---------------------------
const CHANNELS = [
  { id: "cricfy-1", name: "Cricfy HD 1", url: "https://cricfy.live/ch1/index.m3u8" },
  { id: "cricfy-2", name: "Cricfy HD 2", url: "https://cricfy.live/ch2/index.m3u8" },
  { id: "cricfy-3", name: "Cricfy Backup", url: "https://cricfy.live/ch3/index.m3u8" }
];

// ---------------------------
// Addon manifest
// ---------------------------
const manifest = {
  id: "com.sucka.cricfy",
  version: "1.0.4",
  name: "Cricfy TV",
  description: "Live cricket channels from Cricfy",
  logo: "https://i.imgur.com/9Qf2P0K.png",
  types: ["tv"],
  catalogs: [{ type: "tv", id: "cricfy_catalog", name: "Cricfy Live TV" }],
  resources: ["catalog", "meta", "stream"]
};

const builder = new addonBuilder(manifest);

// ---------------------------
// Catalog handler
// ---------------------------
builder.defineCatalogHandler(args => {
  if (args.type !== "tv") return { metas: [] };
  const metas = CHANNELS.map(ch => ({
    id: ch.id,
    type: "tv",
    name: ch.name,
    poster: "https://i.imgur.com/9Qf2P0K.png",
    posterShape: "landscape",
    description: "Cricfy live cricket stream"
  }));
  return Promise.resolve({ metas });
});

// ---------------------------
// Meta handler
// ---------------------------
builder.defineMetaHandler(args => {
  const ch = CHANNELS.find(c => c.id === args.id);
  if (!ch) return Promise.resolve({ meta: {} });
  return Promise.resolve({
    meta: {
      id: ch.id,
      type: "tv",
      name: ch.name,
      poster: "https://i.imgur.com/9Qf2P0K.png",
      background: "https://i.imgur.com/9Qf2P0K.png",
      description: "Cricfy live cricket stream"
    }
  });
});

// ---------------------------
// Stream handler
// ---------------------------
builder.defineStreamHandler(args => {
  const ch = CHANNELS.find(c => c.id === args.id);
  if (!ch) return Promise.resolve({ streams: [] });
  return Promise.resolve({
    streams: [
      {
        title: ch.name,
        url: `${BASE_URL}/proxy/${encodeURIComponent(ch.url)}`
      }
    ]
  });
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

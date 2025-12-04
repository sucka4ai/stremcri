const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());

// ---------------------------
// PROXY for M3U8 STREAMS
// ---------------------------
app.use(
  "/proxy",
  createProxyMiddleware({
    target: "",
    changeOrigin: true,
    secure: false,
    pathRewrite: (path, req) => {
      return path.replace("/proxy/", "");
    },
    onProxyReq: (proxyReq) => {
      proxyReq.setHeader("User-Agent", "Mozilla/5.0");
      proxyReq.setHeader("Referer", "https://cricfy.live/");
    },
  })
);

// ---------------------------
// CHANNEL LIST
// ---------------------------
const CHANNELS = [
  {
    id: "cricfy-1",
    name: "Cricfy HD 1",
    url: "https://cricfy.live/ch1/index.m3u8"
  },
  {
    id: "cricfy-2",
    name: "Cricfy HD 2",
    url: "https://cricfy.live/ch2/index.m3u8"
  },
  {
    id: "cricfy-3",
    name: "Cricfy Backup",
    url: "https://cricfy.live/ch3/index.m3u8"
  }
];

// ---------------------------
// MANIFEST
// ---------------------------
const manifest = {
  id: "com.sucka.cricfy",
  version: "1.0.2",
  name: "Cricfy TV",
  description: "Live cricket channels from Cricfy",
  logo: "https://i.imgur.com/9Qf2P0K.png",
  types: ["tv"],
  catalogs: [
    {
      type: "tv",
      id: "cricfy_catalog",
      name: "Cricfy Live TV"
    }
  ],
  resources: ["catalog", "meta", "stream"]
};

const builder = new addonBuilder(manifest);

// ---------------------------
// CATALOG HANDLER
// ---------------------------
builder.defineCatalogHandler((args) => {
  if (args.type !== "tv") return { metas: [] };

  const metas = CHANNELS.map((c) => ({
    id: c.id,
    type: "tv",
    name: c.name,
    poster: "https://i.imgur.com/9Qf2P0K.png",
    posterShape: "landscape",
    description: "Cricfy live cricket stream"
  }));

  return Promise.resolve({ metas });
});

// ---------------------------
// META HANDLER
// ---------------------------
builder.defineMetaHandler((args) => {
  const c = CHANNELS.find((x) => x.id === args.id);
  if (!c) return Promise.resolve({ meta: {} });

  return Promise.resolve({
    meta: {
      id: c.id,
      type: "tv",
      name: c.name,
      poster: "https://i.imgur.com/9Qf2P0K.png",
      background: "https://i.imgur.com/9Qf2P0K.png",
      description: "Cricfy live cricket stream"
    }
  });
});

// ---------------------------
// STREAM HANDLER
// ---------------------------
builder.defineStreamHandler((args) => {
  const c = CHANNELS.find((x) => x.id === args.id);
  if (!c) return Promise.resolve({ streams: [] });

  return Promise.resolve({
    streams: [
      {
        title: c.name,
        url: `https://stremcri.onrender.com/proxy/${c.url}`
      }
    ]
  });
});

// ---------------------------
// START SERVER (v1.x STYLE)
// ---------------------------
serveHTTP(builder.getInterface(), { port: PORT });

console.log(`Cricfy addon running on port ${PORT}`);

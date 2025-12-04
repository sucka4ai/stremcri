const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { addonBuilder } = require('stremio-addon-sdk');

const app = express();
app.use(cors());

// ---------------------------
// PROXY for stream URLs
// ---------------------------
app.use(
  '/proxy',
  createProxyMiddleware({
    target: 'https://',
    changeOrigin: true,
    pathRewrite: { '^/proxy': '' },
    secure: false,
    onProxyReq: (proxyReq) => {
      proxyReq.setHeader('User-Agent', 'Mozilla/5.0');
    }
  })
);

// ---------------------------
// Cricfy Live Channels
// ---------------------------
const CHANNELS = [
  {
    id: 'cricfy-001',
    name: 'Cricfy HD 1',
    url: 'https://cricfy.live/ch1/index.m3u8'
  },
  {
    id: 'cricfy-002',
    name: 'Cricfy HD 2',
    url: 'https://cricfy.live/ch2/index.m3u8'
  },
  {
    id: 'cricfy-003',
    name: 'Cricfy Backup',
    url: 'https://cricfy.live/ch3/index.m3u8'
  }
];

// ---------------------------
// Stremio Manifest
// ---------------------------
const manifest = {
  id: 'com.cricfy.stremio',
  version: '1.0.0',
  name: 'Cricfy Live TV',
  description: 'Watch Cricfy live cricket streams in Stremio',
  logo: 'https://i.imgur.com/9Qf2P0K.png',
  types: ['tv'],
  catalogs: [
    {
      type: 'tv',
      id: 'cricfy_catalog',
      name: 'Cricfy Live TV'
    }
  ],
  resources: ['catalog', 'stream'],
  idPrefixes: ['cricfy']
};

const builder = new addonBuilder(manifest);

// ---------------------------
// Catalog: Show channels in Stremio
// ---------------------------
builder.defineCatalogHandler(() => {
  const metas = CHANNELS.map((ch) => ({
    id: ch.id,
    type: 'tv',
    name: ch.name,
    poster: 'https://i.imgur.com/FbP4Hru.png',
    description: 'Cricfy Live Cricket'
  }));

  return Promise.resolve({ metas });
});

// ---------------------------
// Stream Handler
// ---------------------------
builder.defineStreamHandler((args) => {
  const ch = CHANNELS.find((c) => c.id === args.id);

  if (!ch) return Promise.resolve({ streams: [] });

  const proxiedUrl = `/proxy/${ch.url.replace('https://', '')}`;

  return Promise.resolve({
    streams: [
      {
        title: ch.name,
        url: proxiedUrl
      }
    ]
  });
});

// ---------------------------
// Router
// ---------------------------
const addonInterface = builder.getInterface();
const router = addonInterface.getRouter();
app.use(router);

// ---------------------------
// Start Server
// ---------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`Cricfy addon running on port ${PORT}`)
);

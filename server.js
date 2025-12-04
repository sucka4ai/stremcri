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
},
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
app.listen(PORT, () => console.log(`Cricfy addon running on port ${PORT}`));

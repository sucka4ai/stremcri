const express = require("express");
const fetch = require("node-fetch");
const { addonBuilder } = require("stremio-addon-sdk");
const { createProxyMiddleware } = require("http-proxy-middleware");

const manifest = {
    id: "cricfy.tv.shanny",
    version: "1.0.0",
    name: "Cricfy TV Live",
    description: "Watch Cricfy TV live cricket streams",
    logo: "https://i.imgur.com/FYx0A8t.png",
    catalogs: [{ type: "tv", id: "cricfy_catalog", name: "Cricfy Live" }],
    resources: ["catalog", "stream", "meta"],
    types: ["tv"],
    idPrefixes: ["cricfy"]
};

async function getCricfyChannels() {
    const url = "https://cricfy.world/android/live.php";

    try {
        const res = await fetch(url);
        const json = await res.json();

        return json.channels.map(ch => ({
            id: "cricfy_" + ch.id,
            name: ch.name,
            poster: ch.logo,
            streamUrl: ch.url
        }));
    } catch (e) {
        console.error("ERROR fetching Cricfy:", e);
        return [];
    }
}

const builder = new addonBuilder(manifest);

// Catalog
builder.defineCatalogHandler(async () => {
    const channels = await getCricfyChannels();

    return {
        metas: channels.map(ch => ({
            id: ch.id,
            name: ch.name,
            type: "tv",
            poster: ch.poster,
            posterShape: "landscape"
        }))
    };
});

// Meta
builder.defineMetaHandler(async ({ id }) => {
    const channels = await getCricfyChannels();
    const ch = channels.find(x => x.id === id);

    if (!ch) return { meta: {} };

    return {
        meta: {
            id: ch.id,
            name: ch.name,
            type: "tv",
            poster: ch.poster,
            background: ch.poster
        }
    };
});

// Stream
builder.defineStreamHandler(async ({ id }) => {
    const channels = await getCricfyChannels();
    const ch = channels.find(x => x.id === id);

    if (!ch) return { streams: [] };

    return {
        streams: [
            {
                title: ch.name,
                url:
                    process.env.BASE_URL +
                    "/proxy?url=" +
                    encodeURIComponent(ch.streamUrl)
            }
        ]
    };
});

// Express app
const app = express();

// CORS (important)
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    next();
});

// Home test page
app.get("/", (req, res) => {
    res.send({
        addon: "Cricfy Stremio Addon",
        status: "online",
        manifest: process.env.BASE_URL + "/manifest.json"
    });
});

// Proxy
app.use(
    "/proxy",
    createProxyMiddleware({
        target: "",
        changeOrigin: true,
        secure: false,
        router: req => req.query.url,
        pathRewrite: { "^/proxy": "" }
    })
);

// Mount addon router (the correct way)
const router = builder.getRouter();
app.use(router);

const PORT = process.env.PORT || 3000;
process.env.BASE_URL =
    process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

app.listen(PORT, () => {
    console.log("Cricfy addon running on port " + PORT);
});

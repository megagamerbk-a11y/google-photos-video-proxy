// server.js
// Node >= 18, package.json -> { "type": "module" }
import express from "express";
import session from "express-session";
import axios from "axios";
import { google } from "googleapis";
import { registerDebug } from "./debug.js";

const app = express();
const PORT = process.env.PORT || 3000;

/* ───── Base ───── */
app.set("trust proxy", 1);           // важно для Render (secure cookie)
app.disable("x-powered-by");
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ───── Sessions ───── */
app.use(
  session({
    name: "sid",
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: "auto",                  // https -> secure
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 дней
    },
  })
);

/* ───── OAuth ───── */
const BASE_URL = (process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const REDIRECT_URI = `${BASE_URL}/oauth2/callback`;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

// оба скоупа должны быть добавлены в Google Auth Platform → Data access
const SCOPES = [
  "https://www.googleapis.com/auth/photoslibrary.readonly",
  "https://www.googleapis.com/auth/photoslibrary",
];

/* ───── Helpers ───── */
function ensureAuthed(req, res, next) {
  if (req.session?.tokens) {
    oauth2Client.setCredentials(req.session.tokens);
    return next();
  }
  if (req.path.startsWith("/videos") || req.path.startsWith("/stream/") || req.path.startsWith("/debug/")) {
    return res.status(401).json({ error: "not_authenticated" });
  }
  return res.redirect("/auth/google");
}

async function getAccessToken() {
  const { token } = await oauth2Client.getAccessToken(); // auto-refresh при необходимости
  return token;
}

async function callWithRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const s = e?.response?.status;
      const retriable = !s || (s >= 500 && s < 600);
      if (!retriable || i === attempts) throw e;
      await new Promise((r) => setTimeout(r, 400 * i));
    }
  }
  throw lastErr;
}

/* ───── Auth routes ───── */
app.get("/auth/google", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
  res.redirect(url);
});

app.get("/oauth2/callback", async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    req.session.tokens = tokens;
    oauth2Client.setCredentials(tokens);
    res.redirect("/");
  } catch (e) {
    console.error("[OAUTH] error:", e?.response?.data || e);
    res.status(500).send("OAuth error");
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

/* ───── API: список видео ───── */
app.get("/videos", ensureAuthed, async (req, res) => {
  try {
    const accessToken = await getAccessToken();

    // 1) попытка через фильтр только видео
    const searchResp = await callWithRetry(() =>
      axios.post(
        "https://photoslibrary.googleapis.com/v1/mediaItems:search",
        { pageSize: 50, filters: { mediaTypeFilter: { mediaTypes: ["VIDEO"] } } },
        { headers: { Authorization: `Bearer ${accessToken}` } }
      )
    ).catch((e) => e?.response || Promise.reject(e));

    if (searchResp?.status === 200 && Array.isArray(searchResp.data?.mediaItems)) {
      const items = searchResp.data.mediaItems.map((mi) => ({
        id: mi.id,
        filename: mi.filename,
        mimeType: mi.mimeType,
        productUrl: mi.productUrl,
        baseUrl: mi.baseUrl,
        creationTime: mi.mediaMetadata?.creationTime,
      }));
      return res.json({ items });
    }

    // 2) фолбэк — берём всё и фильтруем по mimeType
    const listResp = await callWithRetry(() =>
      axios.get("https://photoslibrary.googleapis.com/v1/mediaItems?pageSize=100", {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
    ).catch((e) => e?.response || Promise.reject(e));

    if (listResp?.status === 200 && Array.isArray(listResp.data?.mediaItems)) {
      const items = listResp.data.mediaItems
        .filter((mi) => (mi.mimeType || "").toLowerCase().startsWith("video/"))
        .map((mi) => ({
          id: mi.id,
          filename: mi.filename,
          mimeType: mi.mimeType,
          productUrl: mi.productUrl,
          baseUrl: mi.baseUrl,
          creationTime: mi.mediaMetadata?.creationTime,
        }));
      return res.json({ items });
    }

    return res.status(502).json({
      error: "upstream_error",
      searchStatus: searchResp?.status,
      searchData: searchResp?.data,
      listStatus: listResp?.status,
      listData: listResp?.data,
    });
  } catch (e) {
    const s = e?.response?.status;
    res.status(500).json({ error: "Failed to list videos", status: s, data: e?.response?.data || null });
  }
});

/* ───── API: проксирование потока (Range) ───── */
app.get("/stream/:id", ensureAuthed, async (req, res) => {
  try {
    const id = req.params.id;
    const accessToken = await getAccessToken();

    // получаем baseUrl
    const info = await callWithRetry(() =>
      axios.get(`https://photoslibrary.googleapis.com/v1/mediaItems/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
    ).catch((e) => e?.response || Promise.reject(e));

    if (info.status !== 200 || !info.data?.baseUrl) {
      return res.status(404).send("MediaItem baseUrl not found");
    }

    const url = `${info.data.baseUrl}=dv`;
    const range = req.headers.range;
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      ...(range ? { Range: range } : {}),
      Connection: "keep-alive",
    };

    const upstream = await callWithRetry(() =>
      axios({ url, method: "GET", headers, responseType: "stream", maxRedirects: 5, validateStatus: () => true })
    );

    res.status(upstream.status);
    const h = upstream.headers;
    if (h["content-type"]) res.setHeader("Content-Type", h["content-type"]);
    if (h["content-length"]) res.setHeader("Content-Length", h["content-length"]);
    if (h["accept-ranges"]) res.setHeader("Accept-Ranges", h["accept-ranges"]);
    if (h["content-range"]) res.setHeader("Content-Range", h["content-range"]);
    if (!h["cache-control"]) res.setHeader("Cache-Control", "private, max-age=0, no-store");

    upstream.data.on("error", () => {
      if (!res.headersSent) res.status(502);
      res.end();
    });

    upstream.data.pipe(res);
  } catch (e) {
    console.error("[STREAM] error:", e?.response?.data || e);
    res.status(500).send("Stream error");
  }
});

/* ───── DEBUG (на время настройки) ───── */
registerDebug(app, oauth2Client, ensureAuthed);

/* ───── Login gate + static ───── */
app.get("/", (req, res, next) => {
  if (!req.session?.tokens) {
    return res.send(`
      <!doctype html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Google Photos Player</title>
      <style>
        body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:3rem;max-width:720px;margin:auto}
        h1{font-size:2.2rem;margin:.2rem 0 1rem}
        p{opacity:.8}
        a.btn{display:inline-block;padding:.9rem 1.2rem;border:1px solid #ddd;border-radius:12px;text-decoration:none}
      </style>
      </head><body>
        <h1>Google Photos Player</h1>
        <p>Войдите через Google, чтобы получить список ваших видео.</p>
        <a class="btn" href="/auth/google">Войти с Google</a>
      </body></html>
    `);
  }
  next();
});

app.use(express.static("public"));

app.listen(PORT, () => {
  console.log(`Server listening on ${BASE_URL}`);
});

// server.js
// Node >= 18, package.json -> { "type": "module" }
import express from "express";
import session from "express-session";
import axios from "axios";
import { google } from "googleapis";

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------- Base ---------- */
app.set("trust proxy", 1); // важнo для Render/прокси, чтобы secure cookie работала
app.disable("x-powered-by");
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ---------- Sessions ---------- */
app.use(
  session({
    name: "sid",
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: "auto",                  // https -> secure; локально http — без secure
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 дней
    },
  })
);

/* ---------- OAuth ---------- */
const BASE_URL = (process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const REDIRECT_URI = `${BASE_URL}/oauth2/callback`;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

// Запрашиваем оба скоупа (оба должны быть добавлены в Google Auth Platform → Data access)
const SCOPES = [
  "https://www.googleapis.com/auth/photoslibrary.readonly",
  "https://www.googleapis.com/auth/photoslibrary",
];

/* ---------- Helpers ---------- */
function ensureAuthed(req, res, next) {
  if (req.session?.tokens) {
    oauth2Client.setCredentials(req.session.tokens);
    return next();
  }
  if (
    req.path.startsWith("/videos") ||
    req.path.startsWith("/stream/") ||
    req.path.startsWith("/debug/")
  ) {
    return res.status(401).json({ error: "not_authenticated" });
  }
  return res.redirect("/auth/google");
}

async function getAccessToken() {
  const { token } = await oauth2Client.getAccessToken(); // auto-refresh при необходимости
  return token;
}

// простой ретрай для сетевых/5xx
async function callWithRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e?.response?.status;
      const retriable = !status || (status >= 500 && status < 600);
      if (!retriable || i === attempts) throw e;
      await new Promise((r) => setTimeout(r, 400 * i)); // backoff
    }
  }
  throw lastErr;
}

/* ---------- OAuth routes ---------- */
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
    console.log("[OAUTH] ok; sid:", req.sessionID, "scopes:", tokens.scope);
    res.redirect("/");
  } catch (e) {
    console.error("[OAUTH] error:", e?.response?.data || e);
    res.status(500).send("OAuth error");
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

/* ---------- API: list videos ---------- */
app.get("/videos", ensureAuthed, async (req, res) => {
  try {
    const accessToken = await getAccessToken();

    // 1) основной путь — фильтр по видео
    const searchResp = await callWithRetry(() =>
      axios.post(
        "https://photoslibrary.googleapis.com/v1/mediaItems:search",
        { pageSize: 50, filters: { mediaTypeFilter: { mediaTypes: ["VIDEO"] } } },
        { headers: { Authorization: `Bearer ${accessToken}` } }
      )
    ).catch((e) => e?.response || Promise.reject(e));

    if (searchResp && searchResp.status === 200 && Array.isArray(searchResp.data?.mediaItems)) {
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

    // 2) фолбэк — получаем всё и фильтруем по mimeType
    const listResp = await callWithRetry(() =>
      axios.get("https://photoslibrary.googleapis.com/v1/mediaItems?pageSize=100", {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
    ).catch((e) => e?.response || Promise.reject(e));

    if (listResp && listResp.status === 200 && Array.isArray(listResp.data?.mediaItems)) {
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
    const status = e?.response?.status;
    const data = e?.response?.data;
    console.error("[/videos] error:", status, data || e);
    if (status) return res.status(502).json({ error: "upstream_error", status, data });
    return res.status(500).json({ error: "Failed to list videos" });
  }
});

/* ---------- API: proxy stream (Range) ---------- */
app.get("/stream/:id", ensureAuthed, async (req, res) => {
  const id = req.params.id;
  try {
    const accessToken = await getAccessToken();

    // мета для получения baseUrl
    const info = await callWithRetry(() =>
      axios.get(`https://photoslibrary.googleapis.com/v1/mediaItems/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
    ).catch((e) => e?.response || Promise.reject(e));

    if (info.status !== 200 || !info.data?.baseUrl) {
      console.error("[STREAM] mediaItem error:", info.status, info.data);
      return res.status(404).send("MediaItem baseUrl not found");
    }

    const url = `${info.data.baseUrl}=dv`; // прямой байтовый поток видео
    const range = req.headers.range;
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      ...(range ? { Range: range } : {}),
      Connection: "keep-alive",
    };

    const upstream = await callWithRetry(() =>
      axios({
        url,
        method: "GET",
        headers,
        responseType: "stream",
        maxRedirects: 5,
        validateStatus: () => true,
      })
    );

    res.status(upstream.status);
    const h = upstream.headers;
    if (h["content-type"]) res.setHeader("Content-Type", h["content-type"]);
    if (h["content-length"]) res.setHeader("Content-Length", h["content-length"]);
    if (h["accept-ranges"]) res.setHeader("Accept-Ranges", h["accept-ranges"]);
    if (h["content-range"]) res.setHeader("Content-Range", h["content-range"]);
    if (!h["cache-control"]) res.setHeader("Cache-Control", "private, max-age=0, no-store");

    upstream.data.on("error", (err) => {
      console.error("[STREAM] upstream error:", err);
      if (!res.headersSent) res.status(502);
      res.end();
    });

    upstream.data.pipe(res);
  } catch (e) {
    console.error("[STREAM] error:", e?.response?.data || e);
    res.status(500).send("Stream error");
  }
});

/* ---------- DEBUG (оставьте только на время настройки) ---------- */
const mask = (v) => (typeof v === "string" ? v.slice(0, 12) + "…" : v);

app.get("/debug/token", ensureAuthed, async (req, res) => {
  try {
    const { token } = await oauth2Client.getAccessToken();
    const info = await oauth2Client.getTokenInfo(token);
    res.json({ tokenStartsWith: mask(token), scopes: info.scopes, expiry: oauth2Client.credentials.expiry_date || null });
  } catch (e) {
    res.status(500).json({ error: e?.response?.data || String(e) });
  }
});

app.get("/debug/this-token", ensureAuthed, async (req, res) => {
  try {
    const { token } = await oauth2Client.getAccessToken();
    const info = await oauth2Client.getTokenInfo(token);
    res.json({ tokenStartsWith: mask(token), scopes: info.scopes, expiry: oauth2Client.credentials.expiry_date || null });
  } catch (e) {
    res.status(500).json({ error: e?.response?.data || String(e) });
  }
});

app.get("/debug/tokeninfo", ensureAuthed, async (req, res) => {
  try {
    const { token } = await oauth2Client.getAccessToken();
    const r = await axios.get("https://oauth2.googleapis.com/tokeninfo", {
      params: { access_token: token },
      validateStatus: () => true,
    });
    res.status(r.status).json(r.data); // aud/azp/scope/expires_in …
  } catch (e) {
    res.status(500).json({ error: e?.response?.data || String(e) });
  }
});

app.get("/debug/videos", ensureAuthed, async (req, res) => {
  try {
    const { token } = await oauth2Client.getAccessToken();

    const searchResp = await axios.post(
      "https://photoslibrary.googleapis.com/v1/mediaItems:search",
      { pageSize: 50, filters: { mediaTypeFilter: { mediaTypes: ["VIDEO"] } } },
      { headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true }
    );

    const listResp = await axios.get(
      "https://photoslibrary.googleapis.com/v1/mediaItems?pageSize=100",
      { headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true }
    );

    res.json({
      search: { status: searchResp.status, data: searchResp.data },
      list: { status: listResp.status, data: listResp.data },
    });
  } catch (e) {
    res.status(500).json({ error: e?.response?.data || String(e) });
  }
});

app.get("/debug/session", ensureAuthed, (req, res) => {
  const t = req.session?.tokens || {};
  res.json({
    hasTokens: !!req.session?.tokens,
    keys: Object.keys(t),
    access_token: mask(t.access_token || ""),
    refresh_token: mask(t.refresh_token || ""),
    scopeRaw: t.scope || null,
    expiry_date: t.expiry_date || null,
    sid: req.sessionID,
  });
});

/* ---------- Login gate + static ---------- */
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

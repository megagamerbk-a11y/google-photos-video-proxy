// server.js
import express from "express";
import session from "express-session";
import axios from "axios";
import { google } from "googleapis";

const app = express();
const PORT = process.env.PORT || 3000;

// -------- Base setup
app.set("trust proxy", 1); // важно за прокси (Render) для корректных secure-кук
app.disable("x-powered-by");
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// -------- Sessions
app.use(
  session({
    name: "sid",
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: "auto",                   // https => secure; локально http — без secure
      maxAge: 1000 * 60 * 60 * 24 * 7,  // 7 дней
    },
  })
);

// -------- OAuth setup
const BASE_URL = (process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const REDIRECT_URI = `${BASE_URL}/oauth2/callback`;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

// Только чтение из Google Photos
const SCOPE = ["https://www.googleapis.com/auth/photoslibrary.readonly"];

// -------- Helpers
function ensureAuthed(req, res, next) {
  if (req.session?.tokens) {
    oauth2Client.setCredentials(req.session.tokens);
    return next();
  }
  // Для API лучше 401, чтобы fetch не падал редиректом
  if (req.path.startsWith("/videos") || req.path.startsWith("/stream/") || req.path.startsWith("/debug/")) {
    return res.status(401).json({ error: "not_authenticated" });
  }
  return res.redirect("/auth/google");
}

async function getAccessToken() {
  const { token } = await oauth2Client.getAccessToken();
  return token;
}

// Универсальный ретрай для сетевых/5xx
async function callWithRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e?.response?.status;
      const retriable = !status || (status >= 500 && status < 600);
      console.warn(`[RETRY] attempt ${i} failed`, status || e.message);
      if (!retriable || i === attempts) throw e;
      await new Promise((r) => setTimeout(r, 400 * i)); // backoff
    }
  }
  throw lastErr;
}

// -------- OAuth routes
app.get("/auth/google", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPE,
  });
  res.redirect(url);
});

app.get("/oauth2/callback", async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    req.session.tokens = tokens;
    oauth2Client.setCredentials(tokens);
    console.log("[OAUTH] ok:", Object.keys(tokens), "sid:", req.sessionID);
    res.redirect("/");
  } catch (e) {
    console.error("[OAUTH] error:", e?.response?.data || e);
    res.status(500).send("OAuth error.");
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// -------- API: list videos (REST)
app.get("/videos", ensureAuthed, async (req, res) => {
  try {
    console.log("[VIDEOS] authed sid:", req.sessionID, "hasTokens:", !!req.session?.tokens);
    const accessToken = await getAccessToken();

    // 1) Основной путь: POST /mediaItems:search c фильтром VIDEO
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

    // 2) Фолбэк: GET /mediaItems (без фильтра) + фильтруем видео на сервере
    console.warn("[VIDEOS] fallback to GET /mediaItems due to status:", searchResp?.status);
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

    console.error("[VIDEOS] google error (both paths):", searchResp?.status, listResp?.status);
    return res.status(502).json({ error: "upstream_error" });
  } catch (e) {
    const status = e?.response?.status;
    const data = e?.response?.data;
    console.error("[VIDEOS] error", status, data || e.message || e);
    if (status && status !== 200) return res.status(502).json({ error: "upstream_error", status });
    return res.status(500).json({ error: "Failed to list videos" });
  }
});

// -------- API: proxy stream (REST + Range)
app.get("/stream/:id", ensureAuthed, async (req, res) => {
  const id = req.params.id;
  try {
    const accessToken = await getAccessToken();

    // Получим meta, чтобы взять baseUrl
    const info = await callWithRetry(() =>
      axios.get(`https://photoslibrary.googleapis.com/v1/mediaItems/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
    ).catch((e) => e?.response || Promise.reject(e));

    if (info.status !== 200 || !info.data?.baseUrl) {
      console.error("[STREAM] get mediaItem error:", info.status, info.data);
      return res.status(404).send("MediaItem baseUrl not found");
    }

    const url = `${info.data.baseUrl}=dv`; // прямые байты видео
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
    console.error("[STREAM] error", e?.response?.data || e);
    res.status(500).send("Stream error");
  }
});

// -------- (optional) token debug
app.get("/debug/token", ensureAuthed, async (req, res) => {
  try {
    const info = await oauth2Client.getTokenInfo(oauth2Client.credentials.access_token);
    res.json({ scopes: info.scopes, expiry: oauth2Client.credentials.expiry_date });
  } catch (e) {
    res.status(500).json({ error: e?.response?.data || String(e) });
  }
});

// -------- Login gate before static
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

// -------- Static UI (после авторизации)
app.use(express.static("public"));

app.listen(PORT, () => {
  console.log(`Server listening on ${BASE_URL}`);
});

import express from "express";
import session from "express-session";
import axios from "axios";
import { google } from "googleapis";

const app = express();
const PORT = process.env.PORT || 3000;

// 1) ВАЖНО для Render/прокси: чтобы secure-кука ставилась корректно
app.set("trust proxy", 1);

app.disable("x-powered-by");
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Сессии
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: !!process.env.RENDER, // на Render=true
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 дней
    },
  })
);

// Базовый URL и redirect_uri
const BASE_URL = (process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const REDIRECT_URI = `${BASE_URL}/oauth2/callback`;

// OAuth
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);
const SCOPE = ["https://www.googleapis.com/auth/photoslibrary.readonly"];

// Хелпер
function ensureAuthed(req, res, next) {
  if (req.session?.tokens) {
    oauth2Client.setCredentials(req.session.tokens);
    return next();
  }
  // 2) Для API лучше вернуть 401, а не редиректить в fetch (чтобы не было "Failed to fetch")
  if (req.path.startsWith("/videos") || req.path.startsWith("/stream/")) {
    return res.status(401).json({ error: "not_authenticated" });
  }
  return res.redirect("/auth/google");
}

// ===== OAuth =====
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
    // Лог в Render для отладки
    console.log("OAuth OK. Have tokens:", Object.keys(tokens));
    res.redirect("/");
  } catch (e) {
    console.error("OAuth callback error:", e?.response?.data || e);
    res.status(500).send("OAuth error. Check server logs.");
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// ===== API =====
app.get("/videos", ensureAuthed, async (req, res) => {
  try {
    const photos = google.photoslibrary({ version: "v1", auth: oauth2Client });
    const { data } = await photos.mediaItems.search({
      requestBody: {
        pageSize: 50,
        filters: { mediaTypeFilter: { mediaTypes: ["VIDEO"] } },
      },
    });
    const items = (data.mediaItems || []).map((mi) => ({
      id: mi.id,
      filename: mi.filename,
      mimeType: mi.mimeType,
      productUrl: mi.productUrl,
      baseUrl: mi.baseUrl,
      creationTime: mi.mediaMetadata?.creationTime,
    }));
    res.json({ items });
  } catch (e) {
    console.error("videos error", e?.response?.data || e);
    res.status(500).json({ error: "Failed to list videos" });
  }
});

app.get("/stream/:id", ensureAuthed, async (req, res) => {
  const id = req.params.id;
  try {
    const photos = google.photoslibrary({ version: "v1", auth: oauth2Client });
    const { data } = await photos.mediaItems.get({ mediaItemId: id });
    if (!data?.baseUrl) return res.status(404).send("MediaItem baseUrl not found");

    const url = `${data.baseUrl}=dv`;
    const range = req.headers.range;
    const headers = {
      Authorization: `Bearer ${oauth2Client.credentials.access_token}`,
      ...(range ? { Range: range } : {}),
      Connection: "keep-alive",
    };

    const upstream = await axios({
      url,
      method: "GET",
      headers,
      responseType: "stream",
      maxRedirects: 5,
      validateStatus: () => true,
    });

    res.status(upstream.status);
    const h = upstream.headers;
    if (h["content-type"]) res.setHeader("Content-Type", h["content-type"]);
    if (h["content-length"]) res.setHeader("Content-Length", h["content-length"]);
    if (h["accept-ranges"]) res.setHeader("Accept-Ranges", h["accept-ranges"]);
    if (h["content-range"]) res.setHeader("Content-Range", h["content-range"]);
    if (!h["cache-control"]) res.setHeader("Cache-Control", "private, max-age=0, no-store");

    upstream.data.on("error", (err) => {
      console.error("Upstream stream error:", err);
      if (!res.headersSent) res.status(502);
      res.end();
    });

    upstream.data.pipe(res);
  } catch (e) {
    console.error("stream error", e?.response?.data || e);
    res.status(500).send("Stream error");
  }
});

// ===== Гейт перед отдачей статики =====
app.get("/", (req, res, next) => {
  if (!req.session?.tokens) {
    return res.send(`
      <!doctype html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Google Photos Player</title>
      <style>
        body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:2rem;}
        .btn{display:inline-block;padding:.8rem 1.2rem;border:1px solid #ddd;border-radius:10px;text-decoration:none}
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

// Отдаём статику ТОЛЬКО после авторизации
app.use(express.static("public"));

app.listen(PORT, () => {
  console.log(`Server listening on ${BASE_URL}`);
});

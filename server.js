require("dotenv").config();

const path = require("path");
const express = require("express");
const session = require("express-session");
const axios = require("axios");
const { OAuth2Client } = require("google-auth-library");

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  SESSION_SECRET = "devsecret",
  RENDER_EXTERNAL_URL, // для Render
  ROOT_URL              // можно задать вручную, если нужно
} = process.env;

// --- базовая настройка приложения ---
const app = express();
app.set("trust proxy", 1); // Render/прокси

app.use(
  session({
    name: "ghp.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production"
    }
  })
);

// Статика (index.html и main.js)
app.use(express.static(path.join(__dirname, "public")));

// --- OAuth2 клиент ---
const ROOT =
  ROOT_URL || RENDER_EXTERNAL_URL || "http://localhost:3000";

const oauth = new OAuth2Client({
  clientId: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  redirectUri: `${ROOT}/auth/google/callback`
});

// Запрашиваем оба скоупа и суммирование уже выданных прав
const SCOPES = [
  "https://www.googleapis.com/auth/photoslibrary.readonly",
  "https://www.googleapis.com/auth/photoslibrary"
];

// --- утилиты ---
const hasTokens = (req) =>
  Boolean(req.session && req.session.tokens && req.session.tokens.access_token);

async function ensureAuthed(req, res, next) {
  if (!hasTokens(req)) return res.status(401).json({ error: "not_authenticated" });

  oauth.setCredentials(req.session.tokens);

  // Попробуем обновить токен при необходимости
  try {
    const t = await oauth.getAccessToken();
    if (t && t.token) {
      req.session.tokens = { ...oauth.credentials };
    }
  } catch (e) {
    console.error("refresh error:", e.response?.data || e.message);
    req.session.destroy(() => {});
    return res.status(401).json({ error: "token_refresh_failed" });
  }

  next();
}

// --- API статуса сессии (для кнопки Войти/Выйти на фронте) ---
app.get("/me", (req, res) => {
  res.json({ authed: hasTokens(req) });
});

// --- Маршруты авторизации ---
app.get("/auth/google", (req, res) => {
  const url = oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    scope: SCOPES
  });
  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth.getToken(code);
    oauth.setCredentials(tokens);
    req.session.tokens = { ...tokens };
    res.redirect("/");
  } catch (e) {
    console.error("OAuth callback error:", e.response?.data || e.message);
    res.status(500).send("OAuth error");
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("ghp.sid");
    res.redirect("/");
  });
});

// --- Вспомогательный вызов Photos API ---
async function searchVideos(accessToken, pageToken) {
  const resp = await axios.post(
    "https://photoslibrary.googleapis.com/v1/mediaItems:search",
    {
      pageSize: 50,
      pageToken,
      filters: {
        mediaTypeFilter: { mediaTypes: ["VIDEO"] }
      }
    },
    {
      headers: { Authorization: `Bearer ${accessToken}` }
    }
  );
  return resp.data;
}

// --- Бизнес-эндпоинт: список видео ---
app.get("/api/videos", ensureAuthed, async (req, res) => {
  try {
    const accessToken = oauth.credentials.access_token;
    let items = [];
    let next;

    do {
      const data = await searchVideos(accessToken, next);
      if (Array.isArray(data.mediaItems)) {
        items.push(
          ...data.mediaItems.map((m) => ({
            id: m.id,
            filename: m.filename,
            mimeType: m.mimeType,
            url: `${m.baseUrl}=dv` // dv — флаг проигрывания видео
          }))
        );
      }
      next = data.nextPageToken;
    } while (next && items.length < 200);

    res.json({ items });
  } catch (e) {
    const payload = e.response?.data || { message: e.message };
    console.error("list videos failed:", payload);
    res.status(e.response?.status || 500).json({
      error: "upstream_error",
      data: payload
    });
  }
});

// --- DEBUG (по желанию) ---
app.get("/debug/this-token", (req, res) => {
  if (!hasTokens(req)) return res.json({ error: "not_authenticated" });
  res.json({
    tokenStartsWith: req.session.tokens.access_token?.slice(0, 20),
    scopes: (
      req.session.tokens.scope ||
      req.session.tokens.scopes ||
      oauth.credentials.scope ||
      ""
    )
      .toString()
      .split(" "),
    expiry: oauth.credentials.expiry_date
  });
});

app.get("/debug/tokeninfo", ensureAuthed, async (req, res) => {
  try {
    const r = await axios.get("https://www.googleapis.com/oauth2/v3/tokeninfo", {
      params: { access_token: oauth.credentials.access_token }
    });
    res.json(r.data);
  } catch (e) {
    res.status(e.response?.status || 500).json(e.response?.data || { message: e.message });
  }
});

app.get("/debug/videos", ensureAuthed, async (req, res) => {
  try {
    const data = await searchVideos(oauth.credentials.access_token);
    res.json(data);
  } catch (e) {
    res.status(e.response?.status || 500).json(e.response?.data || { message: e.message });
  }
});

// --- Фолбэк на index.html для всех остальных путей ---
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- старт ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));

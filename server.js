/* eslint-disable no-console */
require("dotenv").config();

const path = require("path");
const express = require("express");
const session = require("express-session");
const axios = require("axios");
const { OAuth2Client } = require("google-auth-library");

const app = express();
const PORT = process.env.PORT || 3000;

// ====== Конфиг окружения ======
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret";

// базовый URL: на Render подойдет RENDER_EXTERNAL_URL, локально — http://localhost:3000
const BASE_URL =
  process.env.EXTERNAL_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://localhost:${PORT}`;

const REDIRECT_URI = `${BASE_URL.replace(/\/$/, "")}/auth/google/callback`;
const SCOPES = ["https://www.googleapis.com/auth/photoslibrary.readonly"];

// ====== OAuth клиент ======
const oauth = new OAuth2Client({
  clientId: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  redirectUri: REDIRECT_URI,
});

// автоматом обновляем токены и сохраняем в сессию
oauth.on("tokens", (tokens) => {
  // Будет вызван, когда библиотека обновит access_token по refresh_token
  app.locals._updateSessionTokens = tokens;
});

// ====== Express / сессии / статика ======
app.set("trust proxy", 1);
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure:
        process.env.NODE_ENV === "production" ||
        /onrender\.com$/.test(BASE_URL), // на https включаем secure
    },
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

// маленький helper — брать валидный токен (с автообновлением)
async function getValidAccessToken(req) {
  const tokens = req.session?.tokens;
  if (!tokens?.access_token) return null;

  // обновление из события google-auth-library
  if (app.locals._updateSessionTokens) {
    req.session.tokens = {
      ...req.session.tokens,
      ...app.locals._updateSessionTokens,
    };
    app.locals._updateSessionTokens = undefined;
  }

  oauth.setCredentials(tokens);

  // библиотека сама обновит access_token, если он протух
  const t = await oauth.getAccessToken();
  if (t && t.token) {
    // getAccessToken не всегда кладёт expiry_date — подстрахуемся событиями .on('tokens') выше
    req.session.tokens = {
      ...req.session.tokens,
      access_token: t.token,
    };
    return t.token;
  }
  return tokens.access_token;
}

function ensureAuthed(req, res, next) {
  if (req.session?.tokens?.access_token) return next();
  return res.status(401).json({ error: "not_authenticated" });
}

// ====== OAuth ======
app.get("/auth/google", (req, res) => {
  const url = oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // чтобы стабильно получить refresh_token
    scope: SCOPES,
  });
  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing code");

    const { tokens } = await oauth.getToken(code);

    // сохраняем в сессию
    req.session.tokens = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token, // будет только при prompt=consent
      expiry_date: tokens.expiry_date,
      scope: tokens.scope,
      token_type: tokens.token_type,
      id_token: tokens.id_token,
    };

    res.redirect("/");
  } catch (e) {
    console.error("OAuth callback error:", e.response?.data || e.message);
    res.status(500).send("OAuth error");
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});
app.get("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ====== API ======
app.get("/api/me", async (req, res) => {
  const authed = !!req.session?.tokens?.access_token;
  res.json({
    authed,
    scopes: req.session?.tokens?.scope || "",
    baseUrl: BASE_URL,
  });
});

// список видео — через mediaItems.list (без search)
app.get("/api/videos", ensureAuthed, async (req, res) => {
  try {
    const accessToken = await getValidAccessToken(req);
    if (!accessToken) return res.status(401).json({ error: "no_token" });

    const listResp = await axios.get(
      "https://photoslibrary.googleapis.com/v1/mediaItems",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { pageSize: 100 },
        timeout: 15000,
      }
    );

    const items = (listResp.data.mediaItems || []).filter((m) =>
      (m.mimeType || "").startsWith("video/")
    );

    const videos = items.map((m) => ({
      id: m.id,
      filename: m.filename,
      mimeType: m.mimeType,
      baseUrl: m.baseUrl, // для видео src используем baseUrl + '=dv'
      productUrl: m.productUrl,
    }));

    res.json({ videos, method: "list" });
  } catch (e) {
    const g = e?.response;
    console.error("videos error:", g?.status, g?.data || e.message);
    res.status(g?.status || 500).json({
      error: "upstream_error",
      listStatus: g?.status,
      listData: g?.data,
      message: e.message,
    });
  }
});

// ====== DEBUG ======
app.get("/debug/this-token", async (req, res) => {
  try {
    const token = await getValidAccessToken(req);
    if (!token) return res.json({ error: "not_authenticated" });
    const scopes = (req.session?.tokens?.scope || "")
      .split(" ")
      .filter(Boolean);
    res.json({
      tokenStartsWith: token.slice(0, 12) + "…",
      scopes,
      expiry: req.session?.tokens?.expiry_date || null,
    });
  } catch (e) {
    res.status(500).json({ error: "debug_error", message: e.message });
  }
});

app.get("/debug/tokeninfo", async (req, res) => {
  try {
    const token = await getValidAccessToken(req);
    if (!token) return res.json({ error: "not_authenticated" });

    const info = await axios.get(
      "https://www.googleapis.com/oauth2/v3/tokeninfo",
      { params: { access_token: token } }
    );
    res.json(info.data);
  } catch (e) {
    res.status(e?.response?.status || 500).json(e?.response?.data || e.message);
  }
});

app.get("/debug/videos", async (req, res) => {
  try {
    const token = await getValidAccessToken(req);
    if (!token) return res.json({ error: "not_authenticated" });

    const list = await axios.get(
      "https://photoslibrary.googleapis.com/v1/mediaItems",
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { pageSize: 10 },
      }
    );

    res.json({
      list: { status: list.status, data: list.data },
    });
  } catch (e) {
    const g = e?.response;
    res.status(g?.status || 500).json({
      error: "upstream_error",
      listStatus: g?.status,
      listData: g?.data,
      message: e.message,
    });
  }
});

// ====== корневой роут (SPA) ======
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ====== старт ======
app.listen(PORT, () => {
  console.log(`Server on ${BASE_URL} (port ${PORT})`);
  console.log("Redirect URI:", REDIRECT_URI);
});

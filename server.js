// server.js
const express = require("express");
const path = require("path");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  SESSION_SECRET,
  RENDER_EXTERNAL_URL,
  PORT = 10000,
  NODE_ENV = "production",
} = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !SESSION_SECRET) {
  console.error("❌ Missing env vars: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / SESSION_SECRET");
  process.exit(1);
}

const app = express();

// ---------- Session ----------
app.set("trust proxy", 1); // Render/Heroku style proxies
app.use(
  session({
    name: "gpv.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: true,        // на Render всегда HTTPS
      sameSite: "lax",     // чтобы не резались редиректы
      maxAge: 1000 * 60 * 60 * 24, // 1 день
    },
  })
);

// ---------- Passport ----------
passport.use(
  new GoogleStrategy(
    {
      clientID: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      callbackURL:
        (RENDER_EXTERNAL_URL?.replace(/\/+$/, "") || "") +
        "/auth/google/callback",
      // Важно: запрашиваем только нужные скоупы
      scope: [
        "profile",
        "https://www.googleapis.com/auth/photoslibrary.readonly",
      ],
    },
    (accessToken, refreshToken, profile, done) => {
      // Сохраняем в сессии всё, что нужно для дальнейших запросов
      const user = {
        id: profile.id,
        name: profile.displayName,
        accessToken,
        refreshToken,
      };
      return done(null, user);
    }
  )
);

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

app.use(passport.initialize());
app.use(passport.session());

// ---------- Helpers ----------
function requireAuth(req, res, next) {
  if (req.isAuthenticated?.()) return next();
  return res.status(401).json({ error: "not_authenticated" });
}

// ---------- Static ----------
app.use(express.static(path.join(__dirname, "public")));

// ---------- Auth routes ----------
app.get("/auth/google", passport.authenticate("google"));

app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/?auth=fail" }),
  (req, res) => {
    res.redirect("/");
  }
);

app.get("/logout", (req, res, next) => {
  // passport 0.6+ — logout с колбэком
  req.logout(err => {
    if (err) return next(err);
    req.session.destroy(() => {
      res.clearCookie("gpv.sid", { path: "/" });
      res.redirect("/");
    });
  });
});

// ---------- Tiny API ----------
app.get("/api/session", (req, res) => {
  const ok = !!(req.isAuthenticated && req.isAuthenticated());
  res.json({ authenticated: ok, user: ok ? { name: req.user.name } : null });
});

// Получить список видео
app.get("/api/videos", requireAuth, async (req, res) => {
  try {
    const token = req.user.accessToken;

    // 1) mediaItems:search с фильтром видео (этого достаточно при readonly scope)
    const searchResp = await fetch(
      "https://photoslibrary.googleapis.com/v1/mediaItems:search",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          pageSize: 100,
          filters: {
            mediaTypeFilter: { mediaTypes: ["VIDEO"] },
          },
        }),
      }
    );

    if (!searchResp.ok) {
      const text = await searchResp.text();
      return res.status(searchResp.status).json({
        error: "upstream_error",
        searchStatus: searchResp.status,
        searchData: safeJSON(text),
      });
    }

    const search = await searchResp.json();
    const items = Array.isArray(search.mediaItems) ? search.mediaItems : [];

    // Нормализуем результат для фронтенда
    const videos = items.map((m) => ({
      id: m.id,
      filename: m.filename,
      productUrl: m.productUrl,
      mimeType: m.mimeType,
      baseUrl: m.baseUrl,           // используем для <video src=`${baseUrl}=dv`>
      creationTime: m.mediaMetadata?.creationTime,
    }));

    res.json({ videos });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

// ---------- Debug ----------
app.get("/debug/this-token", requireAuth, async (req, res) => {
  try {
    const token = req.user.accessToken;
    // tokeninfo возвращает скоупы и срок
    const r = await fetch(
      `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(
        token
      )}`
    );
    const data = await r.json().catch(() => ({}));
    res.json({
      tokenStartsWith: token.slice(0, 12) + "…",
      scopes: data.scope ? data.scope.split(" ") : [],
      expiry: data.exp ? Number(data.exp) * 1000 : null,
    });
  } catch {
    res.json({ error: "tokeninfo_failed" });
  }
});

app.get("/debug/videos", async (req, res) => {
  if (!req.isAuthenticated?.()) return res.json({ error: "not_authenticated" });

  const token = req.user.accessToken;
  const tryReq = async (url, opt = {}) => {
    const r = await fetch(url, opt);
    let data = null;
    try {
      data = await r.json();
    } catch {
      data = await r.text();
    }
    return { status: r.status, data };
  };

  const search = await tryReq(
    "https://photoslibrary.googleapis.com/v1/mediaItems:search",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        pageSize: 1,
        filters: { mediaTypeFilter: { mediaTypes: ["VIDEO"] } },
      }),
    }
  );

  res.json({ search });
});

// healthcheck для Render
app.get("/healthz", (_req, res) => res.send("ok"));

function safeJSON(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

app.listen(PORT, () => {
  console.log(`✅ Server on :${PORT}`);
});

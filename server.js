// server.js
// ---- Google Photos Player backend ----

const path = require('path');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const axios = require('axios');
const { OAuth2Client } = require('google-auth-library');

// Поддержка .env при локальной разработке
try { require('dotenv').config(); } catch (_) {}

const PORT = process.env.PORT || 3000;
const APP_URL =
  process.env.RENDER_EXTERNAL_URL?.replace(/\/$/, '') || `http://localhost:${PORT}`;

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret';

// --- базовая проверка env ---
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('❌ GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET не заданы.');
}
if (!SESSION_SECRET) {
  console.error('❌ SESSION_SECRET не задан.');
}

const SCOPES = [
  'profile',
  'email',
  'https://www.googleapis.com/auth/photoslibrary.readonly',
];

const app = express();

// доверяем прокси (Render)
app.set('trust proxy', 1);

// сессии
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    },
  })
);

// статика
app.use('/public', express.static(path.join(__dirname, 'public')));

// Passport
app.use(passport.initialize());
app.use(passport.session());

// Сериализация в сессию — сохраняем только то, что нужно
passport.serializeUser((user, done) => {
  done(null, {
    id: user.id,
    email: user.email,
    name: user.name,
  });
});
passport.deserializeUser((obj, done) => done(null, obj));

// OAuth2 client (для refresh и tokeninfo)
const makeOAuthClient = () =>
  new OAuth2Client({
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    redirectUri: `${APP_URL}/auth/google/callback`,
  });

// Стратегия Google
passport.use(
  new GoogleStrategy(
    {
      clientID: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      callbackURL: `${APP_URL}/auth/google/callback`,
      passReqToCallback: true,
    },
    async (req, accessToken, refreshToken, params, profile, done) => {
      // params.expires_in обычно есть; иногда его нет — поставим дефолт.
      const expiresInSec =
        (params && Number(params.expires_in)) || 3600; // 1 час
      const expiry = Date.now() + (expiresInSec - 60) * 1000; // запас -1 мин

      // Сохраняем в сессию токены и email
      req.session.tokens = {
        access_token: accessToken,
        refresh_token: refreshToken || req.session.tokens?.refresh_token || null,
        expiry,
        scopes: SCOPES,
      };

      const email =
        (profile.emails && profile.emails[0] && profile.emails[0].value) || null;

      const user = {
        id: profile.id,
        email,
        name: profile.displayName,
      };

      console.log('✅ Google auth success:', {
        user: { id: user.id, email: user.email },
        hasRefresh: !!req.session.tokens.refresh_token,
        expiry: new Date(expiry).toISOString(),
      });

      return done(null, user);
    }
  )
);

// ---------- helpers ----------
function ensureAuthed(req, res, next) {
  if (req.isAuthenticated?.() && req.session?.tokens?.access_token) return next();
  return res.status(401).json({ error: 'not_authenticated' });
}

async function getFreshAccessToken(req) {
  const tokens = req.session?.tokens;
  if (!tokens?.access_token) throw new Error('no_access_token');

  // если не просрочен — возвращаем
  if (Date.now() < (tokens.expiry || 0)) {
    return tokens.access_token;
  }

  // refresh по возможности
  if (!tokens.refresh_token) {
    throw new Error('token_expired_and_no_refresh_token');
  }

  const oAuth2 = makeOAuthClient();
  oAuth2.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  });

  try {
    const { credentials } = await oAuth2.refreshAccessToken();
    tokens.access_token = credentials.access_token;
    tokens.expiry =
      Date.now() + ((credentials.expiry_date ? (credentials.expiry_date - Date.now()) / 1000 : 3600) - 60) * 1000;
    req.session.tokens = tokens;
    console.log('🔄 Access token refreshed, new expiry:', new Date(tokens.expiry).toISOString());
    return tokens.access_token;
  } catch (err) {
    console.error('❌ Refresh token error:', err?.response?.data || err.message || err);
    throw new Error('refresh_failed');
  }
}

// ---------- Auth routes ----------
app.get(
  '/auth/google',
  passport.authenticate('google', {
    scope: SCOPES,
    accessType: 'offline',
    prompt: 'consent',
    includeGrantedScopes: true,
  })
);

// Колбэк с максимально подробными логами
app.get('/auth/google/callback', (req, res, next) => {
  passport.authenticate('google', async (err, user, info) => {
    if (err) {
      console.error('Google callback error:', err, info);
      return res
        .status(500)
        .send(`OAuth error: ${err.message || JSON.stringify(err)}`);
    }
    if (!user) {
      console.error('Google callback: no user', info);
      return res.redirect('/?login=failed');
    }
    req.logIn(user, (loginErr) => {
      if (loginErr) {
        console.error('req.logIn error:', loginErr);
        return res
          .status(500)
          .send(`Login error: ${loginErr.message || JSON.stringify(loginErr)}`);
      }
      return res.redirect('/');
    });
  })(req, res, next);
});

app.get('/logout', (req, res) => {
  try {
    req.logout?.(() => {});
  } catch (_) {}
  try {
    req.session.destroy(() => res.redirect('/'));
  } catch {
    res.redirect('/');
  }
});

// ---------- API ----------
app.get('/api/session', (req, res) => {
  res.json({
    authenticated: !!(req.isAuthenticated?.() && req.session?.tokens?.access_token),
    user: req.user || null,
  });
});

app.get('/api/videos', ensureAuthed, async (req, res) => {
  try {
    const token = await getFreshAccessToken(req);

    // 1) mediaItems:search по фильтру "VIDEO"
    const searchResp = await axios.post(
      'https://photoslibrary.googleapis.com/v1/mediaItems:search',
      {
        pageSize: 50,
        filters: { mediaTypeFilter: { mediaTypes: ['VIDEO'] } },
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // если совсем пусто — попробуем просто получить список (на всякий случай)
    let items = searchResp.data.mediaItems || [];
    if (!items.length) {
      const listResp = await axios.get(
        'https://photoslibrary.googleapis.com/v1/mediaItems?pageSize=50',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      items =
        (listResp.data.mediaItems || []).filter((i) => i.mimeType?.startsWith('video/')) || [];
    }

    const simplified = items.map((m) => ({
      id: m.id,
      filename: m.filename,
      productUrl: m.productUrl,
      baseUrl: m.baseUrl,
      mimeType: m.mimeType,
      mediaMetadata: m.mediaMetadata,
    }));

    res.json({ items: simplified });
  } catch (err) {
    const data = err?.response?.data;
    console.error('❌ /api/videos upstream error:', data || err.message || err);
    res.status(502).json({
      error: 'upstream_error',
      detail: data || err.message || String(err),
    });
  }
});

// ---------- DEBUG ----------
app.get('/debug/token', (req, res) => {
  const t = req.session?.tokens;
  if (!t?.access_token) return res.json({ error: 'not_authenticated' });
  res.json({
    scopes: t.scopes || [],
    expiry: t.expiry,
  });
});

app.get('/debug/this-token', (req, res) => {
  const t = req.session?.tokens;
  if (!t?.access_token) return res.json({ error: 'not_authenticated' });
  res.json({
    tokenStartsWith: t.access_token.slice(0, 12) + '…',
    scopes: t.scopes || [],
    expiry: t.expiry,
  });
});

app.get('/debug/tokeninfo', async (req, res) => {
  try {
    const t = req.session?.tokens;
    if (!t?.access_token) return res.json({ error: 'not_authenticated' });
    const token = await getFreshAccessToken(req);
    const info = await axios.get(
      `https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${encodeURIComponent(
        token
      )}`
    );
    res.json(info.data);
  } catch (err) {
    res.status(500).json({
      error: 'tokeninfo_error',
      detail: err?.response?.data || err.message || String(err),
    });
  }
});

app.get('/debug/videos', ensureAuthed, async (req, res) => {
  const out = {};
  try {
    const token = await getFreshAccessToken(req);

    try {
      const search = await axios.post(
        'https://photoslibrary.googleapis.com/v1/mediaItems:search',
        { pageSize: 1, filters: { mediaTypeFilter: { mediaTypes: ['VIDEO'] } } },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      out.search = { status: 200, count: (search.data.mediaItems || []).length };
    } catch (e) {
      out.search = {
        status: e?.response?.status || 500,
        data: e?.response?.data || e.message,
      };
    }

    try {
      const list = await axios.get(
        'https://photoslibrary.googleapis.com/v1/mediaItems?pageSize=1',
        { headers: { Authorization: `Bearer ${token}` } }
      );
      out.list = { status: 200, count: (list.data.mediaItems || []).length };
    } catch (e) {
      out.list = {
        status: e?.response?.status || 500,
        data: e?.response?.data || e.message,
      };
    }

    res.json(out);
  } catch (err) {
    res.status(500).json({ error: 'not_authenticated' });
  }
});

// ---------- UI ----------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Глобальный обработчик ошибок (чтобы вместо «Internal Server Error» видеть причину)
app.use((err, req, res, next) => {
  console.error('UNHANDLED ERROR:', err);
  res.status(500).send(err?.message || 'Internal Server Error');
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on ${PORT} — ${APP_URL}`);
});

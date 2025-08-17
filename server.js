// server.js
// Node 18+ (есть fetch), Express + Passport Google OAuth2

import express from 'express';
import path from 'path';
import session from 'express-session';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';

const app = express();
app.set('trust proxy', 1); // для корректных secure cookie за reverse proxy (Render)

// ---------- Конфиг ----------
const PORT = process.env.PORT || 3000;
const BASE_URL =
  (process.env.RENDER_EXTERNAL_URL?.replace(/\/$/, '')) ||
  `http://localhost:${PORT}`;

const SCOPES = [
  'https://www.googleapis.com/auth/photoslibrary.readonly'
];

// ---------- Сессии ----------
app.use(
  session({
    name: 'gpp.sid',
    secret: process.env.SESSION_SECRET || 'dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: BASE_URL.startsWith('https://')
    }
  })
);

// ---------- Passport ----------
passport.serializeUser((user, done) => {
  done(null, user);
});
passport.deserializeUser((obj, done) => {
  done(null, obj);
});

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${BASE_URL}/auth/google/callback`,
      scope: SCOPES,
      prompt: 'consent',            // просим заново согласиться
      accessType: 'offline',        // нужен refresh_token
      includeGrantedScopes: false   // не склеивать со старыми скоупами
    },
    (accessToken, refreshToken, params, profile, done) => {
      // params.expires_in — в секундах; params.scope может отсутствовать
      const scopeStr = params.scope || '';
      const scopes = scopeStr ? scopeStr.split(' ') : [];
      const expiresAt = Date.now() + (Number(params.expires_in || 0) * 1000);
      const user = {
        id: profile.id,
        displayName: profile.displayName,
        tokens: {
          access_token: accessToken,
          refresh_token: refreshToken || null,
          scopes,
          expiresAt
        }
      };
      return done(null, user);
    }
  )
);

app.use(passport.initialize());
app.use(passport.session());

// ---------- Хелперы ----------
function ensureAuthed(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.status(401).json({ error: 'not_authenticated' });
}

function getToken(req) {
  return req.user?.tokens?.access_token || null;
}
function getRefreshToken(req) {
  return req.user?.tokens?.refresh_token || null;
}
function getExpiry(req) {
  return req.user?.tokens?.expiresAt || 0;
}

async function refreshAccessToken(req) {
  const refreshToken = getRefreshToken(req);
  if (!refreshToken) return false;

  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error('refresh token failed:', resp.status, text);
    return false;
  }

  const data = await resp.json();
  // { access_token, expires_in, scope, token_type }
  req.user.tokens.access_token = data.access_token;
  req.user.tokens.expiresAt = Date.now() + Number(data.expires_in) * 1000;

  // Иногда Google возвращает scope строкой
  if (data.scope) {
    req.user.tokens.scopes = data.scope.split(' ');
  }
  return true;
}

async function ensureValidToken(req) {
  const skew = 60 * 1000; // за минуту до истечения — обновим
  if (!getToken(req)) return false;
  if (Date.now() < getExpiry(req) - skew) return true;
  return await refreshAccessToken(req);
}

async function gphotosFetch(req, endpoint, { method = 'GET', body } = {}) {
  await ensureValidToken(req);
  const token = getToken(req);

  const url = endpoint.startsWith('http')
    ? endpoint
    : `https://photoslibrary.googleapis.com/v1/${endpoint}`;

  const headers = {
    Authorization: `Bearer ${token}`
  };
  if (body && typeof body === 'object' && method !== 'GET') {
    headers['Content-Type'] = 'application/json';
  }

  const resp = await fetch(url, {
    method,
    headers,
    body: body && typeof body === 'object' ? JSON.stringify(body) : body
  });

  return resp;
}

// ---------- Роуты авторизации ----------
app.get('/auth/google', (req, res, next) => {
  passport.authenticate('google', { scope: SCOPES })(req, res, next);
});

app.get(
  '/auth/google/callback',
  passport.authenticate('google', {
    failureRedirect: '/?auth=failed'
  }),
  (req, res) => res.redirect('/')
);

app.post('/logout', ensureAuthed, (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    req.session.destroy(() => {
      res.clearCookie('gpp.sid');
      res.status(204).end();
    });
  });
});

// ---------- API ----------
app.get('/api/me', ensureAuthed, async (req, res) => {
  const info = {
    displayName: req.user.displayName,
    tokenExpiresAt: req.user.tokens.expiresAt,
    scopes: req.user.tokens.scopes
  };
  res.json(info);
});

app.get('/api/videos', ensureAuthed, async (req, res) => {
  try {
    // 1) Поиск только видео
    const searchResp = await gphotosFetch(req, 'mediaItems:search', {
      method: 'POST',
      body: {
        pageSize: 50,
        filters: {
          mediaTypeFilter: { mediaTypes: ['VIDEO'] }
        }
      }
    });

    if (!searchResp.ok) {
      const errText = await searchResp.text();
      return res
        .status(searchResp.status)
        .json({ error: 'upstream_error', detail: errText });
    }

    const data = await searchResp.json();
    const items = (data.mediaItems || []).map(m => ({
      id: m.id,
      filename: m.filename,
      mimeType: m.mimeType,
      baseUrl: m.baseUrl // для превью/иконки; поток — через /video/:id
    }));

    res.json({ items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// Проксирование видео потока (используем baseUrl=dv)
app.get('/video/:id', ensureAuthed, async (req, res) => {
  try {
    const itemResp = await gphotosFetch(req, `mediaItems/${req.params.id}`);
    if (!itemResp.ok) {
      const t = await itemResp.text();
      return res.status(itemResp.status).send(t);
    }
    const item = await itemResp.json();
    if (!item.baseUrl) {
      return res.status(404).json({ error: 'no_baseUrl' });
    }

    // dv — "download video" поток
    const vidUrl = `${item.baseUrl}=dv`;
    const upstream = await gphotosFetch(req, vidUrl);

    res.status(upstream.status);
    // прокидываем часть заголовков
    upstream.headers.forEach((v, k) => {
      if (!['transfer-encoding', 'content-encoding'].includes(k.toLowerCase())) {
        res.setHeader(k, v);
      }
    });

    if (upstream.body) upstream.body.pipe(res);
    else res.end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'proxy_failed' });
  }
});

// ---------- Debug ----------
app.get('/debug/this-token', ensureAuthed, (req, res) => {
  res.json({
    tokenStartsWith: (req.user.tokens.access_token || '').slice(0, 12),
    scopes: req.user.tokens.scopes,
    expiry: req.user.tokens.expiresAt
  });
});

app.get('/debug/tokeninfo', ensureAuthed, async (req, res) => {
  const t = getToken(req);
  const r = await fetch(
    `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(
      t
    )}`
  );
  res.status(r.status).send(await r.text());
});

app.get('/debug/videos', ensureAuthed, async (req, res) => {
  const out = {};
  try {
    const s = await gphotosFetch(req, 'mediaItems:search', {
      method: 'POST',
      body: { pageSize: 1, filters: { mediaTypeFilter: { mediaTypes: ['VIDEO'] } } }
    });
    out.search = { status: s.status, data: s.ok ? await s.json() : await s.text() };

    const l = await gphotosFetch(req, 'mediaItems?pageSize=1');
    out.list = { status: l.status, data: l.ok ? await l.json() : await l.text() };
  } catch (e) {
    out.error = String(e);
  }
  res.json(out);
});

// ---------- Статика ----------
const __dirname = path.dirname(new URL(import.meta.url).pathname);
app.use(express.static(path.join(__dirname, 'public')));

// Фолбэк на index (если нужен одностраничный интерфейс)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- Старт ----------
app.listen(PORT, () => {
  console.log(`Server on ${BASE_URL} (PORT=${PORT})`);
});

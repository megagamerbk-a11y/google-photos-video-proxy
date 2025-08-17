// server.js
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  SESSION_SECRET = 'dev_secret',
  RENDER_EXTERNAL_URL = ''
} = process.env;

const app = express();

// ------------- ВАЖНО для Render -------------
app.set('trust proxy', 1); // доверяем прокси, чтобы secure cookies работали
// ---------------------------------------------

// статика
app.use(express.static(path.join(__dirname, 'public')));

// сессия
const onRender = !!process.env.RENDER || /^https:\/\//i.test(RENDER_EXTERNAL_URL);
app.use(
  session({
    name: 'sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: onRender,        // на Render — true
      maxAge: 1000 * 60 * 60 * 8
    }
  })
);

// passport
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// стратегия Google
const CALLBACK_PATH = '/auth/google/callback';
const CALLBACK_URL = RENDER_EXTERNAL_URL
  ? new URL(CALLBACK_PATH, RENDER_EXTERNAL_URL).toString()
  : CALLBACK_PATH;

passport.use(
  new GoogleStrategy(
    {
      clientID: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      callbackURL: CALLBACK_URL
    },
    (accessToken, refreshToken, params, profile, done) => {
      const user = {
        id: profile.id,
        displayName: profile.displayName,
        tokens: {
          access_token: accessToken,
          refresh_token: refreshToken,
          scope: params.scope,
          expiry_date: Date.now() + (params.expires_in || 3600) * 1000
        }
      };
      return done(null, user);
    }
  )
);

// утилита
function needAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  res.status(401).json({ error: 'not_authenticated' });
}

// --- auth маршруты ---
app.get(
  '/auth/google',
  passport.authenticate('google', {
    scope: ['https://www.googleapis.com/auth/photoslibrary.readonly'],
    accessType: 'offline',
    prompt: 'consent'
  })
);

app.get(
  CALLBACK_PATH,
  passport.authenticate('google', { failureRedirect: '/' }),
  (req, res) => res.redirect('/')
);

// корректный logout (GET для удобства из кнопки)
app.get('/logout', (req, res, next) => {
  req.logout(err => {
    if (err) return next(err);
    req.session.destroy(() => {
      res.clearCookie('sid');
      res.redirect('/');
    });
  });
});

// --- служебные ---
app.get('/healthz', (_, res) => res.type('text').send('ok'));
app.get('/api/me', (req, res) => {
  res.json({
    loggedIn: !!(req.isAuthenticated && req.isAuthenticated()),
    user: req.user ? { id: req.user.id, name: req.user.displayName } : null
  });
});

// список видео (демо)
app.get('/api/videos', needAuth, async (req, res) => {
  const token = req.user.tokens.access_token;
  const searchBody = {
    pageSize: 50,
    filters: { mediaTypeFilter: { mediaTypes: ['VIDEO'] } }
  };
  const r = await fetch('https://photoslibrary.googleapis.com/v1/mediaItems:search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(searchBody)
  });
  const data = await r.json();
  if (!r.ok) return res.status(r.status).json(data);
  const items = (data.mediaItems || []).map(m => ({
    id: m.id,
    filename: m.filename,
    mimeType: m.mimeType,
    baseUrl: m.baseUrl
  }));
  res.json({ items });
});

// отладка
app.get('/debug/this-token', (req, res) => {
  if (!req.user) return res.json({ error: 'not_authenticated' });
  res.json({
    tokenStartsWith: req.user.tokens.access_token?.slice(0, 12) || null,
    scopes: req.user.tokens.scope?.split(' ') || [],
    expiry: req.user.tokens.expiry_date || null
  });
});
app.get('/debug/tokeninfo', needAuth, async (req, res) => {
  const token = req.user.tokens.access_token;
  const r = await fetch(`https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${token}`);
  const data = await r.json();
  res.json(data);
});
app.get('/debug/videos', async (req, res) => {
  // в открытую чтобы было видно причину 401/403
  if (!req.user) return res.json({ error: 'not_authenticated' });
  const token = req.user.tokens.access_token;
  const body = {
    pageSize: 5,
    filters: { mediaTypeFilter: { mediaTypes: ['VIDEO'] } }
  };
  const r1 = await fetch('https://photoslibrary.googleapis.com/v1/mediaItems:search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j1 = await r1.json();

  const r2 = await fetch('https://photoslibrary.googleapis.com/v1/mediaItems', {
    headers: { Authorization: `Bearer ${token}` }
  });
  const j2 = await r2.json();

  res.json({ search: { status: r1.status, data: j1 }, list: { status: r2.status, data: j2 } });
});

// index.html (одностраничник)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`OK on :${PORT}`));

// server.js
require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const morgan = require('morgan');
const axios = require('axios');
const { OAuth2Client } = require('google-auth-library');

const app = express();

/** ---------- Конфиг ---------- */
const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  SESSION_SECRET = 'change-me',
  RENDER_EXTERNAL_URL // не обязателен; если есть — используем
} = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('ENV ERROR: Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
}

const SCOPES = [
  // только чтение медиатеки Google Photos
  'https://www.googleapis.com/auth/photoslibrary.readonly'
];

/** ---------- Утилиты ---------- */
function getBaseUrl(req) {
  // На Render правильно отрабатывает X-Forwarded-* заголовки
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host');
  // Можно зафиксировать RENDER_EXTERNAL_URL, если хотите жестко
  const fromEnv = RENDER_EXTERNAL_URL && RENDER_EXTERNAL_URL.trim();
  return fromEnv || `${proto}://${host}`;
}

function createOAuthClient(redirectUri) {
  const client = new OAuth2Client({
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    redirectUri
  });
  return client;
}

/** ---------- Мидлвары ---------- */
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.set('trust proxy', 1); // обязательно для Render/прокси, чтобы secure-cookies работали корректно

app.use(
  session({
    name: 'gphotos.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production'
    }
  })
);

// Статика из ./public
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

/** ---------- Auth ---------- */
// Проверка токена в сессии
function hasCreds(req) {
  return (
    req.session &&
    req.session.tokens &&
    req.session.tokens.access_token &&
    req.session.tokens.expiry_date &&
    Date.now() < req.session.tokens.expiry_date - 10 * 1000 // небольшой зазор
  );
}

// Обновление access_token по refresh_token при необходимости
async function ensureAccessToken(req, redirectUri) {
  if (hasCreds(req)) return req.session.tokens.access_token;

  if (!req.session || !req.session.tokens || !req.session.tokens.refresh_token) {
    throw new Error('no_tokens');
  }

  const client = createOAuthClient(redirectUri);
  client.setCredentials(req.session.tokens);

  const { credentials } = await client.refreshAccessToken();
  req.session.tokens = credentials;
  return credentials.access_token;
}

// URL на вход
app.get('/auth/google', (req, res) => {
  const base = getBaseUrl(req);
  const redirectUri = `${base}/auth/google/callback`;

  // сохраним redirectUri в сессию (чтобы тем же значением обработать callback)
  req.session.redirectUri = redirectUri;

  const client = createOAuthClient(redirectUri);
  const url = client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    include_granted_scopes: true,
    prompt: 'consent'
  });

  res.redirect(url);
});

// Callback
app.get('/auth/google/callback', async (req, res) => {
  try {
    const code = req.query.code;
    const redirectUri = req.session.redirectUri || `${getBaseUrl(req)}/auth/google/callback`;

    const client = createOAuthClient(redirectUri);
    const { tokens } = await client.getToken(code);

    // сохраним в сессию
    req.session.tokens = tokens;

    // можно показать краткую инфу — email scopes, для UI
    try {
      const info = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      });
      req.session.user = {
        email: info.data.email,
        name: info.data.name,
        picture: info.data.picture
      };
    } catch (e) {
      // не критично
      req.session.user = null;
    }

    res.redirect('/');
  } catch (e) {
    console.error('OAuth callback error:', e.message, e.response?.data);
    res.status(500).send('Internal Server Error');
  }
});

// Статус сессии
app.get('/auth/status', async (req, res) => {
  const authenticated = hasCreds(req);
  res.json({
    authenticated,
    user: authenticated ? req.session.user : null
  });
});

// Выход
app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('gphotos.sid');
    res.redirect('/');
  });
});

/** ---------- API Google Photos ---------- */
app.get('/api/videos', async (req, res) => {
  try {
    if (!req.session) return res.status(401).json({ error: 'not_authenticated' });

    const redirectUri = req.session.redirectUri || `${getBaseUrl(req)}/auth/google/callback`;
    const accessToken = await ensureAccessToken(req, redirectUri);

    const url = 'https://photoslibrary.googleapis.com/v1/mediaItems:search';
    const body = {
      pageSize: 50,
      filters: {
        mediaTypeFilter: {
          mediaTypes: ['VIDEO']
        }
      }
    };

    const { data } = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    const items = (data.mediaItems || []).map((it) => ({
      id: it.id,
      filename: it.filename,
      productUrl: it.productUrl,
      mimeType: it.mimeType,
      baseUrl: it.baseUrl,
      // Для видео — параметр "=dv" дает поток MP4 для плеера
      playerSrc: `${it.baseUrl}=dv`
    }));

    res.json({ items });
  } catch (e) {
    // Переведем «недостаточно прав» в 403 с понятным текстом
    const code = e.response?.status || 500;
    const payload = e.response?.data || { message: e.message };
    res.status(code).json({ error: 'upstream_error', details: payload });
  }
});

/** ---------- Debug ---------- */
app.get('/debug/this-token', async (req, res) => {
  if (!req.session?.tokens?.access_token) {
    return res.json({ error: 'no_token' });
  }
  const access = req.session.tokens.access_token;
  try {
    const { data } = await axios.get(
      `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${access}`
    );
    res.json({
      tokenStartsWith: access.slice(0, 12) + '…',
      scopes: (data.scope || '').split(' '),
      expiry: req.session.tokens.expiry_date
    });
  } catch (e) {
    res.json({ error: 'invalid_token', error_description: e.response?.data || e.message });
  }
});

app.get('/debug/tokeninfo', async (req, res) => {
  if (!req.session?.tokens?.access_token) {
    return res.json({ error: 'no_token' });
  }
  const access = req.session.tokens.access_token;
  try {
    const { data } = await axios.get(
      `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${access}`
    );
    res.json(data);
  } catch (e) {
    res.json({ error: 'invalid_token', details: e.response?.data || e.message });
  }
});

app.get('/debug/videos', async (req, res) => {
  if (!req.session) return res.json({ error: 'not_authenticated' });
  const redirectUri = req.session.redirectUri || `${getBaseUrl(req)}/auth/google/callback`;
  try {
    const accessToken = await ensureAccessToken(req, redirectUri);

    const body = {
      pageSize: 5,
      filters: { mediaTypeFilter: { mediaTypes: ['VIDEO'] } }
    };
    const { data } = await axios.post(
      'https://photoslibrary.googleapis.com/v1/mediaItems:search',
      body,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    res.json({
      status: 200,
      count: (data.mediaItems || []).length,
      sample: (data.mediaItems || []).slice(0, 2)
    });
  } catch (e) {
    res.json({
      status: e.response?.status || 500,
      data: e.response?.data || e.message
    });
  }
});

/** ---------- SPA-фолбэк и сервер ---------- */
// Главная
app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// Любые неизвестные пути (кроме API) → index.html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/debug')) {
    return next();
  }
  res.sendFile(path.join(publicDir, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));

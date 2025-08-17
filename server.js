// server.js
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');
const { google } = require('googleapis');

// ----------------------------
// Константы и вспомогалки
// ----------------------------
const SCOPES = ['https://www.googleapis.com/auth/photoslibrary.readonly'];
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// Без этих двух переменных OAuth не заработает
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in env.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // чтобы корректно брать https на Render

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      sameSite: 'lax',
      secure: 'auto', // true за прокси, false локально — auto подойдёт
    },
  })
);

// Статика (ваш index.html, main.js и т.п. лежат в /public)
app.use(express.static(path.join(__dirname, 'public')));

// Достаём "базовый" URL сервера (нужно для redirect_uri)
function getBaseUrl(req) {
  // Если руками задали в Render → используем
  if (process.env.RENDER_EXTERNAL_URL) {
    return process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, '');
  }
  // Иначе собираем из заголовков (работает и локально, и за прокси)
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
function getRedirectUri(req) {
  return `${getBaseUrl(req)}/auth/google/callback`;
}

// Клиент OAuth2 (redirect_uri подставляем на каждом запросе)
function oauthClientFor(req) {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, getRedirectUri(req));
}

// Обновляем токен в сессии, когда googleapis его рефрешит
function wireTokenPersistence(oauth2, req) {
  oauth2.on('tokens', (tokens) => {
    req.session.tokens = { ...(req.session.tokens || {}), ...tokens };
  });
}

// Убедиться, что у нас есть валидный access_token.
// Если нужно — обновит его по refresh_token.
async function ensureAccessToken(req) {
  if (!req.session.tokens) return null;

  const oauth2 = oauthClientFor(req);
  wireTokenPersistence(oauth2, req);
  oauth2.setCredentials(req.session.tokens);

  // getAccessToken сам рефрешит, если нужно
  const { token } = await oauth2.getAccessToken();
  if (!token) return null;

  // Сохраним текущее состояние (на случай, если обновился expiry_date)
  req.session.tokens = { ...oauth2.credentials };
  return token;
}

// Обёртка для запросов к Photos Library API
async function photosFetch(req, path, { method = 'GET', body } = {}) {
  const accessToken = await ensureAccessToken(req);
  if (!accessToken) {
    return { status: 401, data: { error: 'not_authenticated' } };
  }

  const url = `https://photoslibrary.googleapis.com${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// ------------------------------------
// OAuth: вход и коллбек
// ------------------------------------
app.get('/auth/google', (req, res) => {
  const oauth2 = oauthClientFor(req);
  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // форсит выдачу refresh_token при повторном входе
    scope: SCOPES,
    redirect_uri: getRedirectUri(req),
  });
  // Сохраним redirect_uri в сессию (бывает полезно)
  req.session.redirect_uri = getRedirectUri(req);
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing code');

  const oauth2 = oauthClientFor(req);
  wireTokenPersistence(oauth2, req);

  try {
    const { tokens } = await oauth2.getToken({
      code,
      redirect_uri: req.session.redirect_uri || getRedirectUri(req),
    });
    oauth2.setCredentials(tokens);
    req.session.tokens = { ...tokens };
    res.redirect('/');
  } catch (err) {
    console.error('OAuth callback error:', err?.response?.data || err);
    res.status(500).send('OAuth error');
  }
});

// ------------------------------------
// API: список видео
// ------------------------------------
// Возвращает до ~200 видео (пагинация по 50)
app.get('/api/videos', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'not_authenticated' });

  try {
    const collected = [];
    let pageToken = undefined;

    for (let i = 0; i < 4; i++) {
      const body = {
        pageSize: 50,
        pageToken,
        filters: {
          mediaTypeFilter: { mediaTypes: ['VIDEO'] },
        },
        orderBy: 'MediaMetadata.creation_time desc',
      };

      const { status, data } = await photosFetch(req, '/v1/mediaItems:search', {
        method: 'POST',
        body,
      });

      if (status !== 200) {
        return res.status(status).json({ error: 'upstream_error', details: data });
      }

      if (Array.isArray(data.mediaItems)) {
        collected.push(
          ...data.mediaItems.map((m) => ({
            id: m.id,
            productUrl: m.productUrl,
            baseUrl: m.baseUrl,
            mimeType: m.mimeType,
            filename: m.filename,
            mediaMetadata: m.mediaMetadata,
          }))
        );
      }

      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }

    res.json({ items: collected });
  } catch (e) {
    console.error('videos error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// Выход: отзываем токены и чистим сессию
app.post('/api/logout', async (req, res) => {
  try {
    const token = req.session?.tokens?.access_token || req.session?.tokens?.refresh_token;
    if (token) {
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
      }).catch(() => {});
    }
  } finally {
    req.session.destroy(() => res.json({ ok: true }));
  }
});

// ------------------------------------
// DEBUG-эндпоинты (очень помогают в настройке)
// ------------------------------------

// Что лежит в сессии
app.get('/debug/this-token', (req, res) => {
  const t = req.session.tokens || {};
  res.json({
    tokenStartsWith: t.access_token ? t.access_token.slice(0, 12) + '…' : null,
    scopes: typeof t.scope === 'string' ? t.scope.split(/\s+/) : t.scopes || t.scope,
    expiry: t.expiry_date || null,
  });
});

// tokeninfo от Google (что реально «видит» Google по этому access_token)
app.get('/debug/tokeninfo', async (req, res) => {
  const token = await ensureAccessToken(req);
  if (!token) return res.json({ error: 'not_authenticated' });

  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
  const data = await r.json().catch(() => ({}));
  res.json(data);
});

// Прямые проверки к Photos API (чтобы видеть статусы 200/403)
app.get('/debug/videos', async (req, res) => {
  // 1) POST search (нужен, чтобы фильтровать видео)
  const search = await photosFetch(req, '/v1/mediaItems:search', {
    method: 'POST',
    body: {
      pageSize: 1,
      filters: { mediaTypeFilter: { mediaTypes: ['VIDEO'] } },
    },
  });

  // 2) GET list (просто «как есть», без фильтра)
  const list = await photosFetch(req, '/v1/mediaItems?pageSize=5');

  res.json({
    search,
    list,
  });
});

// ------------------------------------
// Запуск
// ------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server listening on', PORT);
  console.log('Scopes:', SCOPES.join(' '));
});

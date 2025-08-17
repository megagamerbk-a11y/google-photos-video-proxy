/* eslint-disable no-console */
const path = require('path');
const express = require('express');
const session = require('express-session');
const fetch = require('node-fetch'); // v2 (CommonJS)
const { google } = require('googleapis');
require('dotenv').config();

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  SESSION_SECRET = 'change-me',
  RENDER_EXTERNAL_URL
} = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error(
    '❌ GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET не заданы. ' +
    'Добавьте их в переменные окружения Render (или .env).'
  );
}

const app = express();
app.set('trust proxy', 1); // Render/прокси

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(session({
  name: 'ghp.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    sameSite: 'lax',
    secure: true,    // Render — только https
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 12 // 12h
  }
}));

// ----------- OAuth2 Клиент -----------
function getRedirectUri(req) {
  // Лучше задавать явно через переменную окружения
  if (RENDER_EXTERNAL_URL) return `${RENDER_EXTERNAL_URL.replace(/\/+$/, '')}/oauth2callback`;
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  return `${proto}://${req.headers.host}/oauth2callback`;
}

function makeOAuthClient(req) {
  const redirectUri = getRedirectUri(req);
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    redirectUri
  );
}

// ----------- Авторизация -----------
const SCOPE_READONLY = ['https://www.googleapis.com/auth/photoslibrary.readonly'];

app.get('/auth/google', (req, res) => {
  const oauth2 = makeOAuthClient(req);
  const url = oauth2.generateAuthUrl({
    access_type: 'offline',   // refresh_token
    prompt: 'consent',        // чтобы refresh выдали стабильно
    scope: SCOPE_READONLY
  });
  res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
  try {
    const oauth2 = makeOAuthClient(req);
    const { code } = req.query;
    const { tokens } = await oauth2.getToken(code);
    req.session.tokens = tokens;   // сохраняем в сессию
    res.redirect('/');
  } catch (err) {
    console.error('OAuth callback error:', err?.response?.data || err);
    res.status(500).send('OAuth error');
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ----------- Статика (клиент) -----------
app.use(express.static(path.join(__dirname, 'public')));

// ----------- Мидлвэр: нужна авторизация -----------
function requireAuth(req, res, next) {
  if (!req.session.tokens || !req.session.tokens.access_token) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
  next();
}

function makePhotosClient(req) {
  const oauth2 = makeOAuthClient(req);
  oauth2.setCredentials(req.session.tokens);
  return google.photoslibrary({ version: 'v1', auth: oauth2 });
}

// ----------- API: список видео -----------
app.get('/api/videos', requireAuth, async (req, res) => {
  try {
    const photos = makePhotosClient(req);

    // Фильтр по типу "VIDEO"
    const body = {
      pageSize: 50,
      filters: {
        mediaTypeFilter: { mediaTypes: ['VIDEO'] }
      }
    };
    if (req.query.pageToken) body.pageToken = req.query.pageToken;

    const { data } = await photos.mediaItems.search({ requestBody: body });

    const items = (data.mediaItems || []).map((m) => ({
      id: m.id,
      filename: m.filename,
      mimeType: m.mimeType,
      baseUrl: m.baseUrl,               // для скачивания добавляем '=dv'
      creationTime: m.mediaMetadata?.creationTime
    }));

    res.json({
      items,
      nextPageToken: data.nextPageToken || null
    });
  } catch (err) {
    const payload = err?.response?.data || { message: String(err) };
    console.error('[VIDEOS] list error:', payload);
    res.status(502).json({ error: 'upstream_error', details: payload });
  }
});

// ----------- API: стрим видео по id -----------
app.get('/api/stream/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const photos = makePhotosClient(req);
    const { data } = await photos.mediaItems.get({ mediaItemId: id });

    if (!data || !data.baseUrl) {
      return res.status(404).send('Media item not found');
    }

    // Для видео — параметр '=dv' (docs: baseUrl + '=dv' — download video)
    const downloadUrl = `${data.baseUrl}=dv`;

    // Проксируем поток
    const r = await fetch(downloadUrl);
    if (!r.ok) {
      const text = await r.text();
      console.error('Fetch baseUrl error', r.status, text);
      return res.status(502).send('Failed to fetch video');
    }

    // Пробросим тип и длину если есть
    if (r.headers.get('content-type')) {
      res.setHeader('Content-Type', r.headers.get('content-type'));
    } else {
      res.setHeader('Content-Type', data.mimeType || 'video/webm');
    }
    if (r.headers.get('content-length')) {
      res.setHeader('Content-Length', r.headers.get('content-length'));
    }

    r.body.pipe(res);
  } catch (err) {
    console.error('[STREAM] error:', err?.response?.data || err);
    res.status(502).send('stream_error');
  }
});

// ----------- DEBUG -----------
app.get('/debug/this-token', (req, res) => {
  const t = req.session.tokens;
  if (!t) return res.json({ error: 'no_session_tokens' });
  res.json({
    tokenStartsWith: String(t.access_token || '').slice(0, 12) + '…',
    scopes: (t.scope ? String(t.scope).split(' ') : undefined),
    expiry: t.expiry_date
  });
});

app.get('/debug/token', (req, res) => {
  const t = req.session.tokens;
  if (!t || !t.access_token) return res.json({ error: 'not_authenticated' });
  res.json({
    scopes: (t.scope ? String(t.scope).split(' ') : undefined),
    expiry: t.expiry_date
  });
});

app.get('/debug/tokeninfo', requireAuth, async (req, res) => {
  try {
    const oauth2 = google.oauth2({ version: 'v2' });
    const { tokens } = {
      tokens: req.session.tokens
    };
    // endpoint tokeninfo в v3 устарел; используем v2 userinfo как «живой» пинг
    const me = await oauth2.userinfo.get({
      auth: makeOAuthClient({ headers: {}, session: req.session, ...req })
    });
    res.json({
      email: me.data.email || null,
      scope: req.session.tokens.scope,
      exp: req.session.tokens.expiry_date,
      access_type: 'offline'
    });
  } catch (e) {
    res.status(500).json({ error: 'tokeninfo_failed' });
  }
});

app.get('/debug/videos', requireAuth, async (req, res) => {
  const photos = makePhotosClient(req);
  try {
    const search = await photos.mediaItems.search({
      requestBody: {
        pageSize: 1,
        filters: { mediaTypeFilter: { mediaTypes: ['VIDEO'] } }
      }
    });
    const list = await photos.mediaItems.list({ pageSize: 1 });
    res.json({
      search: { status: 200, total: (search.data.mediaItems || []).length },
      list: { status: 200, total: (list.data.mediaItems || []).length }
    });
  } catch (err) {
    const data = err?.response?.data || { message: String(err) };
    res.json({
      search: { status: err?.response?.status || 500, data },
      list: { status: err?.response?.status || 500, data }
    });
  }
});

// ----------- Запуск -----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('✅ Server listening on', PORT);
});

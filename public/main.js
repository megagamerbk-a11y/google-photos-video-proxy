/* public/main.js */

(() => {
  const els = {
    login: document.getElementById('loginBtn'),
    logout: document.getElementById('logoutBtn'),
    refresh: document.getElementById('refreshBtn'),
    list: document.getElementById('list'),
    video: document.getElementById('video'),
    title: document.getElementById('currentTitle')
  };

  const api = {
    me: '/api/me',
    login: '/auth/google',
    logoutCandidates: ['/logout', '/auth/logout', '/api/logout'],
    videos: '/api/videos',
    stream: id => `/api/video/${encodeURIComponent(id)}/stream`
  };

  let state = {
    authed: false,
    items: [],
    activeId: null
  };

  // ---------- helpers ----------

  async function getJSON(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
    }
    return res.json();
  }

  function setText(el, text) {
    el.textContent = text;
  }

  function toggle(el, show) {
    el.classList.toggle('hidden', !show);
  }

  function setBusy(btn, busy) {
    btn.disabled = !!busy;
    btn.dataset.busy = busy ? '1' : '';
  }

  function showError(msg, details) {
    console.error('[UI ERROR]', msg, details || '');
    alert(`Ошибка: ${msg}${details ? `\n\nПодробности: ${details}` : ''}`);
  }

  // ---------- auth / ui ----------

  async function checkAuth() {
    try {
      const data = await getJSON(api.me); // ожидаем { authenticated: boolean, email?: string }
      state.authed = !!(data && (data.authenticated || data.authed || data.ok));
    } catch (e) {
      state.authed = false;
    }
    updateAuthUI();
    return state.authed;
  }

  function updateAuthUI() {
    toggle(els.login, !state.authed);
    toggle(els.logout, state.authed);
    els.refresh.disabled = !state.authed;
  }

  function login() {
    // Можно добавить редирект назад: ?redirect=/ (если сервер поддерживает)
    window.location.href = api.login;
  }

  async function logout() {
    setBusy(els.logout, true);
    try {
      // Пытаемся корректно разлогиниться POST'ом, если сервер поддерживает
      let ok = false;
      for (const path of api.logoutCandidates) {
        try {
          const r = await fetch(path, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
          });
          if (r.ok) { ok = true; break; }
        } catch (_) { /* продолжаем следующую попытку */ }
      }

      // На некоторых конфигурациях есть только GET /logout — попытаемся и его
      if (!ok) {
        try { await fetch('/logout', { credentials: 'include' }); } catch (_) {}
      }
    } finally {
      setBusy(els.logout, false);
      // Чистим UI вне зависимости от результата — если сессия не очищена,
      // /api/me это покажет.
      state.items = [];
      renderList([]);
      clearPlayer();
      await checkAuth();
    }
  }

  // ---------- videos ----------

  async function loadVideos() {
    if (!state.authed) {
      showError('Вы не авторизованы.');
      return;
    }
    setBusy(els.refresh, true);
    try {
      const data = await getJSON(api.videos);
      // Ожидаем data.items — нормализуем на всякий случай
      const items = (data && (data.items || data.videos || data.mediaItems)) || [];
      state.items = items.map(normalizeItem);
      renderList(state.items);
      if (state.items.length === 0) {
        renderEmpty('Видео не найдены. Добавьте видео в Google Photos и нажмите «Обновить список».');
      }
    } catch (e) {
      showError('Не удалось загрузить список видео', e.message);
    } finally {
      setBusy(els.refresh, false);
    }
  }

  function normalizeItem(x) {
    // Приводим разные возможные поля к общим
    return {
      id: x.id || x.mediaItemId || x.mediaItem?.id || x.videoId || x.filename || String(Math.random()),
      title: x.title || x.filename || x.filenameBase || x.mediaItem?.filename || 'Видео',
      mimeType: x.mimeType || x.mediaMetadata?.mimeType || 'video/mp4',
      streamUrl: x.streamUrl || x.playbackUrl || null,
      baseUrl: x.baseUrl || x.mediaItem?.baseUrl || null
    };
  }

  function renderList(items) {
    els.list.innerHTML = '';
    if (!items || items.length === 0) {
      renderEmpty('Видео не загружены. Нажмите «Обновить список».');
      return;
    }
    for (const it of items) {
      const li = document.createElement('li');
      li.textContent = it.title || it.id;
      li.dataset.id = it.id;
      li.addEventListener('click', () => play(it.id));
      els.list.appendChild(li);
    }
  }

  function renderEmpty(msg) {
    els.list.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = msg;
    els.list.appendChild(li);
  }

  function clearPlayer() {
    els.video.removeAttribute('src');
    els.video.load();
    setText(els.title, 'Ничего не выбрано');
    state.activeId = null;
  }

  function selectRow(id) {
    [...els.list.querySelectorAll('li')].forEach(li => {
      li.style.background = li.dataset.id === id ? '#f0f6ff' : '';
    });
  }

  function resolveStreamUrl(item) {
    // 1) Если сервер уже вернул прямой streamUrl (с проксированием токена) — используем его
    if (item.streamUrl) return item.streamUrl;

    // 2) Серверная ручка по id
    if (item.id) return api.stream(item.id);

    // 3) По baseUrl (Photos API) можно попробовать добавить "=dv"
    if (item.baseUrl) return `${item.baseUrl}=dv`;

    // 4) Ничего не нашли
    return null;
    }

  function play(id) {
    const item = state.items.find(i => i.id === id);
    if (!item) return;

    const url = resolveStreamUrl(item);
    if (!url) {
      showError('Не удалось составить ссылку для воспроизведения');
      return;
    }

    state.activeId = id;
    selectRow(id);
    setText(els.title, item.title || item.id);

    // Ставим источник и проигрываем
    els.video.pause();
    els.video.src = url;
    els.video.load();
    // Автовоспроизведение может блокироваться браузером — без ошибок
    els.video.play().catch(() => {});
  }

  // ---------- init ----------

  function bindUI() {
    els.login.addEventListener('click', login);
    els.logout.addEventListener('click', logout);
    els.refresh.addEventListener('click', loadVideos);
  }

  async function init() {
    bindUI();
    await checkAuth();
    if (state.authed) {
      await loadVideos();
    } else {
      renderEmpty('Войдите в аккаунт Google, чтобы увидеть список ваших видео.');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();

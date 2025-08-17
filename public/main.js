async function getJSON(url) {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

const authBtn = document.getElementById('authBtn');
const refreshBtn = document.getElementById('refresh');
const hello = document.getElementById('hello');
const player = document.getElementById('player');
const list = document.getElementById('list');
const emptyLabel = document.getElementById('empty');

let AUTH = { authenticated: false, user: null };

async function updateAuthUI() {
  try {
    AUTH = await getJSON('/auth/status');
  } catch {
    AUTH = { authenticated: false, user: null };
  }

  if (AUTH.authenticated) {
    authBtn.textContent = 'Выйти';
    hello.textContent = AUTH.user?.email ? `Вошли как ${AUTH.user.email}` : '';
  } else {
    authBtn.textContent = 'Войти';
    hello.textContent = '';
  }
}

authBtn.addEventListener('click', () => {
  if (AUTH.authenticated) {
    window.location.href = '/auth/logout';
  } else {
    window.location.href = '/auth/google';
  }
});

refreshBtn.addEventListener('click', async () => {
  try {
    const data = await getJSON('/api/videos');
    renderList(data.items || []);
  } catch (e) {
    if (e.message === '401') {
      alert('Нужно войти в Google. Нажмите «Войти».');
    } else if (e.message === '403') {
      alert('Недостаточно прав (PERMISSION_DENIED). Проверьте, что на выдаче разрешен доступ к Google Photos.');
    } else {
      alert('Не удалось загрузить список видео.');
    }
  }
});

function renderList(items) {
  list.innerHTML = '';
  if (!items.length) {
    emptyLabel.style.display = 'block';
    return;
  }
  emptyLabel.style.display = 'none';

  items.forEach((it) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="mono">${escapeHTML(it.filename || it.id)}</div>
      <div class="muted" style="margin-top:6px">${escapeHTML(it.mimeType || '')}</div>
    `;
    card.addEventListener('click', () => {
      player.pause();
      player.querySelector('source').src = it.playerSrc;
      player.load();
      player.play().catch(() => {});
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    list.appendChild(card);
  });
}

function escapeHTML(s) {
  return (s || '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[ch]));
}

// Старт
(async function init() {
  await updateAuthUI();
  // Если уже вошли — сразу подтянем список
  if (AUTH.authenticated) {
    try {
      const data = await getJSON('/api/videos');
      renderList(data.items || []);
    } catch (_) {}
  }
})();

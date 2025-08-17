// public/main.js
async function getMe() {
  try {
    const r = await fetch('/api/me', { credentials: 'same-origin' });
    return await r.json();
  } catch {
    return { loggedIn: false };
  }
}

async function updateAuthUI() {
  const me = await getMe();
  const loginBtn = document.getElementById('loginBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const refreshBtn = document.getElementById('refreshBtn');

  if (!loginBtn || !logoutBtn) return;

  if (me.loggedIn) {
    loginBtn.classList.add('hidden');
    logoutBtn.classList.remove('hidden');
    if (refreshBtn) refreshBtn.disabled = false;
  } else {
    loginBtn.classList.remove('hidden');
    logoutBtn.classList.add('hidden');
    if (refreshBtn) refreshBtn.disabled = true;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  updateAuthUI();

  const loginBtn = document.getElementById('loginBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const refreshBtn = document.getElementById('refreshBtn');

  if (loginBtn) loginBtn.addEventListener('click', () => {
    window.location.href = '/auth/google';
  });

  if (logoutBtn) logoutBtn.addEventListener('click', () => {
    window.location.href = '/logout';
  });

  if (refreshBtn) refreshBtn.addEventListener('click', async () => {
    const r = await fetch('/api/videos');
    const data = await r.json();
    if (r.ok) {
      console.log('videos:', data);
      alert(`Видео: ${data.items.length}`);
    } else {
      alert(`Ошибка: ${JSON.stringify(data)}`);
    }
  });
});

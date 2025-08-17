const loginBtn = document.getElementById('login');
const logoutBtn = document.getElementById('logout');
const refreshBtn = document.getElementById('refresh');
const listBox = document.getElementById('list');
const player = document.getElementById('player');

async function pingAuth() {
  const r = await fetch('/debug/token');
  const j = await r.json();
  const authed = !j.error;
  loginBtn.classList.toggle('hidden', authed);
  logoutBtn.classList.toggle('hidden', !authed);
  refreshBtn.classList.toggle('hidden', !authed);
  return authed;
}

loginBtn.onclick = () => location.href = '/auth/google';
logoutBtn.onclick = async () => {
  await fetch('/logout', { method: 'POST' });
  location.reload();
};
refreshBtn.onclick = () => loadVideos(true);

async function loadVideos(alertErrors=false) {
  listBox.innerHTML = '';
  try {
    const r = await fetch('/api/videos');
    const j = await r.json();
    if (j.error) throw j;
    if (!j.items?.length) {
      listBox.innerHTML = '<div>Видео не найдены. Нажмите «Обновить список», либо проверьте, что в Google Photos есть видео.</div>';
      return;
    }
    for (const v of j.items) {
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = `
        <div style="font-size:13px;opacity:.8">${v.filename || v.id}</div>
        <button data-id="${v.id}">▶️ Проиграть</button>
      `;
      listBox.appendChild(div);
    }
  } catch (e) {
    console.error(e);
    if (alertErrors) alert('Не удалось загрузить список видео: ' + JSON.stringify(e));
  }
}

listBox.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-id]');
  if (!btn) return;
  const id = btn.getAttribute('data-id');
  // Проигрываем через наш прокси (получаем видеопоток)
  player.src = `/api/stream/${encodeURIComponent(id)}`;
  player.play().catch(()=>{});
});

(async function init() {
  const ok = await pingAuth();
  if (ok) loadVideos();
})();

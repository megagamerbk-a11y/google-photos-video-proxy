
async function fetchVideos() {
  const res = await fetch("/videos");
  if (!res.ok) throw new Error("Не удалось загрузить список видео");
  const { items } = await res.json();
  return items;
}

function renderList(items) {
  const wrap = document.getElementById("videos");
  wrap.innerHTML = "";
  items.forEach(item => {
    const el = document.createElement("div");
    el.className = "card";
    el.innerHTML = `
      <div><strong>${item.filename || item.id}</strong></div>
      <div class="muted">${new Date(item.creationTime || Date.now()).toLocaleString()}</div>
      <div class="muted">${item.mimeType || ""}</div>
    `;
    el.addEventListener("click", () => play(item.id));
    wrap.appendChild(el);
  });
}

async function play(id) {
  const player = document.getElementById("player");
  const wrap = document.getElementById("playerWrap");
  wrap.textContent = `Идёт загрузка видео ${id}...`;
  player.src = `/stream/${encodeURIComponent(id)}`;
  player.load();
  player.play().catch(()=>{});
  wrap.textContent = "";
  wrap.classList.remove("muted");
}

async function init() {
  try {
    const items = await fetchVideos();
    renderList(items);
  } catch (e) {
    console.error(e);
    alert("Ошибка: " + e.message + ". Возможно, вы не авторизованы. Перезайдите со страницы /");
    location.href = "/";
  }
  document.getElementById("refreshBtn").addEventListener("click", async () => {
    const items = await fetchVideos();
    renderList(items);
  });
}

init();

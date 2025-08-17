// public/main.js

// ---------- helpers ----------
function $(id) {
  return document.getElementById(id);
}

function showMessage(msg) {
  // Можно заменить на свой UI, пока простое alert/overlay
  alert(msg);
}

// ---------- API ----------
async function fetchVideos() {
  let res;
  try {
    res = await fetch("/videos", { credentials: "same-origin" });
  } catch (e) {
    showMessage("Не удалось связаться с сервером. Проверьте сеть и попробуйте ещё раз.");
    return [];
  }

  // Если не авторизованы — отправим на логин
  if (res.status === 401) {
    location.href = "/auth/google";
    return [];
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    showMessage("Не удалось загрузить список видео. " + (text || ""));
    return [];
  }

  const { items } = await res.json();
  return items || [];
}

async function play(id) {
  const player = $("player");
  const wrap = $("playerWrap");

  wrap.textContent = `Идёт загрузка видео ${id}...`;
  player.src = `/stream/${encodeURIComponent(id)}`;
  player.load();
  try {
    await player.play();
  } catch (_) {
    // Автовоспроизведение может быть заблокировано — игнорируем
  }
  wrap.textContent = "";
  wrap.classList.remove("muted");
}

// ---------- UI ----------
function renderList(items) {
  const wrap = $("videos");
  wrap.innerHTML = "";

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "Видео не найдены. Нажмите «Обновить список», либо проверьте, что в Google Photos есть видео.";
    wrap.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const el = document.createElement("div");
    el.className = "card";
    el.innerHTML = `
      <div><strong>${escapeHtml(item.filename || item.id)}</strong></div>
      <div class="muted">${formatDate(item.creationTime)}</div>
      <div class="muted">${item.mimeType || ""}</div>
    `;
    el.addEventListener("click", () => play(item.id));
    wrap.appendChild(el);
  });
}

function formatDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ---------- boot ----------
async function init() {
  const refreshBtn = $("refreshBtn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      const items = await fetchVideos();
      renderList(items);
    });
  }

  // первая загрузка
  const items = await fetchVideos();
  renderList(items);
}

init();

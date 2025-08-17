// public/main.js

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);

function showMessage(text) {
  // простой оверлей через alert — можно заменить на свой UI
  alert(text);
}

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// ---------- API ----------
async function fetchVideos() {
  let res;
  try {
    res = await fetch("/videos", { credentials: "same-origin" });
  } catch (e) {
    showMessage("Не удалось связаться с сервером. Проверьте интернет и попробуйте ещё раз.");
    return [];
  }

  // если не авторизованы — поведём на Google Login
  if (res.status === 401) {
    location.href = "/auth/google";
    return [];
  }

  if (!res.ok) {
    // пытаемся достать JSON-ошибку, иначе обрежем HTML
    let msg = "Не удалось загрузить список видео.";
    try {
      const t = await res.text();
      try {
        const j = JSON.parse(t);
        if (j?.error) msg += " " + JSON.stringify(j);
      } catch {
        msg += " " + t.slice(0, 200) + (t.length > 200 ? "…" : "");
      }
    } catch {}
    showMessage(msg);
    return [];
  }

  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.items) ? data.items : [];
}

async function play(id) {
  const player = $("player");
  const wrap = $("playerWrap");

  wrap.textContent = `Загрузка видео…`;
  player.src = `/stream/${encodeURIComponent(id)}`;
  player.load();
  try {
    await player.play();
  } catch {
    // автозапуск может быть заблокирован — ничего страшного
  }
  wrap.textContent = "";
}

// ---------- UI ----------
function renderList(items) {
  const list = $("videos");
  list.innerHTML = "";

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent =
      "Видео не найдены. Нажмите «Обновить список», либо проверьте, что в Google Photos есть видео.";
    list.appendChild(empty);
    return;
  }

  items.forEach((mi) => {
    const el = document.createElement("div");
    el.className = "card";
    el.innerHTML = `
      <div><strong>${escapeHtml(mi.filename || mi.id)}</strong></div>
      <div class="muted">${formatDate(mi.creationTime)}</div>
      <div class="muted">${escapeHtml(mi.mimeType || "")}</div>
    `;
    el.addEventListener("click", () => play(mi.id));
    list.appendChild(el);
  });
}

// ---------- boot ----------
async function init() {
  const refresh = $("refreshBtn");
  if (refresh) {
    refresh.addEventListener("click", async () => {
      refresh.disabled = true;
      try {
        const items = await fetchVideos();
        renderList(items);
      } finally {
        refresh.disabled = false;
      }
    });
  }

  // первая подгрузка
  const items = await fetchVideos();
  renderList(items);

  // воспроизведение по клику на список — настраивается в renderList
}

document.addEventListener("DOMContentLoaded", init);

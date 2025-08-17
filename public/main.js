/* global window, document, fetch, alert */

const els = {
  login: document.getElementById("loginBtn"),
  logout: document.getElementById("logoutBtn"),
  refresh: document.getElementById("refreshBtn"),
  list: document.getElementById("list"),
  empty: document.getElementById("empty"),
  video: document.getElementById("video"),
};

function setAuthUI(authed) {
  els.login.style.display = authed ? "none" : "inline-block";
  els.logout.style.display = authed ? "inline-block" : "none";
  els.refresh.disabled = !authed;
}

async function getMe() {
  const r = await fetch("/api/me");
  if (!r.ok) return { authed: false };
  return r.json();
}

async function loadVideos() {
  els.list.innerHTML = "";
  els.empty.style.display = "none";
  try {
    const r = await fetch("/api/videos");
    const data = await r.json();

    if (!r.ok) {
      const detail =
        data?.listData?.error?.message || data?.message || r.statusText;
      alert(
        `Не удалось загрузить список видео.\n${
          detail || "Попробуйте выполнить вход ещё раз."
        }`
      );
      return;
    }

    const videos = data?.videos || [];
    if (!videos.length) {
      els.empty.style.display = "block";
      return;
    }

    for (const v of videos) {
      const el = document.createElement("div");
      el.className = "item";
      el.title = v.filename || v.mimeType;

      el.innerHTML = `
        <div style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;background:#0b0e14;border-radius:8px;border:1px solid #2b3240">🎬</div>
        <div style="flex:1;min-width:0">
          <div class="name">${(v.filename || "").replace(/</g, "&lt;")}</div>
          <div class="muted">${v.mimeType || ""}</div>
        </div>
      `;

      el.addEventListener("click", () => {
        // Для видео Google Photos: baseUrl + '=dv'
        const src = `${v.baseUrl}=dv`;
        els.video.src = src;
        els.video.play().catch(() => {});
        // небольшая прокрутка к плееру
        window.scrollTo({ top: 0, behavior: "smooth" });
      });

      els.list.appendChild(el);
    }
  } catch (e) {
    alert("Ошибка сети при загрузке списка.");
  }
}

async function init() {
  const me = await getMe();
  setAuthUI(me.authed);

  els.login.addEventListener("click", () => {
    window.location.href = "/auth/google";
  });

  els.logout.addEventListener("click", async () => {
    try {
      await fetch("/api/logout");
    } catch {}
    window.location.reload();
  });

  els.refresh.addEventListener("click", loadVideos);

  if (me.authed) {
    loadVideos();
  }
}

init();

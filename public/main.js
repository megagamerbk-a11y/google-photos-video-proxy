(async () => {
  const btnAuth = document.getElementById("btn-auth");
  const btnRefresh = document.getElementById("btn-refresh");
  const list = document.getElementById("list");
  const emptyList = document.getElementById("empty-list");
  const player = document.getElementById("player");

  let authed = false;

  async function getJSON(url) {
    const r = await fetch(url, { credentials: "same-origin" });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw Object.assign(new Error("HTTP " + r.status), {
        status: r.status,
        body: text
      });
    }
    return r.json();
  }

  function setAuthUI() {
    btnAuth.textContent = authed ? "Выйти" : "Войти с Google";
    btnRefresh.disabled = !authed;
  }

  async function checkAuth() {
    try {
      const data = await getJSON("/me");
      authed = !!data.authed;
    } catch {
      authed = false;
    }
    setAuthUI();
  }

  async function loadVideos() {
    list.innerHTML = "";
    emptyList.hidden = true;

    try {
      const data = await getJSON("/api/videos");
      if (!data.items || !data.items.length) {
        emptyList.hidden = false;
        return;
      }

      for (const item of data.items) {
        const li = document.createElement("li");
        li.textContent = item.filename || item.id;
        li.onclick = () => {
          player.src = item.url;     // =dv уже добавлен на сервере
          player.play().catch(() => {});
        };
        list.appendChild(li);
      }
    } catch (e) {
      let msg = "Не удалось загрузить список видео.";
      // Если сервер вернул подробности — покажем
      try {
        const parsed = JSON.parse(e.body || "{}");
        if (parsed?.data?.error?.message) {
          msg += " " + parsed.data.error.message;
        }
      } catch {}
      alert(msg);
    }
  }

  // События
  btnAuth.onclick = () => {
    if (authed) {
      location.href = "/logout";
    } else {
      location.href = "/auth/google";
    }
  };

  btnRefresh.onclick = () => loadVideos();

  // init
  await checkAuth();
  if (authed) {
    await loadVideos();
  }
})();

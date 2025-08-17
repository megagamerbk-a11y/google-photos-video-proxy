(() => {
  // --- панель навигации уже в HTML, тут лишь удобства ---
  try {
    const form = document.getElementById("proxyform");
    const input = document.getElementById("proxyurl");
    if (form && input) {
      form.addEventListener("submit", (e) => {
        if (!input.value) e.preventDefault();
      });
    }
  } catch {}

  // --- Переписываем fetch/XHR, чтобы относительные пути слались на исходный домен ---
  try {
    const BASE = window.__PROXY_ORIGIN__ || location.origin;

    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        if (typeof input === "string" && input.startsWith("/")) {
          input = BASE + input;
        } else if (input instanceof Request && input.url.startsWith("/")) {
          input = new Request(BASE + input.url, input);
        }
      } catch {}
      return origFetch(input, init);
    };

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      try {
        if (typeof url === "string" && url.startsWith("/")) {
          url = BASE + url;
        }
      } catch {}
      return origOpen.call(this, method, url, ...rest);
    };
  } catch {}

  // --- Замена HTML5 видеоплееров ---
  function replaceVideos(root = document) {
    const vids = new Set(root.querySelectorAll("video"));

    // иногда источник лежит в <source>
    function findSrc(v) {
      if (v.currentSrc) return v.currentSrc;
      if (v.src) return v.src;
      const s = v.querySelector("source[src]"); if (s) return s.src;
      return "";
    }

    vids.forEach((v) => {
      if (v.closest("#proxybar")) return; // не трогаем нашу панель
      if (v.dataset.__proxied === "1") return;

      const src = findSrc(v);
      if (!src) return; // без явного src не трогаем (часто скрипты сами присваивают позже)

      v.dataset.__proxied = "1";
      const wrapper = document.createElement("div");
      wrapper.className = "proxy-player";

      const nv = document.createElement("video");
      nv.controls = true;
      nv.playsInline = true;
      nv.style.maxWidth = "100%";

      // поддержка .m3u8 через hls.js
      if (/\.m3u8(\?|#|$)/i.test(src) && window.Hls && window.Hls.isSupported()) {
        try {
          const hls = new window.Hls();
          hls.loadSource(src);
          hls.attachMedia(nv);
        } catch {
          nv.src = src;
        }
      } else {
        nv.src = src;
      }

      try {
        // Сохраняем размеры как у оригинала (если были)
        const w = v.getAttribute("width");
        const h = v.getAttribute("height");
        if (w) nv.setAttribute("width", w);
        if (h) nv.setAttribute("height", h);
      } catch {}

      v.replaceWith(wrapper);
      wrapper.appendChild(nv);
    });
  }

  // Первая подмена
  try { replaceVideos(document); } catch {}

  // Наблюдаем за динамическими изменениями (SPA)
  try {
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.addedNodes) {
          m.addedNodes.forEach((n) => {
            if (n.nodeType === 1) replaceVideos(n);
          });
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch {}
})();

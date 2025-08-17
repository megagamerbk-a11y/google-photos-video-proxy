(() => {
  // верхняя панель: просто валидируем поле
  try {
    const f = document.getElementById("proxyform");
    const i = document.getElementById("proxyurl");
    if (f && i) f.addEventListener("submit", (e) => { if (!i.value) e.preventDefault(); });
  } catch {}

  // Патч fetch/XHR для относительных путей (SPA)
  try {
    const BASE = window.__PROXY_ORIGIN__ || location.origin;
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        if (typeof input === "string" && input.startsWith("/")) input = BASE + input;
        else if (input instanceof Request && input.url.startsWith("/"))
          input = new Request(BASE + input.url, input);
      } catch {}
      return origFetch(input, init);
    };
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, url, ...r) {
      try { if (typeof url === "string" && url.startsWith("/")) url = (window.__PROXY_ORIGIN__ || "") + url; } catch {}
      return origOpen.call(this, m, url, ...r);
    };
  } catch {}

  const toAsset = (src) =>
    `/asset?u=${encodeURIComponent(src)}&ref=${encodeURIComponent(window.__PROXY_ORIGIN__ || location.origin)}`;

  function findSrc(v) {
    return v.currentSrc || v.src || (v.querySelector("source[src]") || {}).src || "";
  }

  function replaceVideos(root = document) {
    const vids = root.querySelectorAll("video");
    vids.forEach((v) => {
      if (v.closest("#proxybar")) return;
      if (v.dataset.__proxied === "1") return;

      const src = findSrc(v);
      if (!src) return;

      v.dataset.__proxied = "1";
      const wrap = document.createElement("div");
      wrap.className = "proxy-player";

      const nv = document.createElement("video");
      nv.controls = true; nv.playsInline = true; nv.style.maxWidth = "100%";

      const abs = (s) => {
        try { return new URL(s, window.__PROXY_URL__ || location.href).toString(); }
        catch { return s; }
      };
      const real = abs(src);

      // .m3u8 проксируем и переписываем
      if (/\.m3u8(\?|#|$)/i.test(real) && window.Hls && window.Hls.isSupported()) {
        const hls = new window.Hls();
        hls.loadSource(toAsset(real));
        hls.attachMedia(nv);
      } else {
        // mp4/ts/webm тоже через /asset — чтобы всегда был правильный Referer
        nv.src = toAsset(real);
      }

      v.replaceWith(wrap);
      wrap.appendChild(nv);
    });
  }

  // старт и слежение
  try { replaceVideos(document); } catch {}
  try {
    const mo = new MutationObserver((muts) => muts.forEach((m) =>
      m.addedNodes && m.addedNodes.forEach((n) => n.nodeType === 1 && replaceVideos(n))
    ));
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch {}
})();

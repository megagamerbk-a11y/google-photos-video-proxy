const express = require("express");
const axios = require("axios");
const { URL } = require("url");
const path = require("path");

const app = express();
app.set("trust proxy", 1);

app.use(express.static(path.join(__dirname, "public")));

function isHttpUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === "http:" || x.protocol === "https:";
  } catch {
    return false;
  }
}

// Главная с формой
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Загрузка произвольной страницы и инъекция панели/скриптов
app.get("/load", async (req, res) => {
  const target = (req.query.url || "").trim();

  if (!isHttpUrl(target)) {
    return res
      .status(400)
      .send(
        "<h3>Нужно указать корректный http/https адрес в параметре <code>?url=</code>.</h3>"
      );
  }

  const t = new URL(target);

  try {
    const upstream = await axios.get(target, {
      responseType: "text",
      // немного прикидываемся браузером
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      },
      timeout: 15000,
      validateStatus: () => true
    });

    let html = upstream.data || "";

    // Если пришло не HTML — отдадим как есть
    const ctype = String(upstream.headers["content-type"] || "");
    if (!ctype.includes("text/html")) {
      res.set("Content-Type", ctype || "text/plain; charset=utf-8");
      return res.send(html);
    }

    // Вставим <base> чтобы относительные ссылки/ресурсы резолвились на оригинальный сайт
    const baseTag = `<base href="${t.origin}/">`;

    // Наши стили/скрипты + hls.js + прокинем оригинальный origin/url внутрь страницы
    const injectHead = `
      ${baseTag}
      <link rel="stylesheet" href="/proxy.css">
      <script>window.__PROXY_ORIGIN__=${JSON.stringify(
        t.origin
      )};window.__PROXY_URL__=${JSON.stringify(target)};</script>
      <script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.14/dist/hls.min.js" defer></script>
      <script src="/inject.js" defer></script>
    `;

    // Панель сверху (внутрь <body>)
    const proxyBar = `
      <div id="proxybar">
        <form id="proxyform" action="/load" method="get">
          <input type="url" name="url" id="proxyurl" placeholder="Вставьте адрес страницы" value="${escapeHtml(
            target
          )}" />
          <button type="submit">Перейти</button>
          <a href="/" id="proxyhome" title="На главную">✕</a>
        </form>
      </div>
    `;

    // Вклеиваем в <head>
    const headIdx = html.search(/<\/head>/i);
    if (headIdx !== -1) {
      html = html.slice(0, headIdx) + injectHead + html.slice(headIdx);
    } else {
      html = `<head>${injectHead}</head>${html}`;
    }

    // Вклеиваем панель в начало <body>
    const bodyOpenIdx = html.search(/<body[^>]*>/i);
    if (bodyOpenIdx !== -1) {
      const after = html.indexOf(">", bodyOpenIdx);
      html = html.slice(0, after + 1) + proxyBar + html.slice(after + 1);
    } else {
      html = proxyBar + html;
    }

    // Мы отдаем страницу со СВОЕГО домена => снимем большинство CSP (для PoC)
    res.set(
      "Content-Security-Policy",
      "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; img-src * data: blob:; media-src * data: blob:; style-src * 'unsafe-inline' *; script-src * 'unsafe-inline' 'unsafe-eval' * blob: data:; connect-src * data: blob:;"
    );

    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer-when-downgrade");
    res.set("Cross-Origin-Opener-Policy", "unsafe-none"); // ради совместимости
    res.set("Cross-Origin-Embedder-Policy", "unsafe-none");

    res.type("html").send(html);
  } catch (e) {
    console.error("Proxy load error:", e.message);
    res
      .status(502)
      .send(
        `<h3>Не удалось загрузить страницу.</h3><pre>${escapeHtml(
          e.message
        )}</pre>`
      );
  }
});

// хелпер для экранирования текста в HTML
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Proxy listening on http://localhost:${PORT}`)
);

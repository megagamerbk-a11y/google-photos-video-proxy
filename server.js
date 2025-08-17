const express = require("express");
const axios = require("axios");
const { URL } = require("url");
const path = require("path");

const app = express();
app.set("trust proxy", 1);
app.use(express.static(path.join(__dirname, "public")));

function isHttp(u) {
  try {
    const x = new URL(u);
    return x.protocol === "http:" || x.protocol === "https:";
  } catch {
    return false;
  }
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

/**
 * Прокси страницы: подтягиваем HTML, вклеиваем панель и наш скрипт
 */
app.get("/load", async (req, res) => {
  const target = (req.query.url || "").trim();
  if (!isHttp(target)) return res.status(400).send("Bad url");

  try {
    const upstream = await axios.get(target, {
      responseType: "text",
      headers: { "user-agent": UA, accept: "text/html,*/*;q=0.8" },
      timeout: 20000,
      validateStatus: () => true
    });

    let html = upstream.data || "";
    const t = new URL(target);

    // Вставим base + наши скрипты/стили
    const injectHead = `
      <base href="${t.origin}/">
      <link rel="stylesheet" href="/proxy.css">
      <script>window.__PROXY_ORIGIN__=${JSON.stringify(t.origin)};window.__PROXY_URL__=${JSON.stringify(
      target
    )};</script>
      <script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.14/dist/hls.min.js" defer></script>
      <script src="/inject.js" defer></script>
    `;
    const headPos = html.search(/<\/head>/i);
    html =
      headPos === -1 ? `<head>${injectHead}</head>${html}` : html.slice(0, headPos) + injectHead + html.slice(headPos);

    // Панель навигации
    const bar = `
      <div id="proxybar">
        <form id="proxyform" action="/load" method="get">
          <input id="proxyurl" name="url" type="url" value="${escapeHtml(target)}" />
          <button type="submit">Перейти</button>
          <a id="proxyhome" href="/">✕</a>
        </form>
      </div>
    `;
    const bodyOpen = html.search(/<body[^>]*>/i);
    if (bodyOpen !== -1) {
      const after = html.indexOf(">", bodyOpen);
      html = html.slice(0, after + 1) + bar + html.slice(after + 1);
    } else {
      html = bar + html;
    }

    // Снимаем строгий CSP (PoC)
    res.set(
      "Content-Security-Policy",
      "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; img-src * data: blob:; media-src * data: blob:; style-src * 'unsafe-inline' *; script-src * 'unsafe-inline' 'unsafe-eval' * blob: data:; connect-src * data: blob:;"
    );
    res.type("html").send(html);
  } catch (e) {
    console.error(e.message);
    res.status(502).send("Upstream error");
  }
});

/**
 * Прокси ресурсов/медиа.
 * /asset?u=<absolute-url>&ref=<referer>
 * - передаём Referer и UA;
 * - поддерживаем Range для видео;
 * - для .m3u8 переписываем урлы сегментов на наш /asset.
 */
app.get("/asset", async (req, res) => {
  const u = req.query.u;
  const ref = req.query.ref;
  if (!isHttp(u)) return res.status(400).send("Bad u");

  const urlObj = new URL(u);
  const headers = {
    "user-agent": UA,
    referer: ref || urlObj.origin,
    origin: urlObj.origin
  };

  // Проброс Range (нужно для mp4/ts)
  if (req.headers.range) headers.range = req.headers.range;

  try {
    if (u.toLowerCase().includes(".m3u8")) {
      // m3u8 переписываем
      const r = await axios.get(u, {
        responseType: "text",
        headers,
        timeout: 20000,
        validateStatus: () => true
      });

      if (r.status >= 400) {
        res.status(r.status).send(r.statusText || "Error");
        return;
      }

      const base = new URL(u);
      const toAbs = (line) => new URL(line, base).toString();
      const prox = (line) =>
        `/asset?u=${encodeURIComponent(toAbs(line))}&ref=${encodeURIComponent(ref || base.origin)}`;

      const out = String(r.data || "")
        .split(/\r?\n/)
        .map((ln) => {
          const s = ln.trim();
          if (!s || s.startsWith("#")) return ln;
          return prox(s);
        })
        .join("\n");

      res.set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
      return res.send(out);
    }

    // потоковое проксирование любого другого ресурса
    const r = await axios.get(u, {
      responseType: "stream",
      headers,
      timeout: 20000,
      decompress: false,
      validateStatus: () => true
    });

    res.status(r.status);
    // Пробрасываем важные заголовки
    for (const [k, v] of Object.entries(r.headers)) {
      if (["transfer-encoding", "content-encoding"].includes(k)) continue;
      res.set(k, v);
    }
    r.data.pipe(res);
  } catch (e) {
    console.error("asset:", e.message);
    res.status(502).send("asset error");
  }
});

function escapeHtml(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Proxy on http://localhost:" + PORT));

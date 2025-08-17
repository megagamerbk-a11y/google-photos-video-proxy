// debug.js
import axios from "axios";

/**
 * Регистрирует отладочные эндпоинты.
 * @param {import('express').Express} app
 * @param {import('googleapis').Auth.OAuth2Client} oauth2Client
 * @param {Function} ensureAuthed - middleware, который проверяет, что пользователь залогинен
 */
export function registerDebug(app, oauth2Client, ensureAuthed) {
  const mask = (v) => (typeof v === "string" ? v.slice(0, 12) + "…" : v);

  // Быстрый взгляд на текущий токен в credentials (может быть устаревшим)
  app.get("/debug/token", ensureAuthed, async (req, res) => {
    try {
      // Обновим/получим свежий access_token
      const { token } = await oauth2Client.getAccessToken();
      const info = await oauth2Client.getTokenInfo(token);
      res.json({
        tokenStartsWith: mask(token),
        scopes: info.scopes,
        expiry: oauth2Client.credentials.expiry_date || null,
      });
    } catch (e) {
      res.status(500).json({ error: e?.response?.data || String(e) });
    }
  });

  // Именно тот токен, который уходит в /videos (через getAccessToken)
  app.get("/debug/this-token", ensureAuthed, async (req, res) => {
    try {
      const { token } = await oauth2Client.getAccessToken();
      const info = await oauth2Client.getTokenInfo(token);
      res.json({
        tokenStartsWith: mask(token),
        scopes: info.scopes,
        expiry: oauth2Client.credentials.expiry_date || null,
      });
    } catch (e) {
      res.status(500).json({ error: e?.response?.data || String(e) });
    }
  });

  // Полная интроспекция токена от Google (важно для проверки aud/azp — к какому Client ID выдан)
  app.get("/debug/tokeninfo", ensureAuthed, async (req, res) => {
    try {
      const { token } = await oauth2Client.getAccessToken();
      const r = await axios.get("https://oauth2.googleapis.com/tokeninfo", {
        params: { access_token: token },
        validateStatus: () => true,
      });
      // ожидаем поля: aud, azp, scope, expires_in, issued_to и т.п.
      res.status(r.status).json(r.data);
    } catch (e) {
      res.status(500).json({ error: e?.response?.data || String(e) });
    }
  });

  // Сырые ответы Google Photos на list/search — видно реальный статус и тело
  app.get("/debug/videos", ensureAuthed, async (req, res) => {
    try {
      const { token } = await oauth2Client.getAccessToken();

      const searchResp = await axios.post(
        "https://photoslibrary.googleapis.com/v1/mediaItems:search",
        { pageSize: 50, filters: { mediaTypeFilter: { mediaTypes: ["VIDEO"] } } },
        { headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true }
      );

      const listResp = await axios.get(
        "https://photoslibrary.googleapis.com/v1/mediaItems?pageSize=100",
        { headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true }
      );

      res.json({
        search: { status: searchResp.status, data: searchResp.data },
        list: { status: listResp.status, data: listResp.data },
      });
    } catch (e) {
      res.status(500).json({ error: e?.response?.data || String(e) });
    }
  });

  // Состояние сессии (без небезопасных данных)
  app.get("/debug/session", ensureAuthed, (req, res) => {
    const t = req.session?.tokens || {};
    res.json({
      hasTokens: !!req.session?.tokens,
      keys: Object.keys(t),
      // маскируем потенциально чувствительное
      access_token: mask(t.access_token || ""),
      refresh_token: mask(t.refresh_token || ""),
      scopeRaw: t.scope || null,
      expiry_date: t.expiry_date || null,
      sid: req.sessionID,
    });
  });
}

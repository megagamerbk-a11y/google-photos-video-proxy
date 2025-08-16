
# Google Photos Video Proxy (Render.com)

Прототип сервиса, который авторизуется в Google, получает список ваших видео из Google Photos и проигрывает их через прокси-эндпоинт `/stream/:id` (с поддержкой Range).

## Локальный запуск

1. Создайте OAuth-клиент в Google Cloud:
   - Тип: **Web application**
   - Authorized redirect URIs:
     - `http://localhost:3000/oauth2/callback`
   - Скопируйте **Client ID** и **Client Secret**.

2. Создайте `.env` (не обязателен, можно переменные окружения):
   ```env
   SESSION_SECRET=dev-secret-change-me
   GOOGLE_CLIENT_ID=...your...
   GOOGLE_CLIENT_SECRET=...your...
   ```

3. Установка и запуск:
   ```bash
   npm install
   npm start
   ```

4. Откройте `http://localhost:3000`, нажмите «Войти с Google» и разрешите доступ к Google Photos.

## Деплой на Render

1. Создайте новый репозиторий в GitHub и добавьте файлы проекта.
2. На Render → **New +** → **Web Service** → подключите репозиторий.
3. Build Command: `npm install`
4. Start Command: `node server.js`
5. Environment:
   - `SESSION_SECRET` — задайте случайную строку
   - `GOOGLE_CLIENT_ID` — из Google Cloud
   - `GOOGLE_CLIENT_SECRET` — из Google Cloud
6. Deploy. После деплоя у вас будет URL вида `https://your-app.onrender.com`.

7. Вернитесь в Google Cloud и добавьте в **Authorized redirect URIs** ещё один адрес:
   - `https://your-app.onrender.com/oauth2/callback`

8. Нажмите **Clear variable cache / Redeploy** (если нужно), затем откройте `https://your-app.onrender.com` и войдите через Google.

## Как это работает

- `/auth/google` — OAuth-логин (scope `photoslibrary.readonly`).
- `/oauth2/callback` — получение токенов и сохранение в сессии.
- `/videos` — поиск видео через `mediaItems.search` (фильтр `VIDEO`).
- `/stream/:id` — получение `baseUrl` для видео (`=dv`) и проксирование байтов с поддержкой `Range`.

Токены хранятся в сессии (in-memory), что достаточно для прототипа/личного использования.
Для продакшена используйте внешний session store (Redis/Memcached) и базу для пользователей.

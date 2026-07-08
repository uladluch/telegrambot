# feed — личный Telegram-бот для подкастов и YouTube

Бот: [t.me/uladluchrssbot](https://t.me/uladluchrssbot)

Подписки на RSS-фиды подкастов и YouTube-каналы. Раз в день (07:00 UTC) проверяет
фиды и присылает новое: подкасты — MP3-файлом (до 2 ГБ), видео с каналов — MP4-файлом
(до 480p). Любая присланная YouTube-ссылка → карточка с кнопками скачивания.

## Архитектура

**Supabase `unrikrqynkcfvcpyarql` (TMA) — мозг:**

- Edge Function `rss-bot` ([supabase/functions/rss-bot/index.ts](supabase/functions/rss-bot/index.ts)) —
  webhook Telegram, команды, проверка фидов, очередь заданий. Три входа по секретным
  заголовкам: `x-telegram-bot-api-secret-token` (Telegram), `x-cron-secret` (pg_cron),
  `x-worker-secret` (воркер: actions `claim`/`complete`). Деплой с `verify_jwt=false`.
- Таблицы: `subscriptions` (kind: podcast|youtube), `sent_episodes` (дедупликация),
  `jobs` (очередь для воркера), `bot_state` (owner). Схемы:
  [20260707_rss_bot_schema.sql](supabase/migrations/20260707_rss_bot_schema.sql),
  миграция `jobs_queue_and_youtube` (в Supabase).
- pg_cron job `rss-bot-daily-check` (`0 7 * * *`).

**Railway, проект `feed` — мышцы:**

- `bot-api` — self-hosted `telegram-bot-api` (образ `aiogram/telegram-bot-api`),
  домен `bot-api-production-0811.up.railway.app`, порт 8081, том на
  `/var/lib/telegram-bot-api`. Поднимает лимит файлов бота с 50 МБ до 2 ГБ.
  Бот разлогинен из облака Telegram (`logOut`) и живёт на этом сервере — ВСЕ вызовы
  Bot API (включая webhook) идут через него.
- `worker` — Python + yt-dlp + ffmpeg + **Deno** ([worker/worker.py](worker/worker.py),
  [worker/Dockerfile](worker/Dockerfile)). Раз в 30 сек забирает задание из очереди
  через edge-функцию, качает (curl для подкастов, yt-dlp для YouTube), заливает в
  Telegram через внутренний адрес `bot-api.railway.internal:8081`. Переменная
  `YT_COOKIES_B64` (base64 от cookies.txt) — куки YouTube для обхода бана
  датацентровых IP.

  **YouTube на серверном IP требует трёх вещей одновременно** (см. `YT_BASE` в
  worker.py): куки (`YT_COOKIES_B64`); Deno в образе; флаг `--remote-components
  ejs:github` — в yt-dlp 2026.7 решатель n-challenge вынесен в отдельный
  EJS-компонент, без него YouTube отдаёт «Only images are available». Плюс ретраи
  против периодических HTTP 429 от грязного датацентр-IP.

  Куки берутся из браузера Dia (Chromium) на маке скриптом
  [scripts/dia_cookies.py](scripts/dia_cookies.py): расшифровывает Cookies-базу
  ключом из Keychain («Dia Safe Storage»), пишет Netscape cookies.txt. Обновлять
  раз в несколько месяцев (когда бот начнёт жаловаться на «Sign in to confirm»):
  `python3 scripts/dia_cookies.py c.txt && railway variables --service worker
  --set "YT_COOKIES_B64=$(base64 -i c.txt | tr -d '\n')"`.

## Потоки

Ничего не приходит и не качается само — всё по запросу:

- `/latest` → карточки эпизодов всех подписок за последние 24 часа.
- `/list` → подписки кнопками: тап → последний эпизод, дальше «⬇️ 5 more».
- YouTube-карточка = превью + кнопки «⬇️ Видео» / «🎧 Аудио»; подкаст-карточка =
  кнопка «⬇️ Скачать MP3». Скачивание стартует по нажатию кнопки.
- Кнопка → задание воркеру (`yt_video`/`yt_audio`/`send_audio`) → файл в чат.
  Видео до 480p H.264, до 2 ГБ. Shorts из лент исключаются.
- Файл >2 ГБ → карточка с прямой ссылкой.

## Команды бота

Интерфейс бота — английский. `/latest`, `/list` (подписки кнопками: тап → последний
эпизод, глубже — кнопка «⬇️ 5 more»), `/add` (RSS/название/YouTube-канал),
`/del` (кнопками, с подтверждением), `/digest on|off`
(ежедневный дайджест карточек в 07:00 UTC), `/status` (очередь и ошибки),
`/help`. Скачивание — только через карточки: голая YouTube-ссылка → карточка с кнопками
(плюс кнопка «➕ Subscribe to this channel», если на канал видео ещё нет подписки). Первый `/start`
фиксирует владельца, остальные игнорируются.

Кнопки карточки: `🎬/🎧 EN` — оригинал, `🎬/🎧 RU` — русская закадровая озвучка
через Яндекс (vot-cli на воркере; асинхронно, несколько минут). У русскоязычных
каналов RU-ряда нет. Субтитры (колбэк `s:`) работают, но кнопка временно скрыта. Вместо статус-сообщений —
реакции (👀 взял, 👍 готово, 😢 ошибка) и лоадер «sending file»; в подписи файла —
таймкоды глав. Меню команд Telegram регистрируется при /start и /help.
pg_cron: дайджест (07:00), watchdog зависших заданий (ежечасно), очистка jobs (04:00).

## Производительность

- **Кэш file_id** (`tg_files`): любой уже отправленный ботом файл (видео/аудио/RU/подкаст)
  при повторном запросе шлётся по `file_id` — без скачивания и заливки, мгновенно.
  Ключи `yt:<videoId>:<v|a|rv|ra>`, `pod:<guid>`. Воркер сохраняет file_id после
  заливки (`save_file`), edge проверяет кэш перед постановкой задания.
- **Русская озвучка видео** заменяет дорожку на чистый русский голос (`replace_audio`,
  `-c:v copy`) вместо микса с приглушённым оригиналом (amix декодировал обе дорожки +
  фильтр на весь час) — заметно быстрее на длинных видео.
- **Скачивание видео**: yt-dlp `-N 4` (параллельные DASH-фрагменты) — быстрее загрузка.
- **Realtime-подхват заданий**: воркер подписан на `INSERT` в `jobs` через Supabase
  Realtime (`realtime-py`) — нажатие кнопки будит его мгновенно, без ожидания поллинга.
  Гибрид: Realtime как «будильник» + poll раз в 30 с как страховка на случай разрыва
  подписки (claim остаётся атомарным через edge). Нужны env воркера `SUPABASE_URL` +
  `SUPABASE_KEY` (service_role); `jobs` включена в publication `supabase_realtime`.
  Без ключей воркер падает на быстрый poll (5 с) — ничего не ломается.
- **Кэш shorts** (`youtube_meta`): статус «шортс/не шортс» вечен, проверяется у
  YouTube один раз и кэшируется; `/latest`, дайджест и «5 more» читают его пачкой,
  новые видео проверяются параллельно (пул на 8). Убирает деградацию при листании.
- **`/latest` и дайджест** тянут все фиды параллельно и сортируют эпизоды по дате
  глобально (самый свежий внизу по всему списку, не по каждой подписке).
- **Присланная ссылка** → карточка с кнопками сразу; кнопка «Subscribe» дорисовывается
  вторым шагом (определение канала не задерживает карточку).
- **Воркер**: 2 параллельных потока (`WORKERS`) — длинная RU-озвучка не блокирует
  быстрые скачивания. Ловит SIGTERM (Railway redeploy) и помечает активные задания
  ошибкой сам, не дожидаясь watchdog.
- **Watchdog** (`rss-bot-watchdog`, каждые 15 мин): зависшие в `running` задания →
  ошибка. Порог 20 мин для обычных, 90 мин для RU-озвучки.

## Хранилище и очистка

Эпизоды **нигде не хранятся**: воркер качает во временную папку и удаляет после
отправки; архив — это сами сообщения в Telegram. Supabase Storage не используется.
Единственное, что растёт — таблица `jobs`; pg_cron `rss-bot-cleanup` (04:00 UTC)
удаляет задания старше 3 дней. `youtube_meta` (кэш shorts) растёт крошечными
строками, чистить не нужно. Авто-доставки нет — только дайджест по `/digest on`.

## Деплой

- Edge-функция: Supabase MCP `deploy_edge_function` (verify_jwt=false).
- Воркер: `cd worker && railway up --service worker --detach`.
- bot-api: образ, обновляется через Railway UI/CLI (redeploy).

Токен бота и секреты захардкожены в `index.ts` (личный проект). api_id/api_hash
Telegram-приложения — в переменных сервиса `bot-api` на Railway.

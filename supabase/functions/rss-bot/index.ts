// Личный Telegram-бот: подписки на RSS подкастов и YouTube-каналы.
// Интерфейс английский. Файлы не качаются сами — всё по запросу:
//  /latest          — эпизоды всех подписок за последние сутки (карточки с кнопками)
//  /list            — подписки кнопками (тап → последний эпизод, дальше «⬇️ 5 more»)
//  кнопки на карточке — скачать видео/аудио/озвучку, подписаться на канал
//  (скачивание уходит заданием воркеру); голая YouTube-ссылка → карточка
//  /digest on|off   — ежедневный текстовый дайджест (07:00 UTC, только карточки)
//
// Архитектура:
//  - эта функция — "мозг": команды, подписки, очередь заданий;
//  - на Railway живёт self-hosted telegram-bot-api (лимит файлов 2 ГБ) и воркер
//    с yt-dlp/vot-cli, который забирает задания из очереди (таблица jobs).
//
// Деплой с verify_jwt=false — авторизация своя: Telegram шлёт
// x-telegram-bot-api-secret-token, воркер — x-worker-secret, pg_cron — x-cron-secret
// (дайджест и watchdog зависших заданий).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { XMLParser } from "npm:fast-xml-parser@4.5.0";

const BOT_TOKEN = "8123884090:AAHI6cpcQPZcXggtQ-lk2llcDf0QC2OOu3c";
const WEBHOOK_SECRET = "9e0f3e6f5ad21f545b6ba8fcf0d4aca7efed3b9fdb430da2";
const WORKER_SECRET = "9c26f18e84c246271d28b248b0bf56445921be1cb6a5f569";
const CRON_SECRET = "b57e02c1f4d98a366c2e9b0d715f4ac8de360b9271c5e884";
// Self-hosted Bot API на Railway (бот разлогинен из облака Telegram)
const TG_API = `https://bot-api-production-0811.up.railway.app/bot${BOT_TOKEN}`;

// До 20 МБ сервер скачает сам по URL; больше — отдаём воркеру (у него диск и 2 ГБ лимит)
const URL_SEND_LIMIT = 20 * 1024 * 1024;
const TG_MAX = 1_950_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// ---------- Telegram ----------

async function tg(method: string, payload: Record<string, unknown>) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

function esc(s: string) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function say(chatId: string, html: string) {
  await tg("sendMessage", {
    chat_id: chatId,
    text: html.slice(0, 4096),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

// Реакция вместо сервисного сообщения — тише в чате. Провал не критичен.
async function react(chatId: string, messageId: number, emoji: string) {
  await tg("setMessageReaction", {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: "emoji", emoji }],
  }).catch(() => {});
}

// «Печатает…» вверху чата, пока собираем ответ (живёт ~5 секунд)
async function chatAction(chatId: string, action = "typing") {
  await tg("sendChatAction", { chat_id: chatId, action }).catch(() => {});
}

// ---------- Фиды: RSS (подкасты) и Atom (YouTube) ----------

type Episode = {
  guid: string;
  title: string;
  link?: string;
  pubDate?: string;
  audioUrl?: string;
  audioBytes?: number;
  duration?: string;
};

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function text(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "object") return text((v as Record<string, unknown>)["#text"]);
  const s = String(v).trim();
  return s || undefined;
}

async function fetchFeed(url: string): Promise<{ title: string; episodes: Episode[] }> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (personal podcast bot)" },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`feed returned HTTP ${res.status}`);
  const xml = xmlParser.parse(await res.text());

  // Atom — так выглядит фид YouTube-канала
  if (xml?.feed) {
    const entries = Array.isArray(xml.feed.entry) ? xml.feed.entry : xml.feed.entry ? [xml.feed.entry] : [];
    const episodes: Episode[] = entries.map((en: Record<string, unknown>) => {
      const link = Array.isArray(en.link) ? en.link[0] : en.link;
      return {
        guid: text(en["yt:videoId"]) ?? text(en.id) ?? text(en.title) ?? "",
        title: text(en.title) ?? "(untitled)",
        link: (link as Record<string, string> | undefined)?.["@_href"],
        pubDate: text(en.published),
      };
    }).filter((e: Episode) => e.guid);
    episodes.sort((a, b) => (Date.parse(b.pubDate ?? "") || 0) - (Date.parse(a.pubDate ?? "") || 0));
    return { title: text(xml.feed.title) ?? url, episodes };
  }

  const channel = xml?.rss?.channel;
  if (!channel) throw new Error("not an RSS/Atom feed");
  const rawItems = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];
  const episodes: Episode[] = [];
  for (const it of rawItems) {
    const enclosure = Array.isArray(it.enclosure) ? it.enclosure[0] : it.enclosure;
    const title = text(it.title) ?? "(untitled)";
    const guid = text(it.guid) ?? text(enclosure?.["@_url"]) ?? title;
    episodes.push({
      guid,
      title,
      link: text(it.link),
      pubDate: text(it.pubDate),
      audioUrl: text(enclosure?.["@_url"]),
      audioBytes: Number(enclosure?.["@_length"]) || undefined,
      duration: text(it["itunes:duration"]),
    });
  }
  episodes.sort((a, b) => (Date.parse(b.pubDate ?? "") || 0) - (Date.parse(a.pubDate ?? "") || 0));
  return { title: text(channel.title) ?? url, episodes };
}

// ---------- Отправка эпизода подкаста ----------

function fmtDate(d?: string) {
  const t = Date.parse(d ?? "");
  return t ? new Date(t).toISOString().slice(0, 10) : "";
}

function fmtSize(bytes?: number) {
  return bytes ? `${Math.round(bytes / 1024 / 1024)} MB` : "";
}

function podcastCaption(ep: Episode, feedTitle: string) {
  const parts = [`<b>${esc(ep.title)}</b>`, esc(feedTitle)];
  const meta = [fmtDate(ep.pubDate), ep.duration].filter(Boolean).join(" · ");
  if (meta) parts.push(meta);
  if (ep.link) parts.push(`<a href="${esc(ep.link)}">Episode page</a>`);
  return parts.join("\n").slice(0, 1024);
}

async function audioSize(ep: Episode): Promise<number | undefined> {
  if (ep.audioBytes && ep.audioBytes > 1000) return ep.audioBytes;
  try {
    const res = await fetch(ep.audioUrl!, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    return Number(res.headers.get("content-length")) || undefined;
  } catch {
    return undefined;
  }
}

async function enqueue(type: string, payload: Record<string, unknown>) {
  const { error } = await db.from("jobs").insert({ type, payload });
  if (error) throw new Error(`couldn't queue the job: ${error.message}`);
}

// ---------- Кэш file_id ----------
// Тот же контент, уже загруженный ботом, повторно шлём по file_id — без скачивания
// и заливки, мгновенно. Ключи: "yt:<videoId>:<v|a|rv|ra>", "pod:<guid>".

type CachedFile = { file_id: string; file_type: string; caption: string | null };

async function cachedFile(cacheKey: string): Promise<CachedFile | null> {
  const { data } = await db.from("tg_files").select("file_id, file_type, caption").eq("cache_key", cacheKey).maybeSingle();
  return data ?? null;
}

async function saveFile(cacheKey: string, fileId: string, fileType: string, caption?: string) {
  await db.from("tg_files").upsert(
    { cache_key: cacheKey, file_id: fileId, file_type: fileType, caption: caption ?? null },
    { onConflict: "cache_key" },
  );
}

async function sendCached(chatId: string, f: CachedFile) {
  const method = f.file_type === "video" ? "sendVideo" : "sendAudio";
  const payload: Record<string, unknown> = { chat_id: chatId, caption: f.caption ?? "", parse_mode: "HTML" };
  payload[f.file_type] = f.file_id; // video: <id> / audio: <id>
  if (f.file_type === "video") payload.supports_streaming = true;
  await tg(method, payload);
}

// Мгновенная отдача из кэша по нажатию кнопки: файл + 👍 + снятие нажатой кнопки.
async function deliverCached(cbq: Record<string, any>, chatId: string, cached: CachedFile) {
  await tg("answerCallbackQuery", { callback_query_id: cbq.id, text: "From cache ⚡" }).catch(() => {});
  await sendCached(chatId, cached);
  await react(chatId, cbq.message.message_id, "👍");
  const kb = (cbq.message?.reply_markup?.inline_keyboard ?? [])
    .map((row: Record<string, string>[]) => row.filter((b) => b.callback_data !== cbq.data))
    .filter((row: Record<string, string>[]) => row.length > 0);
  await tg("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: cbq.message.message_id,
    reply_markup: { inline_keyboard: kb },
  }).catch(() => {});
}

// Скачивает и присылает эпизод подкаста файлом (маленькие — сразу, большие — через воркер).
// cacheKey задан → маленький файл кэшируем сразу, большой — воркер после заливки.
async function sendEpisode(chatId: string, ep: Episode, feedTitle: string, cacheKey?: string) {
  if (!ep.audioUrl) {
    await say(chatId, `${podcastCaption(ep, feedTitle)}\n\n⚠️ the feed has no audio file`);
    return;
  }
  const size = await audioSize(ep);

  if (size && size > TG_MAX) {
    await say(chatId, `${podcastCaption(ep, feedTitle)}\n\n⚠️ the file is ${fmtSize(size)} — over Telegram's 2 GB limit\n<a href="${esc(ep.audioUrl)}">Download the MP3 directly</a>`);
    return;
  }

  if (!size || size <= URL_SEND_LIMIT) {
    try {
      const res = await tg("sendAudio", {
        chat_id: chatId,
        audio: ep.audioUrl,
        caption: podcastCaption(ep, feedTitle),
        parse_mode: "HTML",
        title: ep.title.slice(0, 64),
        performer: feedTitle.slice(0, 64),
      });
      if (cacheKey && res?.audio?.file_id) {
        await saveFile(cacheKey, res.audio.file_id, "audio", podcastCaption(ep, feedTitle));
      }
      return;
    } catch (e) {
      console.error("sendAudio by URL failed, queueing for worker", e);
    }
  }

  await enqueue("send_audio", {
    chat_id: chatId,
    url: ep.audioUrl,
    caption: podcastCaption(ep, feedTitle),
    title: ep.title.slice(0, 64),
    performer: feedTitle.slice(0, 64),
    cache_key: cacheKey,
  });
  await say(chatId, `⏳ <b>${esc(ep.title)}</b>${size ? ` (${fmtSize(size)})` : ""} — downloading, the file will arrive in a few minutes`);
}

// ---------- Карточки ----------

type Sub = { id: number; feed_url: string; title: string | null; kind: string };

// Shorts: youtube.com/shorts/<id> для шортса отвечает 200, обычное видео редиректит на /watch.
async function isYoutubeShort(videoId: string): Promise<boolean> {
  try {
    const res = await fetch(`https://www.youtube.com/shorts/${videoId}`, {
      method: "HEAD",
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "Cookie": "CONSENT=YES+cb.20240101-01-p0.en+FX+000; SOCS=CAI",
      },
      signal: AbortSignal.timeout(15_000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

// Русскоязычному каналу русская озвучка не нужна — по кириллице в названии
// канала/ролика прячем RU-ряд, чтобы не захламлять карточку.
function hasCyrillic(s: string) {
  return /[а-яё]/i.test(s);
}

// Клавиатура YouTube-карточки. С RU-рядом кнопки оригинала подписаны EN,
// без него (русскоязычный канал) — нейтральные Video/Audio.
// v/a — оригинал, rv/ra — русская озвучка (Яндекс). Колбэк субтитров (s:)
// в обработчике жив, но кнопку не показываем — вернём, когда понадобится.
function ytKeyboard(videoId: string, withRu: boolean) {
  const original = withRu
    ? [
      { text: "🎬 EN", callback_data: `v:${videoId}` },
      { text: "🎧 EN", callback_data: `a:${videoId}` },
    ]
    : [
      { text: "🎬 Video", callback_data: `v:${videoId}` },
      { text: "🎧 Audio", callback_data: `a:${videoId}` },
    ];
  const rows = [original];
  if (withRu) {
    rows.push([
      { text: "🎬 RU", callback_data: `rv:${videoId}` },
      { text: "🎧 RU", callback_data: `ra:${videoId}` },
    ]);
  }
  return rows;
}

// Карточка YouTube-видео: Telegram сам развернёт превью из ссылки, снизу — кнопки.
async function youtubeCard(chatId: string, ep: Episode, feedTitle: string) {
  const url = ep.link ?? `https://www.youtube.com/watch?v=${ep.guid}`;
  const date = fmtDate(ep.pubDate);
  await tg("sendMessage", {
    chat_id: chatId,
    text: `🎬 <b>${esc(feedTitle)}</b>${date ? `\n📅 ${date}` : ""}\n${esc(url)}`,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: false, url, prefer_large_media: true },
    reply_markup: { inline_keyboard: ytKeyboard(ep.guid, !hasCyrillic(`${feedTitle} ${ep.title}`)) },
  });
}

// Канал присланного видео: тянем страницу ролика и достаём channelId из HTML.
// Провал не критичен — просто не покажем кнопку подписки.
async function videoChannelId(videoId: string): Promise<string | null> {
  try {
    return await resolveYoutubeChannelId(`https://www.youtube.com/watch?v=${videoId}`);
  } catch {
    return null;
  }
}

// Карточка для присланной напрямую ссылки на YouTube — без команды и подписки.
// Язык видео неизвестен, поэтому RU-ряд показываем всегда. Карточку с кнопками
// скачивания шлём сразу, а кнопку подписки (sub:<channelId>) дорисовываем вторым
// шагом — определение канала не должно задерживать самый частый сценарий.
async function linkCard(chatId: string, videoId: string) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const rows = ytKeyboard(videoId, true);
  const sent = await tg("sendMessage", {
    chat_id: chatId,
    text: esc(url),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: false, url, prefer_large_media: true },
    reply_markup: { inline_keyboard: rows },
  });
  try {
    const ch = await videoChannelId(videoId);
    if (!ch) return;
    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${ch}`;
    const { data } = await db.from("subscriptions").select("id").eq("feed_url", feedUrl).maybeSingle();
    if (data) return; // уже подписан — кнопка не нужна
    rows.push([{ text: "➕ Subscribe to this channel", callback_data: `sub:${ch}` }]);
    await tg("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: sent.message_id,
      reply_markup: { inline_keyboard: rows },
    }).catch(() => {});
  } catch {
    // канал не определился — оставляем карточку без кнопки подписки
  }
}

// Карточка эпизода подкаста с кнопкой скачивания.
// callback_data: "pd:<subId>:<idx>" — idx — позиция в фиде (0 = новейший).
async function podcastCard(chatId: string, sub: Sub, ep: Episode, idx: number) {
  const meta = [fmtDate(ep.pubDate), ep.duration].filter(Boolean).join(" · ");
  const lines = [`🎧 <b>${esc(ep.title)}</b>`, esc(sub.title ?? "")];
  if (meta) lines.push(meta);
  if (ep.link) lines.push(`<a href="${esc(ep.link)}">Episode page</a>`);
  await tg("sendMessage", {
    chat_id: chatId,
    text: lines.join("\n").slice(0, 4096),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: {
      inline_keyboard: [[{ text: "🎧 MP3", callback_data: `pd:${sub.id}:${idx}` }]],
    },
  });
}

// Рендерит карточку эпизода (без проверки shorts — она делается при сборе).
async function renderCard(chatId: string, sub: Sub, ep: Episode, feedTitle: string, idx: number) {
  if (sub.kind === "youtube") await youtubeCard(chatId, ep, feedTitle);
  else await podcastCard(chatId, sub, ep, idx);
}

// Параллельный map с ограничением одновременных задач (чтобы не завалить YouTube пачкой HEAD).
async function mapPool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const res: R[] = new Array(items.length);
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      res[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return res;
}

// Возвращает множество видео-id, которые являются shorts. Статус вечен, поэтому
// читаем кэш из youtube_meta одним запросом, а YouTube спрашиваем только про новые.
async function filterShorts(ids: string[]): Promise<Set<string>> {
  const shorts = new Set<string>();
  if (!ids.length) return shorts;
  const { data } = await db.from("youtube_meta").select("video_id, is_short").in("video_id", ids);
  const cached = new Map<string, boolean>((data ?? []).map((r) => [r.video_id, r.is_short]));
  for (const [id, isShort] of cached) if (isShort) shorts.add(id);
  const unknown = ids.filter((id) => !cached.has(id));
  if (unknown.length) {
    const checked = await mapPool(unknown, 8, async (id) => ({ id, short: await isYoutubeShort(id) }));
    await db.from("youtube_meta")
      .upsert(checked.map((c) => ({ video_id: c.id, is_short: c.short })), {
        onConflict: "video_id",
        ignoreDuplicates: true,
      })
      .then(() => {}, () => {});
    for (const c of checked) if (c.short) shorts.add(c.id);
  }
  return shorts;
}

// Собирает до max видимых эпизодов (для youtube пропускает shorts), новейший → старый.
// keep(ep) === false прерывает сбор — список отсортирован по дате, дальше только старее.
// offset пропускает первые N видимых — для кнопки "5 more". Shorts-статус берётся из кэша
// пачкой (см. filterShorts), поэтому сканируем с запасом и фильтруем разом.
async function collectEpisodes(
  sub: Sub,
  episodes: Episode[],
  keep: (ep: Episode) => boolean,
  max: number,
  offset = 0,
): Promise<{ ep: Episode; idx: number }[]> {
  const scanLimit = offset + max * 4 + 20; // запас на отсеиваемые shorts
  const candidates: { ep: Episode; idx: number }[] = [];
  for (let i = 0; i < episodes.length && candidates.length < scanLimit; i++) {
    if (!keep(episodes[i])) break;
    candidates.push({ ep: episodes[i], idx: i });
  }
  let visible = candidates;
  if (sub.kind === "youtube") {
    const shorts = await filterShorts(candidates.map((c) => c.ep.guid));
    visible = candidates.filter((c) => !shorts.has(c.ep.guid));
  }
  return visible.slice(offset, offset + max);
}

// ---------- Команды ----------

const HELP = `<b>Commands:</b>
/latest — new episodes from all subscriptions (last 24h)
/list — subscriptions as buttons: tap one for its latest episode
/add link or name — podcast or YouTube channel
/del — unsubscribe
/digest on|off — daily digest of new episodes (07:00 UTC)
/status — download queue and recent errors
/help — this help`;

// Меню команд Telegram (кнопка «/» у поля ввода) — команды тапаются, а не
// вводятся руками. Идемпотентно, обновляем при /start и /help.
async function registerCommands() {
  await tg("setMyCommands", {
    commands: [
      { command: "latest", description: "New episodes from all subscriptions (24h)" },
      { command: "list", description: "Subscriptions — tap one for its latest episode" },
      { command: "add", description: "Subscribe: /add link or name" },
      { command: "del", description: "Unsubscribe (buttons)" },
      { command: "digest", description: "Daily digest on/off (07:00 UTC)" },
      { command: "status", description: "Download queue and recent errors" },
      { command: "help", description: "Help and tips" },
    ],
  }).catch(() => {});
}

async function getOwner(): Promise<string | null> {
  const { data } = await db.from("bot_state").select("value").eq("key", "owner_chat_id").maybeSingle();
  return data?.value ?? null;
}

function isYoutube(s: string) {
  return /(?:youtube\.com|youtu\.be)/i.test(s);
}

async function resolveYoutubeChannelId(input: string): Promise<string> {
  const direct = input.match(/channel\/(UC[\w-]{22})/);
  if (direct) return direct[1];
  const res = await fetch(input, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      "Accept-Language": "en",
      "Cookie": "CONSENT=YES+cb.20240101-01-p0.en+FX+000; SOCS=CAI",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  const html = await res.text();
  // Канонический линк указывает на канал самой страницы; голый channelId в HTML
  // может принадлежать «рекомендованному» соседнему каналу — он только как фолбэк
  const m = html.match(/rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/) ??
    html.match(/"externalId":"(UC[\w-]{22})"/) ??
    html.match(/"channelId":"(UC[\w-]{22})"/) ??
    html.match(/channel\/(UC[\w-]{22})/);
  if (!m) throw new Error("couldn't detect the channel — send a youtube.com/channel/UC… link");
  return m[1];
}

async function resolveFeed(query: string): Promise<{ url: string; kind: string }> {
  if (isYoutube(query)) {
    const channelId = await resolveYoutubeChannelId(query);
    return { url: `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, kind: "youtube" };
  }
  if (/^https?:\/\//i.test(query)) return { url: query, kind: "podcast" };
  const res = await fetch(
    `https://itunes.apple.com/search?media=podcast&limit=1&term=${encodeURIComponent(query)}`,
  );
  const data = await res.json();
  const feedUrl = data.results?.[0]?.feedUrl;
  if (!feedUrl) throw new Error("podcast not found in the iTunes catalog — send a direct RSS link or a YouTube channel");
  return { url: feedUrl, kind: "podcast" };
}

async function cmdAdd(chatId: string, arg: string) {
  if (!arg) {
    await say(chatId, "Usage: <code>/add https://rss-link</code>, <code>/add podcast name</code> or <code>/add youtube-channel-link</code>");
    return;
  }
  const { url, kind } = await resolveFeed(arg);
  const feed = await fetchFeed(url);
  const { data: sub, error } = await db
    .from("subscriptions")
    .insert({ feed_url: url, title: feed.title, kind })
    .select()
    .single();
  if (error) {
    if (error.code === "23505") {
      await say(chatId, `Already subscribed to <b>${esc(feed.title)}</b>`);
      return;
    }
    throw new Error(error.message);
  }
  const latest = feed.episodes[0];
  await say(
    chatId,
    `✅ Subscribed: <b>${esc(feed.title)}</b> (#${sub.id}, ${kind === "youtube" ? "YouTube" : "podcast"})\n` +
      (latest ? `Latest: ${esc(latest.title)} (${fmtDate(latest.pubDate)})\n` : "") +
      `Browse it via /list`,
  );
}

function subButtonLabel(s: Sub) {
  return `${s.kind === "youtube" ? "🎬" : "🎧"} ${(s.title ?? s.feed_url).slice(0, 48)}`;
}

// Каждая подписка — кнопка: тап → последний эпизод, глубже — через «⬇️ 5 more».
async function cmdList(chatId: string) {
  const { data: subs } = await db.from("subscriptions").select("*").order("id");
  if (!subs?.length) {
    await say(chatId, "No subscriptions yet. Add one: <code>/add joe rogan</code>");
    return;
  }
  const rows = (subs as Sub[]).map((s) => [{ text: subButtonLabel(s), callback_data: `l5:${s.id}` }]);
  await tg("sendMessage", {
    chat_id: chatId,
    text: "<b>Subscriptions</b> — tap one to get its latest episode:",
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: rows },
  });
}

// /del: с номером — сразу; без — список кнопками с подтверждением (del: → delok:/delno)
async function cmdDel(chatId: string, arg: string) {
  if (!arg) {
    const { data: subs } = await db.from("subscriptions").select("*").order("id");
    if (!subs?.length) {
      await say(chatId, "No subscriptions to remove");
      return;
    }
    const rows = (subs as Sub[]).map((s) => [{ text: subButtonLabel(s), callback_data: `del:${s.id}` }]);
    await tg("sendMessage", {
      chat_id: chatId,
      text: "<b>Unsubscribe</b> — pick one:",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: rows },
    });
    return;
  }
  const id = Number(arg.replace("#", ""));
  if (!id) {
    await say(chatId, "Usage: <code>/del</code> (buttons) or <code>/del N</code> (number from /list)");
    return;
  }
  const { data } = await db.from("subscriptions").delete().eq("id", id).select();
  await say(
    chatId,
    data?.length ? `Unsubscribed from: ${esc((data[0] as Sub).title ?? (data[0] as Sub).feed_url)}` : `No subscription #${id}`,
  );
}

// /latest и утренний дайджест: собираем всё, потом шлём. digest=true — тихий режим
// (нет сообщений «ничего нового», зато есть заголовок перед карточками).
async function cmdLatestAll(chatId: string, digest = false) {
  const { data: subs } = await db.from("subscriptions").select("*").order("id");
  if (!subs?.length) {
    if (!digest) await say(chatId, "No subscriptions yet. Add one: <code>/add joe rogan</code>");
    return;
  }
  const cutoff = Date.now() - DAY_MS;
  // Фиды тянем параллельно — 7 подписок за время одного запроса, а не семи подряд
  const perSub = await Promise.all((subs as Sub[]).map(async (sub) => {
    try {
      const feed = await fetchFeed(sub.feed_url);
      const picked = await collectEpisodes(
        sub,
        feed.episodes,
        (ep) => (Date.parse(ep.pubDate ?? "") || 0) >= cutoff,
        50,
      );
      return picked.map((p) => ({ sub, ep: p.ep, feedTitle: feed.title, idx: p.idx }));
    } catch (e) {
      console.error(`latest failed for ${sub.feed_url}`, e);
      return [];
    }
  }));
  // Единый список всех подписок, отсортированный по дате: старые → новые,
  // чтобы самый свежий эпизод оказался внизу чата по всему дайджесту, а не по каждой подписке
  const items = perSub.flat();
  items.sort((a, b) => (Date.parse(a.ep.pubDate ?? "") || 0) - (Date.parse(b.ep.pubDate ?? "") || 0));
  if (!items.length) {
    if (!digest) await say(chatId, "No new episodes in the last 24 hours");
    return;
  }
  if (digest) await say(chatId, "☀️ <b>Daily digest</b> — new episodes from your subscriptions:");
  for (const it of items) await renderCard(chatId, it.sub, it.ep, it.feedTitle, it.idx);
}

// Кнопки из /list — N эпизодов подписки карточками, с пагинацией
async function cmdLast(chatId: string, arg: string, n: number, offset = 0) {
  const id = Number(arg.replace("#", ""));
  if (!id) {
    await say(chatId, "Pick a subscription via /list");
    return;
  }
  const { data: sub } = await db.from("subscriptions").select("*").eq("id", id).maybeSingle();
  if (!sub) {
    await say(chatId, `No subscription #${id}`);
    return;
  }
  const feed = await fetchFeed((sub as Sub).feed_url);
  const picked = await collectEpisodes(sub as Sub, feed.episodes, () => true, n, offset);
  // Старые → новые, чтобы самый свежий оказался внизу чата
  for (let j = picked.length - 1; j >= 0; j--) {
    await renderCard(chatId, sub as Sub, picked[j].ep, feed.title, picked[j].idx);
  }
  if (picked.length === 0) {
    await say(chatId, offset ? "No more episodes" : "The feed has no episodes");
    return;
  }
  // Полная порция — вероятно, есть ещё: кнопка следующей страницы
  if (picked.length === n) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: `More from <b>${esc(feed.title)}</b>?`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "⬇️ 5 more", callback_data: `l5:${id}:${offset + picked.length}` }]],
      },
    });
  }
}

async function cmdDigest(chatId: string, arg: string) {
  const v = arg.trim().toLowerCase();
  if (v === "on" || v === "off") {
    await db.from("bot_state").upsert({ key: "digest", value: v });
    await say(chatId, v === "on"
      ? "☀️ Daily digest is <b>on</b> — every day at 07:00 UTC I'll send cards for new episodes (nothing on quiet days)"
      : "🌙 Daily digest is <b>off</b>");
    return;
  }
  const { data } = await db.from("bot_state").select("value").eq("key", "digest").maybeSingle();
  const state = data?.value === "off" ? "off" : "on";
  await say(chatId, `Daily digest is <b>${state}</b>. Toggle: <code>/digest on</code> / <code>/digest off</code>`);
}

const JOB_LABEL: Record<string, string> = {
  send_audio: "🎧 podcast",
  yt_video: "🎬 video",
  yt_audio: "🎧 audio",
  yt_video_ru: "🎬 video RU",
  yt_audio_ru: "🎧 audio RU",
  yt_subs: "📝 subs",
};

// /status — что в очереди у воркера и какие ошибки были за сутки
async function cmdStatus(chatId: string) {
  const { data: active } = await db.from("jobs").select("*").in("status", ["pending", "running"]).order("id");
  const dayAgo = new Date(Date.now() - DAY_MS).toISOString();
  const { data: errs } = await db.from("jobs").select("*").eq("status", "error")
    .gte("updated_at", dayAgo).order("id", { ascending: false }).limit(3);
  const lines: string[] = [];
  if (active?.length) {
    lines.push("<b>In progress:</b>");
    for (const j of active) {
      const url = String(j.payload?.url ?? "").slice(0, 60);
      lines.push(`${j.status === "running" ? "▶️" : "⏳"} ${JOB_LABEL[j.type] ?? j.type} ${esc(url)}`);
    }
  } else {
    lines.push("Queue is empty — nothing is downloading");
  }
  if (errs?.length) {
    lines.push("", "<b>Errors in the last 24h:</b>");
    for (const j of errs) lines.push(`⚠️ ${JOB_LABEL[j.type] ?? j.type}: ${esc(String(j.error ?? "").slice(0, 100))}`);
  }
  await say(chatId, lines.join("\n"));
}

// ---------- Cron (pg_cron → сюда с x-cron-secret) ----------

async function handleCron(task: string) {
  try {
    const owner = await getOwner();
    if (!owner) return;

    // Watchdog (каждые 15 мин): задания, зависшие в running, помечаем ошибкой.
    // Порог по типу: RU-озвучка у Яндекса легально идёт до полутора часов,
    // обычное скачивание в норме — секунды-минуты, поэтому его хороним быстрее.
    if (task === "watchdog") {
      const SLOW = ["yt_video_ru", "yt_audio_ru"];
      const now = Date.now();
      const { data: running } = await db.from("jobs").select("id, type, updated_at").eq("status", "running");
      const stuck = (running ?? []).filter((j) => {
        const age = now - Date.parse(j.updated_at);
        return age > (SLOW.includes(j.type) ? 90 * 60 * 1000 : 20 * 60 * 1000);
      });
      if (stuck.length) {
        await db.from("jobs")
          .update({ status: "error", error: "timed out — killed by watchdog", updated_at: new Date().toISOString() })
          .in("id", stuck.map((j) => j.id));
        await say(owner, `⚠️ ${stuck.length} stuck download(s) marked as failed — see /status`);
      }
      return;
    }

    // Дайджест: карточки новых эпизодов; в тихие дни — ничего
    const { data } = await db.from("bot_state").select("value").eq("key", "digest").maybeSingle();
    if (data?.value === "off") return;
    await cmdLatestAll(owner, true);
  } catch (e) {
    console.error("cron task failed", task, e);
  }
}

// ---------- Колбэки ----------

async function handleCallback(cbq: Record<string, any>) {
  const chatId = String(cbq.message?.chat?.id ?? "");
  const owner = await getOwner();
  const parts = (cbq.data ?? "").split(":");
  const kind = parts[0];
  // v/a — оригинал, rv/ra — русская озвучка (Яндекс), s — субтитры, pd — эпизод
  // подкаста, l5 — страница эпизодов из /list, del/delok/delno — отписка,
  // sub — подписка на канал с карточки видео
  const YT_JOBS: Record<string, { type: string; note: string }> = {
    v: { type: "yt_video", note: "Downloading video" },
    a: { type: "yt_audio", note: "Downloading audio" },
    rv: { type: "yt_video_ru", note: "Translating video to Russian" },
    ra: { type: "yt_audio_ru", note: "Translating audio to Russian" },
    s: { type: "yt_subs", note: "Fetching subtitles" },
  };
  const KNOWN = ["pd", "l5", "del", "delok", "delno", "sub"];
  if (chatId !== owner || !(YT_JOBS[kind] || KNOWN.includes(kind))) {
    await tg("answerCallbackQuery", { callback_query_id: cbq.id }).catch(() => {});
    return;
  }
  try {
    // l5:<subId> — тап по каналу в /list: только последний эпизод.
    // l5:<subId>:<offset> — кнопка «⬇️ 5 more»: следующая пятёрка; саму кнопку
    // убираем, чтобы не дублировать. Кнопки /list не трогаем — список остаётся рабочим.
    if (kind === "l5") {
      await tg("answerCallbackQuery", { callback_query_id: cbq.id, text: "Fetching episodes…" }).catch(() => {});
      if (parts.length >= 3) {
        await tg("editMessageReplyMarkup", {
          chat_id: chatId,
          message_id: cbq.message.message_id,
          reply_markup: { inline_keyboard: [] },
        }).catch(() => {});
        await cmdLast(chatId, parts[1], 5, Number(parts[2]));
      } else {
        await cmdLast(chatId, parts[1], 1, 0);
      }
      return;
    }

    // sub:<channelId> — подписка на канал прямо с карточки видео.
    // Кнопку убираем сразу; при дубле (гонка двух нажатий) просто сообщаем.
    if (kind === "sub") {
      await tg("answerCallbackQuery", { callback_query_id: cbq.id, text: "Subscribing…" }).catch(() => {});
      const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${parts[1]}`;
      const feed = await fetchFeed(feedUrl);
      const { error } = await db.from("subscriptions").insert({ feed_url: feedUrl, title: feed.title, kind: "youtube" });
      if (error && error.code !== "23505") throw new Error(error.message);
      const kb = (cbq.message?.reply_markup?.inline_keyboard ?? [])
        .map((row: Record<string, string>[]) => row.filter((b) => b.callback_data !== cbq.data))
        .filter((row: Record<string, string>[]) => row.length > 0);
      await tg("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: cbq.message.message_id,
        reply_markup: { inline_keyboard: kb },
      }).catch(() => {});
      await say(chatId, error
        ? `Already subscribed to <b>${esc(feed.title)}</b>`
        : `✅ Subscribed: <b>${esc(feed.title)}</b> — new videos will show up in /latest and /list`);
      return;
    }

    // Отписка: del → подтверждение, delok → удалить, delno — отмена.
    // Всё в одном сообщении через editMessageText.
    if (kind === "del" || kind === "delok" || kind === "delno") {
      await tg("answerCallbackQuery", { callback_query_id: cbq.id }).catch(() => {});
      if (kind === "delno") {
        await tg("editMessageText", {
          chat_id: chatId,
          message_id: cbq.message.message_id,
          text: "Cancelled",
        }).catch(() => {});
        return;
      }
      const subId = Number(parts[1]);
      if (kind === "del") {
        const { data: sub } = await db.from("subscriptions").select("*").eq("id", subId).maybeSingle();
        if (!sub) throw new Error("subscription already removed");
        await tg("editMessageText", {
          chat_id: chatId,
          message_id: cbq.message.message_id,
          text: `Unsubscribe from <b>${esc((sub as Sub).title ?? (sub as Sub).feed_url)}</b>?`,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ Yes, unsubscribe", callback_data: `delok:${subId}` },
              { text: "✖️ Cancel", callback_data: "delno" },
            ]],
          },
        });
        return;
      }
      const { data } = await db.from("subscriptions").delete().eq("id", subId).select();
      await tg("editMessageText", {
        chat_id: chatId,
        message_id: cbq.message.message_id,
        text: data?.length
          ? `✅ Unsubscribed from <b>${esc((data[0] as Sub).title ?? (data[0] as Sub).feed_url)}</b>`
          : `No subscription #${subId}`,
        parse_mode: "HTML",
      }).catch(() => {});
      return;
    }

    let note: string;
    if (YT_JOBS[kind]) {
      const videoId = parts[1];
      const cacheKey = `yt:${videoId}:${kind}`;
      // Уже загружали этот контент → шлём по file_id мгновенно, без воркера
      const cached = await cachedFile(cacheKey);
      if (cached) {
        await deliverCached(cbq, chatId, cached);
        return;
      }
      const url = `https://www.youtube.com/watch?v=${videoId}`;
      // ack_message_id: воркер поставит 👍; cache_key — под каким ключом сохранить file_id
      await enqueue(YT_JOBS[kind].type, { chat_id: chatId, url, ack_message_id: cbq.message.message_id, cache_key: cacheKey });
      note = YT_JOBS[kind].note;
      // Русская озвучка: впервые переводимое видео Яндекс готовит минутами — предупреждаем,
      // чтобы не выглядело зависшим
      if (kind === "rv" || kind === "ra") {
        await say(chatId, "🔊 Requested a Russian dub from Yandex. First-time translations take a few minutes — I'll send the file when it's ready.");
      }
    } else {
      // pd:<subId>:<idx> — эпизод подкаста
      const { data: sub } = await db.from("subscriptions").select("*").eq("id", Number(parts[1])).maybeSingle();
      if (!sub) throw new Error("subscription was removed");
      const feed = await fetchFeed((sub as Sub).feed_url);
      const ep = feed.episodes[Number(parts[2])];
      if (!ep) throw new Error("episode not found");
      const cacheKey = `pod:${ep.guid}`;
      const cached = await cachedFile(cacheKey);
      if (cached) {
        await deliverCached(cbq, chatId, cached);
        return;
      }
      await sendEpisode(chatId, ep, feed.title, cacheKey); // сам решит: сразу или через воркер
      note = "Downloading episode";
    }
    await tg("answerCallbackQuery", { callback_query_id: cbq.id, text: `${note}…` });
    // Убираем только нажатую кнопку (защита от двойного нажатия) —
    // остальные остаются: можно взять и видео, и аудио, и RU с одной карточки
    const kb = (cbq.message?.reply_markup?.inline_keyboard ?? [])
      .map((row: Record<string, string>[]) => row.filter((b) => b.callback_data !== cbq.data))
      .filter((row: Record<string, string>[]) => row.length > 0);
    await tg("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: cbq.message.message_id,
      reply_markup: { inline_keyboard: kb },
    }).catch(() => {});
    // 👀 на карточке = «взял в работу»; воркер по завершении сменит на 👍 (или 😢)
    if (kind !== "pd") {
      await react(chatId, cbq.message.message_id, "👀");
    }
  } catch (e) {
    await tg("answerCallbackQuery", { callback_query_id: cbq.id, text: "Error — see chat" }).catch(() => {});
    await say(chatId, `⚠️ Error: ${esc(String((e as Error).message ?? e))}`).catch(() => {});
  }
}

// ---------- Сообщения ----------

// Ловим id видео в присланном тексте: youtube.com/watch, youtu.be, shorts, live, embed
const YT_LINK = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:[^\s]*&)?v=|shorts\/|live\/|embed\/))([\w-]{11})/i;

async function handleUpdate(update: Record<string, any>) {
  const msg = update.message;
  const chatId = String(msg?.chat?.id ?? "");
  // caption — на случай пересланного поста с видео/картинкой и ссылкой в подписи
  const textMsg: string = msg?.text ?? msg?.caption ?? "";
  if (!chatId || !textMsg) return;

  // Личный бот: первый, кто напишет /start, становится владельцем, остальных игнорируем
  const owner = await getOwner();
  if (!owner) {
    if (!textMsg.startsWith("/start")) return;
    await db.from("bot_state").upsert({ key: "owner_chat_id", value: chatId });
    await say(chatId, "Hi! This is your personal podcast bot.\n\n" + HELP);
    return;
  }
  if (chatId !== owner) return;

  const [cmd, ...rest] = textMsg.trim().split(/\s+/);
  const arg = rest.join(" ");
  try {
    // Не команда — возможно, просто ссылка на видео (или пересланное сообщение с ней):
    // отвечаем карточкой с кнопками, никаких команд запоминать не нужно
    if (!cmd.startsWith("/")) {
      const yt = textMsg.match(YT_LINK);
      if (yt) {
        await react(chatId, msg.message_id, "👀");
        await linkCard(chatId, yt[1]);
      } else {
        await say(chatId, "Send a YouTube link — I'll reply with a download card. Everything else: /help");
      }
      return;
    }
    switch (cmd.split("@")[0].toLowerCase()) {
      case "/start":
      case "/help":
        await registerCommands();
        await say(chatId, HELP);
        break;
      case "/add":
        await cmdAdd(chatId, arg);
        break;
      case "/list":
        await cmdList(chatId);
        break;
      case "/del":
      case "/unsubscribe":
        await cmdDel(chatId, arg);
        break;
      case "/latest":
        // 👀 + «печатает…» вместо текстового «Checking…»
        await react(chatId, msg.message_id, "👀");
        await chatAction(chatId);
        await cmdLatestAll(chatId);
        break;
      case "/digest":
        await cmdDigest(chatId, arg);
        break;
      case "/status":
        await cmdStatus(chatId);
        break;
      default:
        await say(chatId, "Unknown command.\n\n" + HELP);
    }
  } catch (e) {
    console.error("command failed", cmd, e);
    await say(chatId, `⚠️ Error: ${esc(String((e as Error).message ?? e))}`).catch(() => {});
  }
}

// ---------- API для воркера ----------

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function workerApi(body: Record<string, any>): Promise<Response> {
  if (body.action === "claim") {
    const { data: job } = await db.from("jobs").select("*").eq("status", "pending").order("id").limit(1).maybeSingle();
    if (!job) return json({ job: null });
    const { data: claimed } = await db
      .from("jobs")
      .update({ status: "running", attempts: job.attempts + 1, updated_at: new Date().toISOString() })
      .eq("id", job.id)
      .eq("status", "pending")
      .select()
      .maybeSingle();
    return json({ job: claimed ?? null });
  }
  if (body.action === "complete") {
    await db
      .from("jobs")
      .update({
        status: body.ok ? "done" : "error",
        error: body.error ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", body.id);
    return json({ ok: true });
  }
  // Воркер отдал file_id залитого файла — кэшируем для мгновенных повторов
  if (body.action === "save_file") {
    await saveFile(body.cache_key, body.file_id, body.file_type, body.caption);
    return json({ ok: true });
  }
  return json({ error: "unknown action" }, 400);
}

// ---------- HTTP ----------

Deno.serve(async (req) => {
  if (req.headers.get("x-telegram-bot-api-secret-token") === WEBHOOK_SECRET) {
    const update = await req.json();
    // Отвечаем Telegram сразу, обработку ведём в фоне
    if (update.callback_query) {
      EdgeRuntime.waitUntil(handleCallback(update.callback_query));
    } else {
      EdgeRuntime.waitUntil(handleUpdate(update));
    }
    return new Response("ok");
  }

  if (req.headers.get("x-cron-secret") === CRON_SECRET) {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    EdgeRuntime.waitUntil(handleCron(String(body?.task ?? "digest")));
    return new Response("ok");
  }

  if (req.headers.get("x-worker-secret") === WORKER_SECRET) {
    return await workerApi(await req.json());
  }

  return new Response("forbidden", { status: 403 });
});

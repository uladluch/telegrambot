// Личный Telegram-бот: подписки на RSS подкастов и YouTube-каналы.
// Ничего не качается автоматически — всё по запросу:
//  /latest         — эпизоды всех подписок за последние сутки (карточки с кнопками)
//  /last5 /last10 N — N последних эпизодов конкретной подписки
//  кнопки на карточке — скачать видео/аудио/эпизод (задание уходит воркеру)
//  /clear          — удалить переписку с ботом (подписки не трогает)
//
// Архитектура:
//  - эта функция — "мозг": команды, подписки, очередь заданий;
//  - на Railway живёт self-hosted telegram-bot-api (лимит файлов 2 ГБ) и воркер
//    с yt-dlp, который забирает задания из очереди (таблица jobs).
//
// Деплой с verify_jwt=false — авторизация своя: Telegram шлёт
// x-telegram-bot-api-secret-token, воркер — x-worker-secret.
// Очистка старых заданий и хранилища — отдельным pg_cron прямо в БД.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { XMLParser } from "npm:fast-xml-parser@4.5.0";

const BOT_TOKEN = "8123884090:AAHI6cpcQPZcXggtQ-lk2llcDf0QC2OOu3c";
const WEBHOOK_SECRET = "9e0f3e6f5ad21f545b6ba8fcf0d4aca7efed3b9fdb430da2";
const WORKER_SECRET = "9c26f18e84c246271d28b248b0bf56445921be1cb6a5f569";
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
  if (!res.ok) throw new Error(`фид вернул HTTP ${res.status}`);
  const xml = xmlParser.parse(await res.text());

  // Atom — так выглядит фид YouTube-канала
  if (xml?.feed) {
    const entries = Array.isArray(xml.feed.entry) ? xml.feed.entry : xml.feed.entry ? [xml.feed.entry] : [];
    const episodes: Episode[] = entries.map((en: Record<string, unknown>) => {
      const link = Array.isArray(en.link) ? en.link[0] : en.link;
      return {
        guid: text(en["yt:videoId"]) ?? text(en.id) ?? text(en.title) ?? "",
        title: text(en.title) ?? "(без названия)",
        link: (link as Record<string, string> | undefined)?.["@_href"],
        pubDate: text(en.published),
      };
    }).filter((e: Episode) => e.guid);
    episodes.sort((a, b) => (Date.parse(b.pubDate ?? "") || 0) - (Date.parse(a.pubDate ?? "") || 0));
    return { title: text(xml.feed.title) ?? url, episodes };
  }

  const channel = xml?.rss?.channel;
  if (!channel) throw new Error("это не RSS/Atom-фид");
  const rawItems = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];
  const episodes: Episode[] = [];
  for (const it of rawItems) {
    const enclosure = Array.isArray(it.enclosure) ? it.enclosure[0] : it.enclosure;
    const title = text(it.title) ?? "(без названия)";
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
  return bytes ? `${Math.round(bytes / 1024 / 1024)} МБ` : "";
}

function podcastCaption(ep: Episode, feedTitle: string) {
  const parts = [`<b>${esc(ep.title)}</b>`, esc(feedTitle)];
  const meta = [fmtDate(ep.pubDate), ep.duration].filter(Boolean).join(" · ");
  if (meta) parts.push(meta);
  if (ep.link) parts.push(`<a href="${esc(ep.link)}">Страница эпизода</a>`);
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
  if (error) throw new Error(`не смог поставить задание в очередь: ${error.message}`);
}

// Скачивает и присылает эпизод подкаста файлом (маленькие — сразу, большие — через воркер)
async function sendEpisode(chatId: string, ep: Episode, feedTitle: string) {
  if (!ep.audioUrl) {
    await say(chatId, `${podcastCaption(ep, feedTitle)}\n\n⚠️ в фиде нет аудиофайла`);
    return;
  }
  const size = await audioSize(ep);

  if (size && size > TG_MAX) {
    await say(chatId, `${podcastCaption(ep, feedTitle)}\n\n⚠️ файл ${fmtSize(size)} — больше лимита Telegram 2 ГБ\n<a href="${esc(ep.audioUrl)}">Скачать MP3 напрямую</a>`);
    return;
  }

  if (!size || size <= URL_SEND_LIMIT) {
    try {
      await tg("sendAudio", {
        chat_id: chatId,
        audio: ep.audioUrl,
        caption: podcastCaption(ep, feedTitle),
        parse_mode: "HTML",
        title: ep.title.slice(0, 64),
        performer: feedTitle.slice(0, 64),
      });
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
  });
  await say(chatId, `⏳ <b>${esc(ep.title)}</b>${size ? ` (${fmtSize(size)})` : ""} — качаю, пришлю файлом через несколько минут`);
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

// Карточка YouTube-видео: Telegram сам развернёт превью из ссылки, снизу — кнопки.
// callback_data: "v:<videoId>" (видео) / "a:<videoId>" (аудио).
async function youtubeCard(chatId: string, ep: Episode, feedTitle: string) {
  const url = ep.link ?? `https://www.youtube.com/watch?v=${ep.guid}`;
  const date = fmtDate(ep.pubDate);
  await tg("sendMessage", {
    chat_id: chatId,
    text: `🎬 <b>${esc(feedTitle)}</b>${date ? `\n📅 ${date}` : ""}\n${esc(url)}`,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: false, url, prefer_large_media: true },
    reply_markup: {
      inline_keyboard: [[
        { text: "⬇️ Видео", callback_data: `v:${ep.guid}` },
        { text: "🎧 Аудио", callback_data: `a:${ep.guid}` },
      ]],
    },
  });
}

// Карточка эпизода подкаста с кнопкой скачивания.
// callback_data: "pd:<subId>:<idx>" — idx — позиция в фиде (0 = новейший).
async function podcastCard(chatId: string, sub: Sub, ep: Episode, idx: number) {
  const meta = [fmtDate(ep.pubDate), ep.duration].filter(Boolean).join(" · ");
  const lines = [`🎧 <b>${esc(ep.title)}</b>`, esc(sub.title ?? "")];
  if (meta) lines.push(meta);
  if (ep.link) lines.push(`<a href="${esc(ep.link)}">Страница эпизода</a>`);
  await tg("sendMessage", {
    chat_id: chatId,
    text: lines.join("\n").slice(0, 4096),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: {
      inline_keyboard: [[{ text: "⬇️ Скачать MP3", callback_data: `pd:${sub.id}:${idx}` }]],
    },
  });
}

// Рендерит карточку эпизода (без проверки shorts — она делается при сборе).
async function renderCard(chatId: string, sub: Sub, ep: Episode, feedTitle: string, idx: number) {
  if (sub.kind === "youtube") await youtubeCard(chatId, ep, feedTitle);
  else await podcastCard(chatId, sub, ep, idx);
}

// Собирает до max видимых эпизодов (для youtube пропускает shorts), новейший → старый.
// keep(ep) === false прерывает сбор — список отсортирован по дате, дальше только старее.
async function collectEpisodes(
  sub: Sub,
  episodes: Episode[],
  keep: (ep: Episode) => boolean,
  max: number,
): Promise<{ ep: Episode; idx: number }[]> {
  const out: { ep: Episode; idx: number }[] = [];
  for (let i = 0; i < episodes.length && out.length < max; i++) {
    const ep = episodes[i];
    if (!keep(ep)) break;
    if (sub.kind === "youtube" && (await isYoutubeShort(ep.guid))) continue;
    out.push({ ep, idx: i });
  }
  return out;
}

// ---------- Команды ----------

const HELP = `<b>Команды:</b>
/latest — эпизоды всех подписок за последние сутки
/last5 номер — 5 последних эпизодов подписки
/last10 номер — 10 последних
/list — список подписок
/add ссылка или название — подкаст или YouTube-канал
/del номер — отписаться
/video ссылка — скачать видео с YouTube (до 720p)
/audio ссылка — вытащить аудио из YouTube-видео
/clear — очистить переписку с ботом (подписки не трогает)
/help — справка

Ничего не приходит само — эпизоды запрашиваешь через /latest или /last5. На карточке жмёшь кнопку, и бот присылает файл (видео до 2 ГБ). Свои эпизоды храни у себя — на сервере ничего не остаётся.`;

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
  if (!m) throw new Error("не смог определить канал — пришли ссылку вида youtube.com/channel/UC…");
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
  if (!feedUrl) throw new Error("подкаст не нашёлся в каталоге iTunes — пришли прямую ссылку на RSS или YouTube-канал");
  return { url: feedUrl, kind: "podcast" };
}

async function cmdAdd(chatId: string, arg: string) {
  if (!arg) {
    await say(chatId, "Использование: <code>/add https://ссылка-на-rss</code>, <code>/add название подкаста</code> или <code>/add ссылка-на-youtube-канал</code>");
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
      await say(chatId, `Уже есть подписка на <b>${esc(feed.title)}</b>`);
      return;
    }
    throw new Error(error.message);
  }
  const latest = feed.episodes[0];
  await say(
    chatId,
    `✅ Подписал: <b>${esc(feed.title)}</b> (#${sub.id}, ${kind === "youtube" ? "YouTube" : "подкаст"})\n` +
      (latest ? `Последний: ${esc(latest.title)} (${fmtDate(latest.pubDate)})\n` : "") +
      `Посмотреть: <code>/last5 ${sub.id}</code>`,
  );
}

async function cmdList(chatId: string) {
  const { data: subs } = await db.from("subscriptions").select("*").order("id");
  if (!subs?.length) {
    await say(chatId, "Подписок пока нет. Добавь: <code>/add joe rogan</code>");
    return;
  }
  const lines = (subs as Sub[]).map((s) => `#${s.id} ${s.kind === "youtube" ? "🎬" : "🎧"} ${esc(s.title ?? s.feed_url)}`);
  await say(chatId, "<b>Подписки:</b>\n" + lines.join("\n"));
}

async function cmdDel(chatId: string, arg: string) {
  const id = Number(arg.replace("#", ""));
  if (!id) {
    await say(chatId, "Использование: <code>/del номер</code> (номер из /list)");
    return;
  }
  const { data } = await db.from("subscriptions").delete().eq("id", id).select();
  await say(
    chatId,
    data?.length ? `Отписал от: ${esc((data[0] as Sub).title ?? (data[0] as Sub).feed_url)}` : `Подписки #${id} нет`,
  );
}

// /latest — карточки эпизодов всех подписок за последние сутки
async function cmdLatestAll(chatId: string) {
  const { data: subs } = await db.from("subscriptions").select("*").order("id");
  if (!subs?.length) {
    await say(chatId, "Подписок пока нет. Добавь: <code>/add joe rogan</code>");
    return;
  }
  const cutoff = Date.now() - DAY_MS;
  let shown = 0;
  for (const sub of subs as Sub[]) {
    try {
      const feed = await fetchFeed(sub.feed_url);
      const picked = await collectEpisodes(
        sub,
        feed.episodes,
        (ep) => (Date.parse(ep.pubDate ?? "") || 0) >= cutoff,
        50,
      );
      // Отправляем старые → новые, чтобы самый свежий оказался внизу
      for (let j = picked.length - 1; j >= 0; j--) {
        await renderCard(chatId, sub, picked[j].ep, feed.title, picked[j].idx);
        shown++;
      }
    } catch (e) {
      console.error(`latest failed for ${sub.feed_url}`, e);
    }
  }
  if (shown === 0) await say(chatId, "За последние сутки новых эпизодов нет");
}

// /last5, /last10 — N последних эпизодов подписки карточками
async function cmdLast(chatId: string, arg: string, n: number) {
  const id = Number(arg.replace("#", ""));
  if (!id) {
    await say(chatId, `Использование: <code>/last${n} номер</code> (номер из /list)`);
    return;
  }
  const { data: sub } = await db.from("subscriptions").select("*").eq("id", id).maybeSingle();
  if (!sub) {
    await say(chatId, `Подписки #${id} нет`);
    return;
  }
  const feed = await fetchFeed((sub as Sub).feed_url);
  const picked = await collectEpisodes(sub as Sub, feed.episodes, () => true, n);
  // Отправляем старые → новые, чтобы самый свежий оказался внизу
  for (let j = picked.length - 1; j >= 0; j--) {
    await renderCard(chatId, sub as Sub, picked[j].ep, feed.title, picked[j].idx);
  }
  if (picked.length === 0) await say(chatId, "В фиде нет эпизодов");
}

// /clear — удаляет сообщения бота в чате (диапазоном id). Подписки и данные не трогает.
// Telegram даёт удалять сообщения бота только за последние 48 часов, остальное молча пропустится.
async function cmdClear(chatId: string, upToMsgId: number) {
  const { data } = await db.from("bot_state").select("value").eq("key", "clear_floor").maybeSingle();
  const floor = Number(data?.value ?? 0);
  const start = Math.max(floor + 1, upToMsgId - 400);
  for (let id = start; id <= upToMsgId; id++) {
    await tg("deleteMessage", { chat_id: chatId, message_id: id }).catch(() => {});
  }
  await db.from("bot_state").upsert({ key: "clear_floor", value: String(upToMsgId) });
}

async function handleCallback(cbq: Record<string, any>) {
  const chatId = String(cbq.message?.chat?.id ?? "");
  const owner = await getOwner();
  const parts = (cbq.data ?? "").split(":");
  const kind = parts[0];
  if (chatId !== owner || !["v", "a", "pd"].includes(kind)) {
    await tg("answerCallbackQuery", { callback_query_id: cbq.id }).catch(() => {});
    return;
  }
  try {
    let note: string;
    if (kind === "v" || kind === "a") {
      const url = `https://www.youtube.com/watch?v=${parts[1]}`;
      await enqueue(kind === "v" ? "yt_video" : "yt_audio", { chat_id: chatId, url });
      note = kind === "v" ? "Качаю видео" : "Качаю аудио";
    } else {
      // pd:<subId>:<idx> — эпизод подкаста
      const { data: sub } = await db.from("subscriptions").select("*").eq("id", Number(parts[1])).maybeSingle();
      if (!sub) throw new Error("подписка удалена");
      const feed = await fetchFeed((sub as Sub).feed_url);
      const ep = feed.episodes[Number(parts[2])];
      if (!ep) throw new Error("эпизод не найден");
      await sendEpisode(chatId, ep, feed.title); // сам решит: сразу или через воркер
      note = "Скачиваю эпизод";
    }
    await tg("answerCallbackQuery", { callback_query_id: cbq.id, text: `${note}…` });
    // Убираем кнопки, чтобы не нажать дважды
    await tg("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: cbq.message.message_id,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
    if (kind !== "pd") await say(chatId, `⏳ ${note} — пришлю файлом, когда скачается`);
  } catch (e) {
    await tg("answerCallbackQuery", { callback_query_id: cbq.id, text: "Ошибка, см. чат" }).catch(() => {});
    await say(chatId, `⚠️ Ошибка: ${esc(String((e as Error).message ?? e))}`).catch(() => {});
  }
}

async function handleUpdate(update: Record<string, any>) {
  const msg = update.message;
  const chatId = String(msg?.chat?.id ?? "");
  const textMsg: string = msg?.text ?? "";
  if (!chatId || !textMsg) return;

  // Личный бот: первый, кто напишет /start, становится владельцем, остальных игнорируем
  const owner = await getOwner();
  if (!owner) {
    if (!textMsg.startsWith("/start")) return;
    await db.from("bot_state").upsert({ key: "owner_chat_id", value: chatId });
    await say(chatId, "Привет! Это твой личный подкаст-бот.\n\n" + HELP);
    return;
  }
  if (chatId !== owner) return;

  const [cmd, ...rest] = textMsg.trim().split(/\s+/);
  const arg = rest.join(" ");
  try {
    switch (cmd.split("@")[0].toLowerCase()) {
      case "/start":
      case "/help":
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
        await say(chatId, "Смотрю эпизоды за сутки…");
        await cmdLatestAll(chatId);
        break;
      case "/last5":
        await cmdLast(chatId, arg, 5);
        break;
      case "/last10":
        await cmdLast(chatId, arg, 10);
        break;
      case "/video":
      case "/audio": {
        if (!/^https?:\/\//i.test(arg)) {
          await say(chatId, `Использование: <code>${cmd} ссылка-на-видео</code>`);
          break;
        }
        await enqueue(cmd === "/video" ? "yt_video" : "yt_audio", { chat_id: chatId, url: arg });
        await say(chatId, "⏳ Взял в работу — пришлю файлом, когда скачается");
        break;
      }
      case "/clear":
        await cmdClear(chatId, msg.message_id);
        break;
      default:
        await say(chatId, "Не понял команду.\n\n" + HELP);
    }
  } catch (e) {
    console.error("command failed", cmd, e);
    await say(chatId, `⚠️ Ошибка: ${esc(String((e as Error).message ?? e))}`).catch(() => {});
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

  if (req.headers.get("x-worker-secret") === WORKER_SECRET) {
    return await workerApi(await req.json());
  }

  return new Response("forbidden", { status: 403 });
});

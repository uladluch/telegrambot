"""Воркер на Railway: забирает задания из очереди (через edge-функцию Supabase),
качает подкасты и YouTube (yt-dlp), делает русскую озвучку (vot-cli + ffmpeg),
заливает в Telegram через self-hosted bot-api (лимит 2 ГБ).
Тексты для пользователя — английские, как и весь интерфейс бота."""

import base64
import html
import json
import os
import pathlib
import re
import subprocess
import tempfile
import threading
import time

import requests

EDGE_URL = os.environ["EDGE_URL"]
WORKER_SECRET = os.environ["WORKER_SECRET"]
BOT_API = os.environ.get("BOT_API_URL", "http://bot-api.railway.internal:8081")
BOT_TOKEN = os.environ["BOT_TOKEN"]
API = f"{BOT_API}/bot{BOT_TOKEN}"
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "30"))
TG_MAX = 1_950_000_000  # self-hosted bot-api пускает до 2000 МБ

# Перевод на серверах Яндекса асинхронный, vot-cli сам поллит — таймаут щедрый.
VOT_TIMEOUT = int(os.environ.get("VOT_TIMEOUT", "1200"))
# Запасной выход, если Яндекс забанит датацентровый IP Railway: прокси для vot-cli
VOT_PROXY = os.environ.get("VOT_PROXY")

COOKIES_PATH = None
if os.environ.get("YT_COOKIES_B64"):
    COOKIES_PATH = "/tmp/cookies.txt"
    pathlib.Path(COOKIES_PATH).write_bytes(base64.b64decode(os.environ["YT_COOKIES_B64"]))
    print("youtube cookies loaded", flush=True)


def edge(action, **kw):
    r = requests.post(
        EDGE_URL,
        json={"action": action, **kw},
        headers={"x-worker-secret": WORKER_SECRET},
        timeout=60,
    )
    r.raise_for_status()
    return r.json()


def tg(method, files=None, timeout=3600, **params):
    r = requests.post(f"{API}/{method}", data=params, files=files, timeout=timeout)
    d = r.json()
    if not d.get("ok"):
        raise RuntimeError(f"{method}: {d.get('description')}")
    return d["result"]


def notify(chat_id, text_html):
    try:
        tg("sendMessage", chat_id=chat_id, text=text_html[:4096], parse_mode="HTML", timeout=60)
    except Exception as e:
        print("notify failed:", e, flush=True)


def safe_name(s, ext):
    s = re.sub(r"[^\w\d .,()\[\]-]+", "", s, flags=re.U).strip() or "file"
    return f"{s[:60]}.{ext}"


def check_size(path):
    size = path.stat().st_size
    if size > TG_MAX:
        raise RuntimeError(f"file is {size // 1024 // 1024} MB — over Telegram's 2 GB limit")
    return size


def react(chat_id, message_id, emoji):
    """Реакция вместо сервисного сообщения — тише в чате. Провал не критичен."""
    try:
        tg("setMessageReaction", chat_id=chat_id, message_id=message_id,
           reaction=json.dumps([{"type": "emoji", "emoji": emoji}]), timeout=30)
    except Exception:
        pass


class ActionPinger:
    """«Отправляет видео…» вверху чата, пока задание выполняется.
    Индикатор Telegram живёт ~5 секунд — шлём заново из фонового потока."""

    def __init__(self, chat_id, action):
        self.chat_id, self.action = chat_id, action
        self._stop = threading.Event()
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        while not self._stop.is_set():
            try:
                tg("sendChatAction", chat_id=self.chat_id, action=self.action, timeout=30)
            except Exception:
                pass
            self._stop.wait(4.5)

    def close(self):
        self._stop.set()


class Status:
    """Одно редактируемое статус-сообщение на задание: живой прогресс без спама.
    Правки не чаще раза в ~8 секунд (лимиты Telegram), в конце сообщение удаляется."""

    def __init__(self, chat_id, text_msg):
        self.chat_id = chat_id
        self.id = None
        self.last_edit = time.time()
        self.last_text = text_msg
        try:
            self.id = tg("sendMessage", chat_id=chat_id, text=text_msg, timeout=60)["message_id"]
        except Exception as e:
            print("status message failed:", e, flush=True)

    def edit(self, text_msg, force=False):
        if not self.id or text_msg == self.last_text:
            return
        now = time.time()
        if not force and now - self.last_edit < 8:
            return
        self.last_edit, self.last_text = now, text_msg
        try:
            tg("editMessageText", chat_id=self.chat_id, message_id=self.id,
               text=text_msg, timeout=30)
        except Exception:
            pass

    def close(self):
        if self.id:
            try:
                tg("deleteMessage", chat_id=self.chat_id, message_id=self.id, timeout=30)
            except Exception:
                pass
            self.id = None


def do_send_audio(p, tmp):
    st = Status(p["chat_id"], "⏳ Downloading episode…")
    try:
        f = tmp / "episode.mp3"
        with requests.get(
            p["url"], stream=True, timeout=(30, 300),
            headers={"User-Agent": "Mozilla/5.0 (personal podcast bot)"},
        ) as r:
            r.raise_for_status()
            total = int(r.headers.get("content-length") or 0)
            done = 0
            with open(f, "wb") as fh:
                for chunk in r.iter_content(1 << 20):
                    fh.write(chunk)
                    done += len(chunk)
                    if total:
                        st.edit(f"⏳ Downloading episode… {done * 100 // total}%")
        check_size(f)
        st.edit("📤 Uploading to Telegram…", force=True)
        with open(f, "rb") as fh:
            tg(
                "sendAudio",
                files={"audio": (safe_name(p.get("title") or "episode", "mp3"), fh)},
                chat_id=p["chat_id"],
                caption=p.get("caption", ""),
                parse_mode="HTML",
                title=p.get("title", ""),
                performer=p.get("performer", ""),
            )
    finally:
        st.close()


# В yt-dlp 2026 решатель YouTube n-challenge вынесен в отдельный EJS-компонент,
# который надо явно разрешить скачать — иначе adaptive-форматы недоступны
# («Only images are available»). Плюс ретраи против периодических HTTP 429.
YT_BASE = [
    "--remote-components", "ejs:github",
    "--extractor-retries", "3",
    "--sleep-requests", "1.5",
]


def run_ytdlp(url, tmp, audio_only, on_progress=None):
    """Качает видео/аудио. on_progress(pct_str) дёргается на каждой строке прогресса."""
    # --print-json включает quiet и глушит прогресс — возвращаем его явным --progress
    cmd = ["yt-dlp", "--no-playlist", "--newline", "--print-json", "--progress",
           "--progress-template", "download:PCT %(progress._percent_str)s",
           *YT_BASE, "-P", str(tmp), "-o", "media.%(ext)s"]
    if COOKIES_PATH:
        cmd += ["--cookies", COOKIES_PATH]
    if audio_only:
        cmd += ["-f", "bestaudio[ext=m4a]/bestaudio", "-x", "--audio-format", "m4a"]
    else:
        # Telegram проигрывает inline только H.264 (avc1) + AAC (m4a); AV1/VP9/Opus
        # он показывает статичным первым кадром без плеера — поэтому предпочитаем avc1.
        # faststart двигает moov-атом в начало файла, иначе нет потокового воспроизведения.
        cmd += ["-f", "bv*[height<=?720][vcodec^=avc1]+ba[ext=m4a]/"
                      "b[height<=?720][vcodec^=avc1]/bv*[height<=?720]+ba/b",
                "--merge-output-format", "mp4",
                "--postprocessor-args", "ffmpeg:-movflags +faststart"]
    cmd.append(url)

    # stderr сливаем в stdout: прогресс, JSON с метаданными и ошибки разбираем построчно
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    info_line, tail = None, []
    for line in proc.stdout:
        line = line.rstrip("\n")
        tail.append(line)
        if len(tail) > 40:
            tail.pop(0)
        if line.startswith("{"):
            info_line = line
        elif line.startswith("PCT") and on_progress:
            on_progress(line[3:].strip())
    proc.wait()

    if proc.returncode != 0 or not info_line:
        out_tail = "\n".join(tail)
        print("yt-dlp output tail:\n" + out_tail[-2500:], flush=True)
        if "Sign in to confirm" in out_tail:
            raise RuntimeError(
                "🍪 YouTube cookies expired — run scripts/dia_cookies.py on the Mac "
                "and update YT_COOKIES_B64 on Railway"
            )
        last = next((ln for ln in reversed(tail) if ln.strip()), "yt-dlp failed")
        raise RuntimeError(last.strip()[:400])

    info = json.loads(info_line)
    files = [f for f in tmp.iterdir() if f.name.startswith("media.")]
    if not files:
        raise RuntimeError("yt-dlp left no file behind")
    return info, files[0]


def fmt_chapters(info, limit):
    """Таймкоды глав для подписи — Telegram делает их кликабельными у видео/аудио."""
    lines = []
    for c in info.get("chapters") or []:
        t = int(c.get("start_time") or 0)
        h, m, s = t // 3600, t % 3600 // 60, t % 60
        stamp = f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"
        title = html.escape(str(c.get("title") or "").strip())
        if title:
            lines.append(f"{stamp} {title}")
    out = ""
    for ln in lines:
        if len(out) + len(ln) + 1 > limit:
            break
        out += ("\n" if out else "") + ln
    return out


def yt_caption(p, info, extra=""):
    if p.get("caption"):
        base = p["caption"]
    else:
        title = html.escape(info.get("title") or "video")
        channel = html.escape(info.get("channel") or info.get("uploader") or "")
        page = info.get("webpage_url") or p["url"]
        base = f"<b>{title}</b>\n{channel}\n<a href=\"{page}\">YouTube</a>"
    if extra:
        base += "\n" + extra
    # Главы добиваем в остаток лимита подписи (1024), не ломая HTML усечением
    budget = 1024 - len(base) - 2
    if budget > 60:
        chapters = fmt_chapters(info, budget)
        if chapters:
            base += "\n\n" + chapters
    return base[:1024]


def do_youtube(p, tmp, audio_only):
    st = Status(p["chat_id"], "⏳ Preparing download…")
    try:
        info, f = run_ytdlp(p["url"], tmp, audio_only,
                            on_progress=lambda pct: st.edit(f"⏳ Downloading… {pct}"))
        # Видео не влезло в лимит — автоматически падаем на аудио
        if not audio_only and f.stat().st_size > TG_MAX:
            notify(p["chat_id"], "⚠️ Video is over 2 GB — sending audio only")
            for old in tmp.iterdir():
                old.unlink()
            info, f = run_ytdlp(p["url"], tmp, audio_only=True,
                                on_progress=lambda pct: st.edit(f"⏳ Downloading audio… {pct}"))
        check_size(f)
        cap = yt_caption(p, info)
        title = (info.get("title") or "video")[:64]
        channel = (info.get("channel") or info.get("uploader") or "")[:64]
        st.edit("📤 Uploading to Telegram…", force=True)
        with open(f, "rb") as fh:
            if audio_only or f.suffix == ".m4a":
                tg("sendAudio", files={"audio": (safe_name(title, "m4a"), fh)},
                   chat_id=p["chat_id"], caption=cap, parse_mode="HTML",
                   title=title, performer=channel,
                   duration=int(info.get("duration") or 0))
            else:
                tg("sendVideo", files={"video": (safe_name(title, "mp4"), fh)},
                   chat_id=p["chat_id"], caption=cap, parse_mode="HTML",
                   supports_streaming="true",
                   duration=int(info.get("duration") or 0),
                   width=int(info.get("width") or 0), height=int(info.get("height") or 0))
    finally:
        st.close()


# ---------- Русская закадровая озвучка (Яндекс, через vot-cli) ----------
# vot-cli дёргает приватный API «Яндекс.Перевода видео» (тот же, что в Яндекс.Браузере)
# и отдаёт русскую аудиодорожку mp3.

def probe_duration(path):
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, timeout=60,
        )
        return int(float(out.stdout.strip()))
    except Exception:
        return 0


def ytdlp_meta(url):
    """Только метаданные видео (без скачивания) — для подписи русского аудио."""
    cmd = ["yt-dlp", "--no-playlist", "--skip-download", "--dump-json", *YT_BASE]
    if COOKIES_PATH:
        cmd += ["--cookies", COOKIES_PATH]
    cmd.append(url)
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if out.returncode == 0 and out.stdout.strip():
            return json.loads(out.stdout.splitlines()[0])
    except Exception as e:
        print("ytdlp_meta failed:", e, flush=True)
    return {}


def vot_cmd(extra, tmp):
    cmd = ["vot-cli", *extra, "--outdir", str(tmp)]
    if VOT_PROXY:
        cmd += ["--proxy", VOT_PROXY]
    return cmd


def vot_translate_audio(url, tmp, src_lang="auto"):
    """Скачивает русскую закадровую дорожку (mp3) через Яндекс. Возвращает путь к файлу."""
    before = {f.name for f in tmp.glob("*.mp3")}
    cmd = vot_cmd(["--json", "--no-title", "--lang", src_lang, "--reslang", "ru"], tmp)
    cmd.append(url)
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=VOT_TIMEOUT)
    # при --json результат печатается одной JSON-строкой (в stderr либо stdout)
    data = None
    for line in reversed((out.stderr + "\n" + out.stdout).splitlines()):
        s = line.strip()
        if s.startswith("{") and s.endswith("}"):
            try:
                data = json.loads(s)
                break
            except Exception:
                continue
    if not (data and data.get("ok")):
        print("vot-cli stderr:\n" + (out.stderr or "")[-1500:], flush=True)
        raise RuntimeError(
            "Yandex couldn't translate this video — the source language may be "
            "unsupported, the video may be too long, or the translation is still "
            "being prepared. Try again in a few minutes."
        )
    res = (data.get("results") or [{}])[0]
    path = res.get("outputPath")
    if path and pathlib.Path(path).exists():
        return pathlib.Path(path)
    # фолбэк: ищем новый mp3, появившийся в папке
    fresh = [f for f in tmp.glob("*.mp3") if f.name not in before]
    if fresh:
        return fresh[0]
    raise RuntimeError("translation finished but no audio file was found")


def mux_ru(video_path, ru_path, out_path, orig_volume=0.15):
    """Кладёт русскую дорожку поверх приглушённого оригинала (как в Яндекс.Браузере)."""
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(video_path), "-i", str(ru_path),
         "-filter_complex",
         f"[0:a]volume={orig_volume}[a0];[1:a]volume=1.0[a1];"
         "[a0][a1]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]",
         "-map", "0:v", "-map", "[aout]",
         "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
         "-movflags", "+faststart", str(out_path)],
        check=True, capture_output=True,
    )


RU_TAG = "🔊 Russian voice-over (Yandex)"


def do_youtube_audio_ru(p, tmp):
    st = Status(p["chat_id"], "🔊 Requesting Russian voice-over from Yandex… this may take a few minutes")
    try:
        ru = vot_translate_audio(p["url"], tmp, p.get("lang", "auto"))
        check_size(ru)
        info = ytdlp_meta(p["url"])
        cap = yt_caption(p, info, extra=RU_TAG)
        title = (info.get("title") or "audio")[:64]
        channel = (info.get("channel") or info.get("uploader") or "")[:64]
        st.edit("📤 Uploading to Telegram…", force=True)
        with open(ru, "rb") as fh:
            tg("sendAudio", files={"audio": (safe_name(title, "mp3"), fh)},
               chat_id=p["chat_id"], caption=cap, parse_mode="HTML",
               title=title, performer=channel,
               duration=int(info.get("duration") or probe_duration(ru)))
    finally:
        st.close()


def do_youtube_video_ru(p, tmp):
    st = Status(p["chat_id"], "⏳ Downloading video…")
    try:
        info, vf = run_ytdlp(p["url"], tmp, audio_only=False,
                             on_progress=lambda pct: st.edit(f"⏳ Downloading video… {pct}"))
        st.edit("🔊 Requesting Russian voice-over from Yandex… this may take a few minutes", force=True)
        ru = vot_translate_audio(p["url"], tmp, p.get("lang", "auto"))
        st.edit("🎛 Mixing the Russian track into the video…", force=True)
        title = (info.get("title") or "video")[:64]
        channel = (info.get("channel") or info.get("uploader") or "")[:64]
        cap = yt_caption(p, info, extra=RU_TAG)
        out = tmp / "ru_video.mp4"
        mux_ru(vf, ru, out)
        # Видео с озвучкой не влезло в лимит — пришлём хотя бы русское аудио
        if out.stat().st_size > TG_MAX:
            notify(p["chat_id"], "⚠️ Dubbed video is over 2 GB — sending the Russian audio track only")
            check_size(ru)
            st.edit("📤 Uploading to Telegram…", force=True)
            with open(ru, "rb") as fh:
                tg("sendAudio", files={"audio": (safe_name(title, "mp3"), fh)},
                   chat_id=p["chat_id"], caption=cap, parse_mode="HTML",
                   title=title, performer=channel,
                   duration=int(info.get("duration") or probe_duration(ru)))
            return
        check_size(out)
        st.edit("📤 Uploading to Telegram…", force=True)
        with open(out, "rb") as fh:
            tg("sendVideo", files={"video": (safe_name(title, "mp4"), fh)},
               chat_id=p["chat_id"], caption=cap, parse_mode="HTML",
               supports_streaming="true",
               duration=int(info.get("duration") or 0),
               width=int(info.get("width") or 0), height=int(info.get("height") or 0))
    finally:
        st.close()


def do_youtube_subs(p, tmp):
    """Субтитры: сперва русский перевод через vot-cli, не вышло — родные/авто через yt-dlp."""
    st = Status(p["chat_id"], "📝 Fetching subtitles…")
    try:
        srt, label = None, ""
        cmd = vot_cmd(["--subs", "--subs-format=srt", "--reslang", "ru"], tmp)
        cmd.append(p["url"])
        try:
            subprocess.run(cmd, capture_output=True, text=True, timeout=600)
            files = sorted(tmp.glob("*.srt"))
            if files:
                srt, label = files[0], "Russian, Yandex translate"
        except Exception as e:
            print("vot subs failed:", e, flush=True)

        if not srt:
            cmd = ["yt-dlp", "--skip-download", "--no-playlist",
                   "--write-subs", "--write-auto-subs",
                   "--sub-langs", "en.*,ru.*", "--convert-subs", "srt",
                   *YT_BASE, "-P", str(tmp), "-o", "subs.%(ext)s"]
            if COOKIES_PATH:
                cmd += ["--cookies", COOKIES_PATH]
            cmd.append(p["url"])
            subprocess.run(cmd, capture_output=True, text=True, timeout=600)
            files = sorted(tmp.glob("subs*.srt"))
            if files:
                srt, label = files[0], "original"

        if not srt:
            raise RuntimeError("no subtitles available for this video")

        info = ytdlp_meta(p["url"])
        title = (info.get("title") or "subtitles")[:60]
        with open(srt, "rb") as fh:
            tg("sendDocument", files={"document": (safe_name(title, "srt"), fh)},
               chat_id=p["chat_id"], caption=f"📝 Subtitles ({label})")
    finally:
        st.close()


HANDLERS = {
    "send_audio": lambda p, tmp: do_send_audio(p, tmp),
    "yt_video": lambda p, tmp: do_youtube(p, tmp, audio_only=False),
    "yt_audio": lambda p, tmp: do_youtube(p, tmp, audio_only=True),
    "yt_video_ru": lambda p, tmp: do_youtube_video_ru(p, tmp),
    "yt_audio_ru": lambda p, tmp: do_youtube_audio_ru(p, tmp),
    "yt_subs": lambda p, tmp: do_youtube_subs(p, tmp),
}


def main():
    try:
        dv = subprocess.run(["deno", "--version"], capture_output=True, text=True).stdout.splitlines()[:1]
        print(f"deno: {dv}", flush=True)
    except Exception as e:
        print(f"deno missing: {e}", flush=True)
    print(f"worker started, bot-api: {BOT_API}", flush=True)
    while True:
        try:
            job = edge("claim").get("job")
        except Exception as e:
            print("claim failed:", e, flush=True)
            time.sleep(POLL_SECONDS)
            continue
        if not job:
            time.sleep(POLL_SECONDS)
            continue

        p = job["payload"]
        print(f"job {job['id']} ({job['type']}): {p.get('url', '')[:120]}", flush=True)
        # «Отправляет видео/файл…» вверху чата на всё время задания
        action = "upload_video" if job["type"] in ("yt_video", "yt_video_ru") else "upload_document"
        pinger = ActionPinger(p["chat_id"], action) if p.get("chat_id") else None
        ok, err = True, None
        try:
            handler = HANDLERS.get(job["type"])
            if not handler:
                raise RuntimeError(f"unknown job type: {job['type']}")
            with tempfile.TemporaryDirectory() as td:
                handler(p, pathlib.Path(td))
        except Exception as e:
            ok, err = False, str(e)[:500]
            print(f"job {job['id']} failed: {err}", flush=True)
            fallback = f'\n<a href="{p["url"]}">Source link</a>' if p.get("url") else ""
            notify(p.get("chat_id"), f"⚠️ Failed: {html.escape(err)}{fallback}")
            # 👀 «принял» на исходном сообщении меняем на 😢
            if p.get("ack_message_id"):
                react(p.get("chat_id"), p["ack_message_id"], "😢")
        else:
            print(f"job {job['id']} done", flush=True)
            # 👀 → 👍: файл отправлен
            if p.get("ack_message_id"):
                react(p.get("chat_id"), p["ack_message_id"], "👍")
        finally:
            if pinger:
                pinger.close()

        try:
            edge("complete", id=job["id"], ok=ok, error=err)
        except Exception as e:
            print("complete failed:", e, flush=True)


if __name__ == "__main__":
    main()

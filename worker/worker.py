"""Воркер на Railway: забирает задания из очереди (через edge-функцию Supabase),
качает большие подкасты (curl) и YouTube (yt-dlp), заливает в Telegram
через self-hosted bot-api (лимит 2 ГБ)."""

import base64
import html
import json
import os
import pathlib
import re
import subprocess
import tempfile
import time

import requests

EDGE_URL = os.environ["EDGE_URL"]
WORKER_SECRET = os.environ["WORKER_SECRET"]
BOT_API = os.environ.get("BOT_API_URL", "http://bot-api.railway.internal:8081")
BOT_TOKEN = os.environ["BOT_TOKEN"]
API = f"{BOT_API}/bot{BOT_TOKEN}"
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "30"))
TG_MAX = 1_950_000_000  # self-hosted bot-api пускает до 2000 МБ

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
        raise RuntimeError(f"файл {size // 1024 // 1024} МБ — больше лимита Telegram 2 ГБ")
    return size


def do_send_audio(p, tmp):
    f = tmp / "episode.mp3"
    subprocess.run(
        ["curl", "-fSL", "--max-time", "3000", "-A", "Mozilla/5.0 (personal podcast bot)",
         "-o", str(f), p["url"]],
        check=True, capture_output=True,
    )
    check_size(f)
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


# В yt-dlp 2026 решатель YouTube n-challenge вынесен в отдельный EJS-компонент,
# который надо явно разрешить скачать — иначе adaptive-форматы недоступны
# («Only images are available»). Плюс ретраи против периодических HTTP 429.
YT_BASE = [
    "--remote-components", "ejs:github",
    "--extractor-retries", "3",
    "--sleep-requests", "1.5",
]


def run_ytdlp(url, tmp, audio_only):
    cmd = ["yt-dlp", "--no-playlist", "--no-progress", "--print-json", *YT_BASE,
           "-P", str(tmp), "-o", "media.%(ext)s"]
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
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        print("yt-dlp stderr:\n" + (out.stderr or "")[-2500:], flush=True)
        tail = (out.stderr or "yt-dlp failed").strip().splitlines()[-1]
        raise RuntimeError(tail[:400])
    info = json.loads(out.stdout.splitlines()[0])
    files = [f for f in tmp.iterdir() if f.name.startswith("media.")]
    if not files:
        raise RuntimeError("yt-dlp не оставил файла")
    return info, files[0]


def yt_caption(p, info):
    if p.get("caption"):
        return p["caption"]
    title = html.escape(info.get("title") or "видео")
    channel = html.escape(info.get("channel") or info.get("uploader") or "")
    page = info.get("webpage_url") or p["url"]
    return f"<b>{title}</b>\n{channel}\n<a href=\"{page}\">YouTube</a>"[:1024]


def do_youtube(p, tmp, audio_only):
    info, f = run_ytdlp(p["url"], tmp, audio_only)
    # Видео не влезло в лимит — автоматически падаем на аудио
    if not audio_only and f.stat().st_size > TG_MAX:
        notify(p["chat_id"], "⚠️ Видео больше 2 ГБ — пришлю только аудио")
        for old in tmp.iterdir():
            old.unlink()
        info, f = run_ytdlp(p["url"], tmp, audio_only=True)
    check_size(f)
    cap = yt_caption(p, info)
    title = (info.get("title") or "video")[:64]
    channel = (info.get("channel") or info.get("uploader") or "")[:64]
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


HANDLERS = {
    "send_audio": lambda p, tmp: do_send_audio(p, tmp),
    "yt_video": lambda p, tmp: do_youtube(p, tmp, audio_only=False),
    "yt_audio": lambda p, tmp: do_youtube(p, tmp, audio_only=True),
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
        ok, err = True, None
        try:
            handler = HANDLERS.get(job["type"])
            if not handler:
                raise RuntimeError(f"неизвестный тип задания: {job['type']}")
            with tempfile.TemporaryDirectory() as td:
                handler(p, pathlib.Path(td))
        except Exception as e:
            ok, err = False, str(e)[:500]
            print(f"job {job['id']} failed: {err}", flush=True)
            fallback = f'\n<a href="{p["url"]}">Ссылка из задания</a>' if p.get("url") else ""
            notify(p.get("chat_id"), f"⚠️ Не получилось: {html.escape(err)}{fallback}")
        else:
            print(f"job {job['id']} done", flush=True)

        try:
            edge("complete", id=job["id"], ok=ok, error=err)
        except Exception as e:
            print("complete failed:", e, flush=True)


if __name__ == "__main__":
    main()

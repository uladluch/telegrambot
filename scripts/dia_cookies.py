"""Расшифровка cookies браузера Dia (Chromium) в формат Netscape cookies.txt.
Ключ шифрования берётся из macOS Keychain (запись "Dia Safe Storage")."""

import glob
import hashlib
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile

from Crypto.Cipher import AES

HOME = os.path.expanduser("~")
UD = f"{HOME}/Library/Application Support/Dia/User Data"
OUT = sys.argv[1] if len(sys.argv) > 1 else "dia_youtube_cookies.txt"

password = subprocess.check_output(
    ["security", "find-generic-password", "-w", "-s", "Dia Safe Storage"]
).strip()
key = hashlib.pbkdf2_hmac("sha1", password, b"saltysalt", 1003, 16)


def decrypt(value):
    if not value or value[:3] != b"v10":
        return None
    cipher = AES.new(key, AES.MODE_CBC, IV=b" " * 16)
    dec = cipher.decrypt(value[3:])
    dec = dec[: -dec[-1]]  # снять PKCS7 padding
    # Chrome 24+ добавляет 32-байтовый SHA256-префикс домена — отбрасываем, если он есть
    try:
        return dec.decode("utf-8")
    except UnicodeDecodeError:
        return dec[32:].decode("utf-8", "ignore")


rows_out = []
seen = set()
for cookies_db in glob.glob(f"{UD}/*/Cookies"):
    tmp = tempfile.mktemp(suffix=".db")
    shutil.copy(cookies_db, tmp)
    con = sqlite3.connect(tmp)
    for host, name, enc, path, expires, secure in con.execute(
        "select host_key, name, encrypted_value, path, expires_utc, is_secure "
        "from cookies where host_key like '%youtube.com%' or host_key like '%google.com%'"
    ):
        val = decrypt(enc)
        if val is None:
            continue
        dedup = (host, name, path)
        if dedup in seen:
            continue
        seen.add(dedup)
        # Chromium expires_utc — микросекунды с 1601-01-01; конвертируем в unix
        exp = max(0, expires // 1_000_000 - 11_644_473_600) if expires else 0
        rows_out.append(
            "\t".join([
                host,
                "TRUE" if host.startswith(".") else "FALSE",
                path,
                "TRUE" if secure else "FALSE",
                str(exp),
                name,
                val,
            ])
        )
    con.close()
    os.remove(tmp)

with open(OUT, "w") as f:
    f.write("# Netscape HTTP Cookie File\n")
    f.write("\n".join(rows_out) + "\n")

print(f"wrote {len(rows_out)} cookies to {OUT}")

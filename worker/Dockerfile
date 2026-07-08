FROM python:3.12-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates unzip gnupg \
    && rm -rf /var/lib/apt/lists/*
# Node 22 + vot-cli — русская закадровая озвучка через Яндекс (vot-cli требует Node 22+)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g vot-cli \
    && vot-cli --version \
    && rm -rf /var/lib/apt/lists/*
# Deno нужен yt-dlp для решения JS-challenge YouTube (иначе «Requested format is not available»)
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh
RUN pip install --no-cache-dir yt-dlp requests realtime
WORKDIR /app
COPY worker/worker.py .
CMD ["python", "-u", "worker.py"]

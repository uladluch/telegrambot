FROM python:3.12-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*
# Deno нужен yt-dlp для решения JS-challenge YouTube (иначе «Requested format is not available»)
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh
RUN pip install --no-cache-dir yt-dlp requests
WORKDIR /app
COPY worker/worker.py .
CMD ["python", "-u", "worker.py"]

# Keep the standalone C++ CLI: PiperHost uses its persistent JSONL protocol.
FROM node:24-bookworm-slim AS piper
ARG TARGETARCH
COPY scripts/install-piper.sh /tmp/install-piper.sh
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && sh /tmp/install-piper.sh "$TARGETARCH" \
    && rm -rf /var/lib/apt/lists/*

FROM node:24-bookworm-slim AS build
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=5000
ENV LINGUALOOP_STT_ENABLED=true \
    LINGUALOOP_STT_START_MODE=managed \
    LINGUALOOP_STT_SERVER_URL=http://127.0.0.1:8080 \
    LINGUALOOP_STT_PORT=8080 \
    LINGUALOOP_STT_MODEL=base.en \
    LINGUALOOP_STT_CPU_THREADS=4 \
    LINGUALOOP_STT_PYTHON=/opt/lingualoop-stt/bin/python \
    HF_HOME=/models/huggingface \
    LANGUAGE_PRACTICE_FFMPEG_PATH=/usr/local/bin/ffmpeg
WORKDIR /app

# Keep the same CPU-only INT8/VAD Whisper runtime in Docker as in local dev.
COPY stt-requirements.txt /tmp/stt-requirements.txt
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv \
    && python3 -m venv /opt/lingualoop-stt \
    && /opt/lingualoop-stt/bin/pip install --no-cache-dir -r /tmp/stt-requirements.txt \
    && ln -s "$(/opt/lingualoop-stt/bin/python -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())')" /usr/local/bin/ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
ENV LANGUAGE_PRACTICE_PIPER_PATH=/opt/piper/piper
COPY --from=piper /opt/piper /opt/piper
# Verify the executable and its bundled shared libraries in the final image.
RUN /opt/piper/piper --help >/dev/null 2>&1
COPY db/migrations ./db/migrations
COPY scripts/whisper-stt-server.py ./scripts/whisper-stt-server.py
COPY scripts/piper-smoke.cjs ./scripts/piper-smoke.cjs
VOLUME ["/models"]

EXPOSE 5000
CMD ["node", "dist/main.js"]

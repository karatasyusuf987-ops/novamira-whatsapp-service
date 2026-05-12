# Production Dockerfile (alternative to nixpacks; works on Render, Fly.io,
# DigitalOcean App Platform, any Docker host).
FROM node:20-slim

# Install Chromium + fonts so puppeteer can launch headless Chrome.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    libnss3 \
    libxss1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libgbm1 \
    libgtk-3-0 \
    wget \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Install deps first (better layer caching)
COPY package.json yarn.lock* package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# App code
COPY . .

# Persistent volume mount target for whatsapp-web.js LocalAuth session.
# Map this to your platform's persistent volume so the QR doesn't reset on every redeploy.
ENV SESSION_PATH=/data/.wwebjs_auth
RUN mkdir -p /data/.wwebjs_auth

EXPOSE 3000
CMD ["node", "index.js"]

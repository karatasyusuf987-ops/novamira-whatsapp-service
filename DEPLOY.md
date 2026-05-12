# whatsapp-service deploy guide

This Node.js bridge runs `whatsapp-web.js` and exposes a tiny HTTP API the
main app calls (`/status`, `/qr-image`, `/send`, `/send-media`, `/chats`,
`/logout`). One Node service = one paired WhatsApp account.

## Endpoints

| Path             | Method | Purpose                                                 |
| ---------------- | ------ | ------------------------------------------------------- |
| `/`              | GET    | Plain-text health (`WhatsApp servis çalışıyor ✅`)       |
| `/health`        | GET    | JSON health (use this for platform health checks)       |
| `/status`        | GET    | `{ status, qr, info }` — what the dashboard polls       |
| `/qr-image`      | GET    | Browser-renderable PNG QR (open this URL on your phone) |
| `/qr`            | GET    | `{ qr, status }` JSON variant                           |
| `/send`          | POST   | `{ to, text }` — sends a text message                   |
| `/send-media`    | POST   | `{ to, file_url, caption }` — downloads & forwards media|
| `/chats`         | GET    | List of WhatsApp chats (top 50)                         |
| `/logout`        | POST   | Logs out the session and re-initializes (new QR)        |

## Required environment variables

| Var                    | Required | Default                                              |
| ---------------------- | -------- | ---------------------------------------------------- |
| `BACKEND_WEBHOOK_URL`  | yes      | `http://localhost:8001/api/whatsapp/webhook`         |
| `BACKEND_BASE_URL`     | yes      | `http://localhost:8001`                              |
| `PORT`                 | optional | `3002` (Railway/Render set this automatically)       |
| `SESSION_PATH`         | optional | `/app/.wwebjs_auth` — point at a persistent volume!  |
| `PUPPETEER_EXECUTABLE_PATH` | optional | auto-detected (`/usr/bin/chromium` etc.)         |

For your production at https://www.novamiraplatform.com, set:

```
BACKEND_WEBHOOK_URL=https://www.novamiraplatform.com/api/whatsapp/webhook
BACKEND_BASE_URL=https://www.novamiraplatform.com
```

## Deploying

### Option A — Railway (easiest, ~3 min)

1. https://railway.com → **New Project → Deploy from GitHub repo** → pick
   `karatasyusuf987-ops/whatsapp-service`.
2. Railway detects Node + reads `nixpacks.toml`; Chromium installs automatically.
3. **Settings → Variables** → add the two `BACKEND_*` env vars above.
4. **Settings → Volumes** → add a 1 GB volume mounted at `/data` and set
   `SESSION_PATH=/data/.wwebjs_auth` (otherwise QR resets on every redeploy).
5. **Settings → Networking → Generate Domain** → you get
   `https://<random>.up.railway.app`.
6. Open `https://<random>.up.railway.app/qr-image` on your phone → scan with
   WhatsApp Business → **Bağlı cihazlar → Cihaz bağla**.
7. In the dashboard go to *Entegrasyonlar → WhatsApp Bağlantı Servisi*, paste
   the Railway URL, **Test Et → Kaydet**.

### Option B — Render.com (also easy, persistent disk built in)

1. Push the repo to GitHub (you already did).
2. https://render.com → **New → Blueprint** → connect repo → Render reads
   `render.yaml` and provisions everything (including the 1 GB disk for
   sessions).
3. After deploy, public URL appears. Visit `/qr-image`, scan, paste URL into
   the dashboard.

### Option C — VPS with Docker

```bash
git clone https://github.com/karatasyusuf987-ops/whatsapp-service.git
cd whatsapp-service
docker build -t wa-service .
docker run -d \
  --name wa-service \
  --restart unless-stopped \
  -p 3000:3000 \
  -v /var/lib/wa-service:/data \
  -e PORT=3000 \
  -e BACKEND_WEBHOOK_URL=https://www.novamiraplatform.com/api/whatsapp/webhook \
  -e BACKEND_BASE_URL=https://www.novamiraplatform.com \
  -e SESSION_PATH=/data/.wwebjs_auth \
  wa-service
```

Then expose port 3000 via Caddy / nginx with a TLS cert.

## Common issues

- **`Failed to launch the browser process` / `No such file or directory: chromium`**
  Means Chromium wasn't installed. On Railway, ensure `nixpacks.toml` is in the
  repo root. On Docker, rebuild with the Dockerfile.
- **QR resets after every deploy** — you didn't mount a persistent volume.
  Configure `SESSION_PATH` to point at the volume.
- **Webhook 404 in logs** — backend webhook endpoint moved or the URL is
  wrong. Service still runs; fix `BACKEND_WEBHOOK_URL` and redeploy.
- **`client_not_ready` from /send** — scan the QR first.

// WA Business Hub — whatsapp-web.js bridge
//
// Backend (FastAPI) → /api/whatsapp/{send,send-media,logout,sync-chats}
//   relay through this Node service which keeps the WhatsApp session alive.
// Incoming messages → POST {BACKEND_WEBHOOK_URL}/message  (so the backend
//   stores them, runs AI auto-reply with the office's system_prompt, etc.)
// Lifecycle events → POST {BACKEND_WEBHOOK_URL}/{ready,authenticated,
//   disconnected,qr}.
//
// Production deploy notes:
//   • Set BACKEND_WEBHOOK_URL to your public dashboard URL +/api/whatsapp/webhook
//   • Set BACKEND_BASE_URL the same dashboard URL (used to download files for /send-media)
//   • Mount a persistent volume at /data and set SESSION_PATH=/data/.wwebjs_auth
//   • PORT auto-picked from env (Railway/Render); fallback 3002 for local

const express = require("express");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const axios = require("axios");
const fs = require("fs");

const PORT = parseInt(
  process.env.PORT || process.env.WA_SERVICE_PORT || "3002",
  10,
);
const BACKEND_WEBHOOK_URL =
  process.env.BACKEND_WEBHOOK_URL ||
  "http://localhost:8001/api/whatsapp/webhook";
const BACKEND_BASE_URL =
  process.env.BACKEND_BASE_URL || "http://localhost:8001";

function detectChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const p of [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ]) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return undefined;
}
const CHROME_PATH = detectChromePath();
const SESSION_PATH = process.env.SESSION_PATH || "/app/.wwebjs_auth";

const app = express();
app.use(express.json({ limit: "20mb" }));

let currentQr = null;          // raw QR string (used for /qr-image PNG render)
let currentQrDataUrl = null;   // data:image/png;base64,... — what the dashboard expects
let status = "initializing";
let clientInfo = null;

// Track message IDs we sent ourselves via /send and /send-media, so the
// `message_create` event doesn't double-deliver them. The backend already
// stores those messages directly when /send returns 200 — re-sending them
// through the webhook would create a duplicate chat row (because the same
// person can have @lid/@c.us address variants).
const ourOutgoingIds = new Set();
function rememberOurMessage(id) {
  if (!id) return;
  ourOutgoingIds.add(id);
  // Auto-expire after 5 min so the Set doesn't grow forever
  setTimeout(() => ourOutgoingIds.delete(id), 5 * 60 * 1000);
}

// `message_create` fires SYNCHRONOUSLY inside client.sendMessage(), before
// that promise resolves and we have a chance to call rememberOurMessage().
// To close that race window we ALSO match outgoing messages by their
// (recipient address, body) signature. The signature is registered the
// instant we receive the HTTP request, so message_create can find it.
const recentOutgoingSigs = []; // [{to, body, expiresAt}]
function rememberOurSignature(to, body) {
  if (!to || typeof body !== "string") return;
  const expiresAt = Date.now() + 60_000;
  recentOutgoingSigs.push({ to, body, expiresAt });
  if (recentOutgoingSigs.length > 200) recentOutgoingSigs.shift();
}
function consumeMatchingSignature(toAddrCandidates, body) {
  // Returns true (and removes the entry) if any candidate (to, body) matches.
  // We try all candidates because whatsapp-web.js may normalize @lid → @c.us
  // (or vice-versa) between our /send call and the message_create event.
  const now = Date.now();
  for (let i = recentOutgoingSigs.length - 1; i >= 0; i--) {
    const s = recentOutgoingSigs[i];
    if (s.expiresAt < now) {
      recentOutgoingSigs.splice(i, 1);
      continue;
    }
    if (s.body === body && toAddrCandidates.includes(s.to)) {
      recentOutgoingSigs.splice(i, 1);
      return true;
    }
  }
  return false;
}

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "wa-hub",
    dataPath: SESSION_PATH,
  }),
  // Stops the WhatsApp Web HTML manifest crash on recent versions.
  webVersionCache: { type: "none" },
  puppeteer: {
    headless: true,
    ...(CHROME_PATH ? { executablePath: CHROME_PATH } : {}),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
    ],
  },
});

async function postWebhook(event, payload) {
  try {
    await axios.post(`${BACKEND_WEBHOOK_URL}/${event}`, payload, { timeout: 15000 });
  } catch (err) {
    const code = err.response?.status;
    if (code === 404) {
      console.warn(`[webhook:${event}] 404 — backend webhook endpoint missing at ${BACKEND_WEBHOOK_URL}/${event}; ignoring`);
    } else {
      console.error(`[webhook:${event}] ${code || ""} ${err.message}`);
    }
  }
}

// -------------------- WhatsApp client lifecycle --------------------

client.on("qr", async (qr) => {
  status = "qr";
  currentQr = qr;
  try {
    currentQrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 480 });
  } catch (e) {
    currentQrDataUrl = null;
  }
  clientInfo = null;
  console.log("[wa] QR received");
  await postWebhook("qr", { qr: currentQrDataUrl });
});

client.on("authenticated", () => {
  status = "authenticated";
  console.log("[wa] authenticated");
  postWebhook("authenticated", {});
});

client.on("ready", async () => {
  status = "ready";
  currentQr = null;
  currentQrDataUrl = null;
  try {
    clientInfo = {
      wid: client.info?.wid?._serialized || null,
      pushname: client.info?.pushname || null,
      platform: client.info?.platform || null,
    };
  } catch (_) {
    clientInfo = null;
  }
  console.log("[wa] ready", clientInfo);
  await postWebhook("ready", { info: clientInfo });
});

client.on("disconnected", async (reason) => {
  status = "disconnected";
  clientInfo = null;
  console.log("[wa] disconnected:", reason);
  await postWebhook("disconnected", { reason: String(reason) });
});

client.on("auth_failure", async (msg) => {
  status = "auth_failure";
  console.warn("[wa] auth_failure:", msg);
  await postWebhook("auth_failure", { message: String(msg) });
});

// -------------------- Incoming messages --------------------

async function buildMessagePayload(msg, fromMe) {
  // Resolve chat metadata (name, group flag, profile pic, phone)
  let chatName = null;
  let isGroup = false;
  let profilePic = null;
  try {
    const chat = await msg.getChat();
    chatName = chat?.name || null;
    isGroup = !!chat?.isGroup;
  } catch (_) {}

  let contactName = null;
  let phone = null;
  try {
    const contact = await msg.getContact();
    contactName = contact?.pushname || contact?.name || contact?.number || null;
    phone = contact?.number || null;
  } catch (_) {}

  // Media: download and forward to backend storage so it survives Node restart
  let mediaUrl = null;
  let mediaKind = null;
  if (msg.hasMedia) {
    try {
      const media = await msg.downloadMedia();
      if (media) {
        const buf = Buffer.from(media.data, "base64");
        const ext = (media.mimetype || "application/octet-stream").split("/")[1]?.split(";")[0] || "bin";
        const formData = new (require("form-data"))();
        formData.append("file", buf, { filename: `${msg.id?._serialized || Date.now()}.${ext}`, contentType: media.mimetype });
        const r = await axios.post(`${BACKEND_BASE_URL}/api/files/upload`, formData, {
          headers: formData.getHeaders(),
          maxBodyLength: 100 * 1024 * 1024,
          timeout: 60000,
        });
        mediaUrl = `${BACKEND_BASE_URL}/api/files/${r.data.id}`;
        mediaKind = (media.mimetype || "").startsWith("image/")
          ? "image"
          : (media.mimetype || "").startsWith("video/")
          ? "video"
          : (media.mimetype || "").startsWith("audio/")
          ? "audio"
          : "document";
      }
    } catch (e) {
      console.warn("[media] download/upload failed:", e.message);
    }
  }

  return {
    wa_message_id: msg.id?._serialized || null,
    // Always use the customer's address as the chat_id, regardless of which
    // direction the message went. For incoming (fromMe=false) it's msg.from;
    // for outgoing (fromMe=true) it's msg.to. Don't try to compare against
    // client.info.wid — WhatsApp uses different address formats (@lid vs
    // @c.us vs @s.whatsapp.net) for the same user, and a mis-compare would
    // accidentally use OUR wid as chat_id and split the chat into two.
    chat_id: fromMe ? msg.to : msg.from,
    from_me: fromMe,
    body: msg.body || "",
    type: msg.type || "chat",
    timestamp: (msg.timestamp || Math.floor(Date.now() / 1000)) * 1000,
    contact_name: contactName,
    chat_name: chatName,
    is_group: isGroup,
    profile_pic: profilePic,
    media_url: mediaUrl,
    media_kind: mediaKind,
    phone: phone,
    source: "whatsapp",
  };
}

client.on("message", async (msg) => {
  try {
    const payload = await buildMessagePayload(msg, false);
    await postWebhook("message", payload);
  } catch (e) {
    console.error("[wa:message] error:", e.message);
  }
});

client.on("message_create", async (msg) => {
  // Only sync outgoing messages sent FROM THE PHONE (so the operator's UI
  // mirrors what the user typed on their phone). Skip messages we just sent
  // via our own /send endpoints — those were already stored directly when
  // the HTTP request returned, and re-storing via webhook would create a
  // duplicate chat row when WhatsApp's address format differs (@lid/@c.us).
  if (!msg.fromMe) return;
  const wid = msg.id?._serialized;
  if (wid && ourOutgoingIds.has(wid)) {
    ourOutgoingIds.delete(wid);
    return;
  }
  // Race-safe: if we just sent a matching (to, body) via /send, skip too.
  const toCandidates = [msg.to, msg.id?.remote, msg.id?.remote?._serialized].filter(Boolean);
  if (consumeMatchingSignature(toCandidates, msg.body || "")) {
    return;
  }
  try {
    const payload = await buildMessagePayload(msg, true);
    await postWebhook("message", payload);
  } catch (e) {
    console.error("[wa:message_create] error:", e.message);
  }
});

// -------------------- HTTP API --------------------

app.get("/", (_req, res) =>
  res.type("text/plain").send("WhatsApp servis çalışıyor ✅"),
);

app.get("/health", (_req, res) =>
  res.json({ ok: true, status, hasQr: !!currentQrDataUrl }),
);

app.get("/status", (_req, res) =>
  res.json({ status, qr: currentQrDataUrl, info: clientInfo }),
);
app.get("/qr", (_req, res) => res.json({ qr: currentQrDataUrl, status }));

app.get("/qr-image", async (_req, res) => {
  if (!currentQr) {
    res.status(404).type("text/plain").send(
      `No QR available. Current status: ${status}.\n` +
      `If status is "ready" the WhatsApp account is already paired.\n` +
      `Hit POST /logout to force a new QR.`,
    );
    return;
  }
  try {
    const buf = await QRCode.toBuffer(currentQr, { margin: 1, width: 480 });
    res.type("image/png").send(buf);
  } catch (err) {
    res.status(500).type("text/plain").send(`QR render error: ${err.message}`);
  }
});

// Backend dashboard polls these periodically.
app.get("/chats", async (_req, res) => {
  if (status !== "ready") return res.json({ chats: [] });
  try {
    const chats = await client.getChats();
    const out = [];
    for (const c of chats.slice(0, 50)) {
      let lastMessageAt = 0;
      let lastMessage = "";
      try {
        const msgs = await c.fetchMessages({ limit: 1 });
        if (msgs[0]) {
          lastMessageAt = (msgs[0].timestamp || 0) * 1000;
          lastMessage = msgs[0].body || "";
        }
      } catch (_) {}
      out.push({
        chat_id: c.id?._serialized,
        name: c.name || c.id?._serialized,
        is_group: c.isGroup,
        profile_pic: null,
        last_message: lastMessage,
        last_message_at: lastMessageAt,
        phone: c.id?.user || null,
      });
    }
    res.json({ chats: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/send", async (req, res) => {
  // For local preview testing: when WA_FAKE_SEND=1, pretend the message was
  // sent successfully without calling whatsapp-web.js. Useful when the QR
  // hasn't been scanned yet but you want to verify the rest of the pipeline.
  if (process.env.WA_FAKE_SEND === "1") {
    return res.json({
      ok: true,
      message_id: `fake_${Date.now()}`,
      _faked: true,
    });
  }
  if (status !== "ready") {
    return res.status(503).json({ error: "client_not_ready", status });
  }
  const { to, text } = req.body || {};
  if (!to || typeof text !== "string") {
    return res.status(400).json({ error: "to_and_text_required" });
  }
  try {
    rememberOurSignature(to, text);
    const sent = await client.sendMessage(to, text);
    rememberOurMessage(sent?.id?._serialized);
    res.json({ ok: true, message_id: sent?.id?._serialized });
  } catch (e) {
    console.error("[send] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/send-media", async (req, res) => {
  if (status !== "ready") {
    return res.status(503).json({ error: "client_not_ready", status });
  }
  const { to, file_url, caption } = req.body || {};
  if (!to || !file_url) {
    return res.status(400).json({ error: "to_and_file_url_required" });
  }
  try {
    const media = await MessageMedia.fromUrl(file_url, { unsafeMime: true });
    rememberOurSignature(to, caption || "");
    const sent = await client.sendMessage(to, media, { caption: caption || "" });
    rememberOurMessage(sent?.id?._serialized);
    res.json({ ok: true, message_id: sent?.id?._serialized });
  } catch (e) {
    console.error("[send-media] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/logout", async (_req, res) => {
  // Detach the operator's WA session and re-initialize so a brand-new QR is
  // generated. We must call client.destroy() (NOT just logout) to release
  // the puppeteer browser + session lock; without destroy, the next
  // initialize() crashes with "browser is already running for ...".
  try {
    if (client?.logout) {
      try { await client.logout(); } catch (e) {
        console.warn("[logout] logout() warning:", e.message);
      }
    }
  } catch (_) {}
  try {
    if (client?.destroy) {
      await client.destroy();
    }
  } catch (e) {
    console.warn("[logout] destroy() warning:", e.message);
  }
  status = "initializing";
  currentQr = null;
  currentQrDataUrl = null;
  clientInfo = null;
  // Clear any stale session lock files puppeteer might have left behind so
  // the next initialize() can claim the userDataDir cleanly.
  try {
    const sessionDir = `${SESSION_PATH}/session-wa-hub`;
    if (fs.existsSync(sessionDir)) {
      for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
        try { fs.unlinkSync(`${sessionDir}/${f}`); } catch (_) {}
      }
    }
  } catch (_) {}
  setTimeout(() => {
    client.initialize().catch((e) =>
      console.error("[wa] re-initialize error after logout:", e.message),
    );
  }, 2500);
  res.json({ ok: true });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[wa-service] listening on :${PORT}`);
  console.log(`[wa-service] webhook -> ${BACKEND_WEBHOOK_URL}`);
  console.log(`[wa-service] backend  -> ${BACKEND_BASE_URL}`);
  console.log(`[wa-service] session  -> ${SESSION_PATH}`);
  console.log(`[wa-service] chrome   -> ${CHROME_PATH || "(puppeteer bundled)"}`);
  console.log("[wa-service] initializing WhatsApp client...");
  client.initialize().catch((e) => {
    console.error("[wa] initialize error:", e.message);
    status = "disconnected";
  });
});

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Ensure temp download folder exists
const TEMP_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ── In-memory state ──────────────────────────────────────────────────────────
let client = null;
let sessionString = process.env.SESSION_STRING || '';
let sseClients = [];

// ── SSE broadcast ────────────────────────────────────────────────────────────
function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(r => r.write(msg));
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/auth/connect', async (req, res) => {
  try {
    const apiId = parseInt(process.env.API_ID);
    const apiHash = process.env.API_HASH;
    if (!apiId || !apiHash || isNaN(apiId)) {
      return res.status(400).json({ ok: false, error: 'API_ID and API_HASH not set in .env file.' });
    }
    const session = new StringSession(sessionString || '');
    client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });
    await client.connect();
    if (await client.isUserAuthorized()) {
      const me = await client.getMe();
      saveSession(client.session.save());
      return res.json({ ok: true, authorized: true, user: me.username || me.phone });
    }
    res.json({ ok: true, authorized: false });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/auth/send-code', async (req, res) => {
  try {
    const { phone } = req.body;
    const result = await client.sendCode(
      { apiId: parseInt(process.env.API_ID), apiHash: process.env.API_HASH }, phone
    );
    app.locals.phoneCodeHash = result.phoneCodeHash;
    app.locals.phone = phone;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/auth/verify', async (req, res) => {
  try {
    const { code, password } = req.body;
    try {
      await client.invoke(new (require('telegram/tl').Api.auth.SignIn)({
        phoneNumber: app.locals.phone,
        phoneCodeHash: app.locals.phoneCodeHash,
        phoneCode: code.trim(),
      }));
    } catch (e) {
      if (e.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        if (!password) return res.json({ ok: true, need2fa: true });
        const { computeCheck } = require('telegram/Password');
        const srpResult = await client.invoke(new (require('telegram/tl').Api.account.GetPassword)());
        await client.invoke(new (require('telegram/tl').Api.auth.CheckPassword)({
          password: await computeCheck(srpResult, password)
        }));
      } else throw e;
    }
    saveSession(client.session.save());
    const me = await client.getMe();
    res.json({ ok: true, authorized: true, user: me.username || me.phone });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    if (client) {
      try { await client.invoke(new (require('telegram/tl').Api.auth.LogOut)()); } catch(_) {}
      await client.disconnect();
      client = null;
    }
    saveSession('');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CHANNEL — LIST FILES
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/channel/files', async (req, res) => {
  try {
    const { link } = req.body;
    if (!client || !(await client.isUserAuthorized()))
      return res.status(401).json({ ok: false, error: 'Not authenticated' });

    const username = extractUsername(link);
    if (!username) return res.status(400).json({ ok: false, error: 'Invalid Telegram link' });

    const entity = await client.getEntity(username);
    const files = [];
    for await (const msg of client.iterMessages(entity, { limit: 3000 })) {
      if (msg.media) {
        const info = extractFileInfo(msg);
        if (info) files.push(info);
      }
    }
    res.json({ ok: true, count: files.length, files });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// SEQUENTIAL DOWNLOAD — stream one file at a time, delete after serving
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/channel/download', async (req, res) => {
  try {
    const { link, messageIds } = req.body;
    if (!client || !(await client.isUserAuthorized()))
      return res.status(401).json({ ok: false, error: 'Not authenticated' });

    const username = extractUsername(link);
    const entity = await client.getEntity(username);

    // Acknowledge immediately — downloads run in background
    res.json({ ok: true });

    const idSet = messageIds && messageIds.length ? new Set(messageIds) : null;

    ;(async () => {
      const messages = [];
      for await (const msg of client.iterMessages(entity, { limit: 3000 })) {
        if (!msg.media) continue;
        if (idSet && !idSet.has(msg.id)) continue;
        const info = extractFileInfo(msg);
        if (info) messages.push({ msg, info });
      }

      // Process sequentially
      for (let i = 0; i < messages.length; i++) {
        const { msg, info } = messages[i];
        const safeName = sanitize(info.name);
        const tempPath = path.join(TEMP_DIR, `${msg.id}_${safeName}`);

        broadcast({
          type: 'start',
          id: msg.id,
          name: info.name,
          size: info.size,
          index: i + 1,
          total: messages.length,
        });

        try {
          // Download to temp file
          await client.downloadMedia(msg, {
            outputFile: tempPath,
            progressCallback: (dl, total) => {
              broadcast({
                type: 'progress',
                id: msg.id,
                downloaded: Number(dl),
                size: Number(total),
              });
            },
          });

          // Signal frontend: file is ready to fetch
          broadcast({
            type: 'ready',
            id: msg.id,
            name: info.name,
            url: `/api/serve/${encodeURIComponent(`${msg.id}_${safeName}`)}`,
          });

          // Wait for file to be served then auto-delete (done inside serve endpoint)
          // Give browser up to 5 min to start the download, then clean up anyway
          await waitForDeletion(tempPath, 300_000);

        } catch (e) {
          broadcast({ type: 'error', id: msg.id, error: e.message });
          // Clean up if exists
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        }
      }

      broadcast({ type: 'complete' });
    })();
  } catch (e) {
    console.error(e);
  }
});

// Serve a temp file and DELETE it after sending
app.get('/api/serve/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(TEMP_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found or already sent' });
  }

  // Decode display name (strip leading msgId_)
  const displayName = filename.replace(/^\d+_/, '');

  res.setHeader('Content-Disposition', `attachment; filename="${displayName}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', fs.statSync(filePath).size);

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);

  // Delete after fully sent
  res.on('finish', () => {
    fs.unlink(filePath, () => {});
  });
  res.on('close', () => {
    // Client disconnected early — still delete
    fs.unlink(filePath, () => {});
  });
});

// SSE — real-time progress
app.get('/api/status', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();
  sseClients.push(res);
  req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function waitForDeletion(filePath, timeout) {
  return new Promise(resolve => {
    const start = Date.now();
    const check = setInterval(() => {
      if (!fs.existsSync(filePath) || Date.now() - start > timeout) {
        clearInterval(check);
        resolve();
      }
    }, 1000);
  });
}

function extractUsername(link) {
  link = (link || '').trim();
  const m = link.match(/(?:t\.me\/|@)([A-Za-z0-9_]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_]+$/.test(link)) return link;
  return null;
}

function extractFileInfo(message) {
  const m = message.media;
  if (!m) return null;
  let name, size = 0, type = 'file', mime = '';

  if (m.className === 'MessageMediaDocument' && m.document) {
    const doc = m.document;
    size = Number(doc.size || 0);
    mime = doc.mimeType || '';
    const fn = (doc.attributes || []).find(a => a.className === 'DocumentAttributeFilename');
    const au = (doc.attributes || []).find(a => a.className === 'DocumentAttributeAudio');
    const vi = (doc.attributes || []).find(a => a.className === 'DocumentAttributeVideo');
    if (fn) name = fn.fileName;
    else if (au) name = (au.title || 'audio') + '.' + (mime.split('/')[1] || 'mp3');
    else if (vi) name = `video_${message.id}.` + (mime.split('/')[1] || 'mp4');
    else name = `file_${message.id}.` + (mime.split('/')[1] || 'bin');
    type = mime.startsWith('video') ? 'video' : mime.startsWith('audio') ? 'audio' : mime.startsWith('image') ? 'image' : 'file';
  } else if (m.className === 'MessageMediaPhoto' && m.photo) {
    name = `photo_${message.id}.jpg`;
    type = 'image'; mime = 'image/jpeg';
  } else return null;

  return { id: message.id, name, size, type, mime, date: message.date };
}

function sanitize(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').substring(0, 180);
}

function saveSession(session) {
  sessionString = session;
  const envPath = path.join(__dirname, '.env');
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  if (content.includes('SESSION_STRING=')) {
    content = content.replace(/SESSION_STRING=.*/g, `SESSION_STRING=${session}`);
  } else {
    content += `\nSESSION_STRING=${session}`;
  }
  fs.writeFileSync(envPath, content, 'utf-8');
}

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
function getLocalIPs() {
  const ifaces = os.networkInterfaces();
  return Object.values(ifaces).flat().filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address);
}

const PORT = parseInt(process.env.PORT) || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n🚀 Telegram Channel Downloader running!\n');
  console.log(`   Local:   http://localhost:${PORT}`);
  getLocalIPs().forEach(ip => console.log(`   Network: http://${ip}:${PORT}  ← open on your phone`));
  console.log('\n✅ Files stream one-by-one and auto-delete after download.\n');
});

'use strict';

const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { Server: SocketIO } = require('socket.io');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const os = require('os');
const fs = require('fs');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const { nanoid } = require('nanoid');
const { v4: uuidv4 } = require('uuid');
const createMdns = require('multicast-dns');
const forge = require('node-forge');

require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

const PORT = process.env.PORT || 80;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 443;
let httpsEnabled = false;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || nanoid(10);
const SESSION_SECRET = process.env.SESSION_SECRET || nanoid(32);
const DATA_FILE = path.join(__dirname, 'data', 'db.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const MDNS_NAME = process.env.MDNS_NAME || 'lan';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;

async function sendDiscordLog({ title, description, color, fields }) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    const embed = {
      title,
      description,
      color: color || 0xf0a500,
      footer: { text: '⌨ LANHUB • Local Network Hub' },
      timestamp: new Date().toISOString(),
    };
    if (fields && fields.length) embed.fields = fields;

    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Lanhub Log',
        embeds: [embed],
      }),
    });
  } catch (err) {
    console.warn(`  [Discord Log Error] ${err.message}`);
  }
}

const adapter = new FileSync(DATA_FILE);
const db = low(adapter);

db.defaults({
  users: [],
  chat: [],
  polls: [],
  buttons: [],
  checklist: null,
  announcement: null,
  hiddenSections: [],
  menu: null,
  menuOrders: {},
  clockMode: false,
}).write();

function pickLanInterface() {
  const VIRTUAL = /bluetooth|vmware|virtualbox|vbox|hyper-v|vethernet|wsl|loopback|pseudo|tap|tun|ppp|vpn|zerotier|tailscale|hamachi/i;
  const candidates = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      const ip = iface.address;
      if (/^169\.254\./.test(ip)) continue;
      let score = 0;
      if (VIRTUAL.test(name)) score += 100;
      if (!/^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(ip)) score += 50;
      if (/^192\.168\./.test(ip)) score -= 5;
      candidates.push({ name, ip, score });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0];
}
const LAN_IFACE = pickLanInterface();
const LOCAL_IP = LAN_IFACE ? LAN_IFACE.ip : '127.0.0.1';

const CERTS_DIR = path.join(__dirname, 'data', 'certs');
const CA_CERT_FILE = path.join(CERTS_DIR, 'ca.crt');
const CA_KEY_FILE = path.join(CERTS_DIR, 'ca.key.pem');
const SRV_CERT_FILE = path.join(CERTS_DIR, 'server.crt');
const SRV_KEY_FILE = path.join(CERTS_DIR, 'server.key.pem');

function ensureCertificates() {
  fs.mkdirSync(CERTS_DIR, { recursive: true });

  let caCertPem, caKeyPem;
  if (fs.existsSync(CA_CERT_FILE) && fs.existsSync(CA_KEY_FILE)) {
    caCertPem = fs.readFileSync(CA_CERT_FILE, 'utf8');
    caKeyPem = fs.readFileSync(CA_KEY_FILE, 'utf8');
  } else {
    console.log('  HTTPS: generating local CA (first run)...');
    const kp = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const caCert = forge.pki.createCertificate();
    caCert.publicKey = forge.pki.publicKeyFromPem(kp.publicKey);
    caCert.serialNumber = crypto.randomBytes(16).toString('hex');
    caCert.validity.notBefore = new Date();
    caCert.validity.notAfter = new Date();
    caCert.validity.notAfter.setFullYear(caCert.validity.notAfter.getFullYear() + 10);
    const caAttrs = [
      { name: 'commonName', value: 'Lanshub Local CA' },
      { name: 'organizationName', value: 'Lanhub' },
    ];
    caCert.setSubject(caAttrs);
    caCert.setIssuer(caAttrs);
    caCert.setExtensions([
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    ]);
    caCert.sign(forge.pki.privateKeyFromPem(kp.privateKey), forge.md.sha256.create());
    caCertPem = forge.pki.certificateToPem(caCert);
    caKeyPem = kp.privateKey;
    fs.writeFileSync(CA_CERT_FILE, caCertPem);
    fs.writeFileSync(CA_KEY_FILE, caKeyPem);
  }

  const dnsNames = [`${MDNS_NAME}.local`, 'localhost'];
  const ipAddrs = [LOCAL_IP, '127.0.0.1'];
  let srvCertPem = null, srvKeyPem = null;
  if (fs.existsSync(SRV_CERT_FILE) && fs.existsSync(SRV_KEY_FILE)) {
    try {
      const existing = forge.pki.certificateFromPem(fs.readFileSync(SRV_CERT_FILE, 'utf8'));
      const san = existing.getExtension({ name: 'subjectAltName' });
      const names = ((san && san.altNames) || []).filter(a => a.type === 2).map(a => a.value);
      const ips = ((san && san.altNames) || []).filter(a => a.type === 7).map(a => a.ip);
      if (dnsNames.every(d => names.includes(d)) && ipAddrs.every(i => ips.includes(i))) {
        srvCertPem = fs.readFileSync(SRV_CERT_FILE, 'utf8');
        srvKeyPem = fs.readFileSync(SRV_KEY_FILE, 'utf8');
      }
    } catch (_) { }
  }
  if (!srvCertPem) {
    if (fs.existsSync(SRV_CERT_FILE)) console.log('  HTTPS: names/IP changed — issuing new server certificate (CA unchanged)...');
    const kp = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const cert = forge.pki.createCertificate();
    cert.publicKey = forge.pki.publicKeyFromPem(kp.publicKey);
    cert.serialNumber = crypto.randomBytes(16).toString('hex');
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setDate(cert.validity.notAfter.getDate() + 825);
    cert.setSubject([
      { name: 'commonName', value: `${MDNS_NAME}.local` },
      { name: 'organizationName', value: 'Lanhub' },
    ]);
    cert.setIssuer(forge.pki.certificateFromPem(caCertPem).subject.attributes);
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName', altNames: dnsNames.map(d => ({ type: 2, value: d }))
          .concat(ipAddrs.map(i => ({ type: 7, ip: i })))
      },
    ]);
    cert.sign(forge.pki.privateKeyFromPem(caKeyPem), forge.md.sha256.create());
    srvCertPem = forge.pki.certificateToPem(cert);
    srvKeyPem = kp.privateKey;
    fs.writeFileSync(SRV_CERT_FILE, srvCertPem);
    fs.writeFileSync(SRV_KEY_FILE, srvKeyPem);
  }

  return { caCertPem, srvCertPem, srvKeyPem };
}

const app = express();
const server = http.createServer(app);
const io = new SocketIO(server, {});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 },
});
app.use(sessionMiddleware);

io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

function requireUser(req, res, next) {
  if (req.session.user) return next();
  res.status(401).json({ error: 'Not logged in' });
}

function requireAdmin(req, res, next) {
  if (req.session.isAdmin) return next();
  res.status(403).json({ error: 'Admin only' });
}

const connectedUsers = new Map();

function uniqueUsers() {
  const seen = new Set();
  const list = [];
  for (const u of connectedUsers.values()) {
    if (seen.has(u.code)) continue;
    seen.add(u.code);
    list.push(u);
  }
  return list;
}

function refreshOnlineDisplay() {
  const c = global._c;
  if (!c) return;
  const count = uniqueUsers().length;
  process.stdout.write(`\x1b[u\x1b[2K${c.muted}   online:${c.reset}  ${c.green}${count}${c.reset}`);
}

const rateBuckets = new Map();
function isRateLimited(key, limit, windowMs) {
  const now = Date.now();
  const arr = (rateBuckets.get(key) || []).filter(t => now - t < windowMs);
  const limited = arr.length >= limit;
  if (!limited) arr.push(now);
  rateBuckets.set(key, arr);
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) {
      if (!v.some(t => now - t < windowMs)) rateBuckets.delete(k);
    }
  }
  return limited;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

io.on('connection', (socket) => {
  const sess = socket.request.session;
  const user = sess ? sess.user : null;

  if (user) {
    connectedUsers.set(socket.id, user);
    io.emit('presence', { online: uniqueUsers() });
    refreshOnlineDisplay();
  }

  socket.on('disconnect', () => {
    connectedUsers.delete(socket.id);
    io.emit('presence', { online: uniqueUsers() });
    refreshOnlineDisplay();
  });

  socket.on('chat:send', (data) => {
    if (!user) return;
    if (isRateLimited(`chat:${user.code}`, 8, 10 * 1000)) return;
    const msg = {
      id: uuidv4(),
      user: user.name,
      text: (data.text || '').toString().trim().substring(0, 500),
      timestamp: Date.now(),
    };
    if (!msg.text) return;
    const chat = db.get('chat').value();
    chat.push(msg);
    if (chat.length > 500) chat.splice(0, chat.length - 500);
    db.set('chat', chat).write();
    io.emit('chat:message', msg);
  });
});

app.get('/api/info', (req, res) => {
  res.json({
    ip: LOCAL_IP,
    port: PORT,
    url: `http://${LOCAL_IP}:${PORT}`,
    mdnsUrl: `http://${MDNS_NAME}.local${PORT !== 80 ? ':' + PORT : ''}`,
    mdnsName: `${MDNS_NAME}.local`,
    httpsUrl: httpsEnabled ? `https://${MDNS_NAME}.local${HTTPS_PORT !== 443 ? ':' + HTTPS_PORT : ''}` : null,
    caUrl: httpsEnabled ? '/ca.crt' : null,
    online: connectedUsers.size,
    mdns: mdnsStatus,
    llmnr: llmnrStatus,
  });
});

app.post('/api/login', (req, res) => {

  if (isRateLimited(`login:${req.ip}`, 10, 60 * 1000)) {
    return res.status(429).json({ error: 'Too many attempts — try again in a minute' });
  }
  const { code, adminPassword } = req.body;

  if (adminPassword !== undefined) {
    if (typeof adminPassword === 'string' && safeEqual(adminPassword, ADMIN_PASSWORD)) {
      req.session.isAdmin = true;
      req.session.user = { name: 'Host', code: 'admin', seat: '', handle: 'Host' };
      sendDiscordLog({
        title: '⚙ Host Login',
        description: '**Host** logged into the Admin Panel',
        color: 0xf0a500,
        fields: [{ name: 'IP Address', value: req.ip || 'Unknown', inline: true }]
      });
      return res.json({ ok: true, isAdmin: true, user: req.session.user });
    }
    return res.status(401).json({ error: 'Wrong admin password' });
  }

  if (!code) return res.status(400).json({ error: 'Code required' });
  const userRecord = db.get('users').find({ code: code.toUpperCase() }).value();
  if (!userRecord) return res.status(401).json({ error: 'Invalid code' });

  req.session.user = {
    name: userRecord.name,
    code: userRecord.code,
    seat: userRecord.seat || '',
    handle: userRecord.handle || '',
  };
  req.session.isAdmin = false;

  sendDiscordLog({
    title: '🔑 Guest Connected',
    description: `**${userRecord.name}** logged into LAN Hub`,
    color: 0x22c55e,
    fields: [
      { name: 'User', value: userRecord.name, inline: true },
      { name: 'Code', value: `\`${userRecord.code}\``, inline: true },
      { name: 'Seat', value: userRecord.seat || 'N/A', inline: true },
      { name: 'Handle', value: userRecord.handle || 'N/A', inline: true },
      { name: 'IP Address', value: req.ip || 'Unknown', inline: true }
    ]
  });

  res.json({ ok: true, isAdmin: false, user: req.session.user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, user: req.session.user, isAdmin: !!req.session.isAdmin });
});

app.get('/api/users', requireAdmin, (req, res) => {
  const users = db.get('users').value();
  const onlineCodes = new Set(Array.from(connectedUsers.values()).map(u => u.code));
  const result = users.map(u => ({ ...u, online: onlineCodes.has(u.code) }));
  res.json(result);
});

app.post('/api/users/generate', requireAdmin, (req, res) => {
  const { name, seat, handle } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  let code;
  do { code = nanoid(6).toUpperCase(); } while (db.get('users').find({ code }).value());
  const record = { code, name, seat: seat || '', handle: handle || '', createdAt: Date.now(), revoked: false };
  db.get('users').push(record).write();

  sendDiscordLog({
    title: '🎟 Guest Code Generated',
    description: `New guest access code created for **${name}**`,
    color: 0x00b4d8,
    fields: [
      { name: 'Name', value: name, inline: true },
      { name: 'Code', value: `\`${code}\``, inline: true },
      { name: 'Seat', value: seat || 'N/A', inline: true },
      { name: 'Handle', value: handle || 'N/A', inline: true }
    ]
  });

  res.json(record);
});

app.delete('/api/users/:code', requireAdmin, (req, res) => {
  const code = req.params.code.toUpperCase();
  const existing = db.get('users').find({ code }).value();
  const users = db.get('users').value().filter(u => u.code !== code);
  db.set('users', users).write();

  sendDiscordLog({
    title: '🗑 Guest Code Deleted',
    description: `Guest code \`${code}\` (${existing ? existing.name : 'Unknown'}) was deleted by Host`,
    color: 0xef4444
  });

  res.json({ ok: true });
});

app.get('/api/chat', requireUser, (req, res) => {
  const history = db.get('chat').value().slice(-200);
  res.json(history);
});

app.get('/api/polls', requireUser, (req, res) => {
  res.json(db.get('polls').value());
});

app.post('/api/polls', requireAdmin, (req, res) => {
  const { question, options } = req.body;
  if (!question || !Array.isArray(options) || options.length < 2) {
    return res.status(400).json({ error: 'question + at least 2 options required' });
  }
  const poll = {
    id: uuidv4(),
    question,
    options: options.map(o => o.toString().trim()).filter(Boolean),
    votes: {},
    status: 'open',
    createdAt: Date.now(),
  };
  db.get('polls').push(poll).write();
  io.emit('polls:update', db.get('polls').value());

  sendDiscordLog({
    title: '🗳 Poll Created',
    description: `**${question}**`,
    color: 0x00b4d8,
    fields: [
      { name: 'Options', value: poll.options.map((o, i) => `${i + 1}. ${o}`).join('\n') }
    ]
  });

  res.json(poll);
});

app.post('/api/polls/:id/vote', requireUser, (req, res) => {
  const { id } = req.params;
  const { optionIndex } = req.body;
  const poll = db.get('polls').find({ id }).value();
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  if (poll.status !== 'open') return res.status(400).json({ error: 'Poll is closed' });
  const userCode = req.session.user.code;
  if (poll.votes[userCode] !== undefined) return res.status(400).json({ error: 'Already voted' });
  if (optionIndex < 0 || optionIndex >= poll.options.length) return res.status(400).json({ error: 'Invalid option' });
  db.get('polls').find({ id }).get('votes').set(userCode, optionIndex).write();
  const updated = db.get('polls').value();
  io.emit('polls:update', updated);

  const votedOption = poll.options[optionIndex] || 'Option';
  sendDiscordLog({
    title: '🗳 Poll Vote Cast',
    description: `**${req.session.user.name}** voted on poll **"${poll.question}"**`,
    color: 0x22c55e,
    fields: [
      { name: 'User', value: req.session.user.name, inline: true },
      { name: 'Voted For', value: votedOption, inline: true }
    ]
  });

  res.json({ ok: true });
});

app.patch('/api/polls/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!['open', 'closed'].includes(status)) return res.status(400).json({ error: 'status must be open or closed' });
  const poll = db.get('polls').find({ id }).value();
  db.get('polls').find({ id }).assign({ status }).write();
  const updated = db.get('polls').value();
  io.emit('polls:update', updated);

  sendDiscordLog({
    title: status === 'closed' ? '🔒 Poll Closed' : '🔓 Poll Reopened',
    description: `Poll **"${poll ? poll.question : id}"** was ${status}`,
    color: status === 'closed' ? 0xef4444 : 0x22c55e
  });

  res.json({ ok: true });
});

app.delete('/api/polls/:id', requireAdmin, (req, res) => {
  const poll = db.get('polls').find({ id: req.params.id }).value();
  const polls = db.get('polls').value().filter(p => p.id !== req.params.id);
  db.set('polls', polls).write();
  io.emit('polls:update', polls);

  sendDiscordLog({
    title: '🗑 Poll Deleted',
    description: `Poll **"${poll ? poll.question : req.params.id}"** deleted by Host`,
    color: 0xef4444
  });

  res.json({ ok: true });
});

app.get('/api/buttons', requireUser, (req, res) => {
  res.json(db.get('buttons').value());
});

app.post('/api/buttons', requireAdmin, upload.single('file'), (req, res) => {
  const { label, type, url } = req.body;
  if (!label) return res.status(400).json({ error: 'Label required' });
  const buttons = db.get('buttons').value();
  const btn = {
    id: uuidv4(),
    label,
    type: type === 'file' ? 'file' : 'link',
    url: type === 'file' ? null : (url || '#'),
    filename: req.file ? req.file.filename : null,
    originalName: req.file ? req.file.originalname : null,
    order: buttons.length,
  };
  db.get('buttons').push(btn).write();
  io.emit('buttons:update', db.get('buttons').value());
  res.json(btn);
});

app.delete('/api/buttons/:id', requireAdmin, (req, res) => {
  const btn = db.get('buttons').find({ id: req.params.id }).value();
  if (btn && btn.filename) {
    const filePath = path.join(UPLOADS_DIR, btn.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  const buttons = db.get('buttons').value().filter(b => b.id !== req.params.id);
  buttons.forEach((b, i) => { b.order = i; });
  db.set('buttons', buttons).write();
  io.emit('buttons:update', buttons);
  res.json({ ok: true });
});

app.patch('/api/buttons/reorder', requireAdmin, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  const buttons = db.get('buttons').value();
  const reordered = ids.map((id, i) => {
    const b = buttons.find(x => x.id === id);
    if (b) b.order = i;
    return b;
  }).filter(Boolean);
  db.set('buttons', reordered).write();
  io.emit('buttons:update', reordered);
  res.json({ ok: true });
});

app.get('/api/checklist', requireUser, (req, res) => {
  res.json(db.get('checklist').value());
});

app.post('/api/checklist', requireAdmin, (req, res) => {
  const { title, items } = req.body;
  if (!title || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'title and items[] required' });
  }
  const checklist = {
    id: uuidv4(),
    title,
    items: items.map(i => i.toString().trim()).filter(Boolean),
    ticks: {},
    createdAt: Date.now(),
  };
  db.set('checklist', checklist).write();
  io.emit('checklist:update', checklist);
  res.json(checklist);
});

app.post('/api/checklist/tick', requireUser, (req, res) => {
  const { itemIndex, ticked } = req.body;
  const checklist = db.get('checklist').value();
  if (!checklist) return res.status(404).json({ error: 'No checklist' });
  if (itemIndex < 0 || itemIndex >= checklist.items.length) return res.status(400).json({ error: 'Invalid item' });
  const userCode = req.session.user.code;
  if (!checklist.ticks[userCode]) checklist.ticks[userCode] = [];
  const ticks = checklist.ticks[userCode];
  if (ticked) {
    if (!ticks.includes(itemIndex)) ticks.push(itemIndex);
  } else {
    const idx = ticks.indexOf(itemIndex);
    if (idx !== -1) ticks.splice(idx, 1);
  }
  db.set('checklist', checklist).write();
  io.emit('checklist:update', checklist);
  res.json({ ok: true });
});

app.get('/api/announcement', requireUser, (req, res) => {
  res.json(db.get('announcement').value());
});

app.post('/api/announcement', requireAdmin, (req, res) => {
  const { text } = req.body;
  const announcement = text ? { text, createdAt: Date.now() } : null;
  db.set('announcement', announcement).write();
  io.emit('announcement:update', announcement);

  if (announcement) {
    sendDiscordLog({
      title: '📢 Announcement Posted',
      description: `>>> ${announcement.text}`,
      color: 0xf0a500
    });
  } else {
    sendDiscordLog({
      title: '📢 Announcement Cleared',
      description: 'Pinned announcement was cleared by Host',
      color: 0x7a7a90
    });
  }

  res.json({ ok: true });
});

app.get('/api/clock-mode', requireUser, (req, res) => {
  res.json({ enabled: !!db.get('clockMode').value() });
});

app.post('/api/clock-mode', requireAdmin, (req, res) => {
  const { enabled } = req.body;
  const isEnabled = !!enabled;
  db.set('clockMode', isEnabled).write();
  io.emit('clockmode:update', { enabled: isEnabled });

  sendDiscordLog({
    title: isEnabled ? '🕒 Clock Mode Enabled' : '🕒 Clock Mode Disabled',
    description: isEnabled ? 'Clock Mode overlay is now active on all screens' : 'Clock Mode turned off by Host',
    color: isEnabled ? 0xf0a500 : 0x7a7a90
  });

  res.json({ ok: true, enabled: isEnabled });
});

app.get('/api/sections', requireUser, (req, res) => {
  res.json({ hiddenSections: db.get('hiddenSections').value() });
});

app.patch('/api/sections/:id', requireAdmin, (req, res) => {
  const VALID = ['buttons', 'chat', 'polls', 'checklist', 'menu'];
  const sectionId = req.params.id;
  if (!VALID.includes(sectionId)) return res.status(400).json({ error: 'Invalid section id' });
  const { hidden } = req.body;
  const current = db.get('hiddenSections').value();
  let updated;
  if (hidden) {
    updated = current.includes(sectionId) ? current : [...current, sectionId];
  } else {
    updated = current.filter(s => s !== sectionId);
  }
  db.set('hiddenSections', updated).write();
  io.emit('sections:update', { hiddenSections: updated });
  res.json({ ok: true });
});

// ── MENU ─────────────────────────────────────────────────────────────────────

app.get('/api/menu', requireUser, (req, res) => {
  res.json(db.get('menu').value());
});

app.post('/api/menu', requireAdmin, (req, res) => {
  const { title, sections } = req.body;
  if (!title || !Array.isArray(sections) || sections.length === 0) {
    return res.status(400).json({ error: 'title and sections[] required' });
  }
  const menu = {
    id: uuidv4(),
    title,
    open: true,
    createdAt: Date.now(),
    sections: sections.map(sec => ({
      id: uuidv4(),
      title: (sec.title || '').toString().trim(),
      items: (Array.isArray(sec.items) ? sec.items : []).map(item => ({
        id: uuidv4(),
        name: (item.name || '').toString().trim(),
        price: Number(item.price) || 0,
      })).filter(i => i.name),
    })).filter(s => s.title),
  };
  db.set('menu', menu).write();
  db.set('menuOrders', {}).write();
  io.emit('menu:update', menu);
  io.emit('menu:orders:update', {});
  res.json(menu);
});

app.patch('/api/menu', requireAdmin, (req, res) => {
  const menu = db.get('menu').value();
  if (!menu) return res.status(404).json({ error: 'No menu' });
  const { open, title } = req.body;
  if (open !== undefined) menu.open = !!open;
  if (title !== undefined) menu.title = title;
  db.set('menu', menu).write();
  io.emit('menu:update', menu);
  res.json({ ok: true });
});

app.delete('/api/menu', requireAdmin, (req, res) => {
  db.set('menu', null).write();
  db.set('menuOrders', {}).write();
  io.emit('menu:update', null);
  io.emit('menu:orders:update', {});
  res.json({ ok: true });
});

app.get('/api/menu/orders', requireUser, (req, res) => {
  const orders = db.get('menuOrders').value() || {};
  res.json(orders[req.session.user.code] || []);
});

app.put('/api/menu/orders', requireUser, (req, res) => {
  const menu = db.get('menu').value();
  if (!menu) return res.status(404).json({ error: 'No menu' });
  if (!menu.open) return res.status(400).json({ error: 'Menu is closed' });
  const { items } = req.body; // array of item IDs
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items[] required' });
  // validate all IDs exist in menu
  const allItemIds = new Set(menu.sections.flatMap(s => s.items.map(i => i.id)));
  const valid = items.filter(id => allItemIds.has(id));
  const userCode = req.session.user.code;
  const orders = db.get('menuOrders').value() || {};
  orders[userCode] = valid;
  db.set('menuOrders', orders).write();
  // emit updated orders to all (admin needs it; guests only see their own anyway)
  io.emit('menu:orders:update', orders);
  res.json({ ok: true });
});

app.get('/api/menu/orders/all', requireAdmin, (req, res) => {
  const menu = db.get('menu').value();
  const orders = db.get('menuOrders').value() || {};
  const users = db.get('users').value().filter(u => !u.revoked);
  if (!menu) return res.json({ menu: null, orders: {}, users: [] });

  // Build item map for quick lookup
  const itemMap = {};
  menu.sections.forEach(sec => sec.items.forEach(item => { itemMap[item.id] = item; }));

  // Per-user order with resolved items and totals
  const perUser = {};
  for (const u of users) {
    const itemIds = orders[u.code] || [];
    const resolvedItems = itemIds.map(id => itemMap[id]).filter(Boolean);
    const total = resolvedItems.reduce((sum, i) => sum + i.price, 0);
    perUser[u.code] = { name: u.name, seat: u.seat, items: resolvedItems, total };
  }
  // Also include admin orders if any
  if (orders['admin']) {
    const resolvedItems = orders['admin'].map(id => itemMap[id]).filter(Boolean);
    perUser['admin'] = { name: 'Host', seat: '', items: resolvedItems, total: resolvedItems.reduce((s, i) => s + i.price, 0) };
  }

  // Aggregate: count per item
  const aggregate = {};
  Object.values(orders).forEach(itemIds => {
    (itemIds || []).forEach(id => {
      if (!itemMap[id]) return;
      if (!aggregate[id]) aggregate[id] = { item: itemMap[id], count: 0 };
      aggregate[id].count++;
    });
  });

  res.json({ menu, perUser, aggregate: Object.values(aggregate), users });
});

app.get('/ca.crt', (req, res) => {
  res.sendFile(CA_CERT_FILE, { headers: { 'Content-Type': 'application/x-x509-ca-cert' } });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let mdnsStatus = 'off';

function startMdns() {
  const hostname = `${MDNS_NAME}.local`;
  if (LOCAL_IP === '127.0.0.1') {
    console.warn('  [mDNS] No LAN adapter found — mDNS disabled.');
    mdnsStatus = 'failed';
    return;
  }

  let mdns;
  try {
    mdns = createMdns({
      interface: LOCAL_IP,
      reuseAddr: true,
    });
  } catch (err) {
    console.warn(`  [mDNS] Could not start: ${err.message}`);
    mdnsStatus = 'failed';
    return;
  }

  const answer = { name: hostname, type: 'A', ttl: 120, flush: true, data: LOCAL_IP };

  mdns.on('query', (query, rinfo) => {
    for (const q of query.questions || []) {
      if ((q.type === 'A' || q.type === 'ANY') && String(q.name).toLowerCase() === hostname) {
        mdns.respond({ answers: [answer] }, () => { mdnsStatus = 'ok'; });
        if (rinfo && rinfo.address) {
          const legacy = rinfo.port !== 5353;
          const direct = {
            answers: [legacy
              ? { name: hostname, type: 'A', ttl: 10, data: LOCAL_IP }
              : { name: hostname, type: 'A', ttl: 120, flush: true, data: LOCAL_IP }],
          };
          mdns.respond(direct, { address: rinfo.address, port: rinfo.port }, () => { mdnsStatus = 'ok'; });
        }
        break;
      }
    }
  });

  mdns.on('error', (err) => {
    if (mdnsStatus !== 'ok') {
      mdnsStatus = 'failed';
      console.warn(`  [mDNS] Bind/receive failed (UDP 5353 busy?): ${err.message}`);
      console.warn('          Guests can still use the LAN URL below. On Windows, the OS itself or');
      console.warn('          apps like Spotify/Steam can occupy mDNS — retry after closing them.');
    } else {
      console.warn(`  [mDNS] Error: ${err.message}`);
    }
  });

  const announce = () => mdns.respond({ answers: [answer] }, () => { mdnsStatus = 'ok'; });
  announce();
  const warmup = setInterval(announce, 1000);
  setTimeout(() => clearInterval(warmup), 3000);
  const keepalive = setInterval(announce, 60000);

  console.log(`${_c.dim}   mDNS  ${_c.reset}${_c.cyan}http://${hostname}${PORT !== 80 ? ':' + PORT : ''}${_c.reset}`);
}

let llmnrStatus = 'off';

function startLlmnr() {
  if (LOCAL_IP === '127.0.0.1') return;
  const name = MDNS_NAME;
  let llmnr;
  try {
    llmnr = createMdns({
      port: 5355,
      ip: '224.0.0.252',
      interface: LOCAL_IP,
      reuseAddr: true,
    });
  } catch (err) {
    console.warn(`  [LLMNR] Could not start: ${err.message}`);
    llmnrStatus = 'failed';
    return;
  }

  llmnr.on('ready', () => {
    llmnrStatus = 'ok';
  });

  llmnr.on('query', (query, rinfo) => {
    const wants = (query.questions || []).some(q =>
      q.type === 'A' && String(q.name).toLowerCase() === name);
    if (!wants || !rinfo) return;
    llmnr.respond(
      { answers: [{ name, type: 'A', ttl: 120, data: LOCAL_IP }] },
      { address: rinfo.address, port: rinfo.port }
    );
    llmnrStatus = 'ok';
  });

  llmnr.on('error', (err) => {
    if (llmnrStatus !== 'ok') {
      llmnrStatus = 'failed';
      console.warn(`  [LLMNR] Bind/receive failed (UDP 5355 busy?): ${err.message}`);
      console.warn('          http://lan will not resolve — guests can use the other URLs.');
    } else {
      console.warn(`  [LLMNR] Error: ${err.message}`);
    }
  });
}

try {
  const certs = ensureCertificates();
  const httpsServer = https.createServer({ key: certs.srvKeyPem, cert: certs.srvCertPem }, app);
  io.attach(httpsServer);
  httpsServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.warn(`  [HTTPS] Port ${HTTPS_PORT} already in use — HTTPS disabled, HTTP still on ${PORT}.`);
    else if (err.code === 'EACCES') console.warn(`  [HTTPS] No permission for port ${HTTPS_PORT} — HTTPS disabled.`);
    else console.warn(`  [HTTPS] Error: ${err.message}`);
  });
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    httpsEnabled = true;
  });
} catch (err) {
  console.warn(`  [HTTPS] Could not start: ${err.message} — continuing with HTTP on port ${PORT}.`);
}

server.listen(PORT, '0.0.0.0', () => {
  const _c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    gold: '\x1b[33m',
    boldGold: '\x1b[1m\x1b[33m',
    cyan: '\x1b[96m',
    green: '\x1b[92m',
    muted: '\x1b[90m',
    red: '\x1b[91m',
  };
  global._c = _c;

  process.stdout.write('\x1b[2J\x1b[H');

  const port = PORT !== 80 ? `:${PORT}` : '';
  const httpsStr = httpsEnabled ? ` ${_c.dim}+https${_c.reset}` : '';

  process.stdout.write('\n');
  console.log(`${_c.boldGold}   ⌨  L A N H U B${_c.reset}`);
  console.log(`${_c.dim}   ─────────────────────────────────────${_c.reset}`);
  process.stdout.write('\n');
  console.log(`${_c.muted}   ip   ${_c.reset}${_c.cyan}${_c.bold}http://${LOCAL_IP}${port}${_c.reset}${httpsStr}`);
  startMdns();
  startLlmnr();
  console.log(`${_c.muted}   pw   ${_c.reset}${_c.gold}${ADMIN_PASSWORD}${_c.reset}`);
  process.stdout.write(`\x1b[s${_c.muted}   online:${_c.reset}  ${_c.green}0${_c.reset}\n`);
  process.stdout.write('\n');
});

server.on('error', (err) => {
  const r = '\x1b[91m', x = '\x1b[0m', d = '\x1b[90m';
  if (err.code === 'EADDRINUSE') {
    console.error(`\n${r}  ✕ Port ${PORT} already in use.${x}`);
    console.error(`${d}    Set PORT=8080 in .env or free port ${PORT}.${x}\n`);
  } else if (err.code === 'EACCES') {
    console.error(`\n${r}  ✕ Permission denied on port ${PORT}.${x}`);
    console.error(`${d}    Try PORT=8080 in .env${x}\n`);
  } else {
    console.error(`\n${r}  ✕ ${err.message}${x}\n`);
  }
  process.exit(1);
});

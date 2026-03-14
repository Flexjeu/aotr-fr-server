const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use((req, res, next) => { res.header('Access-Control-Allow-Origin', '*'); res.header('Access-Control-Allow-Headers', '*'); next(); });

const ADMIN_USERNAME = 'flexjeu';
const ADMIN_USERNAMES = ['flexjeu', 't4sty'];

const DATA_FILE = path.join(__dirname, 'data.json');
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch(e) { return { users:{}, trades:{}, notifs:{}, convs:{}, userConvs:{}, bans:{}, mods:[] }; }
}
function saveData() {
  if (!db.bans) db.bans = {};
  if (!db.mods) db.mods = [];
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}
let db = loadData();
if (!db.bans) db.bans = {};
if (!db.mods) db.mods = [];
setInterval(saveData, 5000);

function hash(p) { return crypto.createHash('sha256').update(p + 'aotrfr_salt_2025').digest('hex'); }
function getRole(username) {
  if (ADMIN_USERNAMES.includes(username)) return 'admin';
  if (db.mods.includes(username)) return 'mod';
  return 'user';
}
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
function genToken() { return crypto.randomBytes(32).toString('hex'); }

const sessions = {};
const socketToToken = {};
function getUser(token) { return sessions[token] || null; }
function isAdmin(token) { const s = getUser(token); return s && ADMIN_USERNAMES.includes(s.username); }
function isMod(token) { const s = getUser(token); return s && db.mods.includes(s.username); }
function hasAdminAccess(token) { return isAdmin(token) || isMod(token); }

function getBanStatus(username) {
  const ban = db.bans[username];
  if (!ban) return null;
  if (ban.type === 'permanent') return ban;
  if (ban.type === 'temp') {
    if (Date.now() < ban.until) return ban;
    delete db.bans[username];
    return null;
  }
  return null;
}

function banMessage(ban) {
  if (ban.type === 'permanent') {
    return `Ton compte a ete banni definitivement.\nRaison : ${ban.reason || 'Non precisee'}.\nContacte l'admin sur Discord si tu penses que c'est une erreur.`;
  }
  const remaining = Math.max(0, Math.ceil((ban.until - Date.now()) / 1000 / 60));
  const h = Math.floor(remaining / 60), m = remaining % 60;
  const timeStr = h > 0 ? `${h}h${m > 0 ? m + 'min' : ''}` : `${m}min`;
  return `Ton compte est banni temporairement encore ${timeStr}.\nRaison : ${ban.reason || 'Non precisee'}.`;
}

app.get('/', (req, res) => res.json({ status: 'AOTR FR Trade Center OK', users: Object.keys(db.users).length, trades: Object.values(db.trades).filter(t=>t.status==='active').length }));

app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  const u = username?.toLowerCase().replace(/\s/g,'');
  if (!u || !password) return res.json({ error: 'Champs manquants' });
  if (u.length < 3) return res.json({ error: 'Pseudo trop court (min 3)' });
  if (!/^[a-z0-9_]+$/.test(u)) return res.json({ error: 'Pseudo : lettres, chiffres, _ seulement' });
  if (password.length < 6) return res.json({ error: 'Mot de passe trop court (min 6)' });
  if (db.users[u]) return res.json({ error: 'Pseudo deja utilise' });
  const userData = { username: u, password: hash(password), createdAt: Date.now(), ratingGood: 0, ratingBad: 0, tradeCount: 0 };
  db.users[u] = userData;
  const token = genToken();
  sessions[token] = { uid: u, username: u };
  res.json({ ok: true, token, user: { username: u, createdAt: userData.createdAt, ratingGood: 0, isAdmin: ADMIN_USERNAMES.includes(u), isMod: db.mods.includes(u), role: getRole(u) } });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const u = username?.toLowerCase().replace(/\s/g,'');
  if (!u || !password) return res.json({ error: 'Champs manquants' });
  const user = db.users[u];
  if (!user) return res.json({ error: 'Utilisateur introuvable' });
  if (user.password !== hash(password)) return res.json({ error: 'Mot de passe incorrect' });
  const ban = getBanStatus(u);
  if (ban) return res.json({ error: banMessage(ban) });
  const token = genToken();
  sessions[token] = { uid: u, username: u };
  res.json({ ok: true, token, user: { username: u, createdAt: user.createdAt, ratingGood: user.ratingGood||0, isAdmin: ADMIN_USERNAMES.includes(u), isMod: db.mods.includes(u), role: getRole(u) } });
});

app.post('/api/auth-check', (req, res) => {
  const { token } = req.body;
  const s = sessions[token];
  if (!s) return res.json({ ok: false });
  const ban = getBanStatus(s.username);
  if (ban) { delete sessions[token]; return res.json({ ok: false, banned: true, message: banMessage(ban) }); }
  const user = db.users[s.username];
  res.json({ ok: true, user: { username: user.username, createdAt: user.createdAt, ratingGood: user.ratingGood||0, isAdmin: ADMIN_USERNAMES.includes(s.username), isMod: db.mods.includes(s.username), role: getRole(s.username) } });
});

// ── Admin endpoints ───────────────────────────────────────────────
app.post('/api/admin/users', (req, res) => {
  if (!hasAdminAccess(req.body.token)) return res.json({ error: 'Acces refuse' });
  const users = Object.values(db.users).map(u => ({
    username: u.username, createdAt: u.createdAt,
    tradeCount: u.tradeCount||0, ratingGood: u.ratingGood||0,
    ban: db.bans[u.username] || null,
    isMod: db.mods.includes(u.username)
  })).sort((a,b) => b.createdAt - a.createdAt);
  res.json({ ok: true, users });
});

app.post('/api/admin/ban', (req, res) => {
  if (!isAdmin(req.body.token)) return res.json({ error: 'Acces refuse' });
  const { username, type, duration, reason } = req.body;
  const u = username?.toLowerCase();
  if (!db.users[u]) return res.json({ error: 'Utilisateur introuvable' });
  if (ADMIN_USERNAMES.includes(u)) return res.json({ error: 'Impossible de bannir l admin' });
  if (type === 'permanent') {
    db.bans[u] = { type: 'permanent', reason: reason||'', bannedAt: Date.now() };
  } else {
    db.bans[u] = { type: 'temp', reason: reason||'', until: Date.now() + (duration||60)*60*1000, bannedAt: Date.now(), durationMin: duration };
  }
  for (const [t, s] of Object.entries(sessions)) {
    if (s.username === u) { const sock = s.socketId; delete sessions[t]; if (sock) io.to(sock).emit('force:banned', { message: banMessage(db.bans[u]) }); }
  }
  Object.values(db.trades).forEach(tr => { if (tr.author === u && tr.status === 'active') tr.status = 'deleted'; });
  io.emit('trades:refresh');
  saveData();
  res.json({ ok: true });
});

app.post('/api/admin/unban', (req, res) => {
  if (!isAdmin(req.body.token)) return res.json({ error: 'Acces refuse' });
  const u = req.body.username?.toLowerCase();
  delete db.bans[u];
  saveData();
  res.json({ ok: true });
});

app.post('/api/admin/delete-trade', (req, res) => {
  if (!isAdmin(req.body.token)) return res.json({ error: 'Acces refuse' });
  if (db.trades[req.body.tradeId]) { db.trades[req.body.tradeId].status = 'deleted'; io.emit('trade:deleted', req.body.tradeId); }
  saveData();
  res.json({ ok: true });
});

app.post('/api/admin/delete-user', (req, res) => {
  if (!isAdmin(req.body.token)) return res.json({ error: 'Acces refuse' });
  const u = req.body.username?.toLowerCase();
  if (ADMIN_USERNAMES.includes(u)) return res.json({ error: 'Impossible de supprimer l admin' });
  for (const [t, s] of Object.entries(sessions)) {
    if (s.username === u) { const sock = s.socketId; delete sessions[t]; if (sock) io.to(sock).emit('force:banned', { message: 'Ton compte a ete supprime par l administrateur.' }); }
  }
  delete db.users[u]; delete db.bans[u]; delete db.notifs[u];
  Object.values(db.trades).forEach(tr => { if (tr.author === u) tr.status = 'deleted'; });
  saveData();
  res.json({ ok: true });
});

// ── Gestion des modérateurs (super-admin uniquement) ──────────────
app.post('/api/admin/mods', (req, res) => {
  if (!isAdmin(req.body.token)) return res.json({ error: 'Acces refuse' });
  res.json({ ok: true, mods: db.mods });
});

app.post('/api/admin/mods/add', (req, res) => {
  if (!isAdmin(req.body.token)) return res.json({ error: 'Acces refuse' });
  const u = req.body.username?.toLowerCase();
  if (!db.users[u]) return res.json({ error: 'Utilisateur introuvable' });
  if (ADMIN_USERNAMES.includes(u)) return res.json({ error: 'Impossible' });
  if (!db.mods.includes(u)) db.mods.push(u);
  saveData();
  res.json({ ok: true, mods: db.mods });
});

app.post('/api/admin/mods/remove', (req, res) => {
  if (!isAdmin(req.body.token)) return res.json({ error: 'Acces refuse' });
  const u = req.body.username?.toLowerCase();
  db.mods = db.mods.filter(m => m !== u);
  saveData();
  res.json({ ok: true, mods: db.mods });
});

// ── Sockets ───────────────────────────────────────────────────────
io.on('connection', (socket) => {
  function auth(token) {
    const s = getUser(token); if (!s) return null;
    const ban = getBanStatus(s.username);
    if (ban) { socket.emit('force:banned', { message: banMessage(ban) }); delete sessions[token]; return null; }
    sessions[token].socketId = socket.id; socketToToken[socket.id] = token;
    return s;
  }

  socket.on('get:trades', () => {
    socket.emit('trades', Object.values(db.trades).filter(t=>t.status==='active').sort((a,b)=>b.createdAt-a.createdAt).slice(0,80).map(t => ({ ...t, authorRole: getRole(t.author) })));
  });
  socket.on('post:trade', ({ token, trade }) => {
    const s = auth(token); if (!s) return;
    const id = genId();
    const t = { ...trade, id, author: s.username, authorRole: getRole(s.username), createdAt: Date.now(), status: 'active', reqCount: 0 };
    db.trades[id] = t; io.emit('trade:new', t);
  });
  socket.on('delete:trade', ({ token, tradeId }) => {
    const s = auth(token); if (!s) return;
    const t = db.trades[tradeId];
    if (t && t.author === s.username) { t.status = 'deleted'; io.emit('trade:deleted', tradeId); }
  });
  socket.on('send:request', ({ token, toUser, tradeId, message }) => {
    const s = auth(token); if (!s) return socket.emit('err', 'Non connecte');
    if (!db.users[toUser]) return socket.emit('err', 'Utilisateur introuvable');
    const notif = { id: genId(), type: 'request', from: s.username, tradeId, message: message||'Demande de trade', ts: Date.now(), read: false, status: 'pending' };
    if (!db.notifs[toUser]) db.notifs[toUser] = {};
    db.notifs[toUser][notif.id] = notif;
    if (db.trades[tradeId]) db.trades[tradeId].reqCount = (db.trades[tradeId].reqCount||0)+1;
    const ts = findSocket(toUser); if (ts) io.to(ts).emit('notif:new', notif);
    socket.emit('request:sent', { ok: true });
  });
  socket.on('get:notifs', ({ token }) => {
    const s = auth(token); if (!s) return;
    socket.emit('notifs', Object.values(db.notifs[s.username]||{}).sort((a,b)=>b.ts-a.ts).slice(0,30));
  });
  socket.on('notifs:read', ({ token }) => {
    const s = auth(token); if (!s) return;
    if (db.notifs[s.username]) Object.values(db.notifs[s.username]).forEach(n=>n.read=true);
  });
  socket.on('notifs:clear', ({ token }) => {
    const s = auth(token); if (!s) return;
    db.notifs[s.username] = {}; socket.emit('notifs', []);
  });
  socket.on('accept:request', ({ token, notifId, fromUser, tradeId }) => {
    const s = auth(token); if (!s) return;
    const notif = db.notifs[s.username]?.[notifId]; if (!notif) return;
    notif.status = 'accepted'; notif.read = true;
    const parts = [s.username, fromUser].sort();
    const convId = parts.join('__') + '__' + tradeId + '__' + Date.now();
    db.convs[convId] = { id: convId, participants: parts, tradeId, messages: [{ id: genId(), from: '__system__', text: 'Connexion etablie ! Bonne discussion.', ts: Date.now() }], status: 'open', createdAt: Date.now() };
    parts.forEach(u => { if (!db.userConvs[u]) db.userConvs[u]={}; db.userConvs[u][convId]=true; });
    const an = { id: genId(), type: 'accepted', from: s.username, convId, tradeId, message: s.username+' a accepte ta demande !', ts: Date.now(), read: false };
    if (!db.notifs[fromUser]) db.notifs[fromUser] = {};
    db.notifs[fromUser][an.id] = an;
    const fs2 = findSocket(fromUser); if (fs2) io.to(fs2).emit('notif:new', an);
    socket.emit('conv:opened', { convId, conv: db.convs[convId] });
    socket.emit('notifs', Object.values(db.notifs[s.username]).sort((a,b)=>b.ts-a.ts));
  });
  socket.on('decline:request', ({ token, notifId }) => {
    const s = auth(token); if (!s) return;
    if (db.notifs[s.username]?.[notifId]) { db.notifs[s.username][notifId].status='declined'; db.notifs[s.username][notifId].read=true; }
    socket.emit('notifs', Object.values(db.notifs[s.username]).sort((a,b)=>b.ts-a.ts));
  });
  socket.on('delete:conv', ({ token, convId }) => {
    const s = auth(token); if (!s) return;
    const conv = db.convs[convId];
    if (!conv || !conv.participants.includes(s.username)) return;
    if (db.userConvs[s.username]) delete db.userConvs[s.username][convId];
    socket.emit('conv:deleted', convId);
    socket.emit('convs', Object.keys(db.userConvs[s.username]||{}).map(id=>db.convs[id]).filter(Boolean).sort((a,b)=>b.createdAt-a.createdAt));
  });
  socket.on('get:convs', ({ token }) => {
    const s = auth(token); if (!s) return;
    socket.emit('convs', Object.keys(db.userConvs[s.username]||{}).map(id=>db.convs[id]).filter(Boolean).sort((a,b)=>b.createdAt-a.createdAt));
  });
  socket.on('get:conv', ({ token, convId }) => {
    const s = auth(token); if (!s) return;
    const conv = db.convs[convId];
    if (!conv || !conv.participants.includes(s.username)) return;
    socket.join('conv:' + convId); socket.emit('conv', conv);
  });
  socket.on('send:msg', ({ token, convId, text }) => {
    const s = auth(token); if (!s) return;
    const conv = db.convs[convId];
    if (!conv || !conv.participants.includes(s.username) || conv.status !== 'open') return;
    const msg = { id: genId(), from: s.username, text, ts: Date.now() };
    conv.messages.push(msg); io.to('conv:' + convId).emit('msg:new', { convId, msg });
  });
  socket.on('trade:done', ({ token, convId }) => {
    const s = auth(token); if (!s) return;
    const conv = db.convs[convId]; if (!conv || !conv.participants.includes(s.username)) return;
    conv.status = 'closed'; conv.messages.push({ id: genId(), from: '__system__', text: 'Trade confirme avec succes !', ts: Date.now() });
    io.to('conv:' + convId).emit('conv:update', conv);
  });
  socket.on('trade:scam', ({ token, convId }) => {
    const s = auth(token); if (!s) return;
    const conv = db.convs[convId]; if (!conv || !conv.participants.includes(s.username)) return;
    conv.status = 'closed'; conv.messages.push({ id: genId(), from: '__system__', text: 'Signalement effectue. Ouvre un ticket Discord.', ts: Date.now() });
    io.to('conv:' + convId).emit('conv:update', conv);
  });
  socket.on('rate:good', ({ token, targetUser }) => {
    const s = auth(token); if (!s) return;
    if (db.users[targetUser]) db.users[targetUser].ratingGood = (db.users[targetUser].ratingGood||0)+1;
  });
  socket.on('disconnect', () => {
    const token = socketToToken[socket.id];
    if (token && sessions[token]) delete sessions[token].socketId;
    delete socketToToken[socket.id];
  });
});

function findSocket(username) {
  for (const [token, s] of Object.entries(sessions)) {
    if (s.username === username && s.socketId) return s.socketId;
  }
  return null;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`AOTR FR Trade Center server — port ${PORT}`));

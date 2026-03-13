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

// ── Data persistence ──────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'data.json');
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch(e) { return { users:{}, trades:{}, notifs:{}, convs:{}, userConvs:{} }; }
}
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}
let db = loadData();
setInterval(saveData, 5000); // autosave every 5s

// ── Utils ─────────────────────────────────────────────────────────
function hash(p) { return crypto.createHash('sha256').update(p + 'aotrfr_salt_2025').digest('hex'); }
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
function genToken() { return crypto.randomBytes(32).toString('hex'); }

// online users: token -> {uid, username, socketId}
const sessions = {};
const socketToToken = {};

function getUser(token) { return sessions[token] || null; }

// ── HTTP endpoints ────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'AOTR FR Trade Center — OK', users: Object.keys(db.users).length, trades: Object.values(db.trades).filter(t=>t.status==='active').length }));

app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  const u = username?.toLowerCase().replace(/\s/g,'');
  if (!u || !password) return res.json({ error: 'Champs manquants' });
  if (u.length < 3) return res.json({ error: 'Pseudo trop court (min 3)' });
  if (!/^[a-z0-9_]+$/.test(u)) return res.json({ error: 'Pseudo : lettres, chiffres, _ seulement' });
  if (password.length < 6) return res.json({ error: 'Mot de passe trop court (min 6)' });
  if (db.users[u]) return res.json({ error: 'Pseudo déjà utilisé' });
  const user = { username: u, password: hash(password), createdAt: Date.now(), ratingGood: 0, ratingBad: 0, tradeCount: 0 };
  db.users[u] = user;
  const token = genToken();
  sessions[token] = { uid: u, username: u };
  res.json({ ok: true, token, user: { username: u, createdAt: user.createdAt, ratingGood: 0, ratingBad: 0 } });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const u = username?.toLowerCase().replace(/\s/g,'');
  if (!u || !password) return res.json({ error: 'Champs manquants' });
  const user = db.users[u];
  if (!user) return res.json({ error: 'Utilisateur introuvable' });
  if (user.password !== hash(password)) return res.json({ error: 'Mot de passe incorrect' });
  const token = genToken();
  sessions[token] = { uid: u, username: u };
  res.json({ ok: true, token, user: { username: u, createdAt: user.createdAt, ratingGood: user.ratingGood||0, ratingBad: user.ratingBad||0 } });
});

app.post('/api/auth-check', (req, res) => {
  const { token } = req.body;
  const s = sessions[token];
  if (!s) return res.json({ ok: false });
  const user = db.users[s.username];
  res.json({ ok: true, user: { username: user.username, createdAt: user.createdAt, ratingGood: user.ratingGood||0 } });
});

// ── Socket.io realtime ────────────────────────────────────────────
io.on('connection', (socket) => {

  function auth(token) {
    const s = getUser(token);
    if (s) { sessions[token].socketId = socket.id; socketToToken[socket.id] = token; }
    return s;
  }

  // ── Trades ───────────────────────────────────────────────────────
  socket.on('get:trades', ({ token }) => {
    const trades = Object.values(db.trades).filter(t=>t.status==='active').sort((a,b)=>b.createdAt-a.createdAt).slice(0,80);
    socket.emit('trades', trades);
  });

  socket.on('post:trade', ({ token, trade }) => {
    const s = auth(token); if (!s) return socket.emit('err', 'Non connecté');
    const id = genId();
    const t = { ...trade, id, author: s.username, createdAt: Date.now(), status: 'active', reqCount: 0 };
    db.trades[id] = t;
    io.emit('trade:new', t); // broadcast to all
  });

  socket.on('delete:trade', ({ token, tradeId }) => {
    const s = auth(token); if (!s) return;
    const t = db.trades[tradeId];
    if (t && t.author === s.username) { t.status = 'deleted'; io.emit('trade:deleted', tradeId); }
  });

  // ── Requests / Notifs ─────────────────────────────────────────────
  socket.on('send:request', ({ token, toUser, tradeId, message }) => {
    const s = auth(token); if (!s) return socket.emit('err', 'Non connecté');
    if (!db.users[toUser]) return socket.emit('err', 'Utilisateur introuvable');
    const notif = { id: genId(), type: 'request', from: s.username, tradeId, message: message||'Demande de trade', ts: Date.now(), read: false, status: 'pending' };
    if (!db.notifs[toUser]) db.notifs[toUser] = {};
    db.notifs[toUser][notif.id] = notif;
    if (db.trades[tradeId]) db.trades[tradeId].reqCount = (db.trades[tradeId].reqCount||0)+1;
    // notify target if online
    const targetSocket = findSocket(toUser);
    if (targetSocket) io.to(targetSocket).emit('notif:new', notif);
    socket.emit('request:sent', { ok: true });
  });

  socket.on('get:notifs', ({ token }) => {
    const s = auth(token); if (!s) return;
    const notifs = Object.values(db.notifs[s.username]||{}).sort((a,b)=>b.ts-a.ts).slice(0,30);
    socket.emit('notifs', notifs);
  });

  socket.on('notifs:read', ({ token }) => {
    const s = auth(token); if (!s) return;
    if (db.notifs[s.username]) Object.values(db.notifs[s.username]).forEach(n=>n.read=true);
  });

  socket.on('notifs:clear', ({ token }) => {
    const s = auth(token); if (!s) return;
    db.notifs[s.username] = {};
    socket.emit('notifs', []);
  });

  socket.on('accept:request', ({ token, notifId, fromUser, tradeId }) => {
    const s = auth(token); if (!s) return;
    const notif = db.notifs[s.username]?.[notifId];
    if (!notif) return;
    notif.status = 'accepted'; notif.read = true;
    // Create conv
    const parts = [s.username, fromUser].sort();
    const convId = parts.join('__') + '__' + tradeId;
    if (!db.convs[convId]) {
      db.convs[convId] = { id: convId, participants: parts, tradeId, messages: [{ id: genId(), from: '__system__', text: '✅ Connexion établie ! Bonne discussion.', ts: Date.now() }], status: 'open', createdAt: Date.now() };
      parts.forEach(u => { if (!db.userConvs[u]) db.userConvs[u]={}; db.userConvs[u][convId]=true; });
    }
    // Notify requester
    const acceptNotif = { id: genId(), type: 'accepted', from: s.username, convId, tradeId, message: s.username+' a accepté ta demande !', ts: Date.now(), read: false };
    if (!db.notifs[fromUser]) db.notifs[fromUser] = {};
    db.notifs[fromUser][acceptNotif.id] = acceptNotif;
    const fromSocket = findSocket(fromUser);
    if (fromSocket) io.to(fromSocket).emit('notif:new', acceptNotif);
    socket.emit('conv:opened', { convId, conv: db.convs[convId] });
    // update notifs list
    const notifs = Object.values(db.notifs[s.username]).sort((a,b)=>b.ts-a.ts);
    socket.emit('notifs', notifs);
  });

  socket.on('decline:request', ({ token, notifId }) => {
    const s = auth(token); if (!s) return;
    if (db.notifs[s.username]?.[notifId]) { db.notifs[s.username][notifId].status='declined'; db.notifs[s.username][notifId].read=true; }
    const notifs = Object.values(db.notifs[s.username]).sort((a,b)=>b.ts-a.ts);
    socket.emit('notifs', notifs);
  });

  // ── Messages ─────────────────────────────────────────────────────
  socket.on('get:convs', ({ token }) => {
    const s = auth(token); if (!s) return;
    const ids = Object.keys(db.userConvs[s.username]||{});
    const convs = ids.map(id=>db.convs[id]).filter(Boolean).sort((a,b)=>b.createdAt-a.createdAt);
    socket.emit('convs', convs);
  });

  socket.on('get:conv', ({ token, convId }) => {
    const s = auth(token); if (!s) return;
    const conv = db.convs[convId];
    if (!conv || !conv.participants.includes(s.username)) return;
    socket.join('conv:' + convId);
    socket.emit('conv', conv);
  });

  socket.on('send:msg', ({ token, convId, text }) => {
    const s = auth(token); if (!s) return;
    const conv = db.convs[convId];
    if (!conv || !conv.participants.includes(s.username) || conv.status !== 'open') return;
    const msg = { id: genId(), from: s.username, text, ts: Date.now() };
    conv.messages.push(msg);
    io.to('conv:' + convId).emit('msg:new', { convId, msg });
  });

  socket.on('trade:done', ({ token, convId }) => {
    const s = auth(token); if (!s) return;
    const conv = db.convs[convId];
    if (!conv || !conv.participants.includes(s.username)) return;
    conv.status = 'closed';
    const msg = { id: genId(), from: '__system__', text: '✅ Trade confirmé avec succès !', ts: Date.now() };
    conv.messages.push(msg);
    io.to('conv:' + convId).emit('conv:update', conv);
  });

  socket.on('trade:scam', ({ token, convId }) => {
    const s = auth(token); if (!s) return;
    const conv = db.convs[convId];
    if (!conv || !conv.participants.includes(s.username)) return;
    conv.status = 'closed';
    const msg = { id: genId(), from: '__system__', text: '🚨 Signalement effectué. Ouvre un ticket Discord.', ts: Date.now() };
    conv.messages.push(msg);
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
server.listen(PORT, () => console.log(`AOTR FR Trade Center server running on port ${PORT}`));

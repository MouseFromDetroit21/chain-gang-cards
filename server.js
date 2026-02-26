const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  transports: ['websocket','polling']
});

const JWT_SECRET = process.env.JWT_SECRET || 'chaingangpoker_secret_2024';
const PORT = process.env.PORT || 3000;

// ── DATABASE ──────────────────────────────────────────────
const dbFile = path.join(__dirname, 'db.json');
if (!fs.existsSync(dbFile)) fs.writeFileSync(dbFile, JSON.stringify({ users: [], games: [] }));
const adapter = new FileSync(dbFile);
const db = low(adapter);
db.defaults({ users: [], games: [] }).write();

// ── MIDDLEWARE ────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: Date.now() }));

// Catch-all: always serve index.html for unknown routes
app.get('*path', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── AUTH ROUTES ───────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  const { username, password, avatar } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  const exists = db.get('users').find({ username: username.toLowerCase() }).value();
  if (exists) return res.status(400).json({ error: 'Username already taken' });
  const hash = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(),
    username: username.toLowerCase(),
    displayName: username,
    password: hash,
    avatar: avatar || '🎴',
    chips: 1000,
    wins: 0,
    losses: 0,
    createdAt: Date.now()
  };
  db.get('users').push(user).write();
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: safeUser(user) });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = db.get('users').find({ username: username?.toLowerCase() }).value();
  if (!user) return res.status(400).json({ error: 'Invalid username or password' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: 'Invalid username or password' });
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: safeUser(user) });
});

app.get('/api/profile', authMiddleware, (req, res) => {
  const user = db.get('users').find({ id: req.userId }).value();
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(safeUser(user));
});

app.post('/api/profile/avatar', authMiddleware, (req, res) => {
  const { avatar } = req.body;
  db.get('users').find({ id: req.userId }).assign({ avatar }).write();
  res.json({ ok: true });
});

function safeUser(u) {
  return { id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar, chips: u.chips, wins: u.wins, losses: u.losses };
}
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { const d = jwt.verify(token, JWT_SECRET); req.userId = d.id; next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ── GAME ENGINE ───────────────────────────────────────────
const SUITS = ['♠','♥','♦','♣'];
const VALS  = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const VRANK = {2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14};
const LRANK = {A:1,2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13};

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const v of VALS) d.push({ v, s });
  return d;
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = 0 | Math.random() * (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function evalHigh(hand) {
  const vs = hand.map(c => VRANK[c.v]).sort((a, b) => b - a);
  const ss = hand.map(c => c.s);
  const vc = {}; for (const v of vs) vc[v] = (vc[v] || 0) + 1;
  const cnts = Object.values(vc).sort((a, b) => b - a);
  const flush = ss.every(s => s === ss[0]);
  const str = (vs[0] - vs[4] === 4 && new Set(vs).size === 5) ||
    (vs[0] === 14 && vs[1] === 5 && vs[2] === 4 && vs[3] === 3 && vs[4] === 2);
  const byF = Object.entries(vc).sort((a, b) => b[1] - a[1] || b[0] - a[0]).map(e => +e[0]);
  if (flush && str) return { r: 8, n: 'Straight Flush', tb: vs };
  if (cnts[0] === 4) return { r: 7, n: 'Four of a Kind', tb: byF };
  if (cnts[0] === 3 && cnts[1] === 2) return { r: 6, n: 'Full House', tb: byF };
  if (flush) return { r: 5, n: 'Flush', tb: vs };
  if (str) return { r: 4, n: 'Straight', tb: vs };
  if (cnts[0] === 3) return { r: 3, n: 'Three of a Kind', tb: byF };
  if (cnts[0] === 2 && cnts[1] === 2) return { r: 2, n: 'Two Pair', tb: byF };
  if (cnts[0] === 2) return { r: 1, n: 'Pair', tb: byF };
  return { r: 0, n: 'High Card', tb: vs };
}
function evalLow(hand) {
  const vs = hand.map(c => LRANK[c.v]);
  if (new Set(vs).size < 5) return null;
  return vs.sort((a, b) => b - a);
}
function cmpHigh(a, b) {
  if (!a && !b) return 0; if (!a) return 1; if (!b) return -1;
  if (a.r !== b.r) return b.r - a.r;
  for (let i = 0; i < a.tb.length; i++) if (a.tb[i] !== b.tb[i]) return b.tb[i] - a.tb[i];
  return 0;
}
function cmpLow(a, b) {
  if (!a && !b) return 0; if (!a) return 1; if (!b) return -1;
  for (let i = 0; i < 5; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
function combos(arr, k) {
  if (k === 0) return [[]]; if (k > arr.length) return [];
  const res = [];
  function go(s, cur) {
    if (cur.length === k) { res.push([...cur]); return; }
    for (let i = s; i < arr.length; i++) { cur.push(arr[i]); go(i + 1, cur); cur.pop(); }
  }
  go(0, []); return res;
}
function bestHand(hole, cols) {
  const pC = cols.flatMap(col => col.pair.map(c => ({ card: c, t: 'p' })));
  const sC = cols.map(col => ({ card: col.single, t: 's' }));
  const all = [...pC, ...sC];
  let bH = null, bHC = [], bL = null, bLC = [];
  for (let k = 0; k <= Math.min(5, all.length); k++) {
    const hn = 5 - k; if (hn > hole.length || hn < 0) continue;
    let cSubs;
    if (k === 0) { cSubs = [[]]; }
    else {
      cSubs = [];
      const go = (s, cur) => {
        if (cur.length === k) {
          if (cur.some(c => c.t === 'p') && cur.some(c => c.t === 's')) cSubs.push([...cur]);
          return;
        }
        for (let i = s; i < all.length; i++) { cur.push(all[i]); go(i + 1, cur); cur.pop(); }
      };
      go(0, []);
    }
    const hS = combos(hole, hn);
    for (const cs of cSubs) for (const hs of hS) {
      const h = [...hs, ...cs.map(c => c.card)];
      if (h.length !== 5) continue;
      const hr = evalHigh(h);
      if (!bH || cmpHigh(hr, bH) < 0) { bH = hr; bHC = h; }
      const lr = evalLow(h);
      if (lr && (!bL || cmpLow(lr, bL) < 0)) { bL = lr; bLC = h; }
    }
  }
  return { high: bH, highCards: bHC, low: bL, lowCards: bLC };
}

// ── ROOMS ─────────────────────────────────────────────────
const rooms = {}; // roomId -> room object
const socketUser = {}; // socketId -> { userId, username, displayName, avatar, chips }
const userSocket = {}; // userId -> socketId

function createRoom(isPrivate = false) {
  const id = isPrivate
    ? Math.random().toString(36).substr(2, 6).toUpperCase()
    : uuidv4();
  rooms[id] = {
    id,
    isPrivate,
    players: [], // { userId, username, displayName, avatar, chips, hand, bet, folded, decl, ready }
    spectators: [],
    state: null,
    phase: 'waiting', // waiting, ante, pairs, draw, bet1, bet2, decl, bet3, showdown
    pot: 0,
    currentBet: 0,
    ante: 10,
    cols: [],
    deck: [],
    deckIdx: 0,
    log: [],
    drawTimeout: null,
    betTimeout: null,
    declTimeout: null,
    createdAt: Date.now()
  };
  return rooms[id];
}

function publicRoom() {
  // Find a waiting public room with < 5 players
  const r = Object.values(rooms).find(r => !r.isPrivate && r.phase === 'waiting' && r.players.length < 5);
  return r || createRoom(false);
}

function broadcastRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  // Send each player their private state
  room.players.forEach(p => {
    const sid = userSocket[p.userId];
    if (!sid) return;
    io.to(sid).emit('gameState', sanitizeForPlayer(room, p.userId));
  });
  room.spectators.forEach(sid => {
    io.to(sid).emit('gameState', sanitizeForSpectator(room));
  });
}

function sanitizeForPlayer(room, userId) {
  const me = room.players.find(p => p.userId === userId);

  // Calculate best hand based on currently visible board cards
  let myBestHand = null;
  if (me && me.hand && me.hand.length > 0) {
    const visibleCols = phaseCols(room);
    const hasPairs = visibleCols.some(c => c.pair[0] !== null);
    const hasSingles = visibleCols.some(c => c.single !== null);
    if (hasPairs && hasSingles) {
      const evalCols = visibleCols
        .map(col => ({ pair: col.pair.filter(Boolean), single: col.single }))
        .filter(col => col.pair.length > 0 && col.single);
      if (evalCols.length > 0) {
        try {
          const best = bestHand(me.hand, evalCols);
          myBestHand = {
            highName: best.high ? best.high.n : null,
            highCards: best.highCards ? best.highCards.map(c => c.v + c.s) : [],
            lowCards: best.lowCards ? best.lowCards.map(c => c.v + c.s) : [],
            hasLow: best.low !== null
          };
        } catch(e) { myBestHand = null; }
      }
    }
  }

  return {
    roomId: room.id,
    isPrivate: room.isPrivate,
    phase: room.phase,
    pot: room.pot,
    currentBet: room.currentBet,
    ante: room.ante,
    cols: phaseCols(room),
    log: room.log.slice(0, 15),
    myHand: me ? me.hand : [],
    myBet: me ? me.bet : 0,
    myDecl: me ? me.decl : null,
    myFolded: me ? me.folded : false,
    mySelectedDraw: me ? me.selectedDraw : [],
    myBestHand,
    players: room.players.map(p => ({
      userId: p.userId,
      username: p.username,
      displayName: p.displayName,
      avatar: p.avatar,
      chips: p.chips,
      bet: p.bet,
      folded: p.folded,
      decl: p.decl,
      cardCount: p.hand ? p.hand.length : 0,
      isMe: p.userId === userId,
      ready: p.ready,
      acted: p.acted
    })),
    currentTurn: room.currentTurn,
    winner: room.winner || null
  };
}

function sanitizeForSpectator(room) {
  return {
    roomId: room.id,
    phase: room.phase,
    pot: room.pot,
    cols: phaseCols(room),
    log: room.log.slice(0, 15),
    players: room.players.map(p => ({
      username: p.username, displayName: p.displayName, avatar: p.avatar,
      chips: p.chips, bet: p.bet, folded: p.folded, decl: p.decl,
      cardCount: p.hand?.length || 0
    }))
  };
}

function phaseCols(room) {
  const pairsUp = ['draw','bet1','bet2','bet3','decl','showdown'].includes(room.phase);
  const singlesUp = ['bet2','bet3','decl','showdown'].includes(room.phase);
  const factorUp = ['decl','bet3','showdown'].includes(room.phase);
  return room.cols.map((col, i) => ({
    pair: pairsUp ? col.pair : [null, null],
    single: (i === 2 ? factorUp : singlesUp) ? col.single : null
  }));
}

function addLog(room, msg, type = 'act') {
  room.log.unshift({ msg, type, ts: Date.now() });
  if (room.log.length > 30) room.log.pop();
}

// ── GAME FLOW ─────────────────────────────────────────────
function startGame(roomId) {
  const room = rooms[roomId];
  if (!room || room.players.length < 2) return;

  // Fresh shuffle every single hand
  const deck = shuffle(makeDeck());
  let idx = 0;
  const deal = n => { const c = deck.slice(idx, idx + n); idx += n; return c; };

  room.deck = deck;
  room.pot = 0;
  room.currentBet = 0;

  // Deal community board first: 5 cols x (2 pair cards + 1 single) = 15 cards
  room.cols = Array.from({ length: 5 }, () => ({ pair: deal(2), single: deal(1)[0] }));

  // Deal 5 hole cards to each active player
  room.players.forEach(p => {
    p.hand = deal(5);
    p.bet = 0;
    p.folded = false;
    p.decl = null;
    p.selectedDraw = [];
    p.ready = false;
    p.drawDone = false;
    p.acted = false;
  });

  // Save deck index so draw phase can pull from remaining cards
  room.deckIdx = idx;

  room.phase = 'ante';
  room.log = [];
  addLog(room, `🃏 Fresh deck shuffled. ${room.players.length} players dealt in. Post your ante!`, 'imp');
  broadcastRoom(roomId);
}

function checkAllAnted(roomId) {
  const room = rooms[roomId];
  const active = room.players.filter(p => !p.folded);
  if (active.every(p => p.ready)) {
    active.forEach(p => { p.ready = false; });
    room.phase = 'pairs';
    addLog(room, '⛓ Pairs are on the board! Draw phase coming...', 'imp');
    broadcastRoom(roomId);
    // Auto-advance to draw after 2s
    setTimeout(() => {
      room.phase = 'draw';
      room.drawDeadline = Date.now() + 30000; // 30s to draw
      addLog(room, 'Pick up to 2 cards to swap. You have 30 seconds.', 'imp');
      broadcastRoom(roomId);
      room.drawTimeout = setTimeout(() => autoConfirmDraws(roomId), 30000);
    }, 2000);
  }
}

function autoConfirmDraws(roomId) {
  const room = rooms[roomId];
  if (room.phase !== 'draw') return;
  room.players.forEach(p => { if (!p.folded && !p.drawDone) confirmDraw(room, p.userId, []); });
}

function confirmDraw(room, userId, selected) {
  const p = room.players.find(p => p.userId === userId);
  if (!p || p.drawDone) return;
  const dis = [...selected].sort((a, b) => b - a);
  const nc = room.deck.slice(room.deckIdx, room.deckIdx + dis.length);
  room.deckIdx += dis.length;
  dis.forEach(i => p.hand.splice(i, 1));
  p.hand.push(...nc);
  p.drawDone = true;
  addLog(room, `${p.displayName} drew ${dis.length} card(s).`);
  broadcastRoom(room.id);
  // Check if all drew
  const active = room.players.filter(p => !p.folded);
  if (active.every(p => p.drawDone)) {
    clearTimeout(room.drawTimeout);
    active.forEach(p => { p.drawDone = false; });
    startBetting(room, 'bet1');
  }
}

function startBetting(room, phase) {
  room.phase = phase;
  room.currentBet = 0;
  room.players.forEach(p => { p.bet = 0; p.acted = false; });
  // Find first non-folded player
  room.currentTurn = room.players.findIndex(p => !p.folded);
  const timeLimit = 30000;
  room.betDeadline = Date.now() + timeLimit;
  addLog(room, phase === 'bet1' ? 'Betting round 1.' : phase === 'bet2' ? 'Singles revealed! Bet now.' : 'Final betting round!', 'imp');
  broadcastRoom(room.id);
  room.betTimeout = setTimeout(() => autoFold(room.id), timeLimit);
}

function autoFold(roomId) {
  const room = rooms[roomId];
  if (!['bet1','bet2','bet3'].includes(room.phase)) return;
  const p = room.players[room.currentTurn];
  if (p && !p.folded && !p.acted) {
    p.folded = true;
    addLog(room, `${p.displayName} timed out and folded.`);
    advanceTurn(room);
  }
}

function playerBetAction(roomId, userId, action, amount) {
  const room = rooms[roomId];
  if (!room) return;
  const pIdx = room.players.findIndex(p => p.userId === userId);
  if (pIdx !== room.currentTurn) return; // not their turn
  const p = room.players[pIdx];
  if (p.folded || p.acted) return;
  clearTimeout(room.betTimeout);

  if (action === 'fold') {
    p.folded = true;
    addLog(room, `${p.displayName} folds.`);
  } else if (action === 'check') {
    if (room.currentBet > 0) return;
    addLog(room, `${p.displayName} checks.`);
  } else if (action === 'call') {
    const amt = Math.min(room.currentBet - p.bet, p.chips);
    p.chips -= amt; room.pot += amt; p.bet = room.currentBet;
    addLog(room, `${p.displayName} calls $${amt}.`);
  } else if (action === 'raise') {
    const amt = Math.min(amount, p.chips);
    if (amt <= room.currentBet) return;
    p.chips -= amt; room.pot += amt; room.currentBet = amt; p.bet = amt;
    // Reset others
    room.players.forEach((op, i) => { if (i !== pIdx && !op.folded) op.acted = false; });
    addLog(room, `${p.displayName} raises to $${amt}.`, 'imp');
  }
  p.acted = true;
  advanceTurn(room);
}

function advanceTurn(room) {
  const active = room.players.filter(p => !p.folded);
  // Check early win
  if (active.length <= 1) { earlyWin(room); return; }
  // Find next unacted player
  let next = (room.currentTurn + 1) % room.players.length;
  let loops = 0;
  while ((room.players[next].folded || room.players[next].acted) && loops < room.players.length) {
    next = (next + 1) % room.players.length;
    loops++;
  }
  if (loops >= room.players.length || room.players[next].folded || room.players[next].acted) {
    // Betting done
    endBettingRound(room);
  } else {
    room.currentTurn = next;
    room.betDeadline = Date.now() + 30000;
    broadcastRoom(room.id);
    room.betTimeout = setTimeout(() => autoFold(room.id), 30000);
  }
  broadcastRoom(room.id);
}

function endBettingRound(room) {
  clearTimeout(room.betTimeout);
  if (room.phase === 'bet1') {
    room.phase = 'bet2';
    addLog(room, 'Singles revealed! Study the board.', 'imp');
    broadcastRoom(room.id);
    setTimeout(() => startBetting(room, 'bet2'), 1500);
  } else if (room.phase === 'bet2') {
    room.phase = 'decl';
    room.declDeadline = Date.now() + 30000;
    addLog(room, '⚡ FACTOR CARD IS LIVE! Declare: High, Low, or Swing!', 'imp');
    broadcastRoom(room.id);
    room.declTimeout = setTimeout(() => autoDecl(room.id), 30000);
  } else if (room.phase === 'bet3') {
    doShowdown(room);
  }
}

function autoDecl(roomId) {
  const room = rooms[roomId];
  if (room.phase !== 'decl') return;
  room.players.forEach(p => {
    if (!p.folded && !p.decl) {
      p.decl = 'high';
      addLog(room, `${p.displayName} timed out — declared HIGH.`);
    }
  });
  checkAllDeclared(room);
}

function playerDeclare(roomId, userId, decl) {
  const room = rooms[roomId];
  if (!room || room.phase !== 'decl') return;
  const p = room.players.find(p => p.userId === userId);
  if (!p || p.folded || p.decl) return;
  p.decl = decl;
  addLog(room, `${p.displayName} declares ${decl.toUpperCase()}!`, 'imp');
  broadcastRoom(room.id);
  checkAllDeclared(room);
}

function checkAllDeclared(room) {
  const active = room.players.filter(p => !p.folded);
  if (active.every(p => p.decl)) {
    clearTimeout(room.declTimeout);
    startBetting(room, 'bet3');
  }
}

function doShowdown(room) {
  room.phase = 'showdown';
  const factor = room.cols[2].single;
  const players = room.players.filter(p => !p.folded).map(p => ({
    ...p, best: bestHand(p.hand, room.cols)
  }));
  const highP = players.filter(p => p.decl === 'high' || p.decl === 'swing');
  const lowP  = players.filter(p => p.decl === 'low'  || p.decl === 'swing');
  let hWin = null, lWin = null;
  if (highP.length) { highP.sort((a,b) => cmpHigh(a.best.high, b.best.high)); hWin = highP[0]; }
  if (lowP.length) {
    const q = lowP.filter(p => p.best.low);
    if (q.length) {
      q.sort((a,b) => cmpLow(a.best.low, b.best.low));
      if (q.length > 1 && cmpLow(q[0].best.low, q[1].best.low) === 0) {
        const fs = factor.s;
        const a0 = q[0].best.lowCards.some(c => c.s === fs);
        const a1 = q[1].best.lowCards.some(c => c.s === fs);
        lWin = a0 && !a1 ? q[0] : !a0 && a1 ? q[1] : q[0];
      } else lWin = q[0];
    }
  }
  // Swing penalty
  players.forEach(p => {
    if (p.decl === 'swing') {
      const wh = hWin?.userId === p.userId, wl = lWin?.userId === p.userId;
      if (!wh || !wl) {
        if (hWin?.userId === p.userId) hWin = null;
        if (lWin?.userId === p.userId) lWin = null;
        addLog(room, `${p.displayName} swung and LOST — forfeits both pots!`, 'imp');
      }
    }
  });
  const half = Math.floor(room.pot / 2);
  const results = [];
  if (hWin) {
    const dbUser = db.get('users').find({ id: hWin.userId }).value();
    if (dbUser) { db.get('users').find({ id: hWin.userId }).assign({ chips: dbUser.chips + half, wins: dbUser.wins + 1 }).write(); }
    const rp = room.players.find(p => p.userId === hWin.userId);
    if (rp) rp.chips += half;
    addLog(room, `🏆 HIGH ($${half}): ${hWin.displayName} — ${hWin.best.high?.n}`, 'win');
    results.push({ type: 'high', winner: hWin.displayName, amount: half, hand: hWin.best.high?.n });
  } else {
    addLog(room, 'HIGH POT: No winner.');
  }
  if (lWin) {
    const dbUser = db.get('users').find({ id: lWin.userId }).value();
    if (dbUser) { db.get('users').find({ id: lWin.userId }).assign({ chips: dbUser.chips + half }).write(); }
    const rp = room.players.find(p => p.userId === lWin.userId);
    if (rp) rp.chips += half;
    addLog(room, `🎯 LOW ($${half}): ${lWin.displayName} — ${lWin.best.lowCards?.map(c=>c.v+c.s).join(' ')}`, 'win');
    results.push({ type: 'low', winner: lWin.displayName, amount: half, cards: lWin.best.lowCards?.map(c=>c.v+c.s).join(' ') });
  } else {
    addLog(room, 'LOW POT: No qualified low hand.');
  }
  addLog(room, `⚡ Factor Card: ${factor.v}${factor.s}`, 'imp');
  // Update losses
  room.players.forEach(p => {
    if (!p.folded && p.userId !== hWin?.userId && p.userId !== lWin?.userId) {
      const dbUser = db.get('users').find({ id: p.userId }).value();
      if (dbUser) db.get('users').find({ id: p.userId }).assign({ losses: dbUser.losses + 1 }).write();
    }
  });
  room.showdownResults = results;
  room.showdownHands = players.map(p => ({ name: p.displayName, decl: p.decl, highHand: p.best.high?.n, lowCards: p.best.lowCards?.map(c=>c.v+c.s).join(' ') }));
  broadcastRoom(room.id);
  // Auto restart after 10s
  setTimeout(() => {
    if (rooms[room.id]) {
      room.players.forEach(p => { p.folded = false; p.decl = null; p.ready = false; p.drawDone = false; });
      startGame(room.id);
    }
  }, 10000);
}

function earlyWin(room) {
  const alive = room.players.filter(p => !p.folded);
  if (alive.length === 1) {
    const w = alive[0];
    const dbUser = db.get('users').find({ id: w.userId }).value();
    if (dbUser) { db.get('users').find({ id: w.userId }).assign({ chips: dbUser.chips + room.pot, wins: dbUser.wins + 1 }).write(); }
    w.chips += room.pot;
    addLog(room, `${w.displayName} wins $${room.pot} — everyone else folded!`, 'win');
    room.phase = 'showdown';
    broadcastRoom(room.id);
    setTimeout(() => {
      if (rooms[room.id]) {
        room.players.forEach(p => { p.folded = false; p.decl = null; p.ready = false; p.drawDone = false; });
        startGame(room.id);
      }
    }, 5000);
  }
}

// ── SOCKET.IO ─────────────────────────────────────────────
io.on('connection', socket => {
  console.log('Socket connected:', socket.id);

  socket.on('auth', ({ token }) => {
    try {
      const data = jwt.verify(token, JWT_SECRET);
      const user = db.get('users').find({ id: data.id }).value();
      if (!user) return socket.emit('authError', 'User not found');
      socketUser[socket.id] = { userId: user.id, username: user.username, displayName: user.displayName, avatar: user.avatar, chips: user.chips };
      userSocket[user.id] = socket.id;
      socket.emit('authOk', safeUser(user));
    } catch { socket.emit('authError', 'Invalid token'); }
  });

  socket.on('joinPublic', () => {
    const u = socketUser[socket.id];
    if (!u) { socket.emit('lobbyError', 'Not signed in — please refresh and log in again.'); return; }
    leaveCurrentRoom(socket);
    const room = publicRoom();
    joinRoom(socket, room, u);
  });

  socket.on('createPrivate', () => {
    const u = socketUser[socket.id];
    if (!u) { socket.emit('lobbyError', 'Not signed in — please refresh and log in again.'); return; }
    leaveCurrentRoom(socket);
    const room = createRoom(true);
    joinRoom(socket, room, u);
    socket.emit('privateCode', room.id);
  });

  socket.on('joinPrivate', ({ code }) => {
    const u = socketUser[socket.id];
    if (!u) { socket.emit('lobbyError', 'Not signed in — please refresh and log in again.'); return; }
    const room = rooms[code?.toUpperCase()];
    if (!room) { socket.emit('lobbyError', 'Room not found. Double-check the code.'); return; }
    if (room.players.length >= 5) { socket.emit('lobbyError', 'Table is full (max 5 players).'); return; }
    leaveCurrentRoom(socket);
    joinRoom(socket, room, u);
  });

  socket.on('ante', () => {
    const u = socketUser[socket.id];
    if (!u) return;
    const roomId = socket.roomId;
    const room = rooms[roomId];
    if (!room || room.phase !== 'ante') return;
    const p = room.players.find(p => p.userId === u.userId);
    if (!p || p.ready) return;
    if (p.chips < room.ante) return socket.emit('error', 'Not enough chips!');
    p.chips -= room.ante;
    room.pot += room.ante;
    p.ready = true;
    addLog(room, `${p.displayName} posted ante $${room.ante}.`);
    broadcastRoom(roomId);
    checkAllAnted(roomId);
  });

  socket.on('selectDraw', ({ selected }) => {
    const u = socketUser[socket.id];
    if (!u) return;
    const room = rooms[socket.roomId];
    if (!room || room.phase !== 'draw') return;
    const p = room.players.find(p => p.userId === u.userId);
    if (!p) return;
    p.selectedDraw = (selected || []).slice(0, 2);
    broadcastRoom(socket.roomId);
  });

  socket.on('confirmDraw', ({ selected }) => {
    const u = socketUser[socket.id];
    if (!u) return;
    const room = rooms[socket.roomId];
    if (!room || room.phase !== 'draw') return;
    confirmDraw(room, u.userId, selected || []);
  });

  socket.on('betAction', ({ action, amount }) => {
    const u = socketUser[socket.id];
    if (!u) return;
    playerBetAction(socket.roomId, u.userId, action, amount);
  });

  socket.on('declare', ({ decl }) => {
    const u = socketUser[socket.id];
    if (!u) return;
    if (!['high','low','swing'].includes(decl)) return;
    playerDeclare(socket.roomId, u.userId, decl);
  });

  socket.on('chat', ({ msg }) => {
    const u = socketUser[socket.id];
    if (!u || !msg) return;
    const room = rooms[socket.roomId];
    if (!room) return;
    const clean = msg.slice(0, 100);
    io.to(socket.roomId).emit('chat', { from: u.displayName, avatar: u.avatar, msg: clean });
  });

  socket.on('disconnect', () => {
    const u = socketUser[socket.id];
    if (u) {
      delete userSocket[u.userId];
      const room = rooms[socket.roomId];
      if (room) {
        const p = room.players.find(p => p.userId === u.userId);
        if (p) { p.folded = true; addLog(room, `${p.displayName} disconnected.`); broadcastRoom(socket.roomId); }
      }
    }
    delete socketUser[socket.id];
  });

  function leaveCurrentRoom(socket) {
    if (socket.roomId && rooms[socket.roomId]) {
      socket.leave(socket.roomId);
      const room = rooms[socket.roomId];
      room.players = room.players.filter(p => p.userId !== socketUser[socket.id]?.userId);
      if (room.players.length === 0) delete rooms[socket.roomId];
    }
    socket.roomId = null;
  }

  function joinRoom(socket, room, u) {
    const dbUser = db.get('users').find({ id: u.userId }).value();
    room.players.push({
      userId: u.userId, username: u.username, displayName: u.displayName,
      avatar: u.avatar, chips: dbUser?.chips || u.chips,
      hand: [], bet: 0, folded: false, decl: null, ready: false, selectedDraw: [], drawDone: false, acted: false
    });
    socket.join(room.id);
    socket.roomId = room.id;
    socket.emit('joinedRoom', { roomId: room.id, isPrivate: room.isPrivate });
    addLog(room, `${u.displayName} joined the table.`, 'imp');
    broadcastRoom(room.id);
    // Start when 2+ players and all in waiting
    if (room.players.length >= 2 && room.phase === 'waiting') {
      setTimeout(() => { if (rooms[room.id] && room.players.length >= 2 && room.phase === 'waiting') startGame(room.id); }, 3000);
    }
  }
});

server.listen(PORT, () => console.log(`Chain Gang Poker running on port ${PORT}`));

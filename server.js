const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
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

const dbFile = path.join(__dirname, 'db.json');
function loadDb() {
  if (!fs.existsSync(dbFile)) fs.writeFileSync(dbFile, JSON.stringify({ users: [] }));
  try { return JSON.parse(fs.readFileSync(dbFile, 'utf8')); }
  catch(e) { return { users: [] }; }
}
function saveDb(data) { fs.writeFileSync(dbFile, JSON.stringify(data, null, 2)); }
const db = {
  _data: loadDb(),
  getUsers() { return this._data.users || []; },
  findUser(fn) { return this.getUsers().find(fn); },
  addUser(u) { this._data.users.push(u); saveDb(this._data); },
  updateUser(id, changes) {
    const idx = this._data.users.findIndex(u => u.id === id);
    if (idx >= 0) { Object.assign(this._data.users[idx], changes); saveDb(this._data); }
  }
};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

function safeUser(u) {
  return { id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar, chips: u.chips, wins: u.wins, losses: u.losses };
}
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { const d = jwt.verify(token, JWT_SECRET); req.userId = d.id; next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}
app.post('/api/register', async (req, res) => {
  const { username, password, avatar } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
  if (db.findUser(u => u.username === username.toLowerCase())) return res.status(400).json({ error: 'Username already taken' });
  const hash = await bcrypt.hash(password, 10);
  const user = { id: uuidv4(), username: username.toLowerCase(), displayName: username, password: hash, avatar: avatar || '🎴', chips: 1000, wins: 0, losses: 0, createdAt: Date.now() };
  db.addUser(user);
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: safeUser(user) });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = db.findUser(u => u.username === username?.toLowerCase());
  if (!user) return res.status(400).json({ error: 'Invalid username or password' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: 'Invalid username or password' });
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: safeUser(user) });
});

app.get('/api/profile', authMiddleware, (req, res) => {
  const user = db.findUser(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(safeUser(user));
});
const SUITS = ['♠','♥','♦','♣'];
const VALS  = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const VRANK = {2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14};
const LRANK = {A:1,2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13};

function makeDeck() {
  const d=[];
  for(const s of SUITS) for(const v of VALS) d.push({v,s});
  return d;
}
function shuffle(arr) {
  const a=[...arr];
  for(let i=a.length-1;i>0;i--){
    const j=0|Math.random()*(i+1);
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}
function combos(arr,k) {
  if(k===0)return[[]];if(k>arr.length)return[];
  const res=[];
  function go(s,cur){
    if(cur.length===k){res.push([...cur]);return;}
    for(let i=s;i<arr.length;i++){cur.push(arr[i]);go(i+1,cur);cur.pop();}
  }
  go(0,[]);return res;
}
function evalHigh(hand) {
  const vs=hand.map(c=>VRANK[c.v]).sort((a,b)=>b-a);
  const ss=hand.map(c=>c.s);
  const vc={}; for(const v of vs) vc[v]=(vc[v]||0)+1;
  const cnts=Object.values(vc).sort((a,b)=>b-a);
  const flush=ss.every(s=>s===ss[0]);
  const str=(vs[0]-vs[4]===4&&new Set(vs).size===5)||(vs[0]===14&&vs[1]===5&&vs[2]===4&&vs[3]===3&&vs[4]===2);
  const byF=Object.entries(vc).sort((a,b)=>b[1]-a[1]||b[0]-a[0]).map(e=>+e[0]);
  if(flush&&str) return{r:8,n:'Straight Flush',tb:vs};
  if(cnts[0]===4) return{r:7,n:'Four of a Kind',tb:byF};
  if(cnts[0]===3&&cnts[1]===2) return{r:6,n:'Full House',tb:byF};
  if(flush) return{r:5,n:'Flush',tb:vs};
  if(str) return{r:4,n:'Straight',tb:vs};
  if(cnts[0]===3) return{r:3,n:'Three of a Kind',tb:byF};
  if(cnts[0]===2&&cnts[1]===2) return{r:2,n:'Two Pair',tb:byF};
  if(cnts[0]===2) return{r:1,n:'Pair',tb:byF};
  return{r:0,n:'High Card',tb:vs};
}
function evalLow(hand) {
  const vs=hand.map(c=>LRANK[c.v]);
  if(new Set(vs).size<5) return null;
  return vs.sort((a,b)=>b-a);
}
function cmpHigh(a,b) {
  if(!a&&!b)return 0;if(!a)return 1;if(!b)return-1;
  if(a.r!==b.r)return b.r-a.r;
  for(let i=0;i<a.tb.length;i++)if(a.tb[i]!==b.tb[i])return b.tb[i]-a.tb[i];
  return 0;
}
function cmpLow(a,b) {
  if(!a&&!b)return 0;if(!a)return 1;if(!b)return-1;
  for(let i=0;i<5;i++)if(a[i]!==b[i])return a[i]-b[i];
  return 0;
}
function bestHand(hole,cols) {
  const availPairs=cols.map((col,i)=>({cards:col.pair,colIdx:i})).filter(c=>c.cards&&c.cards[0]&&c.cards[1]);
  const availSingles=cols.map((col,i)=>({card:col.single,colIdx:i})).filter(c=>c.card);
  if(availPairs.length===0||availSingles.length===0) return{high:null,highCards:[],low:null,lowCards:[]};
  let bH=null,bHC=[],bL=null,bLC=[];
  const holeCombos=combos(hole,2);
  for(const hc of holeCombos){
    for(const pair of availPairs){
      for(const single of availSingles){
        const hand=[...hc,...pair.cards,single.card];
        if(hand.length!==5)continue;
        const hr=evalHigh(hand);
        if(!bH||cmpHigh(hr,bH)<0){bH=hr;bHC=hand;}
        const lr=evalLow(hand);
        if(lr&&(!bL||cmpLow(lr,bL)<0)){bL=lr;bLC=hand;}
      }
    }
  }
  return{high:bH,highCards:bHC,low:bL,lowCards:bLC};
}
const BDRANK_HIGH={A:14,K:13,Q:12,J:11,10:10,9:9,8:8,7:7,6:6,5:5,4:4,3:3,2:2};
const BDRANK_LOW ={A:1,2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13};

function isBadugi(hand) {
  const suits=hand.map(c=>c.s);
  const ranks=hand.map(c=>c.v);
  return new Set(suits).size===4&&new Set(ranks).size===4;
}
function evalBadugiHigh(hand) {
  if(!isBadugi(hand))return null;
  return hand.map(c=>BDRANK_HIGH[c.v]).sort((a,b)=>b-a);
}
function evalBadugiLow(hand) {
  if(!isBadugi(hand))return null;
  return hand.map(c=>BDRANK_LOW[c.v]).sort((a,b)=>b-a);
}
function cmpBadugiHigh(a,b) {
  if(!a&&!b)return 0;if(!a)return 1;if(!b)return-1;
  for(let i=0;i<4;i++){if(a[i]!==b[i])return b[i]-a[i];}
  return 0;
}
function cmpBadugiLow(a,b) {
  if(!a&&!b)return 0;if(!a)return 1;if(!b)return-1;
  for(let i=0;i<4;i++){if(a[i]!==b[i])return a[i]-b[i];}
  return 0;
}
const rooms={};
const socketUser={};
const userSocket={};

function createRoom(isPrivate=false,gameType='chaingang') {
  const id=isPrivate?Math.random().toString(36).substr(2,6).toUpperCase():uuidv4();
  rooms[id]={id,isPrivate,gameType,players:[],phase:'waiting',pot:0,currentBet:0,ante:10,cols:[],deck:[],deckIdx:0,log:[],currentTurn:0,drawRound:0,dealerIdx:0};
  return rooms[id];
}
function publicRoom(gameType) {
  const max=gameType==='1333'?5:5;
  return Object.values(rooms).find(r=>!r.isPrivate&&r.phase==='waiting'&&r.players.length<max&&r.gameType===gameType)||createRoom(false,gameType);
}
function addLog(room,msg,type='act') {
  room.log.unshift({msg,type,ts:Date.now()});
  if(room.log.length>30)room.log.pop();
}
function phaseCols(room) {
  const pairsUp=['draw','bet1','bet2','bet3','decl','showdown'].includes(room.phase);
  const singlesUp=['bet2','bet3','decl','showdown'].includes(room.phase);
  const factorUp=['decl','bet3','showdown'].includes(room.phase);
  return room.cols.map((col,i)=>({
    pair:pairsUp?col.pair:[null,null],
    single:(i===2?factorUp:singlesUp)?col.single:null
  }));
}
function sanitizeForPlayer(room,userId) {
  const me=room.players.find(p=>p.userId===userId);
  let myBestHand=null;
  if(room.gameType==='chaingang'&&me&&me.hand&&me.hand.length>0){
    const vc=phaseCols(room);
    const hasPairs=vc.some(c=>c.pair[0]!==null);
    const hasSingles=vc.some(c=>c.single!==null);
    if(hasPairs&&hasSingles){
      const ec=vc.map(col=>({pair:col.pair.filter(Boolean),single:col.single})).filter(col=>col.pair.length>0&&col.single);
      if(ec.length>0){
        try{
          const best=bestHand(me.hand,ec);
          myBestHand={highName:best.high?best.high.n:null,highCards:best.highCards?best.highCards.map(c=>c.v+c.s):[],lowCards:best.lowCards?best.lowCards.map(c=>c.v+c.s):[],hasLow:best.low!==null};
        }catch(e){myBestHand=null;}
      }
    }
  }
  let my1333Score=null;
  if(room.gameType==='1333'&&me&&me.hand&&me.hand.length>=2){
    const score=calc1535Score(me.hand).score;
    const visScore=calc1535VisibleScore(me.hand);
    my1333Score={score,visScore:visScore.score,visDisplay:visScore.display,madeLow:is1535Low(score),madeHigh:is1535High(score),bust:is1535Bust(score),stayed:me.stayed,holeCard:me.hand[0],upCards:me.hand.slice(1),display:calc1535Score(me.hand).display};
  }
  let myBadugiHand=null;
  if(room.gameType==='badugi'&&me&&me.hand&&me.hand.length===4){
    myBadugiHand={isValid:isBadugi(me.hand),cards:me.hand.map(c=>c.v+c.s),highRanks:evalBadugiHigh(me.hand),lowRanks:evalBadugiLow(me.hand)};
  }
  return {
    roomId:room.id,isPrivate:room.isPrivate,gameType:room.gameType,phase:room.phase,
    pot:room.pot,currentBet:room.currentBet,ante:room.ante,
    cols:room.gameType==='chaingang'?phaseCols(room):[],
    log:room.log.slice(0,15),
    myHand:me?me.hand:[],myBet:me?me.bet:0,
    myDecl:me?me.decl:null,myFolded:me?me.folded:false,
    mySelectedDraw:me?me.selectedDraw:[],
    myBestHand,myBadugiHand,my1333Score,drawRound:room.drawRound||0,
    players:room.players.map(p=>({
      userId:p.userId,username:p.username,displayName:p.displayName,
      avatar:p.avatar,chips:p.chips,bet:p.bet,folded:p.folded,
      decl:room.phase==='showdown'||p.userId===userId?p.decl:p.decl?'hidden':null,
      cardCount:p.hand?p.hand.length:0,isMe:p.userId===userId,ready:p.ready,acted:p.acted,drawDone:p.drawDone,
      stayed:p.stayed||false,
      visibleCards:room.gameType==='1333'?p.hand.slice(1):[],
      score1333:room.gameType==='1333'&&(p.userId===userId||room.phase==='showdown')?calc1535Score(p.hand).score:null,
      visScore1333:room.gameType==='1333'?calc1535VisibleScore(p.hand).display:null
    })),
    currentTurn:room.currentTurn,winner:room.winner||null
  };
}
function _broadcastRoom(roomId) {
  const room=rooms[roomId];
  if(!room)return;
  room.players.forEach(p=>{
    const sid=userSocket[p.userId];
    if(sid)io.to(sid).emit('gameState',sanitizeForPlayer(room,p.userId));
  });
}
function playerBetAction(roomId,userId,action,amount) {
  const room=rooms[roomId];
  if(!room)return;
  const pIdx=room.players.findIndex(p=>p.userId===userId);
  if(pIdx!==room.currentTurn)return;
  const p=room.players[pIdx];
  if(p.folded||p.acted)return;
  if(action==='fold'){p.folded=true;addLog(room,`${p.displayName} folds.`);}
  else if(action==='check'){if(room.currentBet>0)return;addLog(room,`${p.displayName} checks.`);}
  else if(action==='call'){
    const amt=Math.min(room.currentBet-p.bet,p.chips);
    p.chips-=amt;room.pot+=amt;p.bet=room.currentBet;
    addLog(room,`${p.displayName} calls $${amt}.`);
  }
  else if(action==='raise'){
    const isFinal=room.phase==='bet3'||room.phase==='fbet';
    const maxRaise=isFinal?25:15;
    const amt=Math.min(amount,p.chips,maxRaise);
    if(amt<=room.currentBet)return;
    p.chips-=amt;room.pot+=amt;room.currentBet=amt;p.bet=amt;
    room.players.forEach((op,i)=>{if(i!==pIdx&&!op.folded)op.acted=false;});
    addLog(room,`${p.displayName} raises to $${amt}.`,'imp');
  }
  p.acted=true;
  advanceTurn(room);
}
function advanceTurn(room) {
  const active=room.players.filter(p=>!p.folded);
  if(active.length<=1){earlyWin(room);return;}
  let next=(room.currentTurn+1)%room.players.length;
  let loops=0;
  while((room.players[next].folded||room.players[next].acted)&&loops<room.players.length){
    next=(next+1)%room.players.length;loops++;
  }
  if(loops>=room.players.length||room.players[next].folded||room.players[next].acted){
    endBettingRound(room);
  } else {
    room.currentTurn=next;
  }
  broadcastRoom(room.id);
}
function endBettingRound(room) {
  if(room.gameType==='1333'){end1535BettingRound(room);return;}
  if(room.gameType==='badugi'){
    if(room.phase==='bbet'){
      if(room.drawRound<3){
        startBadugiDraw(room);
      } else {
        room.phase='decl';
        room.currentTurn=room.players.findIndex(p=>!p.folded);
        addLog(room,'Declare HIGH or LOW badugi!','imp');
        broadcastRoom(room.id);
      }
    } else if(room.phase==='fbet'){
      doBadugiShowdown(room);
    }
    return;
  }
  if(room.phase==='bet1'){
    room.phase='bet2';
    addLog(room,'Singles revealed!','imp');
    startBetting(room,'bet2');
  } else if(room.phase==='bet2'){
    room.phase='decl';
    room.currentTurn=room.players.findIndex(p=>!p.folded);
    addLog(room,'FACTOR CARD IS LIVE! Declare: High, Low, or Swing!','imp');
    broadcastRoom(room.id);
  } else if(room.phase==='bet3'){
    doShowdown(room);
  }
}
function startBetting(room,phase) {
  room.phase=phase;
  room.currentBet=0;
  room.players.forEach(p=>{p.bet=0;p.acted=false;});
  room.currentTurn=room.players.findIndex(p=>!p.folded);
  addLog(room,phase==='bet1'?'Betting round 1!':phase==='bet2'?'Singles revealed! Bet now.':'Final betting round!','imp');
  broadcastRoom(room.id);
}
function earlyWin(room) {
  const alive=room.players.filter(p=>!p.folded);
  if(alive.length===1){
    const w=alive[0];
    const rp=room.players.find(p=>p.userId===w.userId);
    if(rp)rp.chips+=room.pot;
    db.updateUser(w.userId,{chips:(db.findUser(u=>u.id===w.userId)||{chips:0}).chips+room.pot});
    addLog(room,`${w.displayName} wins $${room.pot} — all folded!`,'win');
    room.phase='showdown';
    broadcastRoom(room.id);
    setTimeout(()=>{
      if(rooms[room.id]){
        room.players.forEach(p=>{p.folded=false;p.decl=null;p.ready=false;p.drawDone=false;p.acted=false;});
        startGame(room.id);
      }
    },5000);
  }
}
function startGame(roomId) {
  const room=rooms[roomId];
  if(!room||room.players.length<2)return;
  if(room.gameType==='badugi'){startBadugiGame(roomId);return;}
  if(room.gameType==='1333'){start1535Game(roomId);return;}
  const deck=shuffle(makeDeck());
  let idx=0;
  const deal=n=>{const c=deck.slice(idx,idx+n);idx+=n;return c;};
  room.deck=deck;room.pot=0;room.currentBet=0;
  room.cols=Array.from({length:5},()=>({pair:deal(2),single:deal(1)[0]}));
  room.players.forEach(p=>{
    p.hand=deal(5);p.bet=0;p.folded=false;
    p.decl=null;p.selectedDraw=[];p.ready=false;p.drawDone=false;p.acted=false;
  });
  room.deckIdx=idx;room.phase='ante';room.log=[];
  addLog(room,'Fresh deck shuffled! Post your ante.','imp');
  broadcastRoom(roomId);
}
function checkAllAnted(roomId) {
  const room=rooms[roomId];
  const active=room.players.filter(p=>!p.folded);
  if(active.every(p=>p.ready)){
    active.forEach(p=>{p.ready=false;});
    room.phase='draw';
    addLog(room,'Pick up to 2 cards to swap!','imp');
    broadcastRoom(roomId);
  }
}
function checkAllAntedBadugi(roomId) {
  const room=rooms[roomId];
  if(!room)return;
  const active=room.players.filter(p=>!p.folded);
  if(active.every(p=>p.ready)){
    active.forEach(p=>{p.ready=false;});
    startBadugiDraw(room);
  }
}
function confirmDraw(room,userId,selected) {
  const p=room.players.find(p=>p.userId===userId);
  if(!p||p.drawDone)return;
  const dis=[...selected].sort((a,b)=>b-a);
  const nc=room.deck.slice(room.deckIdx,room.deckIdx+dis.length);
  room.deckIdx+=dis.length;
  dis.forEach(i=>p.hand.splice(i,1));
  p.hand.push(...nc);
  p.drawDone=true;
  addLog(room,`${p.displayName} drew ${dis.length} card(s).`);
  broadcastRoom(room.id);
  const active=room.players.filter(p=>!p.folded);
  if(active.every(p=>p.drawDone)){
    active.forEach(p=>{p.drawDone=false;});
    startBetting(room,'bet1');
  }
}
function playerDeclare(roomId,userId,decl) {
  const room=rooms[roomId];
  if(!room||room.phase!=='decl')return;
  const pIdx=room.players.findIndex(p=>p.userId===userId);
  if(pIdx!==room.currentTurn)return;
  const p=room.players[pIdx];
  if(!p||p.folded||p.decl)return;
  p.decl=decl;
  addLog(room,`${p.displayName} declares ${decl.toUpperCase()}!`,'imp');
  const active=room.players.filter(p=>!p.folded);
  if(active.every(p=>p.decl)){
    startBetting(room,'bet3');
  } else {
    let next=(room.currentTurn+1)%room.players.length;
    while(room.players[next].folded) next=(next+1)%room.players.length;
    room.currentTurn=next;
    broadcastRoom(room.id);
  }
}
function doShowdown(room) {
  room.phase='showdown';
  const factor=room.cols[2].single;
  const players=room.players.filter(p=>!p.folded).map(p=>({...p,best:bestHand(p.hand,room.cols)}));
  const highP=players.filter(p=>p.decl==='high'||p.decl==='swing');
  const lowP=players.filter(p=>p.decl==='low'||p.decl==='swing');
  let hWin=null,lWin=null;
  if(highP.length){highP.sort((a,b)=>cmpHigh(a.best.high,b.best.high));hWin=highP[0];}
  if(lowP.length){
    const q=lowP.filter(p=>p.best.low);
    if(q.length){
      q.sort((a,b)=>cmpLow(a.best.low,b.best.low));
      if(q.length>1&&cmpLow(q[0].best.low,q[1].best.low)===0){
        const fs=factor.s;
        const a0=q[0].best.lowCards.some(c=>c.s===fs);
        const a1=q[1].best.lowCards.some(c=>c.s===fs);
        lWin=a0&&!a1?q[0]:!a0&&a1?q[1]:q[0];
      } else lWin=q[0];
    }
  }
  players.forEach(p=>{
    if(p.decl==='swing'){
      const wh=hWin&&hWin.userId===p.userId;
      const wl=lWin&&lWin.userId===p.userId;
      if(!wh||!wl){
        if(hWin&&hWin.userId===p.userId)hWin=null;
        if(lWin&&lWin.userId===p.userId)lWin=null;
        addLog(room,`${p.displayName} swung and LOST both pots!`,'imp');
      }
    }
  });
  const half=Math.floor(room.pot/2);
  if(hWin){
    const rp=room.players.find(p=>p.userId===hWin.userId);
    if(rp)rp.chips+=half;
    db.updateUser(hWin.userId,{chips:(db.findUser(u=>u.id===hWin.userId)||{chips:0}).chips+half,wins:(db.findUser(u=>u.id===hWin.userId)||{wins:0}).wins+1});
    addLog(room,`HIGH ($${half}): ${hWin.displayName} — ${hWin.best.high?hWin.best.high.n:'?'}`,'win');
  } else {addLog(room,'HIGH POT: No winner.');}
  if(lWin){
    const rp=room.players.find(p=>p.userId===lWin.userId);
    if(rp)rp.chips+=half;
    db.updateUser(lWin.userId,{chips:(db.findUser(u=>u.id===lWin.userId)||{chips:0}).chips+half});
    addLog(room,`LOW ($${half}): ${lWin.displayName} — ${lWin.best.lowCards?lWin.best.lowCards.map(c=>c.v+c.s).join(' '):'?'}`,'win');
  } else {addLog(room,'LOW POT: No qualified low hand.');}
  addLog(room,`Factor Card: ${factor.v}${factor.s}`,'imp');
  broadcastRoom(room.id);
  setTimeout(()=>{
    if(rooms[room.id]){
      room.players.forEach(p=>{p.folded=false;p.decl=null;p.ready=false;p.drawDone=false;p.acted=false;});
      startGame(room.id);
    }
  },10000);
}
function startBadugiGame(roomId) {
  const room=rooms[roomId];
  if(!room||room.players.length<2)return;
  const deck=shuffle(makeDeck());
  let idx=0;
  const deal=n=>{const c=deck.slice(idx,idx+n);idx+=n;return c;};
  const carryPot=room.pot||0;room.deck=deck;room.pot=carryPot;room.currentBet=0;room.drawRound=0;
  room.players.forEach(p=>{
    p.hand=deal(4);p.bet=0;p.folded=false;
    p.decl=null;p.selectedDraw=[];p.ready=false;p.drawDone=false;p.acted=false;
  });
  room.deckIdx=idx;room.log=[];
  if(carryPot>0){
    room.phase='draw';
    room.drawRound=1;
    addLog(room,'POT ROLLS OVER! New hand — draw round 1 of 3.','imp');
  } else {
    room.phase='ante';
    addLog(room,'Badugi! 4 cards dealt. Post your ante.','imp');
  }
  broadcastRoom(roomId);
}
function startBadugiDraw(room) {
  room.drawRound=(room.drawRound||0)+1;
  room.phase='draw';
  room.players.forEach(p=>{if(!p.folded){p.drawDone=false;p.selectedDraw=[];}});
  addLog(room,`Draw round ${room.drawRound} of 3 — swap any cards!`,'imp');
  broadcastRoom(room.id);
}
function confirmBadugiDraw(room,userId,selected) {
  const p=room.players.find(p=>p.userId===userId);
  if(!p||p.drawDone)return;
  const dis=[...selected].sort((a,b)=>b-a);
  const nc=room.deck.slice(room.deckIdx,room.deckIdx+dis.length);
  room.deckIdx+=dis.length;
  dis.forEach(i=>p.hand.splice(i,1));
  p.hand.push(...nc);
  p.drawDone=true;
  addLog(room,`${p.displayName} drew ${dis.length} card(s).`);
  broadcastRoom(room.id);
  const active=room.players.filter(p=>!p.folded);
  if(active.every(p=>p.drawDone)){
    active.forEach(p=>{p.drawDone=false;});
    room.phase='bbet';
    room.currentBet=0;
    room.players.forEach(p=>{p.bet=0;p.acted=false;});
    room.currentTurn=room.players.findIndex(p=>!p.folded);
    addLog(room,`Betting round ${room.drawRound}!`,'imp');
    broadcastRoom(room.id);
  }
}
function playerDeclareBadugi(roomId,userId,decl) {
  const room=rooms[roomId];
  if(!room||room.phase!=='decl')return;
  if(!['high','low'].includes(decl))return;
  const pIdx=room.players.findIndex(p=>p.userId===userId);
  if(pIdx!==room.currentTurn)return;
  const p=room.players[pIdx];
  if(!p||p.folded||p.decl)return;
  p.decl=decl;
  addLog(room,`${p.displayName} declares ${decl.toUpperCase()}!`,'imp');
  const active=room.players.filter(p=>!p.folded);
  if(active.every(p=>p.decl)){
    room.phase='fbet';
    room.currentBet=0;
    room.players.forEach(p=>{p.bet=0;p.acted=false;});
    room.currentTurn=room.players.findIndex(p=>!p.folded);
    addLog(room,'Final betting round!','imp');
    broadcastRoom(room.id);
  } else {
    let next=(room.currentTurn+1)%room.players.length;
    while(room.players[next].folded) next=(next+1)%room.players.length;
    room.currentTurn=next;
    broadcastRoom(room.id);
  }
}
function doBadugiShowdown(room) {
  room.phase='showdown';
  const active=room.players.filter(p=>!p.folded);
  const highP=active.filter(p=>p.decl==='high');
  const lowP=active.filter(p=>p.decl==='low');
  let hWin=null,lWin=null;
  if(highP.length){
    const valid=highP.filter(p=>isBadugi(p.hand));
    if(valid.length){
      valid.sort((a,b)=>cmpBadugiHigh(evalBadugiHigh(a.hand),evalBadugiHigh(b.hand)));
      hWin=valid[0];
    }
  }
  if(lowP.length){
    const valid=lowP.filter(p=>isBadugi(p.hand));
    if(valid.length){
      valid.sort((a,b)=>cmpBadugiLow(evalBadugiLow(a.hand),evalBadugiLow(b.hand)));
      lWin=valid[0];
    }
  }
  const half=Math.floor(room.pot/2);
  let anyWinner=false;
  if(hWin){
    anyWinner=true;
    const rp=room.players.find(p=>p.userId===hWin.userId);
    if(rp)rp.chips+=half;
    db.updateUser(hWin.userId,{chips:(db.findUser(u=>u.id===hWin.userId)||{chips:0}).chips+half,wins:(db.findUser(u=>u.id===hWin.userId)||{wins:0}).wins+1});
    addLog(room,`HIGH ($${half}): ${hWin.displayName} — ${hWin.hand.map(c=>c.v+c.s).join(' ')}`,'win');
  } else {addLog(room,'HIGH: No valid badugi.');}
  if(lWin){
    anyWinner=true;
    const rp=room.players.find(p=>p.userId===lWin.userId);
    if(rp)rp.chips+=half;
    db.updateUser(lWin.userId,{chips:(db.findUser(u=>u.id===lWin.userId)||{chips:0}).chips+half});
    addLog(room,`LOW ($${half}): ${lWin.displayName} — ${lWin.hand.map(c=>c.v+c.s).join(' ')}`,'win');
  } else {addLog(room,'LOW: No valid badugi.');}
  if(!anyWinner){
    addLog(room,`NO VALID BADUGI — POT ROLLS OVER! Pot is now $${room.pot}`,'imp');
  } else if(hWin&&lWin){
    room.pot=0;
  } else {
    room.pot=room.pot-half;
  }
  broadcastRoom(room.id);
  setTimeout(()=>{
    if(rooms[room.id]){
      room.players.forEach(p=>{p.folded=false;p.decl=null;p.ready=false;p.drawDone=false;p.acted=false;});
      startBadugiGame(room.id);
    }
  },10000);
}
io.on('connection',socket=>{
  socket.on('auth',({token})=>{
    try{
      const data=jwt.verify(token,JWT_SECRET);
      const user=db.findUser(u=>u.id===data.id);
      if(!user)return socket.emit('authError','User not found');
      socketUser[socket.id]={userId:user.id,username:user.username,displayName:user.displayName,avatar:user.avatar,chips:user.chips};
      userSocket[user.id]=socket.id;
      socket.emit('authOk',safeUser(user));
    }catch{socket.emit('authError','Invalid token');}
  });
  socket.on('joinPublic',({gameType})=>{
    const u=socketUser[socket.id];
    if(!u){socket.emit('lobbyError','Not signed in.');return;}
    leaveCurrentRoom(socket);
    const room=publicRoom(gameType||'chaingang');
    joinRoom(socket,room,u);
  });
  socket.on('createPrivate',({gameType})=>{
    const u=socketUser[socket.id];
    if(!u){socket.emit('lobbyError','Not signed in.');return;}
    leaveCurrentRoom(socket);
    const room=createRoom(true,gameType||'chaingang');
    joinRoom(socket,room,u);
    socket.emit('privateCode',room.id);
  });
  socket.on('joinPrivate',({code})=>{
    const u=socketUser[socket.id];
    if(!u){socket.emit('lobbyError','Not signed in.');return;}
    const room=rooms[code?.toUpperCase()];
    if(!room){socket.emit('lobbyError','Room not found. Check the code.');return;}
    if(room.players.length>=5){socket.emit('lobbyError','Table is full.');return;}
    leaveCurrentRoom(socket);
    joinRoom(socket,room,u);
  });
  socket.on('ante',()=>{
    const u=socketUser[socket.id];
    if(!u)return;
    const room=rooms[socket.roomId];
    if(!room||room.phase!=='ante')return;
    const p=room.players.find(p=>p.userId===u.userId);
    if(!p||p.ready)return;
    if(p.chips<room.ante)return socket.emit('error','Not enough chips!');
    p.chips-=room.ante;room.pot+=room.ante;p.ready=true;
    addLog(room,`${p.displayName} posted ante.`);
    broadcastRoom(socket.roomId);
    if(room.gameType==='badugi')checkAllAntedBadugi(socket.roomId);
    else if(room.gameType==='1333')checkAllAnted1535(socket.roomId);
    else checkAllAnted(socket.roomId);
  });
  socket.on('selectDraw',({selected})=>{
    const u=socketUser[socket.id];
    if(!u)return;
    const room=rooms[socket.roomId];
    if(!room||room.phase!=='draw')return;
    const p=room.players.find(p=>p.userId===u.userId);
    if(!p)return;
    const maxDraw=room.gameType==='badugi'?[3,2,1][room.drawRound-1]??1:2;p.selectedDraw=(selected||[]).slice(0,maxDraw);
    broadcastRoom(socket.roomId);
  });
  socket.on('confirmDraw',({selected})=>{
    const u=socketUser[socket.id];
    if(!u)return;
    const room=rooms[socket.roomId];
    if(!room||room.phase!=='draw')return;
    if(room.gameType==='badugi')confirmBadugiDraw(room,u.userId,selected||[]);
    else confirmDraw(room,u.userId,selected||[]);
  });
  socket.on('betAction',({action,amount})=>{
    const u=socketUser[socket.id];
    if(!u)return;
    const room=rooms[socket.roomId];
    if(!room)return;
    if(['bet1','bet2','bet3','bbet','fbet','bet'].includes(room.phase)){
      playerBetAction(socket.roomId,u.userId,action,amount);
    }
  });
  socket.on('declare',({decl})=>{
    const u=socketUser[socket.id];
    if(!u)return;
    const room=rooms[socket.roomId];
    if(!room||room.phase!=='decl')return;
    if(room.gameType==='badugi'){
      if(!['high','low'].includes(decl))return;
      playerDeclareBadugi(socket.roomId,u.userId,decl);
    } else {
      if(!['high','low','swing'].includes(decl))return;
      playerDeclare(socket.roomId,u.userId,decl);
    }
  });
  socket.on('chat',({msg})=>{
    const u=socketUser[socket.id];
    if(!u||!msg)return;
    const room=rooms[socket.roomId];
    if(!room)return;
    io.to(socket.roomId).emit('chat',{from:u.displayName,avatar:u.avatar,msg:msg.slice(0,100)});
  });
  socket.on('rebuy',({amount})=>{
    const u=socketUser[socket.id];
    if(!u)return;
    const validAmt=[500,1000].includes(amount)?amount:500;
    const dbUser=db.findUser(u2=>u2.id===u.userId);
    if(!dbUser)return;
    dbUser.chips+=validAmt;
    db.updateUser(u.userId,{chips:dbUser.chips});
    const room=rooms[socket.roomId];
    if(room){
      const p=room.players.find(p=>p.userId===u.userId);
      if(p)p.chips+=validAmt;
      addLog(room,`${u.displayName} rebuys ${validAmt} in chips!`,'imp');
      broadcastRoom(socket.roomId);
    }
    socket.emit('authOk',safeUser(dbUser));
  });
  socket.on('hit1333',()=>{
    const u=socketUser[socket.id];
    if(!u)return;
    player1535Hit(socket.roomId,u.userId);
  });
  socket.on('stay1333',()=>{
    const u=socketUser[socket.id];
    if(!u)return;
    player1535Stay(socket.roomId,u.userId);
  });
  socket.on('leaveRoom',()=>leaveCurrentRoom(socket));
  socket.on('disconnect',()=>{
    const u=socketUser[socket.id];
    if(u){
      delete userSocket[u.userId];
      const room=rooms[socket.roomId];
      if(room){
        const p=room.players.find(p=>p.userId===u.userId);
        if(p){p.folded=true;addLog(room,`${p.displayName} disconnected.`);broadcastRoom(socket.roomId);}
      }
    }
    delete socketUser[socket.id];
  });
  function leaveCurrentRoom(socket){
    if(socket.roomId&&rooms[socket.roomId]){
      socket.leave(socket.roomId);
      const room=rooms[socket.roomId];
      const u=socketUser[socket.id];
      if(u)room.players=room.players.filter(p=>p.userId!==u.userId);
      if(room.players.length===0)delete rooms[socket.roomId];
    }
    socket.roomId=null;
  }
  function joinRoom(socket,room,u){
    const dbUser=db.findUser(u2=>u2.id===u.userId);
    room.players.push({
      userId:u.userId,username:u.username,displayName:u.displayName,
      avatar:u.avatar,chips:dbUser?dbUser.chips:u.chips,
      hand:[],bet:0,folded:false,decl:null,ready:false,selectedDraw:[],drawDone:false,acted:false
    });
    socket.join(room.id);
    socket.roomId=room.id;
    socket.emit('joinedRoom',{roomId:room.id,isPrivate:room.isPrivate,gameType:room.gameType});
    addLog(room,`${u.displayName} joined the table.`,'imp');
    broadcastRoom(room.id);
    if(!room.isPrivate)scheduleBot(room.id);
    if(room.players.length>=5)return socket.emit('error','Table is full!');
    if(room.players.length>=2&&room.phase==='waiting'){
      setTimeout(()=>{if(rooms[room.id]&&room.players.length>=2&&room.phase==='waiting')startGame(room.id);},3000);
    }
  }
});

// ── 15/35 GAME v3 ────────────────────────────────────────

function calc1535Score(hand) {
  let base = 0;
  let aces = 0;
  hand.forEach(c => {
    if (c.v === 'A') aces++;
    else if (['J','Q','K'].includes(c.v)) base += 0.5;
    else base += parseInt(c.v);
  });
  let score = base + aces;
  for (let i = 0; i < aces; i++) {
    if (score + 10 <= 35) score += 10;
  }
  const scoreLow = base + aces;
  let display = score + '';
  if (aces > 0 && scoreLow !== score) display = scoreLow + ' or ' + score;
  return { score, scoreLow, display };
}

function calc1535VisibleScore(hand) {
  return calc1535Score(hand.slice(1));
}

function is1535Low(score) { return score >= 13 && score <= 15; }
function is1535High(score) { return score >= 33 && score <= 35; }
function is1535Bust(score) { return score > 35; }

function start1535Game(roomId) {
  const room = rooms[roomId];
  if (!room || room.players.length < 2) return;
  const deck = shuffle(makeDeck());
  let idx = 0;
  room.deck = deck; room.deckIdx = 0;
  room.currentBet = 0;
  room.log = [];
  room.hitRound = 0;
  room.dealerIdx=(room.dealerIdx+1)%room.players.length;
  const leftOfDealer=(room.dealerIdx+1)%room.players.length;
  room.players.forEach(p => {
    if (!p.folded) {
      p.hand = [deck[idx++], deck[idx++]];
      p.bet = 0; p.stayed = false;
      p.decl = null; p.ready = false; p.acted = false;
      p.drawDone = false; p.selectedDraw = [];
    }
  });
  room.deckIdx = idx;
  if (room.pot > 0) {
    room.phase = 'hit';
    room.hitRound = 1;
    const first = room.players.findIndex(p => !p.folded);
    room.currentTurn = first >= 0 ? first : 0;
    addLog(room, 'POT ROLLS OVER! Fresh cards — up card showing. Hit or Stay?', 'imp');
  } else {
    room.phase = 'ante';
    room.ante = 1;
    addLog(room, '15/35! Cards dealt. Post $1 ante to flip your up card.', 'imp');
  }
  broadcastRoom(roomId);
}

function checkAllAnted1535(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const active = room.players.filter(p => !p.folded);
  if (active.every(p => p.ready)) {
    active.forEach(p => { p.ready = false; });
    room.phase = 'hit';
    room.hitRound = 1;
    const lod=(room.dealerIdx+1)%room.players.length;
    room.currentTurn=lod;
    addLog(room, 'Up cards showing! Starting left of dealer — Hit or Stay?', 'imp');
    broadcastRoom(roomId);
  }
}
function player1535Hit(roomId, userId) {
  const room = rooms[roomId];
  if (!room || room.phase !== 'hit') return;
  const pIdx = room.players.findIndex(p => p.userId === userId);
  if (pIdx !== room.currentTurn) return;
  const p = room.players[pIdx];
  if (p.folded || p.stayed) return;
  const newCard = room.deck[room.deckIdx++];
  p.hand.push(newCard);
  const { score, display } = calc1535Score(p.hand);
  if (is1535Bust(score)) {
    addLog(room, `${p.displayName} hits ${newCard.v}${newCard.s} — BUST! (${display} pts)`, 'imp');
    p.stayed = true;
  } else {
    const vis = calc1535VisibleScore(p.hand);
    addLog(room, `${p.displayName} hits ${newCard.v}${newCard.s} (showing: ${vis.display} pts)`);
  }
  advance1535Turn(room);
}

function player1535Stay(roomId, userId) {
  const room = rooms[roomId];
  if (!room || room.phase !== 'hit') return;
  const pIdx = room.players.findIndex(p => p.userId === userId);
  if (pIdx !== room.currentTurn) return;
  const p = room.players[pIdx];
  if (p.folded || p.stayed) return;
  const vis = calc1535VisibleScore(p.hand);
  p.stayed = true;
  addLog(room, `${p.displayName} stays. (showing: ${vis.display} pts)`);
  advance1535Turn(room);
}

function advance1535Turn(room) {
  const active = room.players.filter(p => !p.folded);
  if (active.length <= 1) { earlyWin(room); return; }
  let next = (room.currentTurn + 1) % room.players.length;
  let loops = 0;
  while (loops < room.players.length) {
    const p = room.players[next];
    if (!p.folded && !p.stayed) break;
    next = (next + 1) % room.players.length;
    loops++;
  }
  const stillNeedHit = room.players.filter(p => !p.folded && !p.stayed && !is1535Bust(calc1535Score(p.hand).score));
  if (stillNeedHit.length === 0) {
    const notBust = active.filter(p => !is1535Bust(calc1535Score(p.hand).score));
    if (notBust.length === 0) {
      addLog(room, 'Everyone busted! Dealing fresh cards — no ante needed.', 'imp');
      broadcastRoom(room.id);
      setTimeout(() => {
        if (!rooms[room.id]) return;
        const deck2 = shuffle(makeDeck());
        let idx2 = 0;
        room.players.forEach(p => {
          if (!p.folded) {
            p.hand = [deck2[idx2++], deck2[idx2++]];
            p.stayed = false; p.ready = false; p.acted = false; p.drawDone = false;
          }
        });
        room.deck = deck2; room.deckIdx = idx2;
        room.phase = 'hit';
        room.hitRound++;
        const first = room.players.findIndex(p => !p.folded);
        room.currentTurn = first >= 0 ? first : 0;
        addLog(room, 'Fresh cards dealt! Hit or Stay?', 'imp');
        broadcastRoom(room.id);
      }, 3000);
    } else {
      start1535Betting(room);
    }
  } else {
    room.currentTurn = next;
    broadcastRoom(room.id);
  }
}

function start1535Betting(room) {
  room.phase = 'bet';
  room.currentBet = 0;
  room.players.forEach(p => { p.bet = 0; p.acted = false; });
  const first = room.players.findIndex(p => !p.folded);
  room.currentTurn = first >= 0 ? first : 0;
  addLog(room, 'Bet round! ($1-$10)', 'imp');
  broadcastRoom(room.id);
}

function end1535BettingRound(room) {
  const active = room.players.filter(p => !p.folded);
  if (active.length <= 1) {
    addLog(room, 'All others folded — pot rolls to next hand!', 'imp');
    broadcastRoom(room.id);
    setTimeout(() => { if(rooms[room.id]) start1535Game(room.id); }, 5000);
    return;
  }
  // Check if only one non-bust player remains — they win
  const notBust = active.filter(p => !is1535Bust(calc1535Score(p.hand).score));
  if (notBust.length <= 1) { do1535Showdown(room); return; }
  const stillPlaying = active.filter(p => !p.stayed && !is1535Bust(calc1535Score(p.hand).score));
  if (stillPlaying.length === 0) {
    do1535Showdown(room);
  } else {
    room.hitRound++;
    room.phase = 'hit';
    room.players.forEach(p => { p.acted = false; p.drawDone = false; });
    const lod = (room.dealerIdx+1) % room.players.length;
    let first = lod;
    let loops = 0;
    while (loops < room.players.length) {
      const p = room.players[first];
      if (!p.folded && !p.stayed && !is1535Bust(calc1535Score(p.hand).score)) break;
      first = (first+1) % room.players.length;
      loops++;
    }
    room.currentTurn = first;
    addLog(room, `Hit round ${room.hitRound} — Hit or Stay?`, 'imp');
    broadcastRoom(room.id);
  }
}
function do1535Showdown(room) {
  room.phase = 'showdown';
  const active = room.players.filter(p => !p.folded);
  active.forEach(p => {
    const { score, display } = calc1535Score(p.hand);
    const status = is1535Low(score) ? 'LOW' : is1535High(score) ? 'HIGH' : 'BUST';
    addLog(room, `${p.displayName} reveals hole card ${p.hand[0].v}${p.hand[0].s} — ${display} pts [${status}]`, 'imp');
  });
  const results = active.map(p => {
    const { score } = calc1535Score(p.hand);
    return { ...p, score, madeLow: is1535Low(score), madeHigh: is1535High(score) };
  });
  const lowPlayers = results.filter(r => r.madeLow);
  const highPlayers = results.filter(r => r.madeHigh);
  let anyWinner = false;
  const half = Math.floor(room.pot / 2);
  const remainder = room.pot - half * 2;
  if (lowPlayers.length) {
    anyWinner = true;
    lowPlayers.sort((a, b) => b.score - a.score);
    const lWin = lowPlayers[0];
    const rp = room.players.find(p => p.userId === lWin.userId);
    if (rp) rp.chips += half;
    db.updateUser(lWin.userId, { chips: (db.findUser(u => u.id === lWin.userId)||{chips:0}).chips + half });
    addLog(room, `LOW ($${half}): ${lWin.displayName} wins with ${lWin.score} pts!`, 'win');
  } else { addLog(room, 'LOW: No made hand.'); }
  if (highPlayers.length) {
    anyWinner = true;
    highPlayers.sort((a, b) => b.score - a.score);
    const hWin = highPlayers[0];
    const winAmt = lowPlayers.length ? half + remainder : room.pot;
    const rp = room.players.find(p => p.userId === hWin.userId);
    if (rp) rp.chips += winAmt;
    db.updateUser(hWin.userId, { chips: (db.findUser(u => u.id === hWin.userId)||{chips:0}).chips + winAmt, wins: (db.findUser(u => u.id === hWin.userId)||{wins:0}).wins + 1 });
    addLog(room, `HIGH ($${winAmt}): ${hWin.displayName} wins with ${hWin.score} pts!`, 'win');
  } else { addLog(room, 'HIGH: No made hand.'); }
  if (!anyWinner) {
    addLog(room, `NO MADE HANDS — POT ROLLS OVER! Pot: $${room.pot}`, 'imp');
  } else {
    room.pot = lowPlayers.length && highPlayers.length ? 0 : room.pot - half;
  }
  broadcastRoom(room.id);
  setTimeout(() => {
    if (!rooms[room.id]) return;
    // Folded players stay folded — only busted players get fresh cards
    room.players.forEach(p => {
      if (!p.folded) { p.stayed=false; p.ready=false; p.acted=false; p.drawDone=false; }
    });
    start1535Game(room.id);
  }, 10000);
}

function bot1535Action(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const p = room.players[room.currentTurn];
  if (!p || !p.isBot) return;
  setTimeout(() => {
    const r = rooms[roomId];
    if (!r || r.phase !== 'hit') return;
    const bot = r.players[r.currentTurn];
    if (!bot || !bot.isBot) return;
    const { score } = calc1535Score(bot.hand);
    if (is1535Low(score) || is1535High(score)) {
      player1535Stay(roomId, bot.userId);
    } else if (score < 13) {
      player1535Hit(roomId, bot.userId);
    } else if (score > 15 && score < 28) {
      player1535Hit(roomId, bot.userId);
    } else if (score >= 28 && score <= 32) {
      if (Math.random() < 0.7) player1535Hit(roomId, bot.userId);
      else player1535Stay(roomId, bot.userId);
    } else {
      player1535Stay(roomId, bot.userId);
    }
  }, 1200 + Math.random() * 1500);
}

// ── BOT SYSTEM ──────────────────────────────────────────
const BOT_NAMES=[
  {displayName:'DaQuan',avatar:'😎'},{displayName:'Lil\' Ricky',avatar:'🤠'},
  {displayName:'Smoke',avatar:'💀'},{displayName:'Tanya',avatar:'🦊'},
  {displayName:'Big Mike',avatar:'🐻'},{displayName:'Keisha',avatar:'👑'},
  {displayName:'Dre',avatar:'🔥'},{displayName:'Peanut',avatar:'🃏'},
  {displayName:'Bootleg',avatar:'🎰'},{displayName:'Precious',avatar:'🧠'}
];

function makeBotPlayer(gameType) {
  const n=BOT_NAMES[Math.floor(Math.random()*BOT_NAMES.length)];
  return {
    userId:'bot_'+uuidv4(),username:'bot',displayName:n.displayName,
    avatar:n.avatar,chips:1000,hand:[],bet:0,folded:false,
    decl:null,ready:false,selectedDraw:[],drawDone:false,acted:false,isBot:true
  };
}

function scheduleBot(roomId) {
  const room=rooms[roomId];
  if(!room||room.isPrivate||room.botScheduled)return;
  room.botScheduled=true;
  // First bot after 5 seconds
  setTimeout(()=>{
    const r=rooms[roomId];
    if(!r||r.phase!=='waiting'||r.isPrivate)return;
    const humans=r.players.filter(p=>!p.isBot);
    if(humans.length>=1&&r.players.length<3){
      const bot=makeBotPlayer(r.gameType);
      r.players.push(bot);
      addLog(r,`${bot.displayName} joined the table.`,'imp');
      broadcastRoom(roomId);
      if(r.phase==='ante') botAnte(roomId);
      if(r.players.length>=2&&r.phase==='waiting'){
        setTimeout(()=>{if(rooms[roomId]&&r.phase==='waiting')startGame(roomId);},3000);
      }
      // Second bot after another 4 seconds if still waiting
      setTimeout(()=>{
        const r2=rooms[roomId];
        if(!r2||r2.phase!=='waiting'||r2.isPrivate)return;
        const humans2=r2.players.filter(p=>!p.isBot);
        if(humans2.length>=1&&r2.players.length<3){
          const bot2=makeBotPlayer(r2.gameType);
          r2.players.push(bot2);
          addLog(r2,`${bot2.displayName} joined the table.`,'imp');
          broadcastRoom(roomId);
        }
      },4000);
    }
  },12000);
}

function botAnte(roomId) {
  const room=rooms[roomId];
  if(!room||room.phase!=='ante')return;
  room.players.filter(p=>p.isBot&&!p.ready).forEach(p=>{
    setTimeout(()=>{
      const r=rooms[roomId];
      if(!r||r.phase!=='ante'||p.ready)return;
      p.chips-=r.ante;r.pot+=r.ante;p.ready=true;
      addLog(r,`${p.displayName} posted ante.`);
      broadcastRoom(roomId);
      if(r.gameType==='badugi')checkAllAntedBadugi(roomId);
      else if(r.gameType==='1333')checkAllAnted1535(roomId);
      else checkAllAnted(roomId);
    },1000+Math.random()*2000);
  });
}

function botDraw(roomId) {
  const room=rooms[roomId];
  if(!room||room.phase!=='draw')return;
  room.players.filter(p=>p.isBot&&!p.drawDone).forEach(p=>{
    setTimeout(()=>{
      const r=rooms[roomId];
      if(!r||r.phase!=='draw'||p.drawDone)return;
      if(r.gameType==='badugi'){
        // Smart badugi draw — discard duplicates suits/ranks
        const hand=p.hand;
        const toDiscard=[];
        const seenSuits={},seenRanks={};
        hand.forEach((c,i)=>{
          if(seenSuits[c.s]!==undefined||seenRanks[c.v]!==undefined) toDiscard.push(i);
          else{seenSuits[c.s]=i;seenRanks[c.v]=i;}
        });
        const maxDraw=[3,2,1][r.drawRound-1]??1;
        const selected=toDiscard.slice(0,maxDraw);
        confirmBadugiDraw(r,p.userId,selected);
      } else {
        // Chain Gang draw — discard worst 1-2 cards
        const selected=[];
        if(Math.random()<0.7) selected.push(Math.floor(Math.random()*5));
        if(Math.random()<0.4){
          let s2=Math.floor(Math.random()*5);
          while(s2===selected[0])s2=Math.floor(Math.random()*5);
          selected.push(s2);
        }
        confirmDraw(r,p.userId,selected);
      }
    },1500+Math.random()*2000);
  });
}

function botBet(roomId) {
  const room=rooms[roomId];
  if(!room)return;
  const p=room.players[room.currentTurn];
  if(!p||!p.isBot)return;
  setTimeout(()=>{
    const r=rooms[roomId];
    if(!r||!r.players[r.currentTurn]?.isBot)return;
    const bot=r.players[r.currentTurn];
    if(!bot||!bot.isBot)return;
    const isFinalBet=r.phase==='bet3'||r.phase==='fbet';
    const maxBet=isFinalBet?25:15;
    const rand=Math.random();
    // House favored — bots rarely fold, often raise
    if(r.currentBet===0){
      if(rand<0.5){
        // Raise
        const amt=Math.floor(Math.random()*(maxBet-1))+2;
        playerBetAction(roomId,bot.userId,'raise',amt);
      } else {
        playerBetAction(roomId,bot.userId,'check');
      }
    } else {
      if(rand<0.12){
        // Fold occasionally
        playerBetAction(roomId,bot.userId,'fold');
      } else if(rand<0.55){
        playerBetAction(roomId,bot.userId,'call');
      } else {
        const amt=Math.floor(Math.random()*(maxBet-r.currentBet))+r.currentBet+1;
        playerBetAction(roomId,bot.userId,'raise',Math.min(amt,maxBet));
      }
    }
  },1200+Math.random()*2500);
}

function botDeclare(roomId) {
  const room=rooms[roomId];
  if(!room||room.phase!=='decl')return;
  const p=room.players[room.currentTurn];
  if(!p||!p.isBot)return;
  setTimeout(()=>{
    const r=rooms[roomId];
    if(!r||r.phase!=='decl')return;
    const bot=r.players[r.currentTurn];
    if(!bot||!bot.isBot)return;
    if(r.gameType==='badugi'){
      // Declare based on hand quality
      const valid=isBadugi(bot.hand);
      if(valid){
        const lowRanks=evalBadugiLow(bot.hand);
        const highCard=lowRanks?lowRanks[0]:14;
        // Low hand if top card is 7 or less
        playerDeclareBadugi(roomId,bot.userId,highCard<=7?'low':'high');
      } else {
        playerDeclareBadugi(roomId,bot.userId,Math.random()<0.5?'high':'low');
      }
    } else {
      // Chain Gang declare
      const best=bestHand(bot.hand,r.cols);
      const hasGoodHigh=best.high&&best.high.r>=2;
      const hasLow=best.low!==null;
      if(hasGoodHigh&&hasLow&&Math.random()<0.15){
        playerDeclare(roomId,bot.userId,'swing');
      } else if(hasGoodHigh&&!hasLow){
        playerDeclare(roomId,bot.userId,'high');
      } else if(hasLow&&!hasGoodHigh){
        playerDeclare(roomId,bot.userId,'low');
      } else if(hasGoodHigh&&hasLow){
        playerDeclare(roomId,bot.userId,Math.random()<0.6?'high':'low');
      } else {
        playerDeclare(roomId,bot.userId,Math.random()<0.5?'high':'low');
      }
    }
  },1000+Math.random()*2000);
}

// Hook bot actions into broadcast
function broadcastRoom(roomId) {
  _broadcastRoom(roomId);
  const room=rooms[roomId];
  if(!room)return;
  if(room.phase==='ante') botAnte(roomId);
  else if(room.phase==='draw') botDraw(roomId);
  else if(['bet1','bet2','bet3','bbet','fbet','bet'].includes(room.phase)){
    const cur=room.players[room.currentTurn];
    if(cur&&cur.isBot) botBet(roomId);
  }
  else if(room.phase==='decl'){
    const cur=room.players[room.currentTurn];
    if(cur&&cur.isBot) botDeclare(roomId);
  }
  else if(room.phase==='hit'&&room.gameType==='1333'){
    const cur=room.players[room.currentTurn];
    if(cur&&cur.isBot) bot1535Action(roomId);
  }
}
app.get('*path',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
server.listen(PORT,'0.0.0.0',()=>console.log(`Chain Gang Poker running on port ${PORT}`));

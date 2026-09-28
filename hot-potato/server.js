const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const rooms = new Map();

const ROUND_MS = 12000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;
const MAX_STRIKES = 3;
const TASK_MS = 5000;

const TASKS = [
  { type: 'tap', prompt: 'Tap the potato 5 times!', target: 5 },
  { type: 'color', prompt: 'Tap the BLUE button!', target: 'blue' },
  { type: 'math', prompt: 'Solve this quickly:', target: null },
  { type: 'word', prompt: 'Type the word shown:', target: null }
];
const WORDS = ['QUICK', 'POTATO', 'PANIC', 'PASS', 'BOOM', 'RUN'];
const COLORS = ['blue', 'orange', 'purple', 'green'];

function code() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  do { c = Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join(''); } while (rooms.has(c));
  return c;
}
function playerView(p) { return { id:p.id, name:p.name, strikes:p.strikes, eliminated:p.eliminated, connected:p.connected }; }
function publicState(room) {
  return {
    code: room.code,
    status: room.status,
    hostId: room.hostId,
    round: room.round,
    maxStrikes: MAX_STRIKES,
    potatoHolder: room.potatoHolder,
    deadline: room.deadline,
    task: room.task ? {...room.task, answer: undefined} : null,
    taskDeadline: room.taskDeadline,
    players: [...room.players.values()].map(playerView),
    winnerId: room.winnerId || null,
    message: room.message || ''
  };
}
function emitState(room) { io.to(room.code).emit('state', publicState(room)); }
function activePlayers(room) { return [...room.players.values()].filter(p=>!p.eliminated); }
function resetTask(room) { room.task = null; room.taskDeadline = null; }
function chooseTask() {
  const t = TASKS[Math.floor(Math.random()*TASKS.length)];
  if (t.type === 'math') {
    const a = Math.floor(Math.random()*8)+2, b = Math.floor(Math.random()*8)+2;
    return { type:'math', prompt:`What is ${a} + ${b}?`, answer:String(a+b) };
  }
  if (t.type === 'word') {
    const word = WORDS[Math.floor(Math.random()*WORDS.length)];
    return { type:'word', prompt:'Type this word:', word, answer:word };
  }
  return {...t};
}
function startRound(room, firstId) {
  if (room.timer) clearTimeout(room.timer);
  if (room.taskTimer) clearTimeout(room.taskTimer);
  resetTask(room);
  room.round += 1;
  room.potatoHolder = firstId;
  room.deadline = Date.now() + ROUND_MS;
  room.message = `Round ${room.round} — don't get caught holding it!`;
  room.status = 'playing';
  room.timer = setTimeout(() => resolveTimeout(room.code), ROUND_MS + 30);
  emitState(room);
}
function resolveTimeout(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || room.status !== 'playing') return;
  const holder = room.players.get(room.potatoHolder);
  if (!holder || holder.eliminated) return nextRound(room);
  holder.strikes += 1;
  resetTask(room);
  if (holder.strikes >= MAX_STRIKES) {
    holder.eliminated = true;
    room.message = `${holder.name} got caught and is eliminated!`;
  } else {
    room.message = `${holder.name} got caught! +1 strike.`;
  }
  const alive = activePlayers(room);
  if (alive.length <= 1) {
    room.status = 'finished';
    room.winnerId = alive[0]?.id || null;
    room.potatoHolder = null;
    room.deadline = null;
    if (room.timer) clearTimeout(room.timer);
    emitState(room);
    return;
  }
  emitState(room);
  setTimeout(() => {
    if (rooms.has(room.code) && room.status !== 'finished') {
      const next = alive[Math.floor(Math.random()*alive.length)];
      startRound(room, next.id);
    }
  }, 1400);
}
function validRoom(room, socket) { return room && room.players.has(socket.id); }

app.use(express.static(path.join(__dirname, 'public')));
app.get('/room/:roomCode', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/health', (req,res) => res.json({ok:true, rooms:rooms.size}));

io.on('connection', socket => {
  socket.on('createRoom', ({name}) => {
    name = String(name || '').trim().slice(0,18) || 'Player';
    const c = code();
    const room = { code:c, players:new Map(), hostId:socket.id, status:'lobby', round:0, potatoHolder:null, deadline:null, task:null, taskDeadline:null, timer:null, taskTimer:null, winnerId:null, message:'Waiting for another player…' };
    room.players.set(socket.id,{id:socket.id,name,strikes:0,eliminated:false,connected:true});
    rooms.set(c,room); socket.join(c); socket.data.room=c;
    socket.emit('roomCreated',{code:c}); emitState(room);
  });
  socket.on('joinRoom', ({roomCode,name}) => {
    const c=String(roomCode||'').trim().toUpperCase(); const room=rooms.get(c);
    if (!room) return socket.emit('errorMessage','Room not found. Check the code.');
    if (room.players.size>=MAX_PLAYERS) return socket.emit('errorMessage','Room is full.');
    if (room.status==='finished') return socket.emit('errorMessage','That game has already finished.');
    name=String(name||'').trim().slice(0,18)||'Player';
    room.players.set(socket.id,{id:socket.id,name,strikes:0,eliminated:false,connected:true}); socket.join(c); socket.data.room=c;
    room.message = `${name} joined the room.`; emitState(room);
  });
  socket.on('startGame', () => {
    const room=rooms.get(socket.data.room); if(!validRoom(room,socket) || room.hostId!==socket.id) return;
    if (activePlayers(room).length<MIN_PLAYERS) return socket.emit('errorMessage','You need at least 2 players to start.');
    const alive=activePlayers(room); const first=alive[Math.floor(Math.random()*alive.length)]; startRound(room,first.id);
  });
  socket.on('passPotato', ({targetId}) => {
    const room=rooms.get(socket.data.room); if(!validRoom(room,socket) || room.status!=='playing') return;
    if(room.potatoHolder!==socket.id) return socket.emit('errorMessage','You do not have the potato.');
    const target=room.players.get(targetId); if(!target || target.eliminated || target.id===socket.id) return socket.emit('errorMessage','Choose a living player.');
    if(Date.now()>=room.deadline) return resolveTimeout(room.code);
    room.potatoHolder=target.id; room.message=`${room.players.get(socket.id).name} passed the potato to ${target.name}.`;
    emitState(room);
  });
  socket.on('startTask', () => {
    const room=rooms.get(socket.data.room); if(!validRoom(room,socket) || room.status!=='playing') return;
    if(room.potatoHolder!==socket.id) return socket.emit('errorMessage','You do not have the potato.');
    if(room.task) return;
    if(Date.now()>=room.deadline) return resolveTimeout(room.code);
    room.task=chooseTask(); room.taskDeadline=Math.min(room.deadline,Date.now()+TASK_MS);
    room.taskTimer=setTimeout(()=>resolveTask(room.code,socket.id,false), Math.max(0,room.taskDeadline-Date.now()+20));
    room.message='Complete the task before time runs out!'; emitState(room);
  });
  socket.on('submitTask', ({answer, taps}) => {
    const room=rooms.get(socket.data.room); if(!validRoom(room,socket) || room.status!=='playing') return;
    if(room.potatoHolder!==socket.id || !room.task) return;
    const t=room.task; let ok=false;
    if(t.type==='tap') ok=Number(taps) >= t.target;
    else if(t.type==='color') ok=String(answer).toLowerCase()===t.target;
    else ok=String(answer||'').trim().toUpperCase()===String(t.answer).toUpperCase();
    if(Date.now()>=room.taskDeadline || Date.now()>=room.deadline) ok=false;
    resolveTask(room.code,socket.id,ok);
  });
  socket.on('playAgain', () => {
    const room=rooms.get(socket.data.room); if(!validRoom(room,socket)) return;
    if(room.hostId!==socket.id) return;
    for(const p of room.players.values()) { p.strikes=0; p.eliminated=false; }
    room.status='lobby'; room.round=0; room.winnerId=null; room.potatoHolder=null; room.deadline=null; resetTask(room); room.message='Ready for another game.'; emitState(room);
  });
  socket.on('disconnect', () => {
    const c=socket.data.room, room=rooms.get(c); if(!room) return;
    const p=room.players.get(socket.id); if(!p) return;
    p.connected=false;
    if(room.status==='lobby') { room.players.delete(socket.id); if(room.hostId===socket.id) { const n=room.players.values().next().value; room.hostId=n?.id; } }
    else if(room.status==='playing' && room.potatoHolder===socket.id) resolveTimeout(c);
    emitState(room);
  });
});
function resolveTask(roomCode, playerId, success) {
  const room=rooms.get(roomCode); if(!room || room.status!=='playing' || !room.task) return;
  if(room.taskTimer) clearTimeout(room.taskTimer); room.taskTimer=null;
  const player=room.players.get(playerId); if(!player) return;
  const taskType=room.task.type; resetTask(room);
  if(success) { room.message = `${player.name} completed the task!`; emitState(room); return; }
  player.strikes += 1; room.message = `${player.name} failed the task and takes a strike.`;
  if(player.strikes>=MAX_STRIKES) player.eliminated=true;
  const alive=activePlayers(room);
  if(alive.length<=1) { room.status='finished'; room.winnerId=alive[0]?.id||null; room.potatoHolder=null; room.deadline=null; if(room.timer) clearTimeout(room.timer); emitState(room); return; }
  room.potatoHolder=alive[Math.floor(Math.random()*alive.length)].id;
  room.deadline=Date.now()+ROUND_MS;
  room.round += 1;
  room.timer=setTimeout(()=>resolveTimeout(room.code),ROUND_MS+30);
  emitState(room);
}

server.listen(PORT, () => console.log(`Hot Potato running on http://localhost:${PORT}`));

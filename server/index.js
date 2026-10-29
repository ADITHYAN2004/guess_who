// Authoritative game server: owns rooms, secrets, turns, answers and win checks.
// Clients only render state and send intents.
//
// Storage: rooms are kept in memory by default. Set REDIS_URL to keep them in Redis instead,
// so games survive restarts and several server processes can share them (see server/store.js).
const path = require("path");
const http = require("http");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const { generateBoard } = require("./characters");
const { QUESTION_MAP, PUBLIC_QUESTIONS, GROUPS } = require("./questions");
const { createStore } = require("./store");

const PORT = process.env.PORT || 3000;
// Identifies this server process across restarts, so it can find the players it was serving.
const SERVER_ID = process.env.SERVER_ID || `${os.hostname()}:${PORT}`;
const DISCONNECT_MS = 30_000;  // forfeit / cleanup grace period
const PHASE = { LOBBY: "LOBBY", PICKING: "PICKING", PLAYING: "PLAYING", FINISHED: "FINISHED" };
// Quick reactions: a fixed set (no free text means nothing to moderate).
const REACTIONS = ["😂", "🤔", "😱", "👏", "😎", "🙈"];
const REACT_GAP_MS = 800; // per-player rate limit
const POKE_GAP_MS = 8000; // one poke every 8s at most
// Most games (rooms) at once. Load-tested on Render's free plan (0.1 CPU): smooth up to ~50-75
// games, noticeable lag around 100. Joining an existing room is always allowed.
const MAX_GAMES = Number(process.env.MAX_GAMES) || 100;
const NO_SAVE = Symbol("no-save"); // returned by a room change that didn't modify anything

const app = express();
app.use(express.static(path.join(__dirname, "..", "public"), {
  setHeaders(res, filePath) {
    // The service worker and manifest must never be served stale, or PWA updates get stuck.
    if (filePath.endsWith("sw.js") || filePath.endsWith(".webmanifest")) res.setHeader("Cache-Control", "no-cache");
    if (filePath.endsWith(".webmanifest")) res.setHeader("Content-Type", "application/manifest+json");
  },
}));
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 10_000, pingTimeout: 8_000 });

const store = createStore();
const dcTimers = new Map(); // `${code}:${playerId}` -> forfeit timer (local to this process)

// ---------- client build id ----------
// A hash of everything in public/. Clients get it on connect and reload themselves when it
// changes, so an open tab never keeps running old code after an update or server restart.
const PUBLIC_DIR = path.join(__dirname, "..", "public");

function hashDir(dir, hash = crypto.createHash("sha1")) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) hashDir(full, hash);
    else hash.update(entry.name).update(fs.readFileSync(full));
  }
  return hash;
}
let BUILD = hashDir(PUBLIC_DIR).digest("hex").slice(0, 12);

// Live-reload open pages when files in public/ are edited (debounced).
let rehashTimer;
try {
  fs.watch(PUBLIC_DIR, { recursive: true }, () => {
    clearTimeout(rehashTimer);
    rehashTimer = setTimeout(() => {
      const next = hashDir(PUBLIC_DIR).digest("hex").slice(0, 12);
      if (next === BUILD) return;
      BUILD = next;
      console.log(`Client files changed (build ${BUILD}); reloading open pages.`);
      io.emit("server:hello", { build: BUILD });
    }, 300);
  });
} catch { /* fs.watch unsupported here; restart the server to pick up changes */ }

// ---------- helpers ----------

const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O (they look like 1 and 0)
const randomCode = () => Array.from({ length: 4 }, () => CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)]).join("");
const newId = () => crypto.randomBytes(12).toString("hex");

function cleanName(name) {
  const n = typeof name === "string" ? name.trim().replace(/\s+/g, " ").slice(0, 16) : "";
  return n || "Player";
}

const newPlayer = name => ({ id: newId(), name: cleanName(name), socketId: null, server: null, connected: false, secret: null, rematch: false });
const opponentOf = (room, playerId) => room.players.find(p => p.id !== playerId);
const findPlayer = (room, playerId) => room.players.find(p => p.id === playerId);
const isValidCharacter = (room, id) => Number.isInteger(id) && id >= 0 && id < room.board.length;
const reply = (ack, payload) => typeof ack === "function" && ack(payload);
const fail = (ack, error) => { reply(ack, { ok: false, error }); return NO_SAVE; };

function newBoardFor(room) {
  room.board = generateBoard();
  room.boardId = newId(); // lets clients reset their local flip-downs
}

// Load a room under its lock, run `fn(room)` (which may change it), then save it.
// `room` is null if it doesn't exist. Return NO_SAVE from fn to skip the write.
async function withRoom(code, fn) {
  if (!code) return fn(null);
  const release = await store.lock(code);
  try {
    const room = await store.get(code);
    const result = await fn(room);
    if (room && !room.deleted && result !== NO_SAVE) await store.save(room);
    return result;
  } finally {
    await release();
  }
}

// Run a player's action in their room. Rejects sockets that aren't (or are no longer) in it.
function inRoom(socket, ack, fn) {
  return withRoom(socket.data.code, room => {
    const player = room && findPlayer(room, socket.data.playerId);
    if (!player || player.socketId !== socket.id) return fail(ack, "Not in a room.");
    return fn(room, player);
  });
}

// Wraps a socket handler so storage errors (e.g. Redis down) answer the client instead of crashing.
const safe = handler => async (data, ack) => {
  try {
    await handler(data ?? {}, ack);
  } catch (err) {
    console.error("[handler]", err);
    reply(ack, { ok: false, error: "Server busy, please try again." });
  }
};

// Build the per-player view of the room. The opponent's secret is only included once the game is FINISHED.
function viewFor(room, player) {
  const finished = room.phase === PHASE.FINISHED;
  return {
    code: room.code,
    phase: room.phase,
    private: room.private,
    me: player.id,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      picked: p.secret !== null,
      rematch: p.rematch,
    })),
    board: room.board,
    boardId: room.boardId,
    questions: PUBLIC_QUESTIONS,
    questionGroups: GROUPS,
    turn: room.turn,
    askedThisTurn: Boolean(room.askedThisTurn),
    log: room.log,
    mySecret: player.secret,
    winnerId: room.winnerId,
    reason: room.reason,
    secrets: finished ? Object.fromEntries(room.players.map(p => [p.id, p.secret])) : null,
    summary: finished ? room.summary : null,
    ruledOut: ruledOutFor(room, player.id),
    nextFirst: finished ? room.nextFirst : null,
    reactions: REACTIONS,
  };
}

// Characters this player's own answers have ruled out (they can't be the opponent's person).
// Only uses the player's own questions, so it reveals nothing they don't already know.
function ruledOutFor(room, playerId) {
  if (room.phase !== PHASE.PLAYING && room.phase !== PHASE.FINISHED) return [];
  const asks = room.log
    .filter(e => e.type === "ask" && e.playerId === playerId)
    .map(e => ({ q: QUESTION_MAP.get(e.questionId), answer: e.answer }))
    .filter(a => a.q);
  if (!asks.length) return [];
  return room.board.filter(c => asks.some(a => Boolean(a.q.test(c)) !== a.answer)).map(c => c.id);
}

// End-of-game stats per player: how many questions they asked, and their best question
// (the one that ruled out the most people from their view of the board).
function buildSummary(room) {
  const out = {};
  for (const p of room.players) {
    let remaining = room.board;
    let asked = 0, best = null;
    for (const e of room.log) {
      if (e.type !== "ask" || e.playerId !== p.id) continue;
      const q = QUESTION_MAP.get(e.questionId);
      if (!q) continue;
      asked++;
      const before = remaining.length;
      remaining = remaining.filter(c => Boolean(q.test(c)) === e.answer);
      const ruledOut = before - remaining.length;
      if (!best || ruledOut > best.ruledOut) {
        best = { questionId: q.id, short: q.short, text: q.text, answer: e.answer, ruledOut, left: remaining.length };
      }
    }
    out[p.id] = { asked, best, left: remaining.length };
  }
  return out;
}

// io.to(socketId) reaches the socket on whichever server it's connected to (via the Redis adapter).
function sendState(room) {
  for (const p of room.players) {
    if (p.connected && p.socketId) io.to(p.socketId).emit("room:state", viewFor(room, p));
  }
  lobbyChanged();
}

// ---------- public room list (home-screen dashboard) ----------
// Only names, codes and phases are shared, never boards or secrets.
// Private rooms and rooms with nobody connected are left out.
const LOBBY_CHANNEL = "lobby-watchers";

// The home-screen payload: public rooms + how full the server is.
async function lobbyPayload() {
  const all = await store.list();
  return {
    rooms: publicRoomList(all),
    capacity: { games: all.length, max: MAX_GAMES },
    serverNow: Date.now(),
  };
}

function publicRoomList(all) {
  return all
    .filter(r => !r.private && r.players.some(p => p.connected))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50)
    .map(r => ({
      code: r.code,
      phase: r.phase,
      joinable: r.players.length === 1 && (r.phase === PHASE.LOBBY || r.phase === PHASE.FINISHED),
      players: r.players.map(p => ({ name: p.name, connected: p.connected })),
      createdAt: r.createdAt,
    }));
}

// Debounced broadcast to everyone looking at the home screen (on every server).
let lobbyTimer = null;
function lobbyChanged() {
  if (lobbyTimer) return;
  lobbyTimer = setTimeout(async () => {
    lobbyTimer = null;
    try {
      io.to(LOBBY_CHANNEL).emit("lobby:rooms", await lobbyPayload());
    } catch (err) { console.error("[lobby]", err.message); }
  }, 250);
}

// No turn timer: a turn lasts until the player asks or guesses.
// A turn: ask at most one question, then guess or end the turn. A guess is allowed
// at any point during your own turn (before or after asking).
function startTurn(room, playerId) {
  room.turn = playerId;
  room.askedThisTurn = false;
  io.to(room.code).emit("turn:changed", { playerId });
}

function finishGame(room, winnerId, reason) {
  room.phase = PHASE.FINISHED;
  room.turn = null;
  room.winnerId = winnerId;
  room.reason = reason;
  room.summary = buildSummary(room);
  // The loser goes first in a rematch.
  room.nextFirst = room.players.find(p => p.id !== winnerId)?.id ?? null;
  for (const p of room.players) p.rematch = false;
  const last = room.log[room.log.length - 1];
  const guess = reason.endsWith("guess") && last?.type === "guess"
    ? { playerId: last.playerId, characterId: last.characterId, correct: last.correct }
    : null;
  io.to(room.code).emit("game:over", {
    winnerId,
    reason,
    guess,
    secrets: Object.fromEntries(room.players.map(p => [p.id, p.secret])),
  });
  sendState(room);
}

function startPicking(room) {
  room.phase = PHASE.PICKING;
  room.log = [];
  room.turn = null;
  room.winnerId = null;
  room.reason = null;
  room.summary = null;
  room.askedThisTurn = false;
  for (const p of room.players) { p.secret = null; p.rematch = false; }
}

async function deleteRoom(room) {
  for (const p of room.players) clearDcTimer(room.code, p.id);
  room.deleted = true; // tells withRoom not to save it back
  await store.delete(room.code);
  lobbyChanged();
}

function attachSocket(socket, room, player) {
  clearDcTimer(room.code, player.id);
  // If this player had another tab open, the newest socket wins (works across servers).
  if (player.socketId && player.socketId !== socket.id) io.in(player.socketId).socketsLeave(room.code);
  player.socketId = socket.id;
  player.server = SERVER_ID;
  player.connected = true;
  socket.data.code = room.code;
  socket.data.playerId = player.id;
  socket.join(room.code);
}

// ---------- disconnect grace timers ----------
function clearDcTimer(code, playerId) {
  const key = `${code}:${playerId}`;
  clearTimeout(dcTimers.get(key));
  dcTimers.delete(key);
}

// If the player is still gone after the grace period: forfeit (or delete an empty room).
function startDcTimer(code, playerId, ms = DISCONNECT_MS) {
  clearDcTimer(code, playerId);
  dcTimers.set(`${code}:${playerId}`, setTimeout(() => {
    dcTimers.delete(`${code}:${playerId}`);
    withRoom(code, async room => {
      const player = room && findPlayer(room, playerId);
      if (!player || player.connected) return NO_SAVE; // came back (maybe on another server)
      if (room.players.every(p => !p.connected)) return deleteRoom(room);
      if (room.phase === PHASE.PICKING || room.phase === PHASE.PLAYING) {
        finishGame(room, opponentOf(room, player.id).id, "forfeit");
        return;
      }
      return NO_SAVE;
    }).catch(err => console.error("[dc-timer]", err.message));
  }, ms));
}

// ---------- socket handlers ----------

io.on("connection", socket => {
  socket.emit("server:hello", { build: BUILD });

  socket.on("lobby:watch", safe(async () => {
    socket.join(LOBBY_CHANNEL);
    socket.emit("lobby:rooms", await lobbyPayload());
  }));
  socket.on("lobby:unwatch", () => socket.leave(LOBBY_CHANNEL));

  // True if this socket is currently seated in a room.
  const seated = async () => {
    if (!socket.data.code) return false;
    const room = await store.get(socket.data.code);
    return Boolean(room && findPlayer(room, socket.data.playerId)?.socketId === socket.id);
  };

  socket.on("room:create", safe(async (data, ack) => {
    if (await seated()) return fail(ack, "Already in a room.");
    if ((await store.count()) >= MAX_GAMES) {
      lobbyChanged(); // make sure everyone's home screen shows "full"
      return reply(ack, { ok: false, full: true, error: "The server is full right now. Try again in a few minutes, or join a friend's room." });
    }
    const player = newPlayer(data.playerName);
    const room = {
      code: null,
      private: data.private === true, // private rooms are hidden from the public list
      createdAt: Date.now(),
      phase: PHASE.LOBBY,
      players: [player],
      board: null,
      boardId: null,
      turn: null,
      log: [],
      winnerId: null,
      reason: null,
      nextFirst: null,
    };
    newBoardFor(room);
    // Claim a free code (create is atomic, so two servers can't hand out the same one).
    do { room.code = randomCode(); } while (!(await store.create(room)));

    await withRoom(room.code, saved => {
      const me = findPlayer(saved, player.id);
      attachSocket(socket, saved, me);
      reply(ack, { ok: true, code: saved.code, playerId: me.id });
      sendState(saved);
    });
  }));

  socket.on("room:join", safe(async (data, ack) => {
    if (await seated()) return fail(ack, "Already in a room.");
    const code = String(data.code || "").trim().toUpperCase();
    await withRoom(code, room => {
      if (!room) return fail(ack, "Room not found.");
      if (room.players.length >= 2) return fail(ack, "Room is full.");
      const player = newPlayer(data.playerName);
      room.players.push(player);
      attachSocket(socket, room, player);
      newBoardFor(room);
      startPicking(room);
      room.nextFirst = null; // new opponent = fresh game, random first turn
      reply(ack, { ok: true, code: room.code, playerId: player.id });
      sendState(room);
    });
  }));

  // Reconnect after a dropped socket (page reload, mobile network switch, server restart, ...).
  socket.on("room:rejoin", safe(async (data, ack) => {
    const code = String(data.code || "").toUpperCase();
    await withRoom(code, room => {
      const player = room && findPlayer(room, data.playerId);
      if (!player) return fail(ack, "Game no longer exists.");
      attachSocket(socket, room, player);
      reply(ack, { ok: true, code: room.code, playerId: player.id });
      socket.to(room.code).emit("player:reconnected", { playerId: player.id });
      sendState(room);
    });
  }));

  socket.on("room:leave", safe(async () => {
    const code = socket.data.code;
    await inRoom(socket, null, async (room, player) => {
      socket.leave(room.code);
      socket.data = {};
      // Detach the leaver first so the "game over" update below only reaches the opponent;
      // otherwise the leaver's page would jump to the result screen instead of going home.
      player.connected = false;
      player.socketId = null;
      clearDcTimer(code, player.id);
      const opp = opponentOf(room, player.id);
      if ((room.phase === PHASE.PICKING || room.phase === PHASE.PLAYING) && opp) {
        finishGame(room, opp.id, "forfeit");
      }
      room.players = room.players.filter(p => p.id !== player.id);
      if (room.players.length === 0) return deleteRoom(room);
      // The remaining player sees the result screen; someone new can still join with the same code.
      io.to(room.code).emit("player:disconnected", { playerId: player.id, left: true });
      sendState(room);
    });
  }));

  socket.on("pick:secret", safe((data, ack) => inRoom(socket, ack, (room, player) => {
    if (room.phase !== PHASE.PICKING) return fail(ack, "Not picking right now.");
    if (player.secret !== null) return fail(ack, "Already locked in.");
    if (!isValidCharacter(room, data.characterId)) return fail(ack, "Invalid character.");

    player.secret = data.characterId;
    reply(ack, { ok: true });

    if (room.players.length === 2 && room.players.every(p => p.secret !== null)) {
      room.phase = PHASE.PLAYING;
      // Rematch: the previous loser starts. Otherwise pick at random.
      const first = room.players.some(p => p.id === room.nextFirst)
        ? room.nextFirst
        : room.players[crypto.randomInt(2)].id;
      room.nextFirst = null;
      io.to(room.code).emit("game:start", { firstTurn: first });
      startTurn(room, first);
    }
    sendState(room);
  })));

  socket.on("turn:ask", safe((data, ack) => inRoom(socket, ack, (room, player) => {
    if (room.phase !== PHASE.PLAYING) return fail(ack, "Game is not in progress.");
    if (room.turn !== player.id) return fail(ack, "Not your turn.");
    if (room.askedThisTurn) return fail(ack, "You already asked this turn. Make a guess or end your turn.");
    const q = QUESTION_MAP.get(data.questionId);
    if (!q) return fail(ack, "Unknown question.");

    const opp = opponentOf(room, player.id);
    const answer = Boolean(q.test(room.board[opp.secret]));
    // People still possible from the asker's point of view, before and after this answer.
    // (Not secret: the opponent can work this out from the same board and answers.)
    const before = room.board.length - ruledOutFor(room, player.id).length;
    room.log.push({ type: "ask", playerId: player.id, questionId: q.id, text: q.text, answer, at: Date.now() });
    const left = room.board.length - ruledOutFor(room, player.id).length;
    room.log[room.log.length - 1].left = left;
    room.askedThisTurn = true; // the turn stays with the asker: now guess or end the turn
    reply(ack, { ok: true, answer, left });
    io.to(room.code).emit("ask:result", { playerId: player.id, questionId: q.id, answer, before, left });
    sendState(room);
  })));

  socket.on("turn:end", safe((_data, ack) => inRoom(socket, ack, (room, player) => {
    if (room.phase !== PHASE.PLAYING) return fail(ack, "Game is not in progress.");
    if (room.turn !== player.id) return fail(ack, "Not your turn.");
    if (!room.askedThisTurn) return fail(ack, "Ask a question or make a guess first.");
    reply(ack, { ok: true });
    startTurn(room, opponentOf(room, player.id).id);
    sendState(room);
  })));

  // Poke: nudge an opponent who is taking a long time. Doesn't change the room.
  socket.on("poke:send", safe(async (_data, ack) => {
    if (!socket.data.code) return fail(ack, "Not in a room.");
    const room = await store.get(socket.data.code);
    const player = room && findPlayer(room, socket.data.playerId);
    if (!player || player.socketId !== socket.id) return fail(ack, "Not in a room.");
    const opp = opponentOf(room, player.id);
    if (room.phase !== PHASE.PLAYING || !opp || room.turn !== opp.id) return fail(ack, "You can only poke while it's their turn.");
    const now = Date.now();
    if (now - (socket.data.lastPokeAt || 0) < POKE_GAP_MS) return fail(ack, "Give them a few seconds before poking again.");
    socket.data.lastPokeAt = now;
    if (opp.socketId) io.to(opp.socketId).emit("poke:show", { from: player.name });
    reply(ack, { ok: true });
  }));

  socket.on("turn:guess", safe((data, ack) => inRoom(socket, ack, (room, player) => {
    if (room.phase !== PHASE.PLAYING) return fail(ack, "Game is not in progress.");
    if (room.turn !== player.id) return fail(ack, "Not your turn.");
    if (!isValidCharacter(room, data.characterId)) return fail(ack, "Invalid character.");

    const opp = opponentOf(room, player.id);
    const correct = data.characterId === opp.secret;
    room.log.push({ type: "guess", playerId: player.id, characterId: data.characterId, correct, at: Date.now() });
    reply(ack, { ok: true, correct });
    finishGame(room, correct ? player.id : opp.id, correct ? "correct-guess" : "wrong-guess");
  })));

  // Reactions don't change the room, so they skip the lock and the save.
  socket.on("react:send", safe(async data => {
    if (!REACTIONS.includes(data.emoji) || !socket.data.code) return;
    const now = Date.now();
    if (now - (socket.data.lastReactAt || 0) < REACT_GAP_MS) return; // drop spam silently
    const room = await store.get(socket.data.code);
    const player = room && findPlayer(room, socket.data.playerId);
    if (!player || player.socketId !== socket.id || room.players.length < 2) return;
    socket.data.lastReactAt = now;
    io.to(room.code).emit("react:show", { playerId: player.id, emoji: data.emoji });
  }));

  socket.on("rematch:request", safe((_data, ack) => inRoom(socket, ack, (room, player) => {
    if (room.phase !== PHASE.FINISHED) return fail(ack, "Game is not over.");
    if (room.players.length < 2) return fail(ack, "Opponent left.");

    player.rematch = true;
    reply(ack, { ok: true });
    if (room.players.every(p => p.rematch)) {
      newBoardFor(room);
      startPicking(room);
    }
    sendState(room);
  })));

  socket.on("disconnect", () => {
    const code = socket.data.code;
    withRoom(code, room => {
      const player = room && findPlayer(room, socket.data.playerId);
      if (!player || player.socketId !== socket.id) return NO_SAVE; // stale socket (e.g. replaced by a newer tab)
      player.connected = false;
      socket.to(room.code).emit("player:disconnected", { playerId: player.id, graceMs: DISCONNECT_MS });
      sendState(room);
      startDcTimer(room.code, player.id);
    }).catch(err => console.error("[disconnect]", err.message));
  });
});

// ---------- server heartbeats (Redis) ----------
// Each server checks in every few seconds. If a server stops checking in (crash, redeploy on
// a host like Render, scaled down), any other server marks its players as away and starts
// their usual grace period, so rooms never get stuck with "connected" ghosts.
const HEARTBEAT_MS = 10_000;
const HEARTBEAT_TTL_S = 30;

async function sweepDeadServers() {
  const rooms = await store.list();
  const others = new Set();
  for (const r of rooms) for (const p of r.players) if (p.connected && p.server !== SERVER_ID) others.add(p.server);
  if (!others.size) return;
  const alive = await store.aliveServers([...others].filter(Boolean));
  for (const snapshot of rooms) {
    if (!snapshot.players.some(p => p.connected && p.server !== SERVER_ID && !alive.has(p.server))) continue;
    await withRoom(snapshot.code, room => {
      if (!room) return NO_SAVE;
      let changed = false;
      for (const p of room.players) {
        if (!p.connected || p.server === SERVER_ID || alive.has(p.server)) continue;
        p.connected = false;
        p.socketId = null;
        io.to(room.code).emit("player:disconnected", { playerId: p.id, graceMs: DISCONNECT_MS });
        startDcTimer(room.code, p.id);
        changed = true;
      }
      if (!changed) return NO_SAVE;
      sendState(room);
    });
  }
}

function startHeartbeat() {
  if (store.kind !== "redis") return;
  const beat = () => store.markAlive(SERVER_ID, HEARTBEAT_TTL_S).catch(err => console.error("[heartbeat]", err.message));
  beat();
  setInterval(beat, HEARTBEAT_MS).unref();
  setInterval(() => sweepDeadServers().catch(err => console.error("[sweep]", err.message)), HEARTBEAT_MS * 2).unref();
}

// ---------- startup ----------

// After a restart, players this server was serving are no longer connected. Mark them as away
// and give them the usual grace period to reconnect (their pages do it automatically).
async function recoverRooms() {
  let count = 0;
  for (const snapshot of await store.list()) {
    const mine = snapshot.players.filter(p => p.connected && p.server === SERVER_ID);
    if (!mine.length) continue;
    await withRoom(snapshot.code, room => {
      if (!room) return NO_SAVE;
      for (const p of room.players) {
        if (!p.connected || p.server !== SERVER_ID) continue;
        p.connected = false;
        p.socketId = null;
        startDcTimer(room.code, p.id);
        count++;
      }
    });
  }
  if (count) console.log(`Recovered ${count} player(s) from before the restart; they have ${DISCONNECT_MS / 1000}s to reconnect.`);
}

async function main() {
  await store.connect();
  if (store.kind === "redis") {
    // Share Socket.IO rooms/broadcasts between server processes through Redis pub/sub.
    const { createAdapter } = require("@socket.io/redis-adapter");
    const pub = store.client.duplicate();
    const sub = store.client.duplicate();
    pub.on("error", err => console.error("[redis pub]", err.message));
    sub.on("error", err => console.error("[redis sub]", err.message));
    await Promise.all([pub.connect(), sub.connect()]);
    io.adapter(createAdapter(pub, sub));
  }
  await recoverRooms();
  startHeartbeat();

  server.listen(PORT, () => {
    console.log(`Guess Who server on http://localhost:${PORT}  (rooms stored in ${store.kind}${store.kind === "redis" ? `, server id ${SERVER_ID}` : ""})`);
    // Show LAN addresses so you can open the game on a phone on the same Wi-Fi.
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.family === "IPv4" && !a.internal) console.log(`  on your network: http://${a.address}:${PORT}`);
      }
    }
  });
}

main().catch(err => {
  console.error("Failed to start:", err.message);
  if (process.env.REDIS_URL) console.error("Is Redis running at REDIS_URL? Try: docker compose up -d redis");
  process.exit(1);
});

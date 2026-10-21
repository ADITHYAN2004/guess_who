// Authoritative game server: owns rooms, secrets, turns, answers and win checks.
// Clients only render state and send intents.
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const { generateBoard } = require("./characters");
const { QUESTION_MAP, PUBLIC_QUESTIONS, GROUPS } = require("./questions");

const PORT = process.env.PORT || 3000;
const DISCONNECT_MS = 30_000;  // forfeit / cleanup grace period
const PHASE = { LOBBY: "LOBBY", PICKING: "PICKING", PLAYING: "PLAYING", FINISHED: "FINISHED" };

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

/** @type {Map<string, any>} */
const rooms = new Map();

// ---------- client build id ----------
// A hash of everything in public/. Clients get it on connect and reload themselves when it
// changes, so an open tab never keeps running old code after an update or server restart.
const fs = require("fs");
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
function newRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)]).join("");
  } while (rooms.has(code));
  return code;
}

const newId = () => crypto.randomBytes(12).toString("hex");

function cleanName(name) {
  const n = typeof name === "string" ? name.trim().replace(/\s+/g, " ").slice(0, 16) : "";
  return n || "Player";
}

const opponentOf = (room, playerId) => room.players.find(p => p.id !== playerId);
const findPlayer = (room, playerId) => room.players.find(p => p.id === playerId);
const isValidCharacter = (room, id) => Number.isInteger(id) && id >= 0 && id < room.board.length;

function newBoardFor(room) {
  room.board = generateBoard();
  room.boardId = newId(); // lets clients reset their local flip-downs
}

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
    log: room.log,
    mySecret: player.secret,
    winnerId: room.winnerId,
    reason: room.reason,
    secrets: finished ? Object.fromEntries(room.players.map(p => [p.id, p.secret])) : null,
  };
}

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

function publicRoomList() {
  return [...rooms.values()]
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

// Debounced broadcast to everyone looking at the home screen.
let lobbyTimer = null;
function lobbyChanged() {
  if (lobbyTimer) return;
  lobbyTimer = setTimeout(() => {
    lobbyTimer = null;
    io.to(LOBBY_CHANNEL).emit("lobby:rooms", { rooms: publicRoomList(), serverNow: Date.now() });
  }, 250);
}

// No turn timer: a turn lasts until the player asks or guesses.
function startTurn(room, playerId) {
  room.turn = playerId;
  io.to(room.code).emit("turn:changed", { playerId });
}

function finishGame(room, winnerId, reason) {
  room.phase = PHASE.FINISHED;
  room.turn = null;
  room.winnerId = winnerId;
  room.reason = reason;
  for (const p of room.players) p.rematch = false;
  io.to(room.code).emit("game:over", {
    winnerId,
    reason,
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
  for (const p of room.players) { p.secret = null; p.rematch = false; }
}

function deleteRoom(room) {
  for (const p of room.players) clearTimeout(p.dcTimer);
  rooms.delete(room.code);
  lobbyChanged();
}

function attachSocket(socket, room, player) {
  clearTimeout(player.dcTimer);
  player.dcTimer = null;
  // If this player had another tab open, the newest socket wins.
  if (player.socketId && player.socketId !== socket.id) {
    io.sockets.sockets.get(player.socketId)?.leave(room.code);
  }
  player.socketId = socket.id;
  player.connected = true;
  socket.data.code = room.code;
  socket.data.playerId = player.id;
  socket.join(room.code);
}

// Resolve the room and player for an incoming intent, or null if the socket isn't in a game.
function ctx(socket) {
  const room = rooms.get(socket.data.code);
  if (!room) return null;
  const player = findPlayer(room, socket.data.playerId);
  if (!player || player.socketId !== socket.id) return null;
  return { room, player };
}

const reply = (ack, payload) => typeof ack === "function" && ack(payload);

// ---------- socket handlers ----------

io.on("connection", socket => {
  socket.emit("server:hello", { build: BUILD });

  socket.on("lobby:watch", () => {
    socket.join(LOBBY_CHANNEL);
    socket.emit("lobby:rooms", { rooms: publicRoomList(), serverNow: Date.now() });
  });
  socket.on("lobby:unwatch", () => socket.leave(LOBBY_CHANNEL));

  socket.on("room:create", (data = {}, ack) => {
    if (ctx(socket)) return reply(ack, { ok: false, error: "Already in a room." });
    const room = {
      code: newRoomCode(),
      private: data.private === true, // private rooms are hidden from the public list
      createdAt: Date.now(),
      phase: PHASE.LOBBY,
      players: [],
      board: null,
      boardId: null,
      turn: null,
      log: [],
      winnerId: null,
      reason: null,
    };
    newBoardFor(room);
    const player = { id: newId(), name: cleanName(data.playerName), socketId: null, connected: false, secret: null, rematch: false, dcTimer: null };
    room.players.push(player);
    rooms.set(room.code, room);
    attachSocket(socket, room, player);
    reply(ack, { ok: true, code: room.code, playerId: player.id });
    sendState(room);
  });

  socket.on("room:join", (data = {}, ack) => {
    if (ctx(socket)) return reply(ack, { ok: false, error: "Already in a room." });
    const code = String(data.code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return reply(ack, { ok: false, error: "Room not found." });
    if (room.players.length >= 2) return reply(ack, { ok: false, error: "Room is full." });

    const player = { id: newId(), name: cleanName(data.playerName), socketId: null, connected: false, secret: null, rematch: false, dcTimer: null };
    room.players.push(player);
    attachSocket(socket, room, player);
    newBoardFor(room);
    startPicking(room);
    reply(ack, { ok: true, code: room.code, playerId: player.id });
    sendState(room);
  });

  // Reconnect after a dropped socket (page reload, mobile network switch, ...).
  socket.on("room:rejoin", (data = {}, ack) => {
    const room = rooms.get(String(data.code || "").toUpperCase());
    const player = room && findPlayer(room, data.playerId);
    if (!player) return reply(ack, { ok: false, error: "Game no longer exists." });
    attachSocket(socket, room, player);
    reply(ack, { ok: true, code: room.code, playerId: player.id });
    socket.to(room.code).emit("player:reconnected", { playerId: player.id });
    sendState(room);
  });

  socket.on("room:leave", () => {
    const c = ctx(socket);
    if (!c) return;
    const { room, player } = c;
    socket.leave(room.code);
    socket.data = {};
    const opp = opponentOf(room, player.id);
    if ((room.phase === PHASE.PICKING || room.phase === PHASE.PLAYING) && opp) {
      finishGame(room, opp.id, "forfeit");
    }
    room.players = room.players.filter(p => p.id !== player.id);
    clearTimeout(player.dcTimer);
    if (room.players.length === 0) return deleteRoom(room);
    // The remaining player sees the result screen; someone new can still join with the same code.
    io.to(room.code).emit("player:disconnected", { playerId: player.id, left: true });
    sendState(room);
  });

  socket.on("pick:secret", (data = {}, ack) => {
    const c = ctx(socket);
    if (!c) return reply(ack, { ok: false, error: "Not in a room." });
    const { room, player } = c;
    if (room.phase !== PHASE.PICKING) return reply(ack, { ok: false, error: "Not picking right now." });
    if (player.secret !== null) return reply(ack, { ok: false, error: "Already locked in." });
    if (!isValidCharacter(room, data.characterId)) return reply(ack, { ok: false, error: "Invalid character." });

    player.secret = data.characterId;
    reply(ack, { ok: true });

    if (room.players.length === 2 && room.players.every(p => p.secret !== null)) {
      room.phase = PHASE.PLAYING;
      const first = room.players[crypto.randomInt(2)].id;
      io.to(room.code).emit("game:start", { firstTurn: first });
      startTurn(room, first);
    }
    sendState(room);
  });

  socket.on("turn:ask", (data = {}, ack) => {
    const c = ctx(socket);
    if (!c) return reply(ack, { ok: false, error: "Not in a room." });
    const { room, player } = c;
    if (room.phase !== PHASE.PLAYING) return reply(ack, { ok: false, error: "Game is not in progress." });
    if (room.turn !== player.id) return reply(ack, { ok: false, error: "Not your turn." });
    const q = QUESTION_MAP.get(data.questionId);
    if (!q) return reply(ack, { ok: false, error: "Unknown question." });

    const opp = opponentOf(room, player.id);
    const answer = Boolean(q.test(room.board[opp.secret]));
    room.log.push({ type: "ask", playerId: player.id, questionId: q.id, text: q.text, answer, at: Date.now() });
    reply(ack, { ok: true, answer });
    io.to(room.code).emit("ask:result", { playerId: player.id, questionId: q.id, answer });
    startTurn(room, opp.id);
    sendState(room);
  });

  socket.on("turn:guess", (data = {}, ack) => {
    const c = ctx(socket);
    if (!c) return reply(ack, { ok: false, error: "Not in a room." });
    const { room, player } = c;
    if (room.phase !== PHASE.PLAYING) return reply(ack, { ok: false, error: "Game is not in progress." });
    if (room.turn !== player.id) return reply(ack, { ok: false, error: "Not your turn." });
    if (!isValidCharacter(room, data.characterId)) return reply(ack, { ok: false, error: "Invalid character." });

    const opp = opponentOf(room, player.id);
    const correct = data.characterId === opp.secret;
    room.log.push({ type: "guess", playerId: player.id, characterId: data.characterId, correct, at: Date.now() });
    reply(ack, { ok: true, correct });
    finishGame(room, correct ? player.id : opp.id, correct ? "correct-guess" : "wrong-guess");
  });

  socket.on("rematch:request", (_data, ack) => {
    const c = ctx(socket);
    if (!c) return reply(ack, { ok: false, error: "Not in a room." });
    const { room, player } = c;
    if (room.phase !== PHASE.FINISHED) return reply(ack, { ok: false, error: "Game is not over." });
    if (room.players.length < 2) return reply(ack, { ok: false, error: "Opponent left." });

    player.rematch = true;
    reply(ack, { ok: true });
    if (room.players.every(p => p.rematch)) {
      newBoardFor(room);
      startPicking(room);
    }
    sendState(room);
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.code);
    const player = room && findPlayer(room, socket.data.playerId);
    if (!player || player.socketId !== socket.id) return; // stale socket (e.g. replaced by a newer tab)

    player.connected = false;
    socket.to(room.code).emit("player:disconnected", { playerId: player.id, graceMs: DISCONNECT_MS });
    sendState(room);

    player.dcTimer = setTimeout(() => {
      if (player.connected || !rooms.has(room.code)) return;
      if (room.players.every(p => !p.connected)) return deleteRoom(room);
      if (room.phase === PHASE.PICKING || room.phase === PHASE.PLAYING) {
        finishGame(room, opponentOf(room, player.id).id, "forfeit");
      }
    }, DISCONNECT_MS);
  });
});

server.listen(PORT, () => {
  console.log(`Guess Who server on http://localhost:${PORT}`);
  // Show LAN addresses so you can open the game on a phone on the same Wi-Fi.
  for (const list of Object.values(require("os").networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === "IPv4" && !a.internal) console.log(`  on your network: http://${a.address}:${PORT}`);
    }
  }
});

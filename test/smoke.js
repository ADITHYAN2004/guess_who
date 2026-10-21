// End-to-end check: two clients play a full game against a running server.
// Usage: npm start (in another terminal), then: npm test
const { io } = require("socket.io-client");
const URL = process.env.URL || "http://localhost:3000";
const assert = require("assert");

const connect = () => new Promise(res => { const s = io(URL, { forceNew: true }); s.on("connect", () => res(s)); });
const emit = (s, ev, data) => new Promise(res => s.emit(ev, data, res));
const nextState = (s, pred = () => true) => new Promise(res => {
  const h = st => { if (pred(st)) { s.off("room:state", h); res(st); } };
  s.on("room:state", h);
});

(async () => {
  const a = await connect(), b = await connect();
  const created = await emit(a, "room:create", { playerName: "Alice" });
  assert(created.ok && /^[A-Z]{4}$/.test(created.code), "create room");

  const bPicking = nextState(b, s => s.phase === "PICKING");
  const joined = await emit(b, "room:join", { code: created.code, playerName: "Bob" });
  assert(joined.ok, "join room");
  const sb = await bPicking;
  assert.strictEqual(sb.board.length, 30, "board has 30 characters");

  // Pick secrets; neither client may see the other's.
  const aPlaying = nextState(a, s => s.phase === "PLAYING");
  assert((await emit(a, "pick:secret", { characterId: 3 })).ok);
  assert((await emit(b, "pick:secret", { characterId: 7 })).ok);
  const sa = await aPlaying;
  assert.strictEqual(sa.mySecret, 3);
  assert.strictEqual(sa.secrets, null, "secrets hidden during play");
  assert(!JSON.stringify(sa).includes('"secret"'), "no raw secret fields leaked");

  const [first, second] = sa.turn === created.playerId ? [a, b] : [b, a];
  const firstSecretTarget = first === a ? 7 : 3;

  // Out-of-turn ask is rejected.
  const bad = await emit(second, "turn:ask", { questionId: "female" });
  assert(!bad.ok && bad.error === "Not your turn.", "turn validated on server");

  // Ask a question; answer must match the opponent's character.
  const ask = await emit(first, "turn:ask", { questionId: "female" });
  assert(ask.ok, "ask accepted");
  assert.strictEqual(ask.answer, sb.board[firstSecretTarget].gender === "female", "auto-answer correct");

  // Second player guesses correctly and wins.
  const overP = new Promise(res => first.once("game:over", res));
  const g = await emit(second, "turn:guess", { characterId: first === a ? 3 : 7 });
  assert(g.ok && g.correct, "correct guess");
  const over = await overP;
  assert.strictEqual(over.reason, "correct-guess");
  assert.deepStrictEqual(Object.values(over.secrets).sort(), [3, 7]);

  // Rematch resets to PICKING with a new board.
  const aRe = nextState(a, s => s.phase === "PICKING");
  await emit(a, "rematch:request", {});
  await emit(b, "rematch:request", {});
  const re = await aRe;
  assert.notStrictEqual(re.boardId, sa.boardId, "new board on rematch");

  console.log("✓ smoke test passed");
  a.close(); b.close();
  process.exit(0);
})().catch(e => { console.error("✗", e.message); process.exit(1); });

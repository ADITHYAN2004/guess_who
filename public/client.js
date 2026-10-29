// Client: renders server state and sends intents. It never decides answers or winners.
(function () {
  // socket.io.js only exists when the Node server serves this page.
  if (typeof io === "undefined") {
    document.querySelectorAll(".screen").forEach(s => s.classList.toggle("active", s.id === "screen-noserver"));
    return;
  }
  const socket = io();
  const $ = id => document.getElementById(id);

  let state = null;          // latest room:state from the server
  let selectedPick = null;   // card chosen on the pick screen (before Lock In)
  let guessMode = false;
  let pendingGuess = null;
  let lockedBoardId = null;    // board whose ruled-out cards we've already shown (for the flip sound)
  let selectedGroup = null;    // question category currently open
  let selectedQuestion = null; // picture tapped, waiting for "Ask"
  let eliminated = new Set();
  let eliminatedFor = null;  // boardId the eliminated set belongs to
  let oppGraceEndsAt = null; // when a disconnected opponent forfeits
  const rendered = { pick: null, game: null }; // boardId currently drawn on each grid

  // ---------- storage (wrapped: private mode can throw) ----------
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const SESSION = "gw-session";

  // ---------- helpers ----------
  const me = () => state && state.players.find(p => p.id === state.me);
  const opp = () => state && state.players.find(p => p.id !== state.me);
  const nameOf = id => (id === state.me ? "You" : (state.players.find(p => p.id === id)?.name || "Opponent"));
  const charById = id => state.board[id];
  const esc = s => String(s).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

  let toastTimer;
  function toast(msg, ms = 2600) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add("hidden"), ms);
  }

  function showScreen(name) {
    document.querySelectorAll(".screen").forEach(s => s.classList.toggle("active", s.id === `screen-${name}`));
  }

  function cardHTML(c) {
    return `<div class="inner">
      <div class="face">${renderAvatar(c)}<div class="name">${esc(c.name)}</div></div>
      <div class="back"><svg viewBox="0 0 10 10" preserveAspectRatio="none"><rect width="10" height="10" fill="url(#card-back)"/></svg></div>
    </div>`;
  }

  function makeCard(c, extraClass = "") {
    const el = document.createElement("div");
    el.className = `card ${extraClass}`.trim();
    el.dataset.id = c.id;
    el.innerHTML = cardHTML(c);
    return el;
  }

  function buildBoard(container, key, onClick) {
    if (rendered[key] === state.boardId) return;
    rendered[key] = state.boardId;
    container.innerHTML = "";
    for (const c of state.board) {
      const el = makeCard(c);
      el.addEventListener("click", () => onClick(c.id, el));
      container.appendChild(el);
    }
  }

  // Flip-downs are local-only, but persisted per board so a reload doesn't wipe them.
  function syncEliminated() {
    if (eliminatedFor === state.boardId) return;
    eliminatedFor = state.boardId;
    eliminated = new Set(store.get(`gw-elim-${state.boardId}`) || []);
  }
  function saveEliminated() { store.set(`gw-elim-${state.boardId}`, [...eliminated]); }

  // ---------- render ----------
  function render() {
    setLobbyWatch(!state); // the rooms list only updates while the home screen is shown
    if (!state) {
      // Greet returning players when the home screen opens (not while they're typing).
      if (!$("screen-home").classList.contains("active")) showWelcome();
      showScreen("home"); hideOverlays(); return;
    }
    const phase = state.phase;

    if (phase === "LOBBY") {
      $("lobby-code").textContent = state.code;
      $("lobby-visibility").textContent = state.private
        ? "🔒 Private room: only people with the code can join."
        : "🌐 Listed under Open rooms, so anyone can join.";
      showScreen("lobby");
      hideOverlays();
      return;
    }
    if (phase === "PICKING") { renderPick(); hideOverlays(); return; }
    renderGame();
  }

  function hideOverlays() {
    $("result").classList.add("hidden");
    $("confirm").classList.add("hidden");
    $("leave-confirm").classList.add("hidden");
  }

  function renderPick() {
    showScreen("pick");
    if (rendered.pick !== state.boardId) selectedPick = null;
    buildBoard($("pick-board"), "pick", id => {
      if (me().picked) return;
      selectedPick = id;
      sfx.play("tap");
      renderPick();
    });
    const locked = me().picked;
    const chosen = locked ? state.mySecret : selectedPick;
    $("pick-board").querySelectorAll(".card").forEach(el => {
      el.classList.toggle("selected", Number(el.dataset.id) === chosen);
      el.classList.toggle("static", locked);
    });
    $("btn-lock").disabled = locked || selectedPick === null;
    $("btn-lock").textContent = locked ? "Locked" : "Lock In";

    const o = opp();
    const parts = [];
    if (locked) parts.push(`You picked ${charById(state.mySecret).name}.`);
    if (!o) parts.push("Opponent left.");
    else if (o.picked) parts.push(`${o.name} is ready.`);
    else parts.push(`${o.name} is choosing…`);
    $("pick-status").textContent = parts.join(" ");
  }

  function renderGame() {
    showScreen("game");
    const playing = state.phase === "PLAYING";
    const myTurn = playing && state.turn === state.me;
    const o = opp();
    if (!myTurn) guessMode = false;

    // Turn indicator
    const ti = $("turn-indicator");
    ti.textContent = !playing ? "Game over" : myTurn ? "Your turn" : `${o?.name || "Opponent"}'s turn`;
    ti.classList.toggle("mine", myTurn);

    // Opponent connection banner
    const banner = $("opp-banner");
    if (o && !o.connected && playing) {
      banner.classList.remove("hidden");
      updateOppBanner();
    } else {
      banner.classList.add("hidden");
      if (o?.connected) oppGraceEndsAt = null;
    }

    // Board
    const board = $("game-board");
    buildBoard(board, "game", onGameCardClick);
    board.classList.toggle("guess-mode", guessMode);
    // Cards your answers ruled out flip down by themselves and stay locked.
    const ruledOut = new Set(state.ruledOut || []);
    let newlyLocked = 0;
    board.querySelectorAll(".card").forEach(el => {
      const id = Number(el.dataset.id);
      const locked = ruledOut.has(id);
      if (locked && !el.classList.contains("locked")) newlyLocked++;
      el.classList.toggle("locked", locked);
      el.classList.toggle("down", locked || eliminated.has(id));
      el.setAttribute("aria-label", `${charById(id).name}${locked ? ", ruled out" : eliminated.has(id) ? ", flipped down" : ""}`);
    });
    if (newlyLocked && lockedBoardId === state.boardId) sfx.play("flip");
    lockedBoardId = state.boardId;
    $("guess-hint").classList.toggle("hidden", !guessMode);

    // Secret card
    const secret = $("my-secret");
    if (secret.dataset.id !== String(state.mySecret) && state.mySecret !== null) {
      secret.dataset.id = state.mySecret;
      secret.innerHTML = "";
      secret.appendChild(makeCard(charById(state.mySecret), "static"));
    }

    renderQuestions(myTurn, o);

    document.querySelectorAll(".btn-guess").forEach(gb => {
      gb.disabled = !myTurn;
      gb.textContent = guessMode ? "Cancel" : gb.classList.contains("desktop-only") ? "Make Final Guess" : "Guess";
    });
    $("btn-ask").textContent = myTurn ? "Ask a question" : "Questions & log";
    if (!playing) closeSheet();

    renderLog();
    renderReactions();
    renderResult();
  }

  // ---------- question picker: category icons -> question pictures -> Ask ----------
  const tile = bg => `<rect width="48" height="48" rx="10" fill="${bg}"/>`;
  const GROUP_ICONS = {
    person: `${tile("#ffd6a5")}<path d="M8 48 Q9 34 24 33 Q39 34 40 48Z" fill="#457b9d"/><circle cx="24" cy="20" r="10" fill="#e2b48a"/>
      <circle cx="20.5" cy="20" r="1.4" fill="#111"/><circle cx="27.5" cy="20" r="1.4" fill="#111"/>
      <path d="M20.5 24.5 Q24 27 27.5 24.5" stroke="#5a2e1e" stroke-width="1.4" fill="none" stroke-linecap="round"/>`,
    hair: `${tile("#caffbf")}<path d="M11 42 Q7 9 24 8 Q41 9 37 42 Z" fill="#6b4423"/><circle cx="24" cy="23" r="9" fill="#e2b48a"/>
      <path d="M14 22 Q15 11 24 11 Q33 11 34 22 Q29 15 24 15 Q19 15 14 22Z" fill="#6b4423"/>
      <circle cx="21" cy="24" r="1.2" fill="#111"/><circle cx="27" cy="24" r="1.2" fill="#111"/>`,
    color: `${tile("#bdb2ff")}<path d="M24 8 C12 8 6 17 7 25 C8 33 15 40 23 40 C27 40 27 36 25 34 C23 32 25 29 29 29 L34 29 C39 29 42 26 41 20 C39 12 32 8 24 8Z" fill="#fff7e6"/>
      <circle cx="16" cy="19" r="3.6" fill="#272121"/><circle cx="24" cy="14.5" r="3.6" fill="#efcd6b"/>
      <circle cx="32" cy="19" r="3.6" fill="#c0462b"/><circle cx="15.5" cy="28" r="3.6" fill="#9ea3a8"/>`,
    facial: `${tile("#9bf6ff")}<circle cx="24" cy="23" r="12" fill="#e2b48a"/>
      <path d="M12 23 Q12 41 24 42 Q36 41 36 23 Q34 32 24 33 Q14 32 12 23Z" fill="#272121"/>
      <path d="M17 30 Q21 26.5 24 28.5 Q27 26.5 31 30 Q27 29.5 24 31 Q21 29.5 17 30Z" fill="#272121"/>
      <circle cx="20" cy="21" r="1.4" fill="#111"/><circle cx="28" cy="21" r="1.4" fill="#111"/>
      <path d="M13 18 Q13 10 24 10 Q35 10 35 18 Q29 13 24 13 Q19 13 13 18Z" fill="#272121"/>`,
    extras: `${tile("#ffc6ff")}<path d="M15 21 Q15 7 24 7 Q33 7 33 21Z" fill="#2f3e7a"/><rect x="15" y="16" width="18" height="3" fill="#f4d35e"/>
      <ellipse cx="24" cy="21.5" rx="15" ry="3" fill="#253265"/>
      <g fill="rgba(255,255,255,.7)" stroke="#111" stroke-width="2"><rect x="8" y="28" width="13" height="10" rx="3"/><rect x="27" y="28" width="13" height="10" rx="3"/><path d="M21 32 H27" fill="none"/></g>`,
  };
  // Category icons use the same portrait art as the board (the palette stays for "Hair colour").
  const FACE_BASE = { gender: "male", skin: "medium", hairStyle: "short", hairColor: "black", facialHair: "none", accessory: [], hat: false };
  const GROUP_FACES = {
    person: { gender: "female", hairStyle: "long", hairColor: "black", skin: "dark", accessory: ["earrings"] },
    hair:   { gender: "female", hairStyle: "curly", hairColor: "red", skin: "light" },
    facial: { facialHair: "beard", hairColor: "brown" },
    extras: { hat: true, hairStyle: "curly", accessory: ["glasses"], skin: "medium" },
  };
  const groupIconCache = new Map();
  function groupIcon(g, firstQ) {
    if (!groupIconCache.has(g.id)) {
      const face = GROUP_FACES[g.id];
      const html = face
        ? renderAvatar({ ...FACE_BASE, ...face, id: Object.keys(GROUP_FACES).indexOf(g.id) + 1 }, { crop: true, decorative: true })
        : GROUP_ICONS[g.id] ? `<svg viewBox="0 0 48 48" aria-hidden="true">${GROUP_ICONS[g.id]}</svg>`
        : firstQ ? questionIcon(firstQ) : "";
      groupIconCache.set(g.id, html);
    }
    return groupIconCache.get(g.id);
  }

  function renderQuestions(myTurn, o) {
    const groups = state.questionGroups || [];
    if (!groups.some(g => g.id === selectedGroup)) selectedGroup = groups[0]?.id ?? null;
    const asked = new Map(state.log.filter(e => e.type === "ask" && e.playerId === state.me).map(e => [e.questionId, e.answer]));
    if (!myTurn || guessMode || asked.has(selectedQuestion)) selectedQuestion = null;

    // Category icons, with a counter of how many you've asked in each.
    $("q-groups").innerHTML = groups.map(g => {
      const qs = state.questions.filter(q => q.group === g.id);
      const n = qs.filter(q => asked.has(q.id)).length;
      const active = g.id === selectedGroup;
      return `<button class="g-tab ${active ? "active" : ""}" role="tab" aria-selected="${active}" data-g="${esc(g.id)}">
        <span class="g-icon">${groupIcon(g, qs[0])}</span>
        <span class="g-label">${esc(g.label)}</span>
        ${n ? `<span class="g-count" aria-label="${n} asked">${n}/${qs.length}</span>` : ""}
      </button>`;
    }).join("");

    // Pictures for the open category.
    const canAsk = myTurn && !guessMode;
    $("questions").innerHTML = state.questions.filter(q => q.group === selectedGroup).map(q => {
      const a = asked.get(q.id);
      const cls = [a === undefined ? "" : a ? "asked-yes" : "asked-no", q.id === selectedQuestion ? "selected" : ""].join(" ");
      const badge = a === undefined ? "" : `<span class="q-badge ${a ? "yes" : "no"}">${a ? "✓ Yes" : "✕ No"}</span>`;
      const label = esc(q.text) + (a === undefined ? "" : a ? " (answered yes)" : " (answered no)");
      return `<button class="q ${cls}" data-q="${esc(q.id)}" title="${esc(q.text)}" aria-label="${label}"
          aria-pressed="${q.id === selectedQuestion}" ${canAsk && a === undefined ? "" : "disabled"}>
        <span class="q-img">${questionIcon(q)}</span>
        <span class="q-label">${esc(q.short)}</span>${badge}
      </button>`;
    }).join("");

    // Confirm bar: shows the full question for the picked picture.
    const sel = state.questions.find(q => q.id === selectedQuestion);
    $("ask-text").textContent = sel ? `“${sel.text}”`
      : myTurn ? "Pick a category, then a picture."
      : `Waiting for ${o?.name || "opponent"}…`;
    $("ask-bar").classList.toggle("ready", !!sel);
    $("btn-ask-confirm").disabled = !sel;
    $("questions-title").textContent = myTurn ? "Ask a question" : "Questions";
  }

  // Question pictures are built from the same face renderer as the board, cached per question.
  const iconCache = new Map();
  function questionIcon(q) {
    if (!iconCache.has(q.id)) {
      const idx = state.questions.indexOf(q);
      iconCache.set(q.id, (q.icon || []).map((c, i) => renderAvatar({ ...c, id: idx * 2 + i }, { crop: true, decorative: true })).join(""));
    }
    return iconCache.get(q.id);
  }

  function logEntryHTML(e) {
    const who = esc(nameOf(e.playerId));
    const chip = (ok, yes, no) => `<span class="ans ${ok ? "yes" : "no"}">${ok ? "✓ " + yes : "✕ " + no}</span>`;
    if (e.type === "ask") {
      const q = state.questions.find(x => x.id === e.questionId);
      const pic = q ? `<span class="mini">${questionIcon(q)}</span>` : "";
      return `<span class="entry">${pic}<span class="entry-text"><b>${who}</b> asked ${esc(q ? q.short : e.text)}</span>${chip(e.answer, "Yes", "No")}</span>`;
    }
    if (e.type === "guess") {
      const c = charById(e.characterId);
      const pic = `<span class="mini">${renderAvatar(c, { crop: true, decorative: true })}</span>`;
      return `<span class="entry">${pic}<span class="entry-text"><b>${who}</b> guessed ${esc(c.name)}</span>${chip(e.correct, "Right", "Wrong")}</span>`;
    }
    return "";
  }

  let lastLogLen = 0;
  function renderLog() {
    const items = state.log.slice().reverse().map(e => `<li>${logEntryHTML(e)}</li>`);
    $("log").innerHTML = items.join("") || `<li class="empty">No questions yet.</li>`;

    // The latest answer always stays visible above the board (the full log is in the sheet on phones).
    const strip = $("last-answer");
    const last = state.log[state.log.length - 1];
    strip.innerHTML = last ? logEntryHTML(last) : "";
    if (state.log.length > lastLogLen && last) {
      strip.classList.remove("flash");
      void strip.offsetWidth; // restart the animation
      strip.classList.add("flash");
    }
    lastLogLen = state.log.length;
  }

  // ---------- phone bottom sheet ----------
  function openSheet() { $("screen-game").classList.add("sheet-open"); }
  function closeSheet() { $("screen-game").classList.remove("sheet-open"); }
  $("btn-ask").addEventListener("click", () => {
    guessMode = false;
    openSheet();
    render();
  });
  $("sheet-backdrop").addEventListener("click", closeSheet);

  const buzz = pattern => { try { navigator.vibrate?.(pattern); } catch {} };

  function renderResult() {
    const box = $("result");
    if (state.phase !== "FINISHED") { box.classList.add("hidden"); return; }
    $("confirm").classList.add("hidden");
    box.classList.remove("hidden");

    const won = state.winnerId === state.me;
    const o = opp();
    const title = $("result-title");
    title.textContent = won ? "You win!" : "You lose";
    title.className = won ? "win" : "lose";

    const reasons = {
      "correct-guess": won ? "You guessed their person!" : `${o?.name || "They"} guessed your person.`,
      "wrong-guess": won ? `${o?.name || "They"} guessed wrong.` : "Wrong guess!",
      "forfeit": won ? "Your opponent left the game." : "You were disconnected too long.",
    };
    $("result-reason").textContent = reasons[state.reason] || "";

    const mine = state.secrets?.[state.me];
    const theirs = o ? state.secrets?.[o.id] : null;
    const fill = (el, id) => {
      el.innerHTML = "";
      if (id === null || id === undefined) { el.innerHTML = `<div class="muted">?</div>`; return; }
      el.appendChild(makeCard(charById(id), "static"));
    };
    fill($("reveal-me"), mine);
    fill($("reveal-opp"), theirs);
    renderSummary(o);

    const rb = $("btn-rematch");
    if (!o) { rb.disabled = true; rb.textContent = "Opponent left"; }
    else if (me().rematch) { rb.disabled = true; rb.textContent = "Waiting for opponent…"; }
    else { rb.disabled = false; rb.textContent = o.rematch ? "Accept rematch" : "Rematch"; }
  }

  function updateOppBanner() {
    const o = opp();
    if (!o) return;
    const secs = oppGraceEndsAt ? Math.max(0, Math.ceil((oppGraceEndsAt - Date.now()) / 1000)) : null;
    $("opp-banner").textContent = secs === null
      ? `${o.name} disconnected. Waiting for them to come back…`
      : `${o.name} disconnected. They forfeit in ${secs}s unless they reconnect.`;
  }

  setInterval(() => {
    if (!state) return;
    if (!$("opp-banner").classList.contains("hidden")) updateOppBanner();
  }, 250);

  // ---------- game interactions ----------
  function onGameCardClick(id, el) {
    if (state.phase !== "PLAYING") return;
    // Ruled out by an answer: it can't be their person, so it can't be flipped back up or guessed.
    if (el.classList.contains("locked")) {
      el.classList.remove("nope");
      void el.offsetWidth; // restart the shake
      el.classList.add("nope");
      buzz(30);
      toast(`${charById(id).name} is ruled out by your answers.`, 1800);
      return;
    }
    if (guessMode) {
      if (eliminated.has(id)) return;
      pendingGuess = id;
      const holder = $("confirm-card");
      holder.innerHTML = "";
      holder.appendChild(makeCard(charById(id), "static"));
      $("confirm").classList.remove("hidden");
      return;
    }
    // Manual elimination: flip the card down or back up.
    if (eliminated.has(id)) eliminated.delete(id); else eliminated.add(id);
    el.classList.toggle("down", eliminated.has(id));
    sfx.play("flip");
    saveEliminated();
  }

  $("q-groups").addEventListener("click", e => {
    const tab = e.target.closest(".g-tab");
    if (!tab) return;
    selectedGroup = tab.dataset.g;
    sfx.play("tap");
    selectedQuestion = null;
    render();
  });

  $("questions").addEventListener("click", e => {
    const btn = e.target.closest(".q");
    if (!btn || btn.disabled) return;
    selectedQuestion = selectedQuestion === btn.dataset.q ? null : btn.dataset.q;
    sfx.play("tap");
    render();
  });

  $("btn-ask-confirm").addEventListener("click", () => {
    if (!selectedQuestion) return;
    $("btn-ask-confirm").disabled = true; // avoid double-sends
    socket.emit("turn:ask", { questionId: selectedQuestion }, res => { if (!res?.ok) { toast(res?.error || "Error"); render(); } });
    selectedQuestion = null;
    closeSheet();
  });

  document.querySelectorAll(".btn-guess").forEach(b => b.addEventListener("click", () => {
    guessMode = !guessMode;
    closeSheet();
    render();
  }));
  $("btn-cancel-guess").addEventListener("click", () => { guessMode = false; render(); });
  $("btn-confirm-no").addEventListener("click", () => { pendingGuess = null; $("confirm").classList.add("hidden"); });
  $("btn-confirm-yes").addEventListener("click", () => {
    if (pendingGuess === null) return;
    socket.emit("turn:guess", { characterId: pendingGuess }, res => { if (!res?.ok) toast(res?.error || "Error"); });
    pendingGuess = null;
    guessMode = false;
    $("confirm").classList.add("hidden");
  });

  $("btn-lock").addEventListener("click", () => {
    if (selectedPick === null) return;
    socket.emit("pick:secret", { characterId: selectedPick }, res => { if (!res?.ok) toast(res?.error || "Error"); });
    sfx.play("tap");
  });

  $("btn-rematch").addEventListener("click", () => {
    socket.emit("rematch:request", {}, res => { if (!res?.ok) toast(res?.error || "Error"); });
  });

  function leaveRoom() {
    socket.emit("room:leave");
    closeSheet();
    store.set(SESSION, null);
    state = null;
    guessMode = false;
    render();
  }
  document.querySelectorAll(".btn-leave").forEach(b => b.addEventListener("click", leaveRoom));

  // Leave from the pick/game screens: ask first, because the server counts it as a forfeit.
  document.querySelectorAll(".btn-leave-game").forEach(b => b.addEventListener("click", () => {
    const active = state && (state.phase === "PICKING" || state.phase === "PLAYING") && opp();
    if (!active) return leaveRoom();
    closeSheet();
    $("leave-text").textContent = `${opp().name} will win by forfeit.`;
    $("leave-confirm").classList.remove("hidden");
  }));
  $("btn-leave-no").addEventListener("click", () => $("leave-confirm").classList.add("hidden"));
  $("btn-leave-yes").addEventListener("click", () => { $("leave-confirm").classList.add("hidden"); leaveRoom(); });

  // ---------- home ----------
  // The player's name is saved on this device as they type, and filled in next time.
  const NAME_KEY = "gw-name";
  const nameInput = $("name-input");
  const cleanName = v => v.replace(/\s+/g, " ").trim().slice(0, 16);

  function showWelcome() {
    const saved = store.get(NAME_KEY);
    $("welcome").textContent = saved ? `👋 Welcome back, ${saved}!` : "";
    $("welcome").classList.toggle("hidden", !saved);
  }
  nameInput.value = store.get(NAME_KEY) || "";
  showWelcome();
  nameInput.addEventListener("input", () => {
    store.set(NAME_KEY, cleanName(nameInput.value) || null);
    nameInput.classList.remove("invalid");
  });
  // Only tidy the text on blur. Don't show/hide anything here: a layout shift between
  // mousedown and mouseup would make the click on "Create Room" miss the button.
  nameInput.addEventListener("blur", () => { nameInput.value = cleanName(nameInput.value); });
  nameInput.addEventListener("keydown", e => { if (e.key === "Enter") nameInput.blur(); });

  // Returns the name, or null (with a hint) if it's empty.
  function requireName() {
    const name = cleanName(nameInput.value);
    if (name) { store.set(NAME_KEY, name); return name; }
    nameInput.classList.remove("invalid");
    void nameInput.offsetWidth; // restart the shake animation
    nameInput.classList.add("invalid");
    nameInput.focus();
    toast("Enter your name first.");
    return null;
  }

  function onJoined(res) {
    if (res?.full) {
      serverCapacity = { games: serverCapacity?.max ?? 1, max: serverCapacity?.max ?? 1 };
      renderCapacity();
    }
    if (!res?.ok) return toast(res?.error || "Could not join.", res?.full ? 5000 : 2600);
    store.set(SESSION, { code: res.code, playerId: res.playerId });
  }

  $("btn-create").addEventListener("click", () => {
    const playerName = requireName();
    if (!playerName) return;
    socket.emit("room:create", { playerName, private: $("private-input").checked }, onJoined);
  });

  function join() {
    const playerName = requireName();
    if (!playerName) return;
    const code = $("code-input").value.trim().toUpperCase();
    if (code.length !== 4) { $("code-input").focus(); return toast("Enter the 4-letter room code."); }
    socket.emit("room:join", { code, playerName }, onJoined);
  }
  $("btn-join").addEventListener("click", join);
  $("code-input").addEventListener("keydown", e => { if (e.key === "Enter") join(); });
  $("code-input").addEventListener("input", e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ""); });

  $("btn-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(state.code); toast("Code copied"); } catch { toast(state.code); }
  });

  // Invite links look like /?join=ABCD and prefill the code box.
  const inviteUrl = code => `${location.origin}/?join=${code}`;
  if (!navigator.share) $("btn-share").classList.add("hidden");
  $("btn-share").addEventListener("click", async () => {
    try {
      await navigator.share({ title: "Guess the Person", text: `Join my Guess Who game! Room code: ${state.code}`, url: inviteUrl(state.code) });
    } catch { /* user cancelled */ }
  });
  const joinParam = new URLSearchParams(location.search).get("join");
  if (joinParam && /^[A-Za-z]{4}$/.test(joinParam)) {
    $("code-input").value = joinParam.toUpperCase();
    history.replaceState(null, "", location.pathname);
  }

  // ---------- PWA: install + offline shell ----------
  let installPrompt = null;
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault();
    installPrompt = e;
    $("btn-install").classList.remove("hidden");
  });
  window.addEventListener("appinstalled", () => $("btn-install").classList.add("hidden"));
  $("btn-install").addEventListener("click", async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => {});
    installPrompt = null;
    $("btn-install").classList.add("hidden");
  });
  // iOS has no install prompt, so show a hint instead.
  if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone) $("ios-install").classList.remove("hidden");

  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  // Phones pause background tabs; reconnect right away when the app comes back.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !socket.connected) socket.connect();
  });

  let warnedOffline = false;
  socket.on("connect_error", () => {
    if (warnedOffline) return;
    warnedOffline = true;
    toast(navigator.onLine ? "Can't reach the game server. Retrying…" : "You're offline. Retrying when you're back online…", 4000);
  });

  // ---------- end-of-game summary ----------
  function renderSummary(o) {
    const sum = state.summary || {};
    const order = [state.me, o?.id].filter(id => id && sum[id]);
    $("result-summary").innerHTML = order.map(id => {
      const s = sum[id];
      const isWinner = id === state.winnerId;
      const q = s.best && state.questions.find(x => x.id === s.best.questionId);
      const best = s.best
        ? `<span class="sum-best">
             ${q ? `<span class="mini">${questionIcon(q)}</span>` : ""}
             <span class="sum-best-text">${isWinner ? "Winning question" : "Best question"}: <b>${esc(s.best.short)}</b>
               <span class="ans ${s.best.answer ? "yes" : "no"}">${s.best.answer ? "✓ Yes" : "✕ No"}</span>
               <span class="muted">ruled out ${s.best.ruledOut}</span></span>
           </span>`
        : `<span class="sum-best muted">No questions asked</span>`;
      return `<div class="sum-row ${isWinner ? "winner" : ""}">
        <div class="sum-head"><b>${isWinner ? "🏆 " : ""}${esc(nameOf(id))}</b>
          <span class="muted">${s.asked} question${s.asked === 1 ? "" : "s"}</span></div>
        ${best}
      </div>`;
    }).join("");

    // Rematch: the loser starts.
    const note = $("rematch-note");
    if (o && state.nextFirst) {
      note.textContent = state.nextFirst === state.me ? "🎲 You go first in the rematch." : `🎲 ${o.name} goes first in the rematch.`;
      note.classList.remove("hidden");
    } else {
      note.classList.add("hidden");
    }
  }

  // ---------- music & sound menu ----------
  const soundMenu = $("sound-menu");
  const TRACK_ICONS = { chai: "🍵", tabla: "🪘", arcade: "🕹️" };
  function renderSound() {
    const open = !soundMenu.classList.contains("hidden");
    const silent = sfx.muted && !music.on;
    document.querySelectorAll(".sound-btn").forEach(b => {
      b.classList.toggle("is-muted", silent);
      b.setAttribute("aria-expanded", String(open));
    });
    $("opt-music").checked = music.on;
    $("opt-sfx").checked = !sfx.muted;
    $("track-list").classList.toggle("off", !music.on);
    $("track-list").innerHTML = music.tracks.map(t => {
      const active = t.id === music.track;
      return `<button class="track ${active ? "active" : ""}" role="radio" aria-checked="${active}" data-track="${t.id}">
        <span class="track-icon">${TRACK_ICONS[t.id] || "🎵"}</span>
        <span class="track-text"><b>${esc(t.name)}</b><span>${esc(t.desc)}</span></span>
        ${active && music.on ? `<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>` : ""}
      </button>`;
    }).join("");
  }
  document.querySelectorAll(".sound-btn").forEach(b => b.addEventListener("click", e => {
    e.stopPropagation();
    soundMenu.classList.toggle("hidden");
    renderSound();
  }));
  $("opt-music").addEventListener("change", e => { music.setOn(e.target.checked); renderSound(); });
  $("opt-sfx").addEventListener("change", e => { sfx.setMuted(!e.target.checked); renderSound(); sfx.play("tap"); });
  $("track-list").addEventListener("click", e => {
    const t = e.target.closest("[data-track]");
    if (!t) return;
    music.setTrack(t.dataset.track);
    if (!music.on) music.setOn(true);
    renderSound();
  });
  document.addEventListener("click", e => {
    // composedPath() still knows where the click happened even if that element was just redrawn.
    const inside = e.composedPath().some(el => el === soundMenu || el.classList?.contains("sound-btn"));
    if (!soundMenu.classList.contains("hidden") && !inside) {
      soundMenu.classList.add("hidden");
      renderSound();
    }
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape") { soundMenu.classList.add("hidden"); renderSound(); } });
  renderSound();

  // ---------- quick reactions ----------
  const tray = $("react-tray");
  function setTray(open) {
    tray.classList.toggle("hidden", !open);
    $("btn-react").setAttribute("aria-expanded", String(open));
  }
  function renderReactions() {
    const show = (state.phase === "PLAYING" || state.phase === "FINISHED") && state.players.length === 2;
    document.querySelector(".react").classList.toggle("hidden", !show);
    if (!show) setTray(false);
    const list = state.reactions || [];
    if (tray.dataset.list !== list.join("")) {
      tray.dataset.list = list.join("");
      tray.innerHTML = list.map(e => `<button class="react-opt" role="menuitem" data-emoji="${e}" aria-label="Send ${e}">${e}</button>`).join("");
    }
  }
  $("btn-react").addEventListener("click", e => {
    e.stopPropagation();
    setTray(tray.classList.contains("hidden"));
    sfx.play("tap");
  });
  tray.addEventListener("click", e => {
    const opt = e.target.closest(".react-opt");
    if (!opt) return;
    socket.emit("react:send", { emoji: opt.dataset.emoji });
    setTray(false);
  });
  document.addEventListener("click", e => { if (!e.target.closest(".react")) setTray(false); });

  // Show a reaction floating up: yours on the right, your opponent's on the left.
  function floatReaction(playerId, emoji) {
    const mine = playerId === state?.me;
    const el = document.createElement("div");
    el.className = `react-float ${mine ? "mine" : "theirs"}`;
    el.style.setProperty("--x", `${Math.round(Math.random() * 40 - 20)}px`);
    el.innerHTML = `<span class="react-emoji">${emoji}</span><span class="react-who">${esc(nameOf(playerId))}</span>`;
    document.body.appendChild(el);
    el.addEventListener("animationend", () => el.remove());
    setTimeout(() => el.remove(), 3000); // fallback if animations are off
  }
  socket.on("react:show", ({ playerId, emoji }) => {
    if (!state) return;
    floatReaction(playerId, emoji);
    sfx.play("pop");
    if (playerId !== state.me) buzz(20);
  });

  // ---------- rooms dashboard (home screen) ----------
  let lobbyRooms = null;      // null until the first list arrives
  let lobbyClockOffset = 0;
  let watchingLobby = false;

  function setLobbyWatch(on) {
    if (on === watchingLobby) return;
    watchingLobby = on;
    if (socket.connected) socket.emit(on ? "lobby:watch" : "lobby:unwatch");
  }

  const PHASE_LABEL = { LOBBY: "Waiting", PICKING: "Picking", PLAYING: "Playing", FINISHED: "Game over" };
  const hue = name => [...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
  const bubble = name => `<span class="room-avatar" style="background:hsl(${hue(name)} 65% 62%)">${esc(name.trim()[0]?.toUpperCase() || "?")}</span>`;

  function ago(t) {
    const secs = Math.max(0, (Date.now() + lobbyClockOffset - t) / 1000);
    if (secs < 60) return "just now";
    const mins = Math.floor(secs / 60);
    return mins < 60 ? `${mins} min ago` : `${Math.floor(mins / 60)} h ago`;
  }

  function renderRooms() {
    const list = $("rooms-list");
    if (!lobbyRooms) {
      list.innerHTML = `<p class="rooms-empty">${socket.connected ? "Loading rooms…" : "Connecting…"}</p>`;
      return;
    }
    const open = lobbyRooms.filter(r => r.joinable);
    const busy = lobbyRooms.filter(r => !r.joinable);

    const openRow = r => {
      const host = r.players[0]?.name || "Someone";
      return `<div class="room-row">
        ${bubble(host)}
        <span class="room-info"><b>${esc(host)}'s room</b><span class="muted small">Waiting for a player · ${ago(r.createdAt)}</span></span>
        <button class="btn primary small" data-join="${esc(r.code)}" aria-label="Join ${esc(host)}'s room">Join</button>
      </div>`;
    };
    const busyRow = r => {
      const names = r.players.map(p => p.name);
      return `<div class="room-row busy">
        <span class="room-avatars">${names.map(bubble).join("")}</span>
        <span class="room-info"><b>${names.map(esc).join(" vs ")}</b><span class="muted small">Started ${ago(r.createdAt)}</span></span>
        <span class="phase-pill phase-${r.phase}">${PHASE_LABEL[r.phase] || r.phase}</span>
      </div>`;
    };

    list.innerHTML =
      `<h3>Open rooms <span class="count">${open.length}</span></h3>` +
      (open.length ? open.map(openRow).join("")
        : `<p class="rooms-empty">No open rooms right now. Create one and it shows up here for others.</p>`) +
      (busy.length ? `<h3>In progress <span class="count">${busy.length}</span></h3>${busy.map(busyRow).join("")}` : "");
  }

  $("rooms-list").addEventListener("click", e => {
    const btn = e.target.closest("[data-join]");
    if (!btn) return;
    const playerName = requireName();
    if (!playerName) return;
    btn.disabled = true;
    socket.emit("room:join", { code: btn.dataset.join, playerName }, res => {
      if (!res?.ok) btn.disabled = false;
      onJoined(res);
    });
  });

  socket.on("lobby:rooms", ({ rooms, serverNow, capacity }) => {
    lobbyRooms = rooms;
    lobbyClockOffset = serverNow - Date.now();
    if (capacity) { serverCapacity = capacity; renderCapacity(); }
    renderRooms();
  });

  // ---------- server capacity (max games at once) ----------
  let serverCapacity = null;
  function renderCapacity() {
    const cap = serverCapacity;
    const full = !!cap && cap.games >= cap.max;
    $("full-banner").classList.toggle("hidden", !full);
    const create = $("btn-create");
    create.disabled = full;
    create.textContent = full ? "Server full" : "Create Room";
    const el = $("rooms-capacity");
    el.textContent = cap ? `${cap.games} / ${cap.max} games` : "";
    el.classList.toggle("busy", !!cap && cap.games >= cap.max * 0.8);
    el.classList.toggle("full", full);
  }
  setInterval(() => { if (watchingLobby) renderRooms(); }, 30_000); // keep "x min ago" fresh

  // ---------- socket events ----------
  socket.on("connect", () => {
    warnedOffline = false;
    if (watchingLobby) socket.emit("lobby:watch");
    const session = store.get(SESSION);
    if (!session) { if (!state) render(); return; }
    // Reconnect to the game we were in (reloads, flaky mobile networks).
    socket.emit("room:rejoin", session, res => {
      if (!res?.ok) {
        store.set(SESSION, null);
        if (state) toast(res?.error || "Game ended.");
        state = null;
        render();
      }
    });
  });

  socket.on("disconnect", () => toast("Connection lost. Reconnecting…", 4000));

  // Reload when the server reports different client code than this page started with.
  // Safe mid-game: the page rejoins its room and flipped cards are kept in localStorage.
  let knownBuild = null;
  socket.on("server:hello", ({ build }) => {
    if (knownBuild && build && build !== knownBuild) {
      location.reload();
      return;
    }
    knownBuild = build;
  });

  let warnedOldServer = false;
  socket.on("room:state", s => {
    if (!warnedOldServer && s.questions?.length && !s.questionGroups) {
      warnedOldServer = true;
      toast("The game server is out of date. Restart it (npm start) and reload.", 8000);
    }
    state = s;
    syncEliminated();
    render();
  });

  socket.on("turn:changed", ({ playerId }) => {
    if (!state) return;
    state.turn = playerId;
    if (playerId === state.me) { toast("Your turn!", 1500); buzz(40); sfx.play("turn"); }
  });

  socket.on("ask:result", ({ playerId, questionId, answer }) => {
    if (!state) return;
    sfx.play(answer ? "yes" : "no"); // both players hear the answer chime
    if (playerId !== state.me) return;
    const q = state.questions.find(x => x.id === questionId);
    toast(`${q ? q.text : "Answer"} ${answer ? "YES" : "NO"}`, 3500);
    buzz(answer ? [30, 60, 30] : 80);
  });

  socket.on("game:over", ({ winnerId }) => {
    if (!state) return;
    const won = winnerId === state.me;
    buzz(won ? [40, 60, 40, 60, 120] : 300);
    sfx.play(won ? "win" : "lose");
  });

  socket.on("game:start", ({ firstTurn }) => {
    if (!state) return;
    toast(firstTurn === state.me ? "Game on! You go first." : "Game on! Opponent goes first.");
  });

  socket.on("player:disconnected", ({ playerId, graceMs, left }) => {
    if (!state || playerId === state.me) return;
    if (left) return toast("Your opponent left the room.");
    oppGraceEndsAt = graceMs ? Date.now() + graceMs : null;
    toast("Opponent disconnected.");
  });

  socket.on("player:reconnected", () => {
    oppGraceEndsAt = null;
    toast("Opponent reconnected.");
  });

  render();
})();

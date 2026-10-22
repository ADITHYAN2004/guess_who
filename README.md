# Guess the Person

Two-player online "Guess Who". The server is authoritative: it owns the board, both secrets, the turn order, the answers and the win check.

## Run

```bash
npm install
npm start            # http://localhost:3000  (PORT env var to change)
npm test             # smoke test: run while the server is up (URL env var to point elsewhere)
npm run check-board  # print a sample board + how every question splits it
```

Open two browser windows: Create Room in one, Join with the code in the other.

## Phones & PWA

- On startup the server prints a LAN address (`http://192.168.x.x:3000`). Open it on a phone on the same Wi-Fi to play.
- The game is installable as an app (manifest, icons, service worker). Browsers only allow installing over **HTTPS** (or `localhost`), so a phone on a LAN IP gets the mobile site but no install option. Once hosted on Render/Railway (HTTPS), Android shows "Install app" and iPhone uses Share, then Add to Home Screen.
- Phone layout: board on top, "Ask a question" / "Guess" bar at the bottom, and questions + log in a slide-up sheet. In landscape the buttons move to the right side.
- Invite links: `/?join=ABCD` prefills the room code; the lobby has a "Share invite" button on phones.
- The service worker is network-first and never touches live game traffic, so it can't serve stale game state. Bump `CACHE` in `public/sw.js` if you ever change it to cache-first.

## Layout

| File | What it does |
|---|---|
| `server/index.js` | Socket.IO server: rooms, phases (LOBBY → PICKING → PLAYING → FINISHED), no turn timer, 30s disconnect forfeit, reconnects, rematch |
| `server/characters.js` | Board generator: 30 characters, every pair differs in ≥2 traits, every question answers "yes" for 10–80% of the board |
| `server/questions.js` | Data-driven questions, batched into groups (Person, Hair style, Hair colour, Facial hair, Extras). Each has full text, a short caption and the example face(s) for its picture tile. Add a question here and it appears in the UI automatically |
| `public/avatar.js` | Layered SVG face renderer (hair shape + texture, glasses, earrings, beard/mustache, hat) |
| `public/client.js` | UI: renders server state and sends intents only |
| `public/sw.js`, `public/manifest.webmanifest`, `public/icons/` | PWA: offline shell, install metadata, app icons (`icon.svg` is the source) |
| `test/smoke.js` | Two bot clients play a full game and check that secrets don't leak and turns are enforced |

## Socket events

Client → server: `lobby:watch` / `lobby:unwatch` (live public room list on the home screen), `room:create` (`{ playerName, private }`), `room:join`, `room:rejoin`, `room:leave`, `pick:secret`, `turn:ask`, `turn:guess`, `rematch:request`. All take an ack callback that returns `{ ok, error? }`.

Server → client: `room:state` (a personalized view; the opponent's secret is only included once the game is FINISHED), `game:start`, `turn:changed`, `ask:result`, `game:over`, `player:disconnected`, `player:reconnected`, `lobby:rooms` (public rooms: codes, names and phases only; private rooms are never listed), `server:hello` (client build id; pages reload when it changes).

## Notes

- Rooms live in memory (`Map`), so a restart wipes them. Move to Redis before running more than one server instance.
- Reconnects: the client stores `{ code, playerId }` in localStorage and sends `room:rejoin` on every socket connect.
- Card flip-downs are client-side only and saved per board, so they survive a reload.

// Room storage.
//   MemoryStore: rooms live in this process (default; a restart clears them).
//   RedisStore:  rooms live in Redis (set REDIS_URL). Games survive restarts, and several
//                server processes can share the same rooms.
//
// Both stores hand out *copies* of rooms: change a room, then save() it. Every change is
// made under lock(code) so two events (or two servers) can't overwrite each other.
const crypto = require("crypto");

const ROOM_TTL_SECONDS = Number(process.env.ROOM_TTL_SECONDS) || 6 * 60 * 60; // idle rooms expire after 6h
const LOCK_TTL_MS = 5000;     // a crashed server's lock frees itself after this
const LOCK_WAIT_MS = 4000;    // give up waiting for a lock after this

const clone = v => structuredClone(v);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// In-process lock: queues work per room so one process never interleaves two changes.
function makeLocalLock() {
  const tails = new Map();
  return async function lockLocal(key) {
    const prev = tails.get(key) || Promise.resolve();
    let release;
    const mine = new Promise(r => (release = r));
    const tail = prev.then(() => mine);
    tails.set(key, tail);
    await prev;
    return () => {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    };
  };
}

class MemoryStore {
  constructor() {
    this.kind = "memory";
    this.rooms = new Map();
    this.lockLocal = makeLocalLock();
  }
  async connect() {}
  async close() {}
  async get(code) { const r = this.rooms.get(code); return r ? clone(r) : null; }
  async create(room) {
    if (this.rooms.has(room.code)) return false;
    this.rooms.set(room.code, clone(room));
    return true;
  }
  async save(room) { this.rooms.set(room.code, clone(room)); }
  async delete(code) { this.rooms.delete(code); }
  async list() { return [...this.rooms.values()].map(clone); }
  lock(code) { return this.lockLocal(code); }
}

// Deletes the lock only if we still own it (another server may have taken it after expiry).
const UNLOCK_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

class RedisStore {
  constructor(url, prefix = "gw:") {
    this.kind = "redis";
    const { createClient } = require("redis");
    this.client = createClient({ url });
    this.client.on("error", err => console.error("[redis]", err.message));
    this.prefix = prefix;
    this.setKey = `${prefix}rooms`;
    this.lockLocal = makeLocalLock();
  }
  key(code) { return `${this.prefix}room:${code}`; }
  lockKey(code) { return `${this.prefix}lock:${code}`; }

  async connect() { await this.client.connect(); }
  async close() { await this.client.quit().catch(() => {}); }

  async get(code) {
    const raw = await this.client.get(this.key(code));
    return raw ? JSON.parse(raw) : null;
  }
  async create(room) {
    const ok = await this.client.set(this.key(room.code), JSON.stringify(room), { NX: true, EX: ROOM_TTL_SECONDS });
    if (ok !== "OK") return false;
    await this.client.sAdd(this.setKey, room.code);
    return true;
  }
  async save(room) {
    // Saving also refreshes the expiry, so only rooms nobody touches for ROOM_TTL_SECONDS expire.
    await this.client.multi()
      .set(this.key(room.code), JSON.stringify(room), { EX: ROOM_TTL_SECONDS })
      .sAdd(this.setKey, room.code)
      .exec();
  }
  async delete(code) {
    await this.client.multi().del(this.key(code)).sRem(this.setKey, code).exec();
  }
  async list() {
    const codes = await this.client.sMembers(this.setKey);
    if (!codes.length) return [];
    const raws = await this.client.mGet(codes.map(c => this.key(c)));
    const expired = codes.filter((_, i) => !raws[i]);
    if (expired.length) await this.client.sRem(this.setKey, expired);
    return raws.filter(Boolean).map(r => JSON.parse(r));
  }

  // Lock = in-process queue + a short Redis lock (SET NX PX) shared by all servers.
  async lock(code) {
    const releaseLocal = await this.lockLocal(code);
    const key = this.lockKey(code);
    const token = crypto.randomBytes(8).toString("hex");
    const deadline = Date.now() + LOCK_WAIT_MS;
    try {
      while ((await this.client.set(key, token, { NX: true, PX: LOCK_TTL_MS })) !== "OK") {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for room ${code}`);
        await sleep(15 + Math.random() * 20);
      }
    } catch (err) {
      releaseLocal();
      throw err;
    }
    return async () => {
      try { await this.client.eval(UNLOCK_SCRIPT, { keys: [key], arguments: [token] }); }
      finally { releaseLocal(); }
    };
  }
}

function createStore() {
  const url = process.env.REDIS_URL;
  return url ? new RedisStore(url, process.env.REDIS_PREFIX || "gw:") : new MemoryStore();
}

module.exports = { createStore, MemoryStore, RedisStore };

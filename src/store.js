// The Durable Object that holds all server-side state.
// A Durable Object processes one request at a time (while it's touching storage),
// so read-then-write sequences here are atomic: a code can't be used twice,
// and lockout counters can't be raced. See docs/DECISIONS.md D2.
//
// Stored keys:
//   "code"               -> { hash, expiresAt }        one active sign-in code (hash only)
//   "session:<hash>"     -> { createdAt, lastSeen }     sessions, keyed by SHA-256 of the token
//   "fails:global"       -> [timestamps]                failed sign-ins, all clients
//   "fails:ip:<ip>"      -> [timestamps]                failed sign-ins, per client IP
//   "killSwitch"         -> true when on
//   "order:<id>"         -> { sessionHash, stripeSessionId, url, status, createdAt, checkoutExpiresAt }
//                           status: "created" | "paid" | "delivered"
//   "sessorders:<hash>"  -> [order ids] created by that app session
//   "dl:<hash>"          -> { orderId, sessionHash, expiresAt }   single-use download tokens (hash only)
//   "rl:<name>:<subject>:<bucket>" -> count   fixed-window rate-limit counters (subject = hashed client or "all")
//   "stat:<name>"        -> count                       public counters (get_stats)
//   "hello:<label>"      -> count                       self-reported agent names (owner-only view)
//   "fb:<time>:<rand>"   -> { at, label, text }         private feedback (owner-only view), capped
//   "log:<time>:<rand>"  -> { t, m, p, tool, s, v, c, n, a }  traffic log (owner-only), no raw IPs, 30 days
import { DurableObject } from "cloudflare:workers";

export const FEEDBACK_MAX_STORED = 1000;          // total feedback entries kept
export const TRAFFIC_LOG_PER_DAY = 5000;          // traffic-log entries per day (then logging pauses)
const TRAFFIC_KEEP_MS = 30 * 24 * 60 * 60 * 1000; // traffic log kept 30 days
const RL_KEEP_MS = 2 * 24 * 60 * 60 * 1000;       // rate-limit buckets kept 2 days
const ORDER_KEEP_MS = 30 * 24 * 60 * 60 * 1000;   // orders kept 30 days
const CLEANUP_EVERY_MS = 6 * 60 * 60 * 1000;      // cleanup alarm cadence

export const MAX_ORDERS_PER_SESSION = 5;
export const DOWNLOAD_TTL_MS = 5 * 60 * 1000; // download links expire after 5 minutes

export const CODE_TTL_MS = 10 * 60 * 1000;     // codes expire after 10 minutes
export const SESSION_IDLE_MS = 30 * 60 * 1000; // sessions expire after 30 minutes idle
export const FAIL_WINDOW_MS = 15 * 60 * 1000;  // lockout window
export const MAX_FAILS = 5;                    // failures allowed per window (per IP and global)

function recent(list, now) {
  return (Array.isArray(list) ? list : []).filter((t) => now - t < FAIL_WINDOW_MS);
}

// Constant-time comparison of two equal-length hex strings.
function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class Store extends DurableObject {
  // ---- Admin ----

  async addCode(hash) {
    const s = this.ctx.storage;
    if (await s.get("killSwitch")) return { ok: false, error: "Kill switch is on. No codes can be created." };
    const expiresAt = Date.now() + CODE_TTL_MS;
    await s.put("code", { hash, expiresAt }); // replaces any previous code
    return { ok: true, expiresAt };
  }

  async setKillSwitch(on) {
    const s = this.ctx.storage;
    if (on) {
      await s.put("killSwitch", true);
      const removed = await this.#deleteAllSessions();
      await s.delete("code");
      return { ok: true, killSwitch: true, sessionsRemoved: removed };
    }
    await s.delete("killSwitch");
    return { ok: true, killSwitch: false };
  }

  // Clears sign-in lockouts and all rate-limit counters (owner command: npm run unlock).
  async clearLockouts() {
    const s = this.ctx.storage;
    const keys = [
      ...(await s.list({ prefix: "fails:" })).keys(),
      ...[...(await s.list({ prefix: "rl:" })).keys()].filter((k) => !k.startsWith("rl:visits-count:")),
    ];
    for (let i = 0; i < keys.length; i += 128) await s.delete(keys.slice(i, i + 128));
    return { ok: true, cleared: keys.length };
  }

  async status() {
    const s = this.ctx.storage;
    const now = Date.now();
    const code = await s.get("code");
    let sessions = 0;
    for (const [, v] of await s.list({ prefix: "session:" })) {
      if (now - v.lastSeen <= SESSION_IDLE_MS) sessions++;
    }
    return {
      killSwitch: !!(await s.get("killSwitch")),
      codeActive: !!(code && code.expiresAt > now),
      activeSessions: sessions,
      recentGlobalFailures: recent(await s.get("fails:global"), now).length,
    };
  }

  // ---- Sign-in and sessions ----

  // Returns { ok: true } or { ok: false, reason } (reason is for server logs only, never sent to clients).
  async signIn(codeHash, ip, sessionHash) {
    const s = this.ctx.storage;
    const now = Date.now();
    if (await s.get("killSwitch")) return { ok: false, reason: "kill_switch" };

    const ipKey = `fails:ip:${ip}`;
    const globalFails = recent(await s.get("fails:global"), now);
    const ipFails = recent(await s.get(ipKey), now);
    if (globalFails.length >= MAX_FAILS) return { ok: false, reason: "locked_global" };
    if (ipFails.length >= MAX_FAILS) return { ok: false, reason: "locked_ip" };

    const code = await s.get("code");
    let reason = null;
    if (!code) reason = "no_active_code";
    else if (code.expiresAt <= now) reason = "expired";
    else if (!timingSafeEqualHex(code.hash, codeHash)) reason = "wrong_code";

    if (reason) {
      if (reason === "expired") await s.delete("code");
      globalFails.push(now);
      ipFails.push(now);
      await s.put({ "fails:global": globalFails, [ipKey]: ipFails });
      return { ok: false, reason };
    }

    await s.delete("code"); // single use
    await s.put(`session:${sessionHash}`, { kind: "owner", createdAt: now, lastSeen: now });
    await this.#ensureCleanup();
    return { ok: true };
  }

  // A visitor session for a public agent (no sign-in). Refused while the kill switch is on.
  async createVisitorSession(sessionHash) {
    const s = this.ctx.storage;
    if (await s.get("killSwitch")) return { ok: false };
    const now = Date.now();
    await s.put(`session:${sessionHash}`, { kind: "visitor", createdAt: now, lastSeen: now });
    await this.#ensureCleanup();
    return { ok: true };
  }

  // Checks a session and refreshes its inactivity timer.
  // Returns the session kind ("owner" | "visitor") if valid, otherwise false.
  async touchSession(sessionHash) {
    const s = this.ctx.storage;
    if (await s.get("killSwitch")) return false;
    const key = `session:${sessionHash}`;
    const rec = await s.get(key);
    if (!rec) return false;
    const now = Date.now();
    if (now - rec.lastSeen > SESSION_IDLE_MS) {
      await s.delete(key);
      return false;
    }
    rec.lastSeen = now;
    await s.put(key, rec);
    return rec.kind || "owner";
  }

  async isKilled() {
    return !!(await this.ctx.storage.get("killSwitch"));
  }

  // ---- Rate limits (fixed windows) ----

  // Counts one event for `subject` under `name`; returns false (and doesn't count) if the
  // window already holds `max` events. Use subject "all" for a global cap.
  async hit(name, subject, max, windowMs) {
    const s = this.ctx.storage;
    const bucket = Math.floor(Date.now() / windowMs);
    const key = `rl:${name}:${subject}:${bucket}`;
    const n = (await s.get(key)) || 0;
    if (n >= max) return false;
    await s.put(key, n + 1);
    return true;
  }

  // Current count in this window (without counting).
  async count(name, subject, windowMs) {
    return (await this.ctx.storage.get(`rl:${name}:${subject}:${Math.floor(Date.now() / windowMs)}`)) || 0;
  }

  // Checks several limits; counts against all of them only if all allow it.
  async hitAll(limits) {
    const s = this.ctx.storage;
    const now = Date.now();
    const keys = limits.map(({ name, subject, windowMs }) => `rl:${name}:${subject}:${Math.floor(now / windowMs)}`);
    const counts = await s.get(keys);
    for (let i = 0; i < limits.length; i++) {
      if ((counts.get(keys[i]) || 0) >= limits[i].max) return { ok: false, limit: limits[i].name, scope: limits[i].subject === "all" ? "global" : "visitor" };
    }
    const updates = {};
    keys.forEach((k) => { updates[k] = (counts.get(k) || 0) + 1; });
    await s.put(updates);
    await this.#ensureCleanup();
    return { ok: true };
  }

  // ---- Public counters, hellos and feedback ----

  async bump(name, n = 1) {
    const s = this.ctx.storage;
    await s.put(`stat:${name}`, ((await s.get(`stat:${name}`)) || 0) + n);
  }

  async publicStats() {
    const s = this.ctx.storage;
    const out = {};
    for (const [k, v] of await s.list({ prefix: "stat:" })) out[k.slice(5)] = v;
    out.distinct_agent_names = (await s.list({ prefix: "hello:" })).size;
    return out;
  }

  async recordHello(label) {
    const s = this.ctx.storage;
    const key = `hello:${label}`;
    const n = ((await s.get(key)) || 0) + 1;
    await s.put(key, n);
    await this.bump("hellos");
    return n;
  }

  async addFeedback({ label, text }) {
    const s = this.ctx.storage;
    const count = (await s.get("stat:feedback")) || 0;
    const stored = (await s.list({ prefix: "fb:" })).size;
    if (stored >= FEEDBACK_MAX_STORED) return { ok: false, reason: "full" };
    const key = `fb:${String(Date.now()).padStart(15, "0")}:${crypto.randomUUID().slice(0, 8)}`;
    await s.put({ [key]: { at: new Date().toISOString(), label, text }, "stat:feedback": count + 1 });
    return { ok: true };
  }

  // ---- Traffic log (owner-only; no raw IPs; see docs/SECURITY.md) ----

  async logTraffic(entry) {
    // Caps protect storage under a flood: logging simply stops for the rest of the day.
    if (!(await this.hit("log-cap", "all", TRAFFIC_LOG_PER_DAY, 86_400_000))) return;
    const key = `log:${String(Date.now()).padStart(15, "0")}:${crypto.randomUUID().slice(0, 6)}`;
    await this.ctx.storage.put(key, entry);
    await this.#ensureCleanup();
  }

  async readTraffic({ startAfter, limit = 2000 } = {}) {
    const opts = { prefix: "log:", limit: Math.min(limit, 5000) };
    if (startAfter) opts.startAfter = startAfter;
    const page = await this.ctx.storage.list(opts);
    const entries = [...page.values()];
    const last = [...page.keys()].pop();
    return { entries, next: entries.length === opts.limit ? last : null };
  }

  // ---- Owner-only views (admin API) ----

  async ownerReport({ feedbackLimit = 50 } = {}) {
    const s = this.ctx.storage;
    const hellos = {};
    for (const [k, v] of await s.list({ prefix: "hello:" })) hellos[k.slice(6)] = v;
    const fb = [...(await s.list({ prefix: "fb:", reverse: true, limit: feedbackLimit })).values()];
    return { stats: await this.publicStats(), hellos, feedback: fb };
  }

  // ---- Cleanup (alarm) ----

  async #ensureCleanup() {
    if ((await this.ctx.storage.getAlarm()) == null) {
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_EVERY_MS);
    }
  }

  async alarm() {
    const s = this.ctx.storage;
    const now = Date.now();
    const doomed = [];
    for (const [k] of await s.list({ prefix: "rl:" })) {
      const parts = k.split(":"); // rl:<name>:<subject>:<bucket>; windows are 1 h or 1 day
      const bucket = Number(parts[parts.length - 1]);
      const windowMs = parts[1].endsWith("-h") ? 3600_000 : 86_400_000;
      if (!Number.isFinite(bucket) || (bucket + 1) * windowMs < now - RL_KEEP_MS) doomed.push(k);
    }
    for (const [k, v] of await s.list({ prefix: "session:" })) if (now - v.lastSeen > SESSION_IDLE_MS) doomed.push(k);
    for (const [k, v] of await s.list({ prefix: "dl:" })) if (v.expiresAt <= now) doomed.push(k);
    // Traffic log: keys are log:<15-digit ms>:<rand>, so old entries come first.
    for (const [k] of await s.list({ prefix: "log:", end: `log:${String(now - TRAFFIC_KEEP_MS).padStart(15, "0")}` })) doomed.push(k);
    for (const [k, v] of await s.list({ prefix: "order:" })) if (now - v.createdAt > ORDER_KEEP_MS) doomed.push(k);
    for (const [k, v] of await s.list({ prefix: "sessorders:" })) {
      const anyLive = await s.get(v.map((id) => `order:${id}`));
      if (![...anyLive.values()].some(Boolean)) doomed.push(k);
    }
    const code = await s.get("code");
    if (code && code.expiresAt <= now) doomed.push("code");
    for (let i = 0; i < doomed.length; i += 128) await s.delete(doomed.slice(i, i + 128));
    await s.setAlarm(now + CLEANUP_EVERY_MS);
  }

  async endSession(sessionHash) {
    await this.ctx.storage.delete(`session:${sessionHash}`);
    return { ok: true };
  }

  // ---- Orders ----

  // Before creating a Stripe session: reuse an open unpaid order, or check the per-session cap.
  // Returns { existing: order+id } | { allowed: true } | { allowed: false, error }
  async prepareCheckout(sessionHash) {
    const s = this.ctx.storage;
    const ids = (await s.get(`sessorders:${sessionHash}`)) || [];
    const now = Date.now();
    for (const id of ids.slice().reverse()) {
      const o = await s.get(`order:${id}`);
      // Reuse only if still payable for at least 2 more minutes.
      if (o && o.status === "created" && o.checkoutExpiresAt - now > 2 * 60 * 1000) {
        return { existing: { orderId: id, ...o } };
      }
    }
    if (ids.length >= MAX_ORDERS_PER_SESSION) {
      return { allowed: false, error: `This session has reached the limit of ${MAX_ORDERS_PER_SESSION} orders.` };
    }
    return { allowed: true };
  }

  async saveOrder(sessionHash, { orderId, stripeSessionId, url, checkoutExpiresAt }) {
    const s = this.ctx.storage;
    const listKey = `sessorders:${sessionHash}`;
    const ids = (await s.get(listKey)) || [];
    ids.push(orderId);
    await s.put({
      [`order:${orderId}`]: { sessionHash, stripeSessionId, url, status: "created", createdAt: Date.now(), checkoutExpiresAt },
      [listKey]: ids,
    });
  }

  // ---- Token-paid orders (Shared Payment Token route) ----

  // Reserves a new token order for this session, respecting the per-session cap.
  // Returns { allowed: true } or { allowed: false, error }.
  async reserveTokenOrder(sessionHash, orderId) {
    const s = this.ctx.storage;
    const listKey = `sessorders:${sessionHash}`;
    const ids = (await s.get(listKey)) || [];
    if (ids.length >= MAX_ORDERS_PER_SESSION) {
      return { allowed: false, error: `This session has reached the limit of ${MAX_ORDERS_PER_SESSION} orders.` };
    }
    ids.push(orderId);
    await s.put({
      [`order:${orderId}`]: { sessionHash, method: "token", paymentIntentId: null, status: "created", createdAt: Date.now() },
      [listKey]: ids,
    });
    return { allowed: true };
  }

  async recordTokenCharge(orderId, { paymentIntentId, paid }) {
    const s = this.ctx.storage;
    const o = await s.get(`order:${orderId}`);
    if (!o) return;
    o.paymentIntentId = paymentIntentId;
    const updates = {};
    if (paid && o.status === "created") {
      o.status = "paid";
      o.paidAt = Date.now();
      updates["stat:test_purchases"] = ((await s.get("stat:test_purchases")) || 0) + 1;
    }
    updates[`order:${orderId}`] = o;
    await s.put(updates);
  }

  // Returns the order only if it belongs to this session.
  async getOrderForSession(orderId, sessionHash) {
    const o = await this.ctx.storage.get(`order:${orderId}`);
    return o && o.sessionHash === sessionHash ? o : null;
  }

  // Returns true only when this call moved the order to "paid" (so it is counted once).
  async markPaid(orderId) {
    const s = this.ctx.storage;
    const o = await s.get(`order:${orderId}`);
    if (o && o.status === "created") {
      o.status = "paid";
      o.paidAt = Date.now();
      await s.put({ [`order:${orderId}`]: o, "stat:test_purchases": ((await s.get("stat:test_purchases")) || 0) + 1 });
      return true;
    }
    return false;
  }

  // Atomically: order must belong to session, be paid and not delivered -> mark delivered + store token.
  async issueDownload(orderId, sessionHash, tokenHash) {
    const s = this.ctx.storage;
    const o = await s.get(`order:${orderId}`);
    if (!o || o.sessionHash !== sessionHash) return { ok: false, reason: "not_found" };
    if (o.status === "delivered") return { ok: false, reason: "already_delivered" };
    if (o.status !== "paid") return { ok: false, reason: "not_paid" };
    const expiresAt = Date.now() + DOWNLOAD_TTL_MS;
    o.status = "delivered";
    o.deliveredAt = Date.now();
    await s.put({
      [`order:${orderId}`]: o,
      [`dl:${tokenHash}`]: { orderId, sessionHash, expiresAt },
    });
    return { ok: true, expiresAt };
  }

  // Single use: the token is deleted when redeemed (or found expired).
  async redeemDownload(tokenHash, sessionHash) {
    const s = this.ctx.storage;
    const key = `dl:${tokenHash}`;
    const d = await s.get(key);
    if (!d) return { ok: false, reason: "unknown_or_used" };
    if (d.sessionHash !== sessionHash) return { ok: false, reason: "wrong_session" }; // not deleted
    await s.delete(key);
    if (d.expiresAt <= Date.now()) return { ok: false, reason: "expired" };
    await this.bump("downloads");
    return { ok: true, orderId: d.orderId };
  }

  async #deleteAllSessions() {
    const s = this.ctx.storage;
    const keys = [...(await s.list({ prefix: "session:" })).keys()];
    for (let i = 0; i < keys.length; i += 128) await s.delete(keys.slice(i, i + 128));
    return keys.length;
  }
}

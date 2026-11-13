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
import { DurableObject } from "cloudflare:workers";

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

  async clearLockouts() {
    const s = this.ctx.storage;
    const keys = [...(await s.list({ prefix: "fails:" })).keys()];
    if (keys.length) await s.delete(keys);
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
    await s.put(`session:${sessionHash}`, { createdAt: now, lastSeen: now });
    return { ok: true };
  }

  // Checks a session and refreshes its inactivity timer. Returns true if valid.
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
    return true;
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

  // Returns the order only if it belongs to this session.
  async getOrderForSession(orderId, sessionHash) {
    const o = await this.ctx.storage.get(`order:${orderId}`);
    return o && o.sessionHash === sessionHash ? o : null;
  }

  async markPaid(orderId) {
    const s = this.ctx.storage;
    const o = await s.get(`order:${orderId}`);
    if (o && o.status === "created") {
      o.status = "paid";
      o.paidAt = Date.now();
      await s.put(`order:${orderId}`, o);
    }
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
    return { ok: true, orderId: d.orderId };
  }

  async #deleteAllSessions() {
    const s = this.ctx.storage;
    const keys = [...(await s.list({ prefix: "session:" })).keys()];
    for (let i = 0; i < keys.length; i += 128) await s.delete(keys.slice(i, i + 128));
    return keys.length;
  }
}

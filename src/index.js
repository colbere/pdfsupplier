// The PDF Supplier: Cloudflare Worker (server).
// Serves the single text-only page, its WebMCP script, the sign-in API and the admin API.
import PAGE_HTML from "./page/index.html";
import APP_JS from "./page/app.browser.js";
import { hashCode, sha256Hex } from "./shared.js";
export { Store } from "./store.js";

const SESSION_COOKIE = "__Host-pdfs_session";

// Strict security headers on every response.
// The CSP only lets the browser run our own script (/app.js) and talk to our own server.
const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

function respond(body, contentType, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType, ...SECURITY_HEADERS, ...extra },
  });
}

function json(obj, status = 200, extra = {}) {
  return respond(JSON.stringify(obj), "application/json; charset=utf-8", status, extra);
}

// Every sign-in failure returns exactly this (see docs/DECISIONS.md D6).
const SIGN_IN_FAILED = { ok: false, error: "Sign-in failed." };
const NOT_AUTHENTICATED = { ok: false, error: "Not authenticated. Sign in again with a new one-time code from the store owner." };

function store(env) {
  return env.STORE.get(env.STORE.idFromName("main"));
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function sessionCookie(token) {
  // __Host- prefix: browser only accepts it with Secure, Path=/ and no Domain.
  return `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}

function clearedSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32)); // 256 bits
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sessionHash(token) {
  return sha256Hex(`pdfs-session:${token}`);
}

// Returns true if the request carries a valid, unexpired session (and refreshes its idle timer).
// Used by every purchase endpoint (Steps 4 and 5).
async function hasValidSession(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token || token.length < 40 || token.length > 60) return false;
  return store(env).touchSession(await sessionHash(token));
}

// Browser API calls must come from our own page (defence in depth alongside SameSite=Strict).
function sameOrigin(request, url) {
  const origin = request.headers.get("Origin");
  return origin === null || origin === url.origin;
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

// ---- Admin API (used by the npm scripts; requires ADMIN_TOKEN from .env) ----

async function isAdmin(request, env) {
  const configured = env.ADMIN_TOKEN;
  if (typeof configured !== "string" || configured.length < 32) return false;
  const auth = request.headers.get("Authorization") || "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  // Compare hashes in constant time so the comparison doesn't leak the token.
  const [a, b] = await Promise.all([sha256Hex(`admin:${given}`), sha256Hex(`admin:${configured}`)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handleAdmin(request, env, pathname) {
  if (typeof env.ADMIN_TOKEN !== "string" || env.ADMIN_TOKEN.length < 32) {
    return json({ ok: false, error: "Admin is not configured. Run `npm run setup`, then restart the server." }, 503);
  }
  if (!(await isAdmin(request, env))) return json({ ok: false, error: "Unauthorized." }, 401);

  const s = store(env);
  if (pathname === "/admin/code" && request.method === "POST") {
    const body = await readJson(request);
    if (!body || typeof body.hash !== "string" || !/^[0-9a-f]{64}$/.test(body.hash)) {
      return json({ ok: false, error: "Expected { hash: <64 hex chars> }." }, 400);
    }
    const result = await s.addCode(body.hash);
    console.log(`admin: new code ${result.ok ? "stored" : "refused"}`);
    return json(result, result.ok ? 200 : 409);
  }
  if (pathname === "/admin/kill-switch" && request.method === "POST") {
    const body = await readJson(request);
    if (!body || typeof body.on !== "boolean") return json({ ok: false, error: "Expected { on: true|false }." }, 400);
    const result = await s.setKillSwitch(body.on);
    console.log(`admin: kill switch ${body.on ? "ON" : "off"}`);
    return json(result);
  }
  if (pathname === "/admin/unlock" && request.method === "POST") {
    const result = await s.clearLockouts();
    console.log("admin: lockouts cleared");
    return json(result);
  }
  if (pathname === "/admin/status" && request.method === "GET") {
    return json({ ok: true, ...(await s.status()) });
  }
  return json({ ok: false, error: "Unknown admin route." }, 404);
}

// ---- Sign-in ----

async function handleSignIn(request, env, url) {
  if (!sameOrigin(request, url)) return json(SIGN_IN_FAILED, 403);
  const body = await readJson(request);
  const code = body && typeof body.code === "string" ? body.code.slice(0, 100) : "";
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  const token = randomToken();
  const result = await store(env).signIn(await hashCode(code), ip, await sessionHash(token));

  // Log the outcome only, never the code or token.
  console.log(`sign_in: ${result.ok ? "success" : "failed (" + result.reason + ")"}`);

  if (!result.ok) return json(SIGN_IN_FAILED, 401);
  return json(
    { ok: true, message: "Signed in. The store's purchase tools are now available." },
    200,
    { "Set-Cookie": sessionCookie(token) },
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (pathname === "/" && (method === "GET" || method === "HEAD")) {
      return respond(PAGE_HTML, "text/html; charset=utf-8");
    }

    if (pathname === "/app.js" && (method === "GET" || method === "HEAD")) {
      return respond(APP_JS, "text/javascript; charset=utf-8");
    }

    if (pathname === "/api/sign-in" && method === "POST") {
      return handleSignIn(request, env, url);
    }

    // Lets the page find out whether it is signed in (e.g. after a reload).
    if (pathname === "/api/session" && method === "GET") {
      const signedIn = await hasValidSession(request, env);
      return signedIn ? json({ ok: true, signedIn: true }) : json({ ...NOT_AUTHENTICATED, signedIn: false }, 401);
    }

    if (pathname.startsWith("/admin/")) {
      return handleAdmin(request, env, pathname);
    }

    return respond("Not found.", "text/plain; charset=utf-8", 404);
  },
};

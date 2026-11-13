// The PDF Supplier: Cloudflare Worker (server).
// Serves the single text-only page, its WebMCP script, the tool API, the download route and the admin API.
import PAGE_HTML from "./page/index.html";
import APP_JS from "./page/app.browser.js";
import { hashCode, sha256Hex, PRODUCT } from "./shared.js";
import { isTestKey, redact, createCheckoutSession, getCheckoutSession, StripeError } from "./stripe.js";
import { buildPdf } from "./pdf.js";
export { Store } from "./store.js";

const SESSION_COOKIE = "__Host-pdfs_session";
const ORDER_ID_RE = /^ord_[a-z2-9]{20}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

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
// `code` lets the page recognise this and remove the purchase tools.
const NOT_AUTHENTICATED = {
  ok: false,
  code: "not_authenticated",
  error: "Not signed in, or the session has expired. Sign in again with a new one-time code from the store owner.",
};

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

function randomOrderId() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"; // must match ORDER_ID_RE ([a-z2-9])
  const limit = 256 - (256 % alphabet.length);
  let id = "";
  while (id.length < 20) {
    for (const b of crypto.getRandomValues(new Uint8Array(32))) {
      if (b < limit && id.length < 20) id += alphabet[b % alphabet.length];
    }
  }
  return `ord_${id}`;
}

function sessionHash(token) {
  return sha256Hex(`pdfs-session:${token}`);
}

// Returns the session's hash if the request carries a valid, unexpired session
// (and refreshes its idle timer). Otherwise null.
async function validSessionHash(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token || token.length < 40 || token.length > 60) return null;
  const hash = await sessionHash(token);
  return (await store(env).touchSession(hash)) ? hash : null;
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

// ---- Session-protected tool endpoints ----
// Every purchase-related endpoint goes through this: same-origin POST + valid session, checked on the server.
async function withSession(request, env, url, handler) {
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);
  if (!sameOrigin(request, url)) return json({ ok: false, error: "Cross-origin request refused." }, 403);
  const sh = await validSessionHash(request, env);
  if (!sh) return json(NOT_AUTHENTICATED, 401);
  return handler(sh);
}

function handleProduct() {
  return json({
    ok: true,
    product: {
      name: PRODUCT.name,
      price: PRODUCT.priceLabel,
      description: `A PDF file containing exactly one sentence: "${PRODUCT.contents}"`,
      delivery: "After payment, a single-use download link that expires in minutes.",
      note: "Payments run in Stripe test mode. No real money moves.",
    },
  });
}

function stripeFailure(where, err) {
  // Server log gets the (redacted) reason; the agent gets a short, honest message.
  console.log(`${where}: Stripe error ${err.status || ""} ${redact(err.message)}`);
  return json({ ok: false, error: "The payment provider (Stripe) returned an error. Try again shortly; if it keeps failing, tell the store owner." }, 502);
}

async function handleCreateCheckout(env, url, sh) {
  const s = store(env);
  const prep = await s.prepareCheckout(sh);
  if (prep.existing) {
    const o = prep.existing;
    console.log(`create_checkout: reused open order ${o.orderId}`);
    return json({ ok: true, reused: true, order_id: o.orderId, checkout_url: o.url, expires_at: new Date(o.checkoutExpiresAt).toISOString() });
  }
  if (!prep.allowed) return json({ ok: false, error: prep.error }, 429);

  const orderId = randomOrderId();
  let session;
  try {
    session = await createCheckoutSession(env, { orderId, origin: url.origin });
  } catch (err) {
    if (err instanceof StripeError) return stripeFailure("create_checkout", err);
    throw err;
  }
  await s.saveOrder(sh, { orderId, stripeSessionId: session.id, url: session.url, checkoutExpiresAt: session.expiresAt });
  console.log(`create_checkout: order ${orderId} created`); // never log the Stripe URL
  return json({ ok: true, reused: false, order_id: orderId, checkout_url: session.url, expires_at: new Date(session.expiresAt).toISOString() });
}

async function readOrderId(request) {
  const body = await readJson(request);
  const id = body && typeof body.order_id === "string" ? body.order_id.trim() : "";
  return ORDER_ID_RE.test(id) ? id : null;
}

const NO_SUCH_ORDER = { ok: false, error: "No order with that order_id was found for this session. Use the order_id returned by create_checkout." };

async function handleCheckOrder(request, env, sh) {
  const orderId = await readOrderId(request);
  if (!orderId) return json({ ok: false, error: "order_id is missing or malformed. It looks like ord_ followed by 20 characters." }, 400);
  const s = store(env);
  const order = await s.getOrderForSession(orderId, sh);
  if (!order) return json(NO_SUCH_ORDER, 404);
  if (order.status === "delivered") return json({ ok: true, order_id: orderId, status: "delivered" });

  let cs;
  try {
    cs = await getCheckoutSession(env, order.stripeSessionId);
  } catch (err) {
    if (err instanceof StripeError) return stripeFailure("check_order", err);
    throw err;
  }
  // Paid only when Stripe says paid AND Stripe's copy of our order_id matches.
  const paid = cs.paymentStatus === "paid" && cs.orderId === orderId && cs.id === order.stripeSessionId && !cs.livemode;
  if (paid) await s.markPaid(orderId);
  console.log(`check_order: ${orderId} stripe=${cs.status}/${cs.paymentStatus} -> ${paid ? "paid" : "not paid"}`);
  return json({ ok: true, order_id: orderId, status: paid ? "paid" : (cs.status === "expired" ? "expired" : "unpaid"), checkout_status: cs.status });
}

// open_checkout: returns the Stripe URL of an unpaid, unexpired order owned by this session,
// so the page can move the tab there by script. The URL is never written into the page.
async function handleOpenCheckout(request, env, sh) {
  const orderId = await readOrderId(request);
  if (!orderId) return json({ ok: false, error: "order_id is missing or malformed. It looks like ord_ followed by 20 characters." }, 400);
  const order = await store(env).getOrderForSession(orderId, sh);
  if (!order) return json(NO_SUCH_ORDER, 404);
  if (order.status !== "created") {
    return json({ ok: false, error: `Order ${orderId} is already paid. Call check_order, then get_download.` }, 409);
  }
  if (order.checkoutExpiresAt <= Date.now() + 60 * 1000) {
    return json({ ok: false, error: `The checkout page for ${orderId} has expired. Call create_checkout to start a new order.` }, 410);
  }
  if (typeof order.url !== "string" || !order.url.startsWith("https://checkout.stripe.com/")) {
    return json({ ok: false, error: "No valid Stripe checkout URL is stored for this order." }, 500);
  }
  console.log(`open_checkout: ${orderId} -> navigating to Stripe`); // never log the URL
  return json({ ok: true, order_id: orderId, checkout_url: order.url });
}

async function handleGetDownload(request, env, url, sh) {
  const orderId = await readOrderId(request);
  if (!orderId) return json({ ok: false, error: "order_id is missing or malformed. It looks like ord_ followed by 20 characters." }, 400);
  const token = randomToken();
  const r = await store(env).issueDownload(orderId, sh, await sha256Hex(`pdfs-dl:${token}`));
  console.log(`get_download: ${orderId} -> ${r.ok ? "link issued, order delivered" : r.reason}`);
  if (!r.ok) {
    const msg = {
      not_found: NO_SUCH_ORDER.error,
      not_paid: "This order is not marked paid yet. Call check_order first; get_download works once check_order reports paid.",
      already_delivered: "This order was already delivered. Download links are single-use, so a new link can't be issued.",
    }[r.reason];
    return json({ ok: false, error: msg }, r.reason === "not_found" ? 404 : 409);
  }
  return json({ ok: true, order_id: orderId, download_url: `${url.origin}/download/${token}`, expires_at: new Date(r.expiresAt).toISOString() });
}

async function handleDownload(request, env, token) {
  // Requires the same signed-in session that requested the link (rule 4). See DECISIONS D13.
  const sh = await validSessionHash(request, env);
  if (!sh) {
    console.log("download: refused (no valid session)");
    return respond("Not signed in, or the session has expired.", "text/plain; charset=utf-8", 401);
  }
  if (!TOKEN_RE.test(token)) return respond("Download link not found.", "text/plain; charset=utf-8", 404);
  const r = await store(env).redeemDownload(await sha256Hex(`pdfs-dl:${token}`), sh);
  console.log(`download: ${r.ok ? `served PDF for ${r.orderId}` : `refused (${r.reason})`}`);
  if (!r.ok) {
    const msg = r.reason === "expired" ? "This download link has expired." : "Download link not found, already used, or not yours.";
    return respond(msg, "text/plain; charset=utf-8", r.reason === "expired" ? 410 : 404);
  }
  return new Response(buildPdf(PRODUCT.contents), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="you-now-own-this.pdf"',
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
}

async function handleSignOut(request, env) {
  // Always clears the cookie. Deletes the server session if there is one.
  const token = getCookie(request, SESSION_COOKIE);
  if (token && token.length >= 40 && token.length <= 60) {
    await store(env).endSession(await sessionHash(token));
  }
  console.log("sign_out");
  return json({ ok: true, message: "Signed out." }, 200, { "Set-Cookie": clearedSessionCookie() });
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
    { ok: true, message: "Signed in." }, // the page adds which tools became available
    200,
    { "Set-Cookie": sessionCookie(token) },
  );
}

export default {
  async fetch(request, env) {
    // Hard rule 1: never run with anything but a Stripe TEST key.
    if (!isTestKey(env.STRIPE_SECRET_KEY)) {
      console.log("REFUSING TO SERVE: STRIPE_SECRET_KEY is missing or is not a Stripe test key (rk_test_/sk_test_).");
      return json({ ok: false, error: "Server misconfigured: a Stripe TEST key (rk_test_ or sk_test_) is required. Refusing to run." }, 503);
    }

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
      const signedIn = !!(await validSessionHash(request, env));
      return signedIn ? json({ ok: true, signedIn: true }) : json({ ...NOT_AUTHENTICATED, signedIn: false }, 401);
    }

    if (pathname === "/api/product") return withSession(request, env, url, () => handleProduct());
    if (pathname === "/api/checkout") return withSession(request, env, url, (sh) => handleCreateCheckout(env, url, sh));
    if (pathname === "/api/open-checkout") return withSession(request, env, url, (sh) => handleOpenCheckout(request, env, sh));
    if (pathname === "/api/order") return withSession(request, env, url, (sh) => handleCheckOrder(request, env, sh));
    if (pathname === "/api/download") return withSession(request, env, url, (sh) => handleGetDownload(request, env, url, sh));

    if (pathname === "/api/sign-out" && method === "POST") {
      if (!sameOrigin(request, url)) return json({ ok: false, error: "Cross-origin request refused." }, 403);
      return handleSignOut(request, env);
    }

    if (pathname.startsWith("/download/") && method === "GET") {
      return handleDownload(request, env, pathname.slice("/download/".length));
    }

    if (pathname.startsWith("/admin/")) {
      return handleAdmin(request, env, pathname);
    }

    return respond("Not found.", "text/plain; charset=utf-8", 404);
  },
};

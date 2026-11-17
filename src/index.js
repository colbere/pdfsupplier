// The PDF Supplier: Cloudflare Worker (server).
// Serves the single text-only page, its WebMCP script, the tool API, the download route and the admin API.
import PAGE_HTML from "./page/index.html";
import APP_JS from "./page/app.browser.js";
import { hashCode, sha256Hex, PRODUCT } from "./shared.js";
import {
  isTestKey, redact, createCheckoutSession, getCheckoutSession, StripeError,
  isSharedPaymentToken, chargeSharedPaymentToken, getPaymentIntent, createTestSharedPaymentToken,
} from "./stripe.js";
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
const NOT_AUTHENTICATED = {
  ok: false,
  code: "not_authenticated",
  error: "No active session (it may have expired after 30 minutes idle). Start a purchase again with get_test_payment_token or create_checkout.",
};
const CLOSED = { ok: false, code: "closed", error: "The store is temporarily closed. Try again later." };

// ---- Abuse limits (docs/SECURITY.md) ----
// Visitors are identified only by a SHA-256 of their IP address mixed with the current UTC day,
// so raw IPs are never stored and the identifier changes daily.
// Names ending in "-h" are hourly windows; the rest are daily.
const HOUR = 3_600_000;
const DAY = 86_400_000;
const LIMITS = {
  // Global API budget sized to the Cloudflare free plan's storage allowance (docs/research/GO-LIVE.md).
  api:        { name: "api-h",            perVisitor: 300, global: 1500,  windowMs: HOUR },
  visitors:   { name: "visitor-sessions", perVisitor: 20,  global: 5000,  windowMs: DAY },
  checkouts:  { name: "checkouts",        perVisitor: 5,   global: 300,   windowMs: DAY },
  testTokens: { name: "test-tokens",      perVisitor: 5,   global: 300,   windowMs: DAY },
  payments:   { name: "token-payments",   perVisitor: 10,  global: 500,   windowMs: DAY },
  hellos:     { name: "hellos",           perVisitor: 20,  global: 3000,  windowMs: DAY },
  feedback:   { name: "feedback",         perVisitor: 5,   global: 300,   windowMs: DAY },
};
const ADMIN_FAILS_PER_HOUR = 5; // owner's choice (2026-11-16)
const VISITS_COUNTED_PER_DAY = 50000;

// Per-request context set by the gate (one storage call per request; see route()).
const RC = new WeakMap();

async function clientId(request) {
  const cached = RC.get(request)?.cid;
  if (cached) return cached;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const day = new Date().toISOString().slice(0, 10);
  return (await sha256Hex(`client:${day}:${ip}`)).slice(0, 32);
}

async function checkLimit(env, request, spec) {
  const cid = await clientId(request);
  const r = await store(env).hitAll([
    { name: spec.name, subject: cid, max: spec.perVisitor, windowMs: spec.windowMs },
    { name: spec.name, subject: "all", max: spec.global, windowMs: spec.windowMs },
  ]);
  if (r.ok) return null;
  const when = spec.windowMs === HOUR ? "this hour" : "today";
  console.log(`limit: ${spec.name} (${r.scope}) reached`);
  return json({
    ok: false,
    code: "rate_limited",
    error: r.scope === "global"
      ? `The store's overall limit for this action has been reached ${when}. Try again later.`
      : `You've reached this store's limit for this action ${when}. Try again later.`,
  }, 429);
}

// Keeps visitor-supplied text short and free of control characters.
function cleanText(value, max, { singleLine = false } = {}) {
  if (typeof value !== "string") return "";
  let t = value.replace(/[\u0000-\u0008\u000B-\u001F\u007F​-‏‪-‮⁦-⁩]/g, "");
  if (singleLine) t = t.replace(/\s+/g, " ");
  return t.trim().slice(0, max);
}
function cleanLabel(value, max) {
  return cleanText(value, max, { singleLine: true }).replace(/[^A-Za-z0-9 ._:/()+@-]/g, "").trim();
}

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
  return (await validSession(request, env))?.hash ?? null;
}

// Returns { hash, kind } for a valid session ("owner" or "visitor"), otherwise null.
// Uses the gate's answer when this request went through it (no extra storage call).
async function validSession(request, env) {
  const rc = RC.get(request);
  if (rc && rc.gated) return rc.session ? { hash: rc.sessionHash, kind: rc.session } : null;
  const token = getCookie(request, SESSION_COOKIE);
  if (!token || token.length < 40 || token.length > 60) return null;
  const hash = await sessionHash(token);
  const kind = await store(env).touchSession(hash);
  return kind ? { hash, kind } : null;
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
  const s = store(env);
  const cid = await clientId(request);
  // Too many failed admin attempts from this visitor this hour: refuse without checking.
  if ((await s.count("admin-fail-h", cid, HOUR)) >= ADMIN_FAILS_PER_HOUR) {
    return json({ ok: false, error: "Too many attempts. Try again later." }, 429);
  }
  if (!(await isAdmin(request, env))) {
    await s.hit("admin-fail-h", cid, ADMIN_FAILS_PER_HOUR + 1, HOUR);
    console.log("admin: unauthorized attempt");
    return json({ ok: false, error: "Unauthorized." }, 401);
  }

  if (pathname === "/admin/report" && request.method === "GET") {
    return json({ ok: true, ...(await s.ownerReport({ feedbackLimit: 100 })) });
  }
  if (pathname === "/admin/traffic" && request.method === "GET") {
    const u = new URL(request.url);
    const startAfter = u.searchParams.get("after") || undefined;
    if (startAfter && !/^log:\d{15}:[0-9a-f-]{1,8}$/.test(startAfter)) return json({ ok: false, error: "Bad cursor." }, 400);
    return json({ ok: true, ...(await s.readTraffic({ startAfter, limit: Number(u.searchParams.get("limit")) || 2000 })) });
  }
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
// Every purchase-related endpoint goes through this: same-origin POST + valid session, checked on
// the server. With { visitor: true } (endpoints that START a purchase), a visiting agent without a
// session gets a new visitor session, within the visitor-session limits.
async function withSession(request, env, url, handler, { visitor = false } = {}) {
  if (request.method !== "POST") return json({ ok: false, error: "Use POST." }, 405);
  if (!sameOrigin(request, url)) return json({ ok: false, error: "Cross-origin request refused." }, 403);
  let sh = await validSessionHash(request, env);
  let newCookie = null;
  if (!sh) {
    if (await isClosed(request, env)) return json(CLOSED, 503);
    if (!visitor) return json(NOT_AUTHENTICATED, 401);
    const limited = await checkLimit(env, request, LIMITS.visitors);
    if (limited) return limited;
    const token = randomToken();
    sh = await sessionHash(token);
    if (!(await store(env).createVisitorSession(sh)).ok) return json(CLOSED, 503);
    newCookie = sessionCookie(token);
    await store(env).bump("visitor_sessions");
  }
  const res = await handler(sh);
  if (newCookie) res.headers.append("Set-Cookie", newCookie);
  return res;
}

// Public endpoints (no session needed): refused while the kill switch is on.
async function publicGate(request, env, url) {
  if (!sameOrigin(request, url)) return json({ ok: false, error: "Cross-origin request refused." }, 403);
  if (await isClosed(request, env)) return json(CLOSED, 503);
  return null;
}

// Kill switch state: from the gate when available, otherwise one read.
async function isClosed(request, env) {
  const rc = RC.get(request);
  if (rc && rc.gated) return rc.killed;
  return store(env).isKilled();
}

function handleProduct() {
  return json({
    ok: true,
    product: {
      name: PRODUCT.name,
      price: PRODUCT.priceLabel,
      description: `A PDF file containing exactly one sentence: "${PRODUCT.contents}"`,
      delivery: "After payment, a single-use download link that expires in minutes.",
      note: "Payments run in Stripe test mode (sandbox). No real money moves, and any agent may try.",
    },
  });
}

function handleTestCard() {
  return json({
    ok: true,
    card: {
      number: "4242 4242 4242 4242",
      expiry: "any future date, e.g. 12/34",
      cvc: "any 3 digits, e.g. 123",
      other_fields: "any name, email and postal code",
    },
    note: "Stripe's public test card. It only works in Stripe test mode (sandbox); no real money moves.",
  });
}

async function handleTestToken(request, env) {
  const limited = await checkLimit(env, request, LIMITS.testTokens);
  if (limited) return limited;
  let t;
  try {
    t = await createTestSharedPaymentToken(env);
  } catch (err) {
    if (err instanceof StripeError) return stripeFailure("get_test_payment_token", err);
    throw err;
  }
  await store(env).bump("test_tokens_issued");
  console.log("get_test_payment_token: issued"); // never log the token
  return json({ ok: true, payment_token: t.token, limit: PRODUCT.priceLabel, expires_at: new Date(t.expiresAt).toISOString() });
}

async function handleHello(request, env) {
  const body = await readJson(request);
  const name = cleanLabel(body?.agent_name, 60);
  const model = cleanLabel(body?.model, 80);
  if (!name) return json({ ok: false, error: "agent_name is required (letters, numbers and basic punctuation, up to 60 characters)." }, 400);
  const limited = await checkLimit(env, request, LIMITS.hellos);
  if (limited) return limited;
  const n = await store(env).recordHello(model ? `${name} | ${model}` : name);
  console.log("say_hello: recorded");
  return json({ ok: true, message: `Hello, ${name}. Recorded (this name has said hello ${n} time${n === 1 ? "" : "s"}).` });
}

async function handleStats(env) {
  const st = await store(env).publicStats();
  const tools = {};
  for (const [k, v] of Object.entries(st)) if (k.startsWith("tool:")) tools[k.slice(5)] = v;
  return json({
    ok: true,
    stats: {
      page_visits: st.visits || 0,
      visitor_sessions: st.visitor_sessions || 0,
      test_tokens_issued: st.test_tokens_issued || 0,
      test_purchases_completed: st.test_purchases || 0,
      pdfs_downloaded: st.downloads || 0,
      hellos: st.hellos || 0,
      distinct_agent_names: st.distinct_agent_names || 0,
      feedback_received: st.feedback || 0,
      tool_calls: tools,
    },
    note: "All purchases are in Stripe test mode. Agent names and feedback are kept private.",
  });
}

async function handleFeedback(request, env) {
  const body = await readJson(request);
  const text = cleanText(body?.feedback, 500);
  const label = cleanLabel(body?.agent_name, 60) || "(unnamed)";
  if (text.length < 3) return json({ ok: false, error: "feedback is required (3 to 500 characters)." }, 400);
  const limited = await checkLimit(env, request, LIMITS.feedback);
  if (limited) return limited;
  const r = await store(env).addFeedback({ label, text });
  if (!r.ok) return json({ ok: false, error: "The feedback box is full for now. Thank you anyway." }, 507);
  console.log("leave_feedback: recorded"); // never log the text
  return json({ ok: true, message: "Thank you. Your feedback was recorded privately for the store owner." });
}

function stripeFailure(where, err) {
  // Server log gets the (redacted) reason; the agent gets a short, honest message.
  console.log(`${where}: Stripe error ${err.status || ""} ${redact(err.message)}`);
  return json({ ok: false, error: "The payment provider (Stripe) returned an error. Try again shortly; if it keeps failing, tell the store owner." }, 502);
}

async function handleCreateCheckout(request, env, url, sh) {
  const s = store(env);
  const prep = await s.prepareCheckout(sh);
  if (prep.existing) {
    const o = prep.existing;
    console.log(`create_checkout: reused open order ${o.orderId}`);
    return json({ ok: true, reused: true, order_id: o.orderId, checkout_url: o.url, expires_at: new Date(o.checkoutExpiresAt).toISOString() });
  }
  if (!prep.allowed) return json({ ok: false, error: prep.error }, 429);
  const limited = await checkLimit(env, request, LIMITS.checkouts);
  if (limited) return limited;

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

  if (order.method === "token") {
    // Token-paid order: ask Stripe about the PaymentIntent itself.
    if (!order.paymentIntentId) return json({ ok: true, order_id: orderId, status: "unpaid", payment_status: "not charged" });
    let pi;
    try {
      pi = await getPaymentIntent(env, order.paymentIntentId);
    } catch (err) {
      if (err instanceof StripeError) return stripeFailure("check_order", err);
      throw err;
    }
    const paid = pi.status === "succeeded" && pi.amount === PRODUCT.unitAmountCents && pi.currency === PRODUCT.currency &&
      pi.orderId === orderId && pi.id === order.paymentIntentId && !pi.livemode;
    if (paid) await s.markPaid(orderId);
    console.log(`check_order: ${orderId} (token) stripe=${pi.status} -> ${paid ? "paid" : "not paid"}`);
    return json({ ok: true, order_id: orderId, status: paid ? "paid" : "unpaid", payment_status: pi.status });
  }

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
  if (order.method === "token") {
    return json({ ok: false, error: `Order ${orderId} is paid with a shared payment token, not on Stripe's checkout page. Call check_order instead.` }, 409);
  }
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

// pay_with_token: creates an order and charges the agent's Shared Payment Token exactly once.
// The token is a payment credential: it is never logged or echoed back.
async function handlePayWithToken(request, env, sh) {
  const body = await readJson(request);
  const token = body && typeof body.payment_token === "string" ? body.payment_token.trim() : "";
  if (!isSharedPaymentToken(token)) {
    return json({ ok: false, error: "payment_token is missing or not a Shared Payment Token (it should start with spt_). Visitors can get a sandbox one from get_test_payment_token." }, 400);
  }
  const limited = await checkLimit(env, request, LIMITS.payments);
  if (limited) return limited;
  const s = store(env);
  const orderId = randomOrderId();
  const reserved = await s.reserveTokenOrder(sh, orderId);
  if (!reserved.allowed) return json({ ok: false, error: reserved.error }, 429);

  let pi;
  try {
    pi = await chargeSharedPaymentToken(env, { orderId, token });
  } catch (err) {
    if (err instanceof StripeError) {
      console.log(`pay_with_token: ${orderId} Stripe refused (${err.status}) ${redact(err.message).replace(/spt_[A-Za-z0-9_]+/g, "spt_[…]")}`);
      // Stripe's reason (e.g. token used, expired, over its limit) helps the agent; strip any token text.
      const reason = redact(err.message).replace(/spt_[A-Za-z0-9_]+/g, "[token]").slice(0, 200);
      return json({ ok: false, order_id: orderId, error: `The payment was not accepted by Stripe: ${reason}` }, 402);
    }
    throw err;
  }
  const paid = pi.status === "succeeded" && pi.amount === PRODUCT.unitAmountCents && pi.currency === PRODUCT.currency;
  await s.recordTokenCharge(orderId, { paymentIntentId: pi.id, paid });
  console.log(`pay_with_token: ${orderId} stripe=${pi.status} -> ${paid ? "paid" : "not paid"}`);
  if (!paid) {
    return json({ ok: false, order_id: orderId, status: "unpaid", error: `Stripe reported the payment as "${pi.status}", not completed.` }, 402);
  }
  return json({ ok: true, order_id: orderId, status: "paid", amount: PRODUCT.priceLabel });
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

// Which tool each API path serves (for the public per-tool counters).
const API_TOOL_NAMES = {
  "/api/sign-in": "sign_in", "/api/product": "get_product", "/api/test-card": "get_test_card",
  "/api/test-token": "get_test_payment_token", "/api/pay-with-token": "pay_with_token",
  "/api/checkout": "create_checkout", "/api/open-checkout": "open_checkout", "/api/order": "check_order",
  "/api/download": "get_download", "/api/hello": "say_hello", "/api/stats": "get_stats",
  "/api/feedback": "leave_feedback", "/api/sign-out": "sign_out",
};

// ---- Traffic log (owner-only; docs/SECURITY.md) ----
// One entry per request, written after the response is sent. No raw IPs, no secrets:
// download links are recorded as /download/[token]; headers like Authorization are never read here.
async function logTraffic(request, env, url, status) {
  try {
    if (url.pathname === "/app.js") return;
    const path = url.pathname.startsWith("/download/") ? "/download/[token]" : url.pathname.slice(0, 80);
    const cf = request.cf || {};
    await store(env).logTraffic({
      t: new Date().toISOString(),
      m: request.method,
      p: path,
      tool: API_TOOL_NAMES[url.pathname] || null,
      s: status,
      v: (await clientId(request)).slice(0, 12),
      c: typeof cf.country === "string" ? cf.country.slice(0, 2) : null,
      n: typeof cf.asOrganization === "string" ? cf.asOrganization.slice(0, 80) : null,
      a: cleanText(request.headers.get("User-Agent") || "", 160, { singleLine: true }) || null,
    });
  } catch (err) {
    console.log("traffic log: write failed");
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const response = await route(request, env);
    const rc = RC.get(request);
    if (ctx && typeof ctx.waitUntil === "function" && isTestKey(env.STRIPE_SECRET_KEY) && rc?.log !== false) {
      ctx.waitUntil(logTraffic(request, env, url, response.status));
    }
    return response;
  },
};

async function route(request, env) {
  {
    // Hard rule 1: never run with anything but a Stripe TEST key.
    if (!isTestKey(env.STRIPE_SECRET_KEY)) {
      console.log("REFUSING TO SERVE: STRIPE_SECRET_KEY is missing or is not a Stripe test key (rk_test_/sk_test_).");
      return json({ ok: false, error: "Server misconfigured: a Stripe TEST key (rk_test_ or sk_test_) is required. Refusing to run." }, 503);
    }

    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // One canonical origin: www.<host> redirects to <host> (path kept, query dropped).
    if (env.CANONICAL_HOST && url.hostname === `www.${env.CANONICAL_HOST}`) {
      return new Response(null, { status: 301, headers: { Location: `https://${env.CANONICAL_HOST}${pathname}`, ...SECURITY_HEADERS } });
    }

    // ---- The gate: ONE storage call for the page, every API call and downloads ----
    const isPage = pathname === "/" && method === "GET";
    if (isPage || pathname.startsWith("/api/") || pathname.startsWith("/download/")) {
      const cid = await clientId(request);
      const token = isPage ? null : getCookie(request, SESSION_COOKIE);
      const sessionHashValue = token && token.length >= 40 && token.length <= 60 ? await sessionHash(token) : null;
      const g = await store(env).gate({
        cid,
        tool: API_TOOL_NAMES[pathname] || null,
        isPage,
        sessionHash: sessionHashValue,
        api: pathname.startsWith("/api/") ? { perVisitor: LIMITS.api.perVisitor, global: LIMITS.api.global } : null,
        visitsCap: VISITS_COUNTED_PER_DAY,
      });
      RC.set(request, { gated: true, cid, sessionHash: sessionHashValue, ...g });
      if (g.limited) {
        console.log(`limit: api-h (${g.limited === "global" ? "global" : "visitor"}) reached`);
        return json({
          ok: false,
          code: "rate_limited",
          error: g.limited === "global"
            ? "The store's overall limit for this action has been reached this hour. Try again later."
            : "You've reached this store's limit for this action this hour. Try again later.",
        }, 429);
      }
    }

    if (pathname === "/" && (method === "GET" || method === "HEAD")) {
      // Chrome's WebMCP origin trial: makes document.modelContext available to ordinary Chrome
      // visitors on this origin (no flag needed). The token is public by design.
      const ot = typeof env.ORIGIN_TRIAL_TOKEN === "string" && /^[A-Za-z0-9+/=]{20,2000}$/.test(env.ORIGIN_TRIAL_TOKEN)
        ? { "Origin-Trial": env.ORIGIN_TRIAL_TOKEN } : {};
      return respond(PAGE_HTML, "text/html; charset=utf-8", 200, ot);
    }

    if (pathname === "/app.js" && (method === "GET" || method === "HEAD")) {
      return respond(APP_JS, "text/javascript; charset=utf-8");
    }

    if (pathname === "/api/sign-in" && method === "POST") {
      return handleSignIn(request, env, url);
    }

    // Lets the page find out whether it is signed in (e.g. after a reload).
    if (pathname === "/api/session" && method === "GET") {
      const sess = await validSession(request, env);
      return sess
        ? json({ ok: true, signedIn: sess.kind === "owner", kind: sess.kind })
        : json({ ...NOT_AUTHENTICATED, signedIn: false }, 401);
    }

    // Public tools (no session).
    if (method === "POST" && ["/api/product", "/api/test-card", "/api/hello", "/api/stats", "/api/feedback"].includes(pathname)) {
      const gated = await publicGate(request, env, url);
      if (gated) return gated;
      if (pathname === "/api/product") return handleProduct();
      if (pathname === "/api/test-card") return handleTestCard();
      if (pathname === "/api/hello") return handleHello(request, env);
      if (pathname === "/api/stats") return handleStats(env);
      if (pathname === "/api/feedback") return handleFeedback(request, env);
    }

    // Purchase tools. Those that START a purchase may create a visitor session.
    if (pathname === "/api/test-token") return withSession(request, env, url, () => handleTestToken(request, env), { visitor: true });
    if (pathname === "/api/checkout") return withSession(request, env, url, (sh) => handleCreateCheckout(request, env, url, sh), { visitor: true });
    if (pathname === "/api/pay-with-token") return withSession(request, env, url, (sh) => handlePayWithToken(request, env, sh), { visitor: true });
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
  }
}

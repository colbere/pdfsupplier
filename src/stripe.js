// Minimal Stripe REST client (no SDK). Test mode only. See docs/DECISIONS.md D3, D4.
import { PRODUCT } from "./shared.js";

const API = "https://api.stripe.com/v1";
const STRIPE_VERSION = "2026-10-28.endive";

// Only Stripe TEST keys are allowed: restricted (preferred) or secret.
export function isTestKey(key) {
  return typeof key === "string" && /^(rk|sk)_test_[A-Za-z0-9]{16,}$/.test(key) && !/REPLACE/i.test(key);
}

// Remove anything key-like or checkout-URL-like before text goes to a log or a tool result.
export function redact(text) {
  return String(text)
    .replace(/\b(sk|rk|pk)_(test|live)_[A-Za-z0-9*]+/g, "[REDACTED_KEY]")
    .replace(/https:\/\/checkout\.stripe\.com\/\S+/g, "[REDACTED_URL]");
}

export class StripeError extends Error {
  constructor(status, message, type) {
    super(redact(message));
    this.status = status;
    this.type = type;
  }
}

// Shared Payment Tokens are a preview feature with their own API version (docs/research/AGENTIC-COMMERCE.md).
const SPT_VERSION = "2026-09-30.preview";

export function isSharedPaymentToken(value) {
  return typeof value === "string" && /^spt_[A-Za-z0-9_]{6,200}$/.test(value);
}

async function stripeFetch(env, method, path, params, idempotencyKey, version = STRIPE_VERSION) {
  const headers = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    "Stripe-Version": version,
  };
  let body;
  if (params) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(params).toString();
  }
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const res = await fetch(API + path, { method, headers, body });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const err = data && data.error;
    throw new StripeError(res.status, (err && err.message) || `HTTP ${res.status}`, err && err.type);
  }
  return data;
}

// Creates a hosted Checkout Session for the one product. Returns { id, url, expiresAt }.
export async function createCheckoutSession(env, { orderId, origin }) {
  const expiresAt = Math.floor(Date.now() / 1000) + 31 * 60; // Stripe minimum is 30 minutes
  const s = await stripeFetch(env, "POST", "/checkout/sessions", {
    mode: "payment",
    "line_items[0][price_data][currency]": PRODUCT.currency,
    "line_items[0][price_data][unit_amount]": String(PRODUCT.unitAmountCents),
    "line_items[0][price_data][product_data][name]": PRODUCT.name,
    "line_items[0][quantity]": "1",
    success_url: `${origin}/`,
    cancel_url: `${origin}/`,
    // Card only, and no Link: Link's "save my information" opt-in added a required
    // phone-number field that blocked agent run 4 (see DECISIONS D22). With API
    // 2026-09-30.endive+ `payment_method_types` is no longer accepted; these are the
    // documented replacements.
    "allowed_payment_method_types[0]": "card",
    "wallet_options[link][display]": "never",
    client_reference_id: orderId,
    "metadata[order_id]": orderId,
    expires_at: String(expiresAt),
  }, `create-${orderId}`);
  if (s.livemode) throw new StripeError(500, "Stripe returned a LIVE session. Refusing.", "live_mode");
  return { id: s.id, url: s.url, expiresAt: expiresAt * 1000 };
}

// Charges a Shared Payment Token for the one product, exactly once (Stripe enforces single use
// and the token's own amount cap). Returns { id, status, amount, currency, livemode }.
export async function chargeSharedPaymentToken(env, { orderId, token }) {
  const pi = await stripeFetch(env, "POST", "/payment_intents", {
    amount: String(PRODUCT.unitAmountCents),
    currency: PRODUCT.currency,
    "payment_method_data[shared_payment_granted_token]": token,
    confirm: "true",
    description: PRODUCT.name,
    "metadata[order_id]": orderId,
  }, `pay-${orderId}`, SPT_VERSION);
  if (pi.livemode) throw new StripeError(500, "Stripe returned a LIVE PaymentIntent. Refusing.", "live_mode");
  return { id: pi.id, status: pi.status, amount: pi.amount, currency: pi.currency, livemode: pi.livemode };
}

// SANDBOX ONLY: creates a test Shared Payment Token for a visiting agent with Stripe's test
// helper (test card, limited to exactly the product price, short expiry). This is circular by
// design (the store's sandbox pays itself) and exists only so visiting agents can try the
// on-page payment flow (docs/DECISIONS.md D29). It can only work with a test key.
export async function createTestSharedPaymentToken(env, { minutes = 15 } = {}) {
  if (!isTestKey(env.STRIPE_SECRET_KEY)) throw new StripeError(500, "Test tokens need a Stripe test key.", "not_test");
  const t = await stripeFetch(env, "POST", "/test_helpers/shared_payment/granted_tokens", {
    payment_method: "pm_card_visa",
    "usage_limits[currency]": PRODUCT.currency,
    "usage_limits[max_amount]": String(PRODUCT.unitAmountCents),
    "usage_limits[expires_at]": String(Math.floor(Date.now() / 1000) + minutes * 60),
  }, null, SPT_VERSION);
  if (t.livemode) throw new StripeError(500, "Stripe returned a LIVE token. Refusing.", "live_mode");
  return { token: t.id, expiresAt: Date.now() + minutes * 60 * 1000 };
}

// Returns the fields we need from a PaymentIntent.
export async function getPaymentIntent(env, id) {
  const pi = await stripeFetch(env, "GET", `/payment_intents/${encodeURIComponent(id)}`, null, null, SPT_VERSION);
  return {
    id: pi.id,
    status: pi.status, // succeeded | processing | requires_action | requires_payment_method | canceled | ...
    amount: pi.amount,
    currency: pi.currency,
    orderId: pi.metadata && pi.metadata.order_id,
    livemode: pi.livemode,
  };
}

// Returns the fields we need from a Checkout Session.
export async function getCheckoutSession(env, id) {
  const s = await stripeFetch(env, "GET", `/checkout/sessions/${encodeURIComponent(id)}`);
  return {
    id: s.id,
    status: s.status,                 // open | complete | expired
    paymentStatus: s.payment_status,  // paid | unpaid | no_payment_required
    orderId: s.metadata && s.metadata.order_id,
    livemode: s.livemode,
  };
}

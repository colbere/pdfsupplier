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

async function stripeFetch(env, method, path, params, idempotencyKey) {
  const headers = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    "Stripe-Version": STRIPE_VERSION,
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
    client_reference_id: orderId,
    "metadata[order_id]": orderId,
    expires_at: String(expiresAt),
  }, `create-${orderId}`);
  if (s.livemode) throw new StripeError(500, "Stripe returned a LIVE session. Refusing.", "live_mode");
  return { id: s.id, url: s.url, expiresAt: expiresAt * 1000 };
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

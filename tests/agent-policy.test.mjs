// Spending-rule tests for the owner's agent (agent/policy.mjs). Run: node --test tests/
// The rule is the agent's only safeguard (no human confirmation), so it must fail closed.
import test from "node:test";
import assert from "node:assert/strict";
import { makePolicy } from "../agent/policy.mjs";

const STRIPE_PAGE = "https://checkout.stripe.com";
const payTool = { origin: "https://js.stripe.com", annotations: { consequentialHint: true } };
const summaryTool = {};
const mk = () =>
  makePolicy({ storeOrigin: "http://localhost:8787", maxCents: 100, currency: "usd", maxPurchases: 1, requireTestMode: true });
const summary = (over = {}) =>
  JSON.stringify({
    content: [{ type: "text", text: JSON.stringify({ livemode: false, currency: "usd", totalAmount: 100, recurring_or_may_have_future_charges: false, ...over }) }],
  });
const runTool = (value, kind = "ok") => async () => ({ kind, value });
const check = (p, { value = summary(), page = STRIPE_PAGE, tool = payTool, sum = summaryTool, kind } = {}) =>
  p.checkPayment({ tool, pageOrigin: page, summaryTool: sum, runTool: runTool(value, kind) });

test("allows exactly $1.00 USD in test mode on Stripe Checkout", async () => {
  assert.equal((await check(mk())).ok, true);
});

for (const [label, opts] of [
  ["over the limit ($1.01)", { value: summary({ totalAmount: 101 }) }],
  ["live mode", { value: summary({ livemode: true }) }],
  ["livemode missing", { value: summary({ livemode: undefined }) }],
  ["another currency", { value: summary({ currency: "eur" }) }],
  ["recurring charges", { value: summary({ recurring_or_may_have_future_charges: true }) }],
  ["a non-integer amount", { value: summary({ totalAmount: "100" }) }],
  ["the wrong page", { page: "https://evil.example" }],
  ["a tool from another origin", { tool: { ...payTool, origin: "https://evil.example" } }],
  ["no order-summary tool", { sum: null }],
  ["an unreadable summary", { value: "not json" }],
  ["a summary that timed out", { kind: "timeout" }],
]) {
  test(`refuses ${label}`, async () => {
    assert.equal((await check(mk(), opts)).ok, false);
  });
}

test("allows only one purchase per run", async () => {
  const p = mk();
  assert.equal((await check(p)).ok, true);
  assert.equal((await check(p)).ok, false);
});

test("only consequential tools need the payment check", () => {
  const p = mk();
  assert.equal(p.needsPaymentCheck(payTool), true);
  assert.equal(p.needsPaymentCheck({ annotations: { consequentialHint: false } }), false);
  assert.equal(p.needsPaymentCheck({ annotations: {} }), false);
});

test("only the store and Stripe are allowed", () => {
  const p = mk();
  assert.equal(p.isAllowedPage("http://localhost:8787"), true);
  assert.equal(p.isAllowedPage("https://checkout.stripe.com"), true);
  assert.equal(p.isAllowedPage("https://evil.example"), false);
  assert.equal(p.isAllowedToolOrigin("https://js.stripe.com"), true);
  assert.equal(p.isAllowedToolOrigin("https://pay.google.com"), false);
});

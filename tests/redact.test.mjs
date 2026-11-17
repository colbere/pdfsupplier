// node --test tests/redact.test.mjs
// redact() must strip keys, payment tokens and checkout URLs before text reaches a log or a tool
// result (docs/SECURITY.md: "Never logged"). Uses made-up values only.
import test from "node:test";
import assert from "node:assert/strict";
import { redact, StripeError } from "../src/stripe.js";

const FAKE_SPT = "spt_" + "1TestOnlyNotARealToken_abc123";
const FAKE_KEY = "rk_" + "test_" + "A".repeat(24);

test("strips Shared Payment Tokens", () => {
  const out = redact(`No such shared_payment_granted_token: '${FAKE_SPT}'`);
  assert.ok(!out.includes("spt_"), out);
  assert.match(out, /\[REDACTED_TOKEN\]/);
});

test("strips several tokens and keeps the rest of the message", () => {
  const out = redact(`a ${FAKE_SPT} b ${FAKE_SPT}x c`);
  assert.equal(out, "a [REDACTED_TOKEN] b [REDACTED_TOKEN] c");
});

test("still strips keys and checkout URLs", () => {
  const out = redact(`key ${FAKE_KEY} url https://checkout.stripe.com/c/pay/cs_test_x#frag end`);
  assert.ok(!out.includes("rk_test_"), out);
  assert.ok(!out.includes("checkout.stripe.com"), out);
  assert.match(out, /\[REDACTED_KEY\]/);
  assert.match(out, /\[REDACTED_URL\]/);
});

test("leaves ordinary text alone", () => {
  assert.equal(redact("Your card was declined."), "Your card was declined.");
  assert.equal(redact("respect_the_limits and inspt_ words"), "respect_the_limits and inspt_ words");
});

test("StripeError messages are redacted at creation", () => {
  const e = new StripeError(400, `Token ${FAKE_SPT} has already been used.`, "invalid_request_error");
  assert.ok(!e.message.includes("spt_"), e.message);
});

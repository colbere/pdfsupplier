// The agent's TEST wallet for the Shared Payment Token route (docs/DECISIONS.md D28).
//
// Testing shortcut: a real agent would get an SPT from its own Stripe account or from a
// person's Link agent wallet, addressed to this store. Here we use Stripe's sandbox test
// helper, which "generates an SPT without an agent", with the store's own TEST key.
// The token carries its own limit (amount, currency, expiry) and Stripe enforces single use.

const SPT_VERSION = "2026-09-30.preview";

export async function createTestToken({ stripeKey, maxCents, currency, minutes = 15 }) {
  if (!/^(rk|sk)_test_/.test(stripeKey || "")) throw new Error("The test wallet only works with a Stripe TEST key.");
  const res = await fetch("https://api.stripe.com/v1/test_helpers/shared_payment/granted_tokens", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      "Stripe-Version": SPT_VERSION,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      payment_method: "pm_card_visa",
      "usage_limits[currency]": currency,
      "usage_limits[max_amount]": String(maxCents),
      "usage_limits[expires_at]": String(Math.floor(Date.now() / 1000) + minutes * 60),
    }).toString(),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.id?.startsWith("spt_")) {
    const msg = String(data?.error?.message || `HTTP ${res.status}`).replace(/(sk|rk)_(test|live)_\S+/g, "[KEY]");
    throw new Error(`Could not create a test Shared Payment Token: ${msg}`);
  }
  if (data.livemode) throw new Error("Stripe returned a LIVE token. Refusing.");
  return { token: data.id, limits: data.usage_limits };
}

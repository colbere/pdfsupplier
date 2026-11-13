# DECISIONS

Each design decision, the alternatives considered, and the reason. Newest at the bottom.

---

## D1. Backend: Cloudflare Worker, run locally with Wrangler
- **Date:** 2026-11-13
- **Decision:** One Cloudflare Worker serves the homepage and the API. It runs locally with `wrangler dev` (http://localhost:8787). Wrangler is installed per project as a dev dependency, not globally.
- **Alternatives:** A Node/Express server, which is familiar but doesn't match the planned Phase 2 deployment target.
- **Reason:** Suggested in the brief. It runs fully locally, has few dependencies and deploys easily later. Cloudflare recommends a per-project Wrangler install.

## D2. Storage: a Durable Object instead of Workers KV
- **Date:** 2026-11-13
- **Decision:** Keep codes, sessions, failed-attempt counters, orders and download tokens in a single **Durable Object**, using its built-in storage.
- **Alternatives:** Workers KV, as the brief suggested.
- **Reason:** Cloudflare's KV docs say KV is eventually consistent (changes "may take up to 60 seconds or more to be visible"), not atomic, and limited to 1 write per second per key. They say "If you need stronger consistency guarantees, consider using Durable Objects." Our security features need atomic read-then-write: single-use codes, lockout counters, single-use download links and "mark delivered". A Durable Object handles requests one at a time, so two simultaneous requests can't both use the same code. It also runs fully locally under `wrangler dev`. The user approved this change on 2026-11-13.

## D3. Stripe keys: test keys only; restricted keys preferred
- **Date:** 2026-11-13
- **Decision:** The server starts only if `STRIPE_SECRET_KEY` begins with `rk_test_` (preferred) or `sk_test_`. Anything else, including `sk_live_`, `rk_live_`, an empty value or a placeholder, makes it refuse to start. The docs recommend creating a restricted key with only the permissions we need: Checkout Sessions write and read.
- **Alternatives:** Accept only `sk_test_`, as the brief's hard rule 1 says.
- **Reason:** Stripe's docs recommend restricted keys "especially when giving a key to an AI agent." A restricted key limits the damage if it leaks. Live keys are still always refused, so the intent of hard rule 1 (test mode only) is kept. The user approved this change on 2026-11-13.

## D4. Call the Stripe REST API with `fetch`
- **Date:** 2026-11-13
- **Decision:** No Stripe SDK. Form-encoded `fetch` calls to `https://api.stripe.com/v1/checkout/sessions`, pinned to a `Stripe-Version` header (currently `2026-10-28.endive`).
- **Alternatives:** The official `stripe` npm package.
- **Reason:** We only need two calls (create and retrieve), and this keeps dependencies minimal as the brief asks. Pinning the version keeps the behaviour stable.

## D5. Session cookie always has `Secure`, even on localhost
- **Date:** 2026-11-13
- **Decision:** The cookie is `HttpOnly; Secure; SameSite=Strict; Path=/`.
- **Reason:** MDN: "The `https:` requirements are ignored when the `Secure` attribute is set by localhost." So one cookie setting works both locally and once deployed. To be confirmed in Chrome DevTools during Step 3.

## D6. `sign_in` returns one generic error for every failure
- **Date:** 2026-11-13
- **Decision:** A wrong code, expired code, reused code, lockout and kill switch all return the same message.
- **Alternatives:** Chrome's best-practices page recommends descriptive errors so the model can recover.
- **Reason:** Specific errors would tell an attacker which codes are close to valid and when the lockout lifts. The brief's section 7 requires a generic error. Every other tool returns specific, helpful errors as Chrome recommends.

## Pending
- `create_checkout` annotations (brief section 6): to be decided and recorded in Step 5.

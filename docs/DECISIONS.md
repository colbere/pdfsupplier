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

## D7. Kill switch is a stored flag, toggled by an admin command
- **Date:** 2026-11-13 (Step 3)
- **Decision:** `npm run kill-switch -- on|off|status`. Turning it on stores a flag in the Durable Object and **immediately deletes every session and the active code**. While it's on, sign-in fails, `new-code` is refused, and every session check fails. Turning it off does not bring old sessions back.
- **Alternatives:** A `KILL_SWITCH` environment variable, which was in the first `.env.example`.
- **Reason:** The brief allows either. An environment variable only takes effect when the server restarts, and it can't delete sessions at the moment it's switched on. A stored flag acts instantly and would work the same way after deployment (no redeploy needed).

## D8. Codes: 15 characters, one active at a time, SHA-256 hashed
- **Date:** 2026-11-13 (Step 3)
- **Decision:** Alphabet `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` (32 characters, no 0/O/1/I, upper-case only so no l). 15 characters, which is 75 bits, generated with rejection sampling. Shown as `XXXXX-XXXXX-XXXXX`. Input is normalised (case-insensitive, spaces and dashes ignored). Only `SHA-256("pdfs-code:" + code)` is stored. **A new code replaces the previous one**, so at most one code is valid. Expiry is 10 minutes and the code is deleted on first successful use.
- **Alternatives:** The brief's minimum of 12 characters (60 bits). A slow password hash such as PBKDF2.
- **Reason:** With only 5 guesses per 15 minutes, 75 bits is far beyond guessable. A slow hash is meant to protect *low-entropy* human passwords, so it adds nothing for a random 75-bit code. One active code keeps the constant-time comparison simple (compare against one stored hash) and limits exposure.

## D9. Admin API protected by a generated `ADMIN_TOKEN`
- **Date:** 2026-11-13 (Step 3)
- **Decision:** The terminal commands call `/admin/*` on the local server with `Authorization: Bearer <ADMIN_TOKEN>`. `npm run setup` generates the token (256 bits) into `.env` and never prints it. The server compares SHA-256 digests in constant time. If the token is missing or short, admin routes return 503.
- **Alternatives:** Have the script write directly into Wrangler's local Durable Object storage files (fragile, and not possible once deployed). Generate the code on the server and return it over HTTP (the code would then travel over the network).
- **Reason:** Only the **hash** of the code leaves the terminal, so the code itself "never appears anywhere else" (brief section 7). The same mechanism works after deployment.

## D10. `npm run unlock` clears lockouts (small addition to the brief)
- **Date:** 2026-11-13 (Step 3)
- **Decision:** An admin command that deletes the failed-attempt counters.
- **Reason:** The global lockout means a stranger could lock the owner out for 15 minutes on purpose (see Q13). This lets the owner recover immediately. It also lets the tests reset state.
- **Note:** The brief sets both the per-IP and the global limit at 5 per 15 minutes. With equal limits, the global counter always trips first, so the per-IP limit never independently blocks. It is kept because it matters if the global limit is raised later (Phase 2, Q13).

## D11. Sessions stored as hashes; extra Origin check; `__Host-` cookie
- **Date:** 2026-11-13 (Step 3)
- **Decision:**
  - Session token: 32 random bytes (256 bits), base64url. The server stores only `SHA-256("pdfs-session:" + token)`, so reading the storage doesn't reveal usable tokens.
  - Cookie: `__Host-pdfs_session=...; Path=/; Secure; HttpOnly; SameSite=Strict`. This is D5 plus the `__Host-` prefix, which makes the browser reject the cookie unless it is Secure, has `Path=/` and has no `Domain`.
  - No `Max-Age`, so it's a browser-session cookie. The server enforces the 30-minute inactivity limit on every check.
  - `POST /api/sign-in` refuses any request whose `Origin` header is another site (403), on top of `SameSite=Strict`.
- **Reason:** Defence in depth. Each layer is cheap.

## D12. `create_checkout` annotations: `readOnlyHint: false`, `consequentialHint: false`
- **Date:** 2026-11-13 (Step 5)
- **Decision:** Not read-only (it creates an order and a Stripe session), and not consequential.
- **Alternatives:** `consequentialHint: true`.
- **Reason:** It spends nothing and can be repeated or abandoned freely: an unpaid Checkout Session just expires. The irreversible step is Stripe's own payment-submit tool, which Stripe marks `consequentialHint`. Marking ours consequential as well would make the extension ask twice for one purchase and dilute the meaning of the hint. Because it isn't read-only, the extension still shows an Allow / Don't allow prompt for it (per its README), unless the user has turned those alerts off.
- Other Step 5 tools: `check_order` is `readOnlyHint: true` (per the brief; it only records a paid status that Stripe already reports). `get_download` is `readOnlyHint: false, consequentialHint: false` (per the brief).

## D13. Download link: needs the session cookie too; order marked delivered when the link is issued
- **Date:** 2026-11-13 (Step 5)
- **Decision:**
  - `get_download` returns `/download/<token>`: 256-bit random, only its hash stored, single use, expires after 5 minutes.
  - `GET /download/<token>` **also requires the same signed-in session** that requested the link. A request without it gets 401 and **does not use up** the token.
  - The order is marked `delivered` when the link is issued, as the brief says, so a second `get_download` for the same order is refused.
- **Alternatives:** Treat the token alone as enough (a "capability URL"), with no cookie.
- **Reason:** Hard rule 4: every purchase-related endpoint verifies the session on the server. **Risk:** if the extension fetches the link from a context that doesn't send our `SameSite=Strict` cookie, the download will fail with 401. That would be a useful finding for Q5. Relaxing to token-only is the first fix to try, **and needs the user's OK** because it changes rule 4's application.
- **Known gap (brief's design):** because "delivered" is set when the link is issued, an agent that can't fetch the link has no way to get another. For Phase 1 this is recorded rather than changed.

## D14. One open order at a time per session; at most 5 orders per session
- **Date:** 2026-11-13 (Step 5)
- **Decision:** If the session has an unpaid order whose Stripe page is still valid for more than 2 minutes, `create_checkout` returns that order again (with `reused: true`) instead of creating a new Stripe session. Each session can create at most 5 orders. Stripe create calls use an `Idempotency-Key` (`create-<order_id>`).
- **Reason:** Agents retry. Chrome's best-practices page recommends rejecting duplicate submissions. The cap bounds how many Stripe sessions one sign-in can create.

## D15. Stripe Checkout Session details
- **Date:** 2026-11-13 (Step 5)
- **Decision:**
  - Hosted Checkout (default `ui_mode`), `mode=payment`, one line item with inline `price_data` (usd, 100 cents, product name "The PDF Supplier: one PDF"), quantity 1.
  - `success_url` and `cancel_url` are the homepage.
  - `metadata[order_id]` and `client_reference_id` are both set to the order ID.
  - `expires_at` is 31 minutes from creation (Stripe's minimum is 30).
  - Paid means: `payment_status == "paid"` **and** `metadata.order_id` matches **and** the Stripe session ID matches the one stored **and** `livemode == false`.
  - Any text that might contain a key or Stripe URL is passed through a redaction function before logging. The Stripe URL is never logged.
- **Reason:** These follow the brief's section 8. The extra ID and livemode checks are cheap and close off mix-ups.

## D17. Pre-commit secret guard; pushing disabled on the extension clone
- **Date:** 2026-11-13 (Step 6, at the user's request: "ensure no sensitive data is being shared or exposed, and can't be exposed in the future")
- **Decision:**
  - `scripts/git-hooks/pre-commit`, enabled by `npm run setup` (`git config core.hooksPath scripts/git-hooks`). It refuses a commit if the staged changes contain:
    - any `.env*` or `.dev.vars*` file except `.env.example`;
    - a Stripe or Anthropic key-shaped string (`(sk|rk)_(live|test)_…`, `sk-ant-…`, `whsec_…`);
    - the exact value of any secret in `.env`.
  - It never prints values.
  - The same hook is enabled on the extension clone (`c:\claude\webmcp-extension`). That clone's push URL is set to `DISABLED-never-push-this-clone`, because it is Google's repository and must never receive our commits.
- **Alternatives:** Rely on `.gitignore` alone (bypassed by `git add -f`, or by pasting a key into a tracked file). Third-party scanners such as gitleaks (another dependency).
- **Reason:** It's a cheap, local, dependency-free second layer. A git hook can be skipped with `--no-verify`, so for the public repo GitHub's push protection is a useful third layer (see the note in LOG.md).

## D16. "Refuse to start" in two layers
- **Date:** 2026-11-13 (Step 5)
- **Decision:**
  1. `npm run dev` runs `scripts/check-env.mjs` first (npm's `predev` hook). Unless the key matches `^(rk|sk)_test_[A-Za-z0-9]{16,}$` (and isn't the placeholder), it exits with an error and Wrangler never starts.
  2. The Worker checks the same rule on **every request** and answers 503 to everything if it fails.
- **Reason:** A Worker has no "on startup" hook, and someone could run `npx wrangler dev` directly to skip npm's check. Layer 2 makes the server unusable without a test key either way.

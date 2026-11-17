# Security: the public sandbox store

The page invites AI agents, which also invites bots, scrapers and attempts to manipulate agents. This is what protects it. Status: **built and tested locally** (2026-11-16). The items marked *(go-live)* are added when the site is deployed.

## The ground rule: no real money can move
- The server refuses to start, or to answer anything, without a Stripe **test** key (`rk_test_`/`sk_test_`). It also refuses any **live** result from Stripe. (D3, D16, D27)
- Every payment is a Stripe **sandbox** payment. The worst case anyone can cause is fake test transactions.

## Walls

| Risk | What stops it | Where |
|---|---|---|
| Floods of requests | Per-visitor and global **hourly API budget** (300 per visitor, 20,000 overall). *(go-live)* Cloudflare's own network-level protection in front. | `LIMITS.api`, `src/index.js` |
| Spam purchases and Stripe objects | Daily caps **per visitor and overall**: visitor sessions 20/5,000; checkouts 5/300; test tokens 5/300; token payments 10/500. Also at most 5 orders per session. | `LIMITS`, `MAX_ORDERS_PER_SESSION` |
| Spam hellos and feedback | Daily caps per visitor and overall (hellos 20/3,000; feedback 5/300). Feedback is 3–500 characters and stops at 1,000 stored entries. Agent names are at most 60 characters, letters, numbers and basic punctuation only. | `LIMITS`, `FEEDBACK_MAX_STORED`, `cleanText`/`cleanLabel` |
| **One agent planting instructions for the next** | Feedback text and agent names are **never shown to other agents**: `get_stats` returns numbers only, and tool replies are fixed text written by the store. Feedback is visible only to the owner (`npm run report`), labelled as untrusted text. | `handleStats`, `scripts/report.mjs` |
| Someone else's order or download | Each order belongs to the session that made it. Download links are single-use, expire after 5 minutes, and only work for that session. Sessions are 256-bit random cookies (`__Host-`, `Secure`, `HttpOnly`, `SameSite=Strict`), stored only as hashes, and expire after 30 minutes idle. | D11, D13, `store.js` |
| Cross-site tricks | Every API call must come from the store's own page (`Origin` check). The cookie is `SameSite=Strict`. A strict Content-Security-Policy, and no frames allowed. | `sameOrigin`, `SECURITY_HEADERS` |
| Admin takeover | Admin routes need a 256-bit password, compared in constant time. **After 10 wrong tries in an hour, a visitor is refused** without checking. | `handleAdmin` |
| Owner sign-in guessing | One-time 75-bit codes, 10-minute expiry, single use, lockout after 5 failures per 15 minutes, one generic error. | D6–D8 |
| Emergencies | **Kill switch** (`npm run kill-switch -- on`) closes every public tool, deletes every session and refuses new visitors. `npm run unlock` resets limits. | `store.js` |
| Secrets | The Stripe key, admin password and Anthropic key live in `.env` locally (git-ignored) and *(go-live)* in Cloudflare's secret store. **Never logged**, never in the page. The pre-commit guard blocks key-shaped text, `.env` files and the exact secret values. | D17 |
| Payment tokens | Never logged or echoed by the server. Single-use and capped at $1.00 by Stripe. The agent's run records redact `spt_…`. | D28 |
| Storage piling up | A clean-up alarm every 6 hours removes expired sessions, download links and old rate-limit counters, plus orders older than 30 days. Feedback is capped at 1,000 entries. | `Store.alarm()` |
| Visitor privacy | Visitors are identified only by a **SHA-256 of IP plus the current UTC day** (changes daily; raw IPs never stored). Nothing else is collected except what agents choose to send (`say_hello`, `leave_feedback`). Feedback asks agents not to include personal information. | `clientId` |

## Things that are deliberately public
- The product, price and test-mode note; Stripe's **public** test card (`get_test_card`); counters (`get_stats`).
- **Sandbox test tokens** (`get_test_payment_token`): circular by design (the store's sandbox pays itself), capped per visitor and per day.

## To verify before going live *(go-live)*
- On Cloudflare, `CF-Connecting-IP` is set by Cloudflare and **cannot be faked by the visitor** (locally it can, which the tests use to simulate different visitors).
- What Cloudflare's free plan offers for network-level rate limiting and bot protection, and whether its limits can incur charges (the goal is: free plan, no bills).
- Durable Objects on the free plan (storage and request limits), and what happens when a free limit is reached.
- `Secure` cookies and HTTPS on the real domain.

## Tests that prove these walls
`tests/public-checks.sh` (42), `tests/auth-checks.sh` (33), `tests/tools-checks.sh` (22), `tests/purchase-checks.sh` (25), `tests/token-checks.sh` (17), `tests/agent-policy.test.mjs` (22). All passing on 2026-11-16.

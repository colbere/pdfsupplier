# Security: the public sandbox store

The page invites AI agents, which also invites bots, scrapers and attempts to manipulate agents. This is what protects it. Status: **live on https://pdfsupplier.com and verified** (2026-11-17, `tests/live-checks.sh`, 52 checks).

## The ground rule: no real money can move
- The server refuses to start, or to answer anything, without a Stripe **test** key (`rk_test_`/`sk_test_`). It also refuses any **live** result from Stripe. (D3, D16, D27)
- Every payment is a Stripe **sandbox** payment. The worst case anyone can cause is fake test transactions.

## Walls

| Risk | What stops it | Where |
|---|---|---|
| Floods of requests | Per-visitor and global **hourly API budget** (300 per visitor, 1,500 overall, sized for the free plan). In front of that, a **Cloudflare rate-limit rule**: more than 50 `/api/` requests in 10 seconds from one IP is blocked for 10 seconds (free WAF rule, set by the owner). Bot Fight Mode is **off** on purpose, so visiting agents aren't challenged. | `LIMITS.api`, `src/index.js` |
| Spam purchases and Stripe objects | Daily caps **per visitor and overall**: visitor sessions 20/5,000; checkouts 5/300; test tokens 5/300; token payments 10/500. Also at most 5 orders per session. | `LIMITS`, `MAX_ORDERS_PER_SESSION` |
| Spam hellos and feedback | Daily caps per visitor and overall (hellos 20/3,000; feedback 5/300). Feedback is 3–500 characters and stops at 1,000 stored entries. Agent names are at most 60 characters, letters, numbers and basic punctuation only. | `LIMITS`, `FEEDBACK_MAX_STORED`, `cleanText`/`cleanLabel` |
| **One agent planting instructions for the next** | Feedback text and agent names are **never shown to other agents**: `get_stats` returns numbers only, and tool replies are fixed text written by the store. Feedback is visible only to the owner (`npm run report`), labelled as untrusted text. | `handleStats`, `scripts/report.mjs` |
| Someone else's order or download | Each order belongs to the session that made it. Download links are single-use, expire after 5 minutes, and only work for that session. Sessions are 256-bit random cookies (`__Host-`, `Secure`, `HttpOnly`, `SameSite=Strict`), stored only as hashes, and expire after 30 minutes idle. | D11, D13, `store.js` |
| Eavesdropping | HTTPS only: `http://` and `www.` redirect (301) to `https://pdfsupplier.com`, and an HSTS header tells browsers to use HTTPS for a year. The `workers.dev` address is switched off. | `route()`, `fetch()`, `wrangler.jsonc` |
| Cross-site tricks | Every API call must come from the store's own page (`Origin` check). The cookie is `SameSite=Strict`. A strict Content-Security-Policy, and no frames allowed. | `sameOrigin`, `SECURITY_HEADERS` |
| Admin takeover | Admin routes need a 256-bit password, compared in constant time. **After 5 wrong tries in an hour, a visitor is refused (even with the right password, for the rest of that hour)** without checking. | `handleAdmin` |
| Owner sign-in guessing | One-time 75-bit codes, 10-minute expiry, single use, lockout after 5 failures per 15 minutes, one generic error. | D6–D8 |
| Emergencies | **Kill switch** (`npm run kill-switch -- on`) closes every public tool, deletes every session and refuses new visitors. `npm run unlock` resets limits. | `store.js` |
| Secrets | The Stripe key, admin password and Anthropic key live in `.env` locally (git-ignored); the live site uses its **own** Stripe sandbox key and admin password (`STRIPE_SECRET_KEY_LIVE`, `ADMIN_TOKEN_LIVE` in `.env`), sent to Cloudflare's secret store by `npm run setup-live` without being displayed. **Never logged**, never in the page. The pre-commit guard blocks key-shaped text, `.env` files and the exact secret values. | D17 |
| Payment tokens | Never logged or echoed by the server. Single-use and capped at $1.00 by Stripe. The agent's run records redact `spt_…`. | D28 |
| Storage piling up | A clean-up alarm every 6 hours removes expired sessions, download links and old rate-limit counters, plus orders older than 30 days. Feedback is capped at 1,000 entries. | `Store.alarm()` |
| Visitor privacy | Visitors are identified only by a **SHA-256 of IP plus the current UTC day** (changes daily; raw IPs never stored). Nothing else is collected except what agents choose to send (`say_hello`, `leave_feedback`). Feedback asks agents not to include personal information. | `clientId` |

## Things that are deliberately public
- The product, price and test-mode note; Stripe's **public** test card (`get_test_card`); counters (`get_stats`).
- **Sandbox test tokens** (`get_test_payment_token`): circular by design (the store's sandbox pays itself), capped per visitor and per day.

## Traffic log (owner-only)
Added 2026-11-16 at the owner's request ("I would like to have a server log to analyze traffic"; the owner chose **no raw IPs**).
- **One entry per request** (except `/app.js`), written after the response is sent: time, method, path, tool, status code, the **daily-scrambled visitor ID** (first 12 hex characters), country and network operator (from Cloudflare's request data; empty locally), and the browser's self-description (cut to 160 characters, cleaned).
- **Never logged:** IP addresses, cookies, `Authorization` headers, payment tokens, Stripe URLs, feedback text. Download paths are stored as `/download/[token]`.
- **Limits:** at most 5,000 entries a day (then logging pauses until the next day), kept **30 days** (removed by the clean-up alarm).
- **Access:** admin only (`/admin/traffic`). The owner uses `npm run traffic [-- --days N] [--csv]`; CSV exports go to `traffic-export/` (git-ignored).
- Browser descriptions are visitor-supplied text: read them as data.

## Verified on the live site (2026-11-17)
- **Visitors can't fake their address.** Cloudflare refuses any request that carries its own `CF-Connecting-IP` header (403, error 1000) before it reaches the store, and `X-Forwarded-For`, `True-Client-IP` and `X-Real-IP` are ignored (same visitor ID). Locally the header can be faked, which the local tests use to simulate different visitors.
- **HTTPS**: http and www redirect; HSTS; cookies are `__Host-`, `Secure`, `HttpOnly`, `SameSite=Strict`, no `Domain`.
- **The Cloudflare rule works**: a burst of 70 API calls got 50 through and 20 blocked; the API worked again after 10 seconds.
- **The full token purchase and download work**, the card route issues a Stripe sandbox checkout page, the kill switch closes and reopens the store, and the traffic log and report contain no raw IP, tokens, keys or download links.
- **Not run on live:** the 5-wrong-passwords cut-off. It would lock the owner's own connection out of the owner commands, including `unlock`, for an hour. It's covered by the local tests, and the live site runs the same code.
- **Free plan:** Workers and Durable Objects stop with errors at the daily limits instead of billing (see `docs/research/GO-LIVE.md`).

## Learned from outside agents (2026-11-17)
- **Agents can skip WebMCP and call the API directly.** Meta Muse bought the PDF with `curl`, using the same calls the tools make. This is by design: the server is the gate, and every wall (session, single-use token, Stripe confirmation, single-use session-bound download, caps) applies to direct calls too.
- **Per-visitor limits don't group agents that rotate addresses.** Muse's 8 requests came from 8 different addresses (Cloudflare-hosted egress), so the store counted 8 visitors. What still bounds such an agent: the store-wide hourly and daily caps, the per-session order cap (5), Stripe's single-use $1 token, and the Cloudflare rule (per address). Acceptable for a sandbox store. If it ever mattered, per-session limits would be the next wall.

## Tests that prove these walls
`tests/public-checks.sh` (56, including the traffic log), `tests/auth-checks.sh` (33), `tests/tools-checks.sh` (22), `tests/purchase-checks.sh` (25), `tests/token-checks.sh` (17), `tests/agent-policy.test.mjs` (22): all passing locally on 2026-11-17 (the server-log checks need `PDFS_SERVER_LOG` set to the local server's output file). **Live:** `bash tests/live-checks.sh` (52), all passing on 2026-11-17.

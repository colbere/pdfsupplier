# Research: going live (Cloudflare and Chrome's WebMCP origin trial)

**Date:** 2026-11-16. Sources: Cloudflare and Chrome docs read the same day (URLs at the end), plus the WebMCP origin-trial registration page as pasted by the owner. *Unverified* marks anything not confirmed on a page.

## Chrome's WebMCP origin trial

**Will I be accepted?** Very likely, because it isn't an application. Chrome's guide: "Origin trials are public and open to all developers." You fill in the Register form; nothing in the docs mentions a review or approval step. (The register page itself is rendered by script and couldn't be read by the fetch tool, so "token issued immediately" is *unverified*, but that is how origin-trial registration normally works.)

From the registration page the owner pasted (authoritative for this trial):
- **Available Chrome 149 to 162; end date Mar 29, 2027.** After that, WebMCP on the live site stops working for ordinary visitors unless Chrome ships it or extends the trial.
- Options: "Third-party matching" (not needed) and "**match all subdomains**" (tick it, so `www.` and the bare domain both work).
- "Expected usage: page views per day": a small number (this is a hobby experiment).
- Acknowledgements: experimental, may change, may disappear; may be disabled if used on more than **1%** of Chrome page loads (Chrome's general guide says 0.5% for most trials; this trial's page says 1%). This is irrelevant at this site's scale. Use feature detection: **the page already does** (`if (!document.modelContext) return`).
- Google will email reminders and feedback requests. Chrome's guide: tokens are valid **six weeks**, then renewed by submitting feedback.

**How it's deployed:** the token goes in a `<meta http-equiv="origin-trial">` tag or an **`Origin-Trial:` HTTP header**. The plan is to use the header from the Worker. The token is public by design (not a secret). It must match the exact origin (scheme and host), over HTTPS.

**What it enables:** "enable a feature for all users on your origin, without requiring them to toggle any flags" (Chrome 149+ on desktop; not Chrome on iOS). So ordinary Chrome visitors get `document.modelContext`. **Whether a given agent actually uses page tools is up to that agent** (Muse: unconfirmed).

## Cloudflare

### Cost: the free plan errors instead of billing
- **Workers Free:** 100,000 requests/day, 10 ms CPU per request. Over the limit, Cloudflare returns **Error 1027**, not a charge. Only the Paid plan (from $5/month) has overage pricing.
- **Durable Objects on Free:** SQLite-backed objects (what this store uses) **are available**. Free limits per day: **100,000 requests, 13,000 GB-s, 5 million rows read, 100,000 rows written**; **5 GB** total storage (one FAQ says 1 GB, an inconsistency). Over a limit, "further operations of that type will fail with an error", resetting at 00:00 UTC.
- **Domain:** Cloudflare Registrar is "Available on all plans", sold **at cost ("No markup")**, and **needs a payment method** at purchase. Supported TLDs weren't listed on the pages read (.com is *unverified*, but common).
- Whether signing up for the free plan itself needs a card: *unverified*.

### ⚠️ Capacity: the store uses too many storage operations per request
Each request currently makes several separate Durable Object calls (limit check, counters, traffic log, session) and **several writes**. So the free **100,000 storage requests a day** and **100,000 rows written a day** run out after roughly **15,000–25,000 site requests a day** (an estimate). After that, storage errors make the store fail until midnight UTC. **No bill**, but it is an easy way to knock the store offline. **Fix before going live:** combine each request's checks and counters into **one** storage call, and write less (see the plan).

### Security
- **`CF-Connecting-IP`:** Cloudflare sets it ("provides the client IP address connecting to Cloudflare"), but the docs **don't say whether a visitor's own fake value is overwritten**. **Verify on the live site** (send a fake header; check the traffic log's visitor ID doesn't follow it). The **global** caps remain the backstop either way: they bound total test tokens, checkouts and feedback per day no matter who sends them.
- `request.cf.country` and `request.cf.asOrganization` are available on all plans (e.g. "Google Cloud"). These feed the traffic log.
- **Free WAF rate limiting:** **1 rule** per zone, matching on Path (and Verified Bot), counted per IP over **10 s**. Useful as a coarse flood brake in front of `/api/*`.
- **Bot Fight Mode: leave it OFF.** It "issues computationally expensive challenges", "may challenge API or mobile app traffic", and can't be bypassed with custom rules on Free. It could block the very agents this site invites.
- **AI agents:** for new domains, Cloudflare's AI Crawler and Agent policies default to **"Allow (do not block)"** for Search, Agents and Training. Cloudflare "recommends Allow for Personal Agents". Check the dashboard after setup.
- Workers Rate Limiting binding: exists, approximate and per location; free-plan availability *unverified*. Not needed: the store's own Durable Object limits are exact.

### Deployment mechanics
- A custom domain on a Worker needs "an active Cloudflare zone" (domains bought through Cloudflare Registrar use Cloudflare nameservers automatically).
- Secrets: `npx wrangler secret put <KEY>` prompts for the value (typed by the owner into the terminal, never chat). Deploy uses `wrangler login` (browser sign-in) or an API token.

## Sources
- Chrome: developer.chrome.com/blog/ai-webmcp-origin-trial; /docs/web-platform/origin-trials; /docs/web-platform/origin-trial-troubleshooting; /docs/ai/webmcp. Registration page as pasted by the owner. (chromestatus.com and the register page couldn't be read by the fetch tool: script-rendered.)
- Cloudflare: /fundamentals/reference/http-headers/; /workers/runtime-apis/request/; /waf/rate-limiting-rules/; /bots/get-started/bot-fight-mode/; /bots/additional-configurations/block-ai-bots/; /workers/runtime-apis/bindings/rate-limit/; /workers/platform/limits/; /workers/platform/pricing/; /durable-objects/platform/pricing/; /durable-objects/platform/limits/; /durable-objects/api/alarms/; /workers/platform/spend-management/; /workers/configuration/routing/custom-domains/; /registrar/ (+ register-domain); /workers/configuration/secrets/; /workers/wrangler/commands/workers/.

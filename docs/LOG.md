# LOG: The PDF Supplier (Phase 1)

Chronological record of what was done, why, what happened, and what changed. Secrets are always redacted.

---

## 2026-11-13 12:26 (UTC-7): Step 0, environment check and doc verification

### What was done
1. Checked installed software (read-only, nothing installed or changed).
2. Read the current official docs listed in BRIEF.md section 4 and compared them with the brief's assumptions.

### Why
The brief's section 13 starts with Step 0. WebMCP is an origin-trial API that changes often, so the brief's facts must be checked before any code is written.

### 1. Environment

Command (PowerShell): version checks for node, npm, npx, git, wrangler and the Chrome executable.

```
node: v22.19.0
npm: 11.6.2
npx: 11.6.2
git: git version 2.53.0.windows.1
wrangler(global): not installed globally
chrome: 157.0.8103.52  (C:\Program Files\Google\Chrome\Application\chrome.exe)
```

Outcome:
- Node 22.19.0 meets the extension's requirement ("Node.js 22.18 or newer").
- Chrome 157 meets both the WebMCP origin trial (149+) and the extension (155+).
- Wrangler is not installed globally. Cloudflare recommends installing it per project as a dev dependency (`npm i -D wrangler`), not globally, so nothing is missing.
- Not yet checked: whether `chrome://flags/#enable-webmcp-testing` is enabled. The user will do this in Chrome before the agent test.

### 2. Doc findings

Pages read on 2026-11-13. "Last updated" dates are given where the page showed one.

#### WebMCP (Chrome)
Sources:
- https://developer.chrome.com/docs/ai/webmcp (updated 2026-10-07)
- https://developer.chrome.com/docs/ai/webmcp/imperative-api (updated 2026-10-16)
- https://developer.chrome.com/docs/ai/webmcp/secure-tools (updated 2026-09-01)
- https://developer.chrome.com/docs/ai/webmcp/best-practices (updated 2026-10-30)
- https://developer.chrome.com/docs/ai/webmcp/build-tools (updated 2026-10-30)
- https://developer.chrome.com/docs/devtools/application/webmcp

| Brief's assumption | What the docs say | Status |
|---|---|---|
| Entry point is `document.modelContext`; `navigator.modelContext` is deprecated | Every example uses `document.modelContext`. Neither page mentions `navigator.modelContext` or any deprecation. | **Partly confirmed.** Use `document.modelContext`. The deprecation of `navigator.modelContext` is not stated in the docs read. |
| `await registerTool(tool, { signal })` with `name`, `description`, `inputSchema`, `execute(input, { signal })`; abort unregisters | Confirmed. `execute` gets `{ signal }` as its second argument. The examples return **strings**. No `unregisterTool` method. **New:** since Chrome 153, "you can unregister a tool without cancelling and breaking in-flight executions." **New:** a second option, `exposedTo: [origins]`, shares a tool with other origins (we will not use it). | Confirmed, plus additions |
| Annotations: `readOnlyHint`, `untrustedContentHint`, `consequentialHint` | All three confirmed. They go in an `annotations` object on the tool and default to `false`. **New:** a fourth one, `debugging`, from Chrome 156. There is no `destructiveHint`. | Confirmed, plus addition |
| `getTools()` and `executeTool()` exist; JSON-stringified args to `executeTool` deprecated from Chrome 155 | Confirmed. Quote: "JSON stringified input arguments are deprecated from Chrome 155." `executeTool` "returns ... null when a navigation is triggered." | Confirmed |
| Limits: description 500, parameter description 150, names 30, output 1.5K | Confirmed on the secure-tools page, but as **recommendations** ("We recommend the following character limits") that "are subject to change". They are not enforced. | Confirmed (as recommendations) |
| Chrome 149+; enable `chrome://flags/#enable-webmcp-testing` for local dev | Confirmed: origin trial "from Chrome 149"; flag `#enable-webmcp-testing`, then relaunch. | Confirmed |
| Chrome's security page says nothing about authentication or server-side checks | True for the **secure-tools** page alone (it covers prompt injection and cross-origin exposure). But **build-tools** says: "Your application code must check authorization, exact identifiers, known subjects, and sequence safety", and that enforcement "belongs in your application logic, beyond `readOnlyHint` or `untrustedContentHint`." | **Differs.** Chrome does tell developers to enforce authorization in app code, which supports hard rule 4. The specific design (one-time code, sessions, lockout) is still ours. |

Other relevant points:
- **`toolchange` event:** `document.modelContext` fires `toolchange` when the tool list changes. The extension listens for it, so tools registered after sign-in should be picked up "before the next model turn."
- **Permissions Policy:** WebMCP is gated by a `tools` policy that defaults to `self`. A same-origin top-level page needs nothing extra.
- **Best practices that apply to our tools:** one function per tool; descriptive error messages (not generic ones) so the model can recover; "Validate strictly in code, loosely in schema"; idempotency keys to reject duplicate submissions; only report success when it matches real state.
- **Possible tension with hard rule 7:** best-practices advises against generic error messages, but the brief requires one generic error for all sign-in failures. The brief's rule should win for `sign_in`, because a specific message would help an attacker guess codes. Other tools can return specific errors.
- **DevTools:** Application tab, then the **WebMCP** pane. "Available tools" lists the registered tools with invocation counts. "Invoked tools" shows each call's input, output and status. Tools can be run manually from there. We will use this for test-script step 1 and the negative tests.

#### Example Agentic Chrome Extension
Source: https://github.com/GoogleChromeLabs/webmcp-extension/ (last commit 2026-11-10, Apache 2.0, "not an officially supported Google product", "not a production-ready agent").

- Requires **Chrome 155+** (the brief says 149+ for WebMCP in general) and Node 22.18+. Both are met.
- Setup: `cp .env.example .env`, then `npm install`, `npm run server` (model server on `http://localhost:3000`) and `npm run build`. Load `dist/` as an unpacked extension. It runs in Chrome's side panel.
- **Anthropic is supported.** The key goes in the extension repo's own `.env` as `ANTHROPIC_API_KEY=`. The model is set with `MODEL=anthropic:<model-id>`. The code's default Anthropic model is `claude-sonnet-4-5`, an older ID. Per the brief, current IDs will be looked up and the user will choose. Note that `.env.example` ships with `MODEL=google:gemini-3.6-flash` uncommented, so it must be changed or the server will try Google.
- **Confirmation behaviour (important for our annotations):**
  - `readOnlyHint: true`: runs without asking.
  - `readOnlyHint: false`: asks the user (Allow / Don't allow / Allow on site for this chat). This can be turned off in Settings.
  - `consequentialHint: true`: "The user is always asked, even if alerts are off."
  - So `sign_in`, `create_checkout`, `get_download` and `sign_out` will prompt the user unless they are marked read-only (they should not be, because they change state).
- Tool results are capped at **8,000 characters** in the extension. Chrome's recommended 1.5K is still our target.
- **Big open risk:** the README does **not** say the agent can open tabs, navigate to URLs, follow links or download files. It only calls tools the page exposes, and it picks up new tools after a navigation. So it may be unable to go from our `create_checkout` URL to Stripe's page, or to fetch the PDF from the `get_download` link. This is exactly what section 9 asks us to test. Logged in OPEN-QUESTIONS when that file is created.

#### Stripe
Sources: https://docs.stripe.com/agentic-commerce/agents/webmcp, /api/checkout/sessions/create, /api/checkout/sessions/retrieve, /api/checkout/sessions/object, /testing, /keys, /sandboxes, /keys/restricted-api-keys

- **Stripe WebMCP:** supported on "Full page" (hosted Checkout), "Embedded form", "Elements" and the "Hosted invoice page." **No tool names are published.** Stripe says "Don't hard-code tool names, schemas, or assumptions about tool availability." The tools can read the checkout context, select a payment method, fill fields and submit. Stripe sets `consequentialHint` on payment submission and says "get the user's confirmation. Don't interpret the hint itself as confirmation."
  - **Not stated:** whether it works in test mode or sandboxes, whether it needs enabling, and which Chrome version it needs. **Unverified until we test it.**
- **Checkout Session create:** `POST https://api.stripe.com/v1/checkout/sessions`, form-encoded, with the secret key as the HTTP basic-auth username. `ui_mode` defaults to `hosted_page`, which is what we want. `mode=payment` and `line_items` are required. `metadata` is supported. `expires_at` can be **30 minutes to 24 hours** (default 24h). The current API version is `2026-10-28.endive`.
  - Inline `price_data` (`line_items[0][price_data][currency|unit_amount|product_data][name]`) was **not shown** on the page read (its example uses a pre-made Price ID). **VERIFY** when building, by calling Stripe's test API and reading the error if it is wrong.
- **Retrieve:** `GET /v1/checkout/sessions/{id}`. `payment_status` is `paid`, `unpaid` or `no_payment_required`, and `status` is `open`, `complete` or `expired`. Checking `payment_status === "paid"` as the brief says is correct.
- **Test card:** `4242 4242 4242 4242`, "a valid future date, such as 12/34", "any three-digit CVC", "any value you like for other form fields." **Confirmed.**
- **Keys:** test/sandbox secret keys still start with `sk_test_`, so hard rule 1 works as written. **New:**
  - Stripe now recommends **sandboxes** over the older "test mode sandbox" for new integrations. Both give `sk_test_` keys.
  - Stripe recommends **restricted keys** (`rk_test_...`) "especially when giving a key to an AI agent." The brief's rule only accepts `sk_test_`. **Decision for the user** (see below).
- **Test mode before account activation:** not stated on the pages read. The sandboxes page says the Stripe CLI can create "an anonymous Stripe sandbox with working API keys. It doesn't require account registration." Signing up for a normal account and using its sandbox is expected to work without activation, but this is **still unverified**. We will confirm it when the user creates the account.

#### Cloudflare Workers, KV, Wrangler
Sources: developers.cloudflare.com get-started guide, wrangler install/configuration/commands, local-development, secrets, KV write API, KV limits, how-kv-works.

- **Project setup:** `npm create cloudflare@latest` installs Wrangler **locally in the project** (recommended over a global install). Run it with `npx wrangler dev`. The config file is now **`wrangler.jsonc`** (recommended for new projects; `wrangler.toml` still works).
- **Local dev:** `http://localhost:8787`. Bindings such as KV and Durable Objects are simulated locally and persist between runs. **Unverified:** whether purely local dev needs a Cloudflare login. The guide says first use "will open your web browser so you can login." We will find out when we run it, and no account will be created without asking.
- **Secrets locally:** Wrangler reads **`.env`** (or `.dev.vars`, but not both) next to the config file. That fits the brief's `.env` plan directly. Cloudflare says to git-ignore `.env*` and `.dev.vars*`.
- **KV limitations (important, differs from the brief's suggested stack):**
  - Minimum `expirationTtl` is **60 seconds**. That is fine for 10-minute codes and 30-minute sessions.
  - KV is **eventually consistent** (changes "may take up to 60 seconds or more to be visible" elsewhere) and **not atomic**: "KV is not ideal for applications where you need support for atomic operations ... consider using Durable Objects."
  - Only **1 write per second per key**, and "concurrent writes ... the last write will take precedence."
  - This matters for **single-use codes**, **failed-attempt counters and lockout**, and **single-use download links / mark-delivered**. Two near-simultaneous requests could both pass. Locally there is one simulated instance, so this rarely shows up in Phase 1, but it would after deploying.
  - Cloudflare's own recommendation for counters and atomicity is **Durable Objects**, which also run fully locally under `wrangler dev`.
- **`Secure` cookie on localhost:** MDN says "The `https:` requirements are ignored when the `Secure` attribute is set by localhost." So we can always set `Secure` on the session cookie, even on `http://localhost`. To be confirmed in Chrome DevTools when we build sign-in.

### Decisions needed from the user (not yet made)
1. **Storage:** keep KV as the brief suggests, or use a Durable Object for codes, sessions, lockout and orders (atomic, and Cloudflare's own recommendation for this). Proposed: Durable Object.
2. **Stripe key type:** keep "must start with `sk_test_`", or also allow restricted test keys (`rk_test_`), which Stripe recommends for agents. Either way, live keys (`sk_live_`, `rk_live_`) are refused.

### Outcome
Step 0 complete. All required software is present. The brief is broadly accurate, with the differences listed above. No code written, nothing installed, no git repo yet (to be initialised at the start of Step 1, after the user's go-ahead).

---

## 2026-11-13 (UTC-7): User decisions, then Step 1 (project skeleton and git)

### Decisions from the user
1. Use a **Durable Object** instead of KV for all state. Recorded as D2 in DECISIONS.md.
2. Follow Stripe's guidance on keys: accept **`rk_test_` (preferred) or `sk_test_`** and refuse everything else. This changes the wording of the brief's hard rule 1 but keeps its intent (test mode only). Recorded as D3.

### What was done
- Created `.gitignore`. It ignores `.env`, `.env.*` (except `.env.example`), `.dev.vars*`, `node_modules/`, `.wrangler/` (local Durable Object state) and `dist/`.
- Created `.env.example` with placeholder values only: `STRIPE_SECRET_KEY=rk_test_REPLACE_ME` and `KILL_SWITCH=off`.
- Created `docs/DECISIONS.md` (D1 to D6), `docs/OPEN-QUESTIONS.md` (Q1 to Q12), `docs/test-runs/README.md` (the format for run files) and a beginner `README.md`.
- Ran `git init` and made the first commit.

### Why
The brief requires the docs to exist from the start, and requires `.env` to be git-ignored before any secret could exist.

### GitHub
- The user asked whether Claude could create a GitHub repo. The `gh` CLI is not installed, so the user will create the repo on github.com. Nothing will be pushed until the user explicitly says so (brief section 2).

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
- The user created the repo and supplied its URL. Ran `git remote add origin https://github.com/colbere/pdfsupplier.git`. This only records the address locally. **Nothing pushed.**
- The user then said "push". Ran `git push -u origin main`, which pushed the 2 commits. No credential prompt appeared.

---

## 2026-11-13 (UTC-7): Step 2, the text-only page and the `sign_in` tool

### What was done
1. Created `package.json` with one script, `npm run dev` (runs `wrangler dev`).
2. `npm install --save-dev wrangler`: installed **Wrangler 4.162.0** locally (37 packages, "found 0 vulnerabilities"). npm also printed a notice that a newer npm exists. That would be a global update, so it was skipped.
3. Created `wrangler.jsonc`: entry `src/index.js`, `compatibility_date` 2026-11-01, local dev on `localhost:8787`, `send_metrics: false` (no anonymous usage data sent to Cloudflare), and a rule so `*.browser.js` files are imported as text.
4. Created the site:
   - `src/page/index.html`: semantic HTML with one `h1`, the tagline and three paragraphs, using the brief's copy as written. Minimal inline CSS (centered, narrow column, serif type, light/dark aware). No links, buttons, forms, inputs or images.
   - `src/page/app.browser.js`: feature-detects `document.modelContext` and does nothing without it. Registers **only `sign_in`** (annotations `readOnlyHint: false`, `consequentialHint: false`, `untrustedContentHint: false`). It POSTs the code to `/api/sign-in` and returns the server's text.
   - `src/index.js` (the Worker): serves `/` and `/app.js`, a placeholder `POST /api/sign-in` that always returns the generic failure, and 404 for everything else.
5. Started `npx wrangler dev`.

### Design notes (why)
- **Script served as `/app.js`, not inline:** this allows a strict Content Security Policy (`script-src 'self'`) without hashes or nonces. The page is still the only *page*. `/app.js` is a resource the page loads. The CSP also sets `form-action 'none'`, `frame-ancestors 'none'`, `connect-src 'self'` and `default-src 'none'`.
- **Other headers:** `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
- **Placeholder sign-in:** it lets the tool be exercised in DevTools before the real logic exists.

### Output
`wrangler dev` startup (trimmed): no login prompt. **Q9 answered: local dev needs no Cloudflare account.**
```
wrangler 4.162.0
Starting local server...
Wrangler detected this dev session is running in an AI agent.
[...list of Local Explorer API routes...]
[wrangler:info] Ready on http://localhost:8787
```

Checks with curl:
```
GET /            -> 200 text/html; CSP, nosniff, no-referrer, no-store present
forbidden tags (a/button/form/input/select/textarea/iframe/img) -> none found
h1 count         -> 1
GET /app.js      -> 200 text/javascript
POST /api/sign-in {"code":"anything"} -> 401 {"ok":false,"error":"Sign-in failed."}
GET /nope        -> 404
GET /api/sign-in -> 404 (wrong method)
```

### Chrome check (done by the user, reported later the same day)
- With `chrome://flags/#enable-webmcp-testing` enabled, in Chrome 157: DevTools, then Application, then WebMCP lists **only `sign_in`**, and running it returns "Sign-in failed." **Confirmed by the user.** Test-script step 1 passes for the pre-sign-in state.

---

## 2026-11-13 (UTC-7): Q&A with the user, then Step 3 (real sign-in and lockdown)

### User questions before Step 3
- **"Where does the code go?"** Explained: `npm run new-code` prints the code in the owner's terminal and sends only its hash to the server. The owner pastes the code into the agent's chat, and the agent passes it to `sign_in`.
- **"Does Step 3 stop spam once live?"** Explained: it blocks purchases, Stripe session creation (and so card-testing fraud) and code guessing, but not request floods or a deliberate global lockout. Recorded as Q13. Edge rate limiting is for Phase 2.
- Pushed commit `08ff909` to GitHub on the user's instruction.

### What was built
- `src/store.js`: the `Store` Durable Object (SQLite-backed, binding `STORE`, migration `v1`). It holds the active code hash, sessions (by token hash), failure timestamps (global and per IP) and the kill-switch flag. Methods: `addCode`, `signIn`, `touchSession`, `endSession`, `setKillSwitch`, `clearLockouts`, `status`.
- `src/shared.js`: code alphabet and generator, normalisation and SHA-256 helpers. Shared by the server and the Node scripts.
- `src/index.js`: real `POST /api/sign-in`, `GET /api/session` (page can ask "am I signed in?"), and the admin API `/admin/code`, `/admin/kill-switch`, `/admin/unlock`, `/admin/status`.
- `scripts/`: `setup.mjs`, `new-code.mjs`, `kill-switch.mjs`, `unlock.mjs` and `lib.mjs`, wired up as `npm run setup | new-code | kill-switch | unlock`.
- `wrangler.jsonc`: added the Durable Object binding and migration. `package.json`: `"type": "module"` plus the scripts.
- `.env.example`: replaced `KILL_SWITCH` with an `ADMIN_TOKEN` placeholder (see D7, D9).
- `tests/auth-checks.sh`: a repeatable test script. It never prints codes or tokens.
- Design decisions D7 to D11 recorded in DECISIONS.md.

### Bug caught while writing
- The first version of the code alphabet left out upper-case `L` as well as the look-alikes, giving 31 characters. With a simple "byte mod length" generator, 31 characters would make some characters slightly more likely than others. Fixed: added `L` back (32 characters, 5 bits each), and the generator uses rejection sampling so it stays unbiased for any alphabet size.

### Setup output
```
> npm run setup
Created .env from .env.example.
Generated a new ADMIN_TOKEN in .env (value not shown).
```
`.env` contains `STRIPE_SECRET_KEY` (still the placeholder) and `ADMIN_TOKEN` (43 characters). `git status` does not list `.env` (ignored as intended).

Wrangler restart:
```
Using secrets defined in .env
env.STORE (Store)                       Durable Object            local
env.STRIPE_SECRET_KEY ("(hidden)")      Environment Variable      local
env.ADMIN_TOKEN ("(hidden)")            Environment Variable      local
[wrangler:info] Ready on http://localhost:8787
```
Wrangler prints a generic telemetry notice at startup, but `wrangler telemetry status` reports `Disabled (set by wrangler config)`, so `send_metrics: false` works.

### Test results: `bash tests/auth-checks.sh`, **33 passed, 0 failed**
```
== 1. Admin API needs the admin token
  PASS  admin status, no token (got 401)
  PASS  admin status, wrong token (got 401)
== 2. Sign-in with no active code fails generically
  PASS  no code -> 401 / generic error body {"ok":false,"error":"Sign-in failed."}
== 3. Valid code signs in (typed lower-case, no dashes) and sets a locked-down cookie
  PASS  valid code -> 200
        Set-Cookie: __Host-pdfs_session=[REDACTED]; Path=/; Secure; HttpOnly; SameSite=Strict
  PASS  cookie has __Host- prefix, Path=/, Secure, HttpOnly, SameSite=Strict
== 4. Session checks
  PASS  with cookie -> 200 | no cookie -> 401 | forged cookie -> 401
== 5. Code is single use
  PASS  reuse same code -> 401
== 6. Cross-origin request refused
  PASS  Origin: https://evil.example -> 403; same code still valid from our origin -> 200
== 7. Lockout after 5 failures (generic error throughout)
  PASS  wrong code #1..#5 -> 401
  PASS  CORRECT code while locked -> 401, with an identical error body
  PASS  different client IP also locked (global) -> 401
  PASS  after `npm run unlock`, same code works -> 200
== 8. Kill switch
  PASS  session valid before kill -> 200
        Kill switch is ON. Sessions removed: 3. Sign-in is disabled.
  PASS  both sessions after kill -> 401; new-code refused; sign-in -> 401
        Kill switch is off. Sign-in works again (old sessions stay invalid).
  PASS  old session still dead after kill off -> 401; fresh sign-in -> 200
RESULT: 33 passed, 0 failed
```

Server log for the run (outcomes only):
```
sign_in: success x4 | failed (wrong_code) x5 | failed (no_active_code) x2 | failed (locked_global) x2 | failed (kill_switch) x1
admin: new code stored x4 | new code refused x1 | kill switch ON x1 | lockouts cleared x8
```
A search of the server log for code-shaped or session-token-shaped strings found **0 matches**. No errors.

### Not yet tested
- **10-minute code expiry** and **30-minute session inactivity** were not tested live, because that means waiting 10 or 30 minutes. The logic is simple timestamp comparisons in `store.js`. To test later, either wait, or temporarily shorten the constants.
- **Chrome accepting the `__Host-` + `Secure` cookie on `http://localhost` (Q11):** curl received the header, but only a real browser can show whether it stores the cookie. The user will check in DevTools.
- Per-IP lockout never triggers on its own while both limits are 5 (see D10 note).

### Browser check of Step 3 (done by the user)
- The user generated a code with `npm run new-code` and ran `sign_in` from the DevTools WebMCP pane.
- Server log: `sign_in: success`. A second run with the same code gave `failed (no_active_code)` (single use working). A later new code gave `success` again.
- DevTools → Application → Cookies showed `__Host-pdfs_session` with HttpOnly, Secure and SameSite=Strict. **Q11 answered: Chrome accepts the Secure + `__Host-` cookie on `http://localhost`.**
- **Lesson (wording):** the success message says "The store's purchase tools are now available," but in Step 3 no purchase tools exist yet, so the user expected new tools to appear and thought something had failed. Tool output should describe the actual state. It becomes accurate in Step 4, when the page registers those tools on success. This is a small example of what Chrome's best-practices page says: "Only resolve a tool execution with success when the output matches the application state."
- Outcome: Step 3 verified in the browser.

---

## 2026-11-13 (UTC-7): Step 4, post-sign-in tools (`get_product`, `sign_out`)

Pushed `7e0434e` and `2a8b2ea` to GitHub on the user's instruction.

### What was built
**Server (`src/index.js`):**
- `withSession()`: one wrapper for every purchase-related endpoint. It requires POST, refuses a cross-site `Origin` (403) and checks for a valid session (401 with `code: "not_authenticated"`). Steps 5+ reuse it.
- `POST /api/product`: returns the product (name, price, description, delivery, test-mode note). The product data lives in `PRODUCT` in `src/shared.js` so Stripe will use the same values.
- `POST /api/sign-out`: deletes the server session if present and always clears the cookie (`Max-Age=0`). Harmless if already signed out.
- The sign-in success message is now just "Signed in." The page adds the list of tools that were actually registered (lesson from the Step 3 browser check).

**Page script (`src/page/app.browser.js`):**
- `get_product` (`readOnlyHint: true`) and `sign_out` (`readOnlyHint: false`, `consequentialHint: false`) are registered **only after a successful sign-in**, all with one `AbortController`.
- **All or nothing:** if any registration fails, the controller is aborted so no partial set is left (Chrome best-practices: "expose either the complete tool surface or none of it").
- **Removal** (`controller.abort()`) happens on `sign_out`, after 30 minutes without a successful server call (client idle timer matching the server), and whenever any server reply has `code: "not_authenticated"` (for example after the kill switch or a server-side expiry).
- **On page load** it calls `GET /api/session`. If still signed in, it re-registers the purchase tools.
- `sign_in` now reports exactly what was added, for example "Signed in. These tools are now available: get_product, sign_out."

### Tests
`node --check` on the browser script and shared module: OK.

`bash tests/tools-checks.sh`, first run: **19 passed, 1 failed.** The failure was the test's fault: it searched the page for the word "checkout", which the brief's copy legitimately contains ("no checkout for a person to click through"). Fixed the check to look for what rule 3 actually forbids: a Stripe checkout URL (`checkout.stripe.com`, `stripe.com/`, `cs_test_`/`cs_live_`) in the page HTML **or** `app.js`.

Second run: **20 passed, 0 failed**
```
== 1. Purchase endpoints refuse requests without a valid session
  PASS  get_product, no cookie -> 401 (says not_authenticated)
  PASS  get_product, forged cookie -> 401
  PASS  get_product, GET instead of POST -> 405
== 2. Signed in: get_product works
  PASS  sign in -> 200; get_product with session -> 200; name, price, sentence present
        body: {"ok":true,"product":{"name":"The PDF Supplier: one PDF","price":"$1.00 USD",
               "description":"A PDF file containing exactly one sentence: \"You now own this PDF.\"",
               "delivery":"After payment, a single-use download link that expires in minutes.",
               "note":"Payments run in Stripe test mode. No real money moves."}}
  PASS  get_product cross-origin -> 403
== 3. sign_out ends the session
  PASS  sign_out cross-origin -> 403, and the session survives it
  PASS  sign_out -> 200, cookie cleared (Max-Age=0); old cookie -> 401; second sign_out -> 200
== 4. Kill switch also blocks tool endpoints
  PASS  get_product before kill -> 200, after kill -> 401
== 5. Page still clean
  PASS  no links/buttons/forms/inputs/images; no Stripe checkout URL in page or app.js
```
Regression: `bash tests/auth-checks.sh` gives **33 passed, 0 failed**.

### Not testable from the terminal
The browser-side behaviour (tools appearing after sign-in, surviving a reload, disappearing on sign-out) needs Chrome with WebMCP. Handed to the user for a DevTools check.

### Browser check of Step 4 (done by the user)
Checklist results in Chrome 157, DevTools → Application → WebMCP:
1. New code: OK.
2. Before sign-in, only `sign_in` listed: **OK**.
3. `sign_in`: output listed the new tools, and three tools appeared: **OK**.
4. `get_product`: **at first the user saw no output and thought it hadn't run.** The server log showed `POST /api/product 200 OK` three times, so it had run and succeeded. Following up (the newest row in the "Invoked tools" log, and/or a Console call to `document.modelContext.executeTool()`), the user confirmed the product output. **OK.**
5. Reload while signed in: tools restored automatically (`GET /api/session 200`, then `get_product` ran again): **OK**.
6. `sign_out`: tools dropped back to only `sign_in` and the cookie was removed: **OK**.

**Note for the write-up:** a tool's result isn't necessarily shown next to the "Run tool" button in the DevTools WebMCP pane. Check the "Invoked tools" log, or call `executeTool` from the Console. A tool can succeed while looking as if it did nothing, so the server log was the quickest way to tell.

Outcome: Step 4 verified in the browser.

---

## 2026-11-13 (UTC-7): Step 5, Stripe account, key, and the purchase tools

### Stripe account (done by the user)
- Before guiding the user, re-read Stripe docs: get-started/account, sandboxes, the manage-sandboxes Dashboard page, restricted keys, keys, and the Checkout Sessions create API (`line_items.price_data`).
  - Docs: "Immediately after you create a Stripe account, you can use a sandbox… without moving any money" (Q8).
  - Docs: "Write permissions imply read permissions."
  - The docs don't name the Checkout permission, or say whether inline `price_data` needs Products or Prices permissions.
- The user signed up at dashboard.stripe.com/register, switched to a sandbox (account picker → Switch to sandbox) and created a restricted key named `pdf-supplier-local`.
- The live "Assign permissions" screen offered four choices (template / custom / full-except-sensitive / full). Advised **Custom permissions** with Checkout Sessions = Write and everything else None (Q14). Advised **not** to tag it as an agent key, because the server holds it and the agent never does.
- The user pasted the key into `.env` themselves. The first check found the placeholder still there (the file hadn't been saved). After saving: one `STRIPE_SECRET_KEY` line, starts with `rk_test_`, length 107, no spaces or quotes. The value was never displayed.
- Pushed `8a6e41a` and `f74b179` on the user's instruction.

### What was built
- `src/stripe.js`: `fetch`-based Stripe client pinned to `Stripe-Version: 2026-10-28.endive`. Functions: `isTestKey`, `redact` (removes key- and checkout-URL-shaped text), `createCheckoutSession` (with Idempotency-Key, and refuses if `livemode` is true) and `getCheckoutSession`.
- `src/pdf.js`: hand-written minimal PDF 1.4 (one US-Letter page, Helvetica 24pt). No dependency.
- `src/store.js`: orders (`prepareCheckout`, `saveOrder`, `getOrderForSession`, `markPaid`) and download tokens (`issueDownload`, which atomically marks the order delivered and stores the token hash; `redeemDownload`, single use).
- `src/index.js`: rewritten.
  - New `POST /api/checkout`, `/api/order` and `/api/download`, all through `withSession`.
  - `GET /download/<token>`: needs the session cookie and the token. Serves `application/pdf`, `Content-Disposition: attachment`.
  - A per-request test-key guard that answers 503 to everything otherwise.
- `src/page/app.browser.js`: `create_checkout`, `check_order` and `get_download` added to the post-sign-in tool set. `get_product` now ends with "To buy it, call create_checkout."
- `scripts/check-env.mjs`, wired as `predev` and `check-env`.
- `tests/purchase-checks.sh`.
- Decisions D12 to D16.

### Results
**PDF:** 596 bytes. `pdftotext` extracts exactly `You now own this PDF.` (`pypdf` isn't installed, so `pdftotext` was the independent check.)

**Startup with the real key:**
```
> node scripts/check-env.mjs
Environment OK: Stripe restricted TEST key found (value not shown).
> wrangler dev
[wrangler:info] Ready on http://localhost:8787
```

**First live Stripe call (test mode):**
```
sign_in: 200
create_checkout HTTP: 200
ok: true | reused: false | order_id: ord_pkwzp3pkyehmn2yr5z65 | expires_at: 2026-11-13T21:01:48.000Z
checkout_url: starts with https://checkout.stripe.com/ -> true | contains cs_test_ -> true | length: 407
create_checkout again (should reuse): reused: true order_id: ord_pkwzp3pkyehmn2yr5z65
check_order:  {"ok":true,"order_id":"ord_pkwzp3pkyehmn2yr5z65","status":"unpaid","checkout_status":"open"}
get_download: {"ok":false,"error":"This order is not marked paid yet. Call check_order first; ..."}
```
- **Q10 answered:** inline `price_data` works, and **Checkout Sessions: Write alone is enough**.
- The checkout URL is 407 characters, well within the 1.5K output target.
- A bug in my own ad-hoc test (Node on Windows can't write to the bash path `/tmp/...`) briefly sent an empty `order_id`. The server correctly answered 400 "order_id is missing or malformed". Re-ran with the ID directly. The saved test script avoids this.

**Refuse-to-start (hard rule 1, as amended by D3):**
```
key shape 'sk_live_…' -> exit 1 : STRIPE_SECRET_KEY is a LIVE key. ... Refusing to start.
key shape 'rk_live_…' -> exit 1 : (same)
key shape 'pk_test_…' -> exit 1 : must be a Stripe test key starting with rk_test_ (preferred) or sk_test_. Refusing to start.
key shape 'rk_test_…' (placeholder REPLACE_ME) -> exit 1 : (same)
key shape '' -> exit 1 : STRIPE_SECRET_KEY is missing from .env. Refusing to start.
key shape 'sk_test_…' (well-formed fake) -> exit 0 : Environment OK
npm run dev with a fake LIVE key -> predev prints the LIVE-key error, exit 1, Wrangler never starts
```
Bypassing npm with `npx wrangler dev --port 8788 --var STRIPE_SECRET_KEY:sk_live_FAKE…`: `GET /` → 503, `GET /app.js` → 503, `POST /api/sign-in` → 503. Worker log: `REFUSING TO SERVE: STRIPE_SECRET_KEY is missing or is not a Stripe test key`. That server was stopped afterwards.

**Test suites:** `purchase-checks.sh` **19/19**, `tools-checks.sh` **20/20**, `auth-checks.sh` **33/33**. purchase-checks covers:
- all purchase endpoints and `/download/*` return 401 without a session;
- a real create, reuse, and check (unpaid/open);
- `get_download` on an unpaid order → 409;
- **a second signed-in session can't see or download the first session's order** (404);
- malformed or missing `order_id` → 400; a bogus token → 404;
- no Stripe URL or key anywhere in the server log.

### Still to test (needs a payment on Stripe's page, in the browser)
The paid path (`check_order` → paid, `get_download` → link, PDF download, single use) can't be done from the terminal, because hosted Checkout needs a browser. Handed to the user to do by hand once, as a backend check before the agent run. This is not the Phase 1 pass run, which must have no human clicking.

### Manual paid-path check (done by the user in Chrome, by hand; not the agent run)
- The user signed in through DevTools; all six tools appeared. They also ran `get_product` unprompted, and it worked.
- `create_checkout` returned order `ord_uzc8ag5vk2gb59fs4vxg` and a Stripe URL, which the user opened in a new tab.
- **Stripe's sandbox Checkout page lists six WebMCP tools in DevTools:** `fill_payment_form`, `get_link_pay_token_merchant`, `get_order_summary`, `select_payment_method`, `set_link_pay_token`, `submit_payment`. Details are in Q3. The DevTools panel did **not** show the tools' annotations to the user, so which tool is marked consequential is still unobserved.
- The user paid by hand with 4242 4242 4242 4242 / 12/34 / 123 and was redirected to the homepage.
- Server log (download token redacted):
```
create_checkout: order ord_uzc8ag5vk2gb59fs4vxg created
check_order: ord_uzc8ag5vk2gb59fs4vxg stripe=complete/paid -> paid
get_download: ord_uzc8ag5vk2gb59fs4vxg -> link issued, order delivered
download: served PDF for ord_uzc8ag5vk2gb59fs4vxg
[wrangler:info] GET /download/[REDACTED] 200 OK (192ms)
get_download: ord_uzc8ag5vk2gb59fs4vxg -> already_delivered
```
- The user reports every tool worked as intended and the PDF downloaded.
- A search of the server log for Stripe URLs or keys found **0 matches**.
- **Gap, stated plainly:** the server received only **one** request for the download link. Reopening the link did not reach the server: either it wasn't reopened, or Chrome served it from its download history. So **single-use of the download link has not yet been observed on a real paid order.** (The code deletes the token on first redemption, and the tests show unknown or used tokens get 404.) Re-check during the agent run.

**Outcome:** the backend purchase flow works end to end in Stripe test mode: sign-in → checkout → Stripe payment → paid check → single-use download → PDF. Step 5 complete.

---

## 2026-11-13 (UTC-7): Step 6 setup, the Example Agentic Chrome Extension

Pushed `28640a2` and `f91b300` on the user's instruction. The user approved Step 6, including downloading the extension and installing its dependencies.

### Extension download and review
- `git clone https://github.com/GoogleChromeLabs/webmcp-extension.git c:\claude\webmcp-extension`, a separate folder next to this project. Commit **`051a93c` (2026-11-11)**, "Merge pull request #93".
- Reviewed before installing:
  - `package.json` has no install or postinstall scripts of its own.
  - Dependencies: Vercel AI SDK (`ai`, `@ai-sdk/anthropic|google|openai`), React, esbuild, puppeteer-core, `@puppeteer/browsers`.
  - `.env` is git-ignored.
- **What the agent can do (relevant to Q2 and Q5):**
  - `extension/manifest.json` permissions are `sidePanel`, `scripting`, `webNavigation` and `favicon`, with host permission `<all_urls>`. There is **no `tabs` or `downloads` permission**.
  - A search of the extension source for `tabs.create`, `tabs.update`, `chrome.downloads` and `window.open` found nothing.
  - `server/tools.ts` gives the model **only the page's own WebMCP tools** ("No tool is given an `execute`. Tools belong to the web page").
  - The system prompt (`shared/systemPrompt.ts`) includes: "Do not try to use other tools than the available ones."
  - **Prediction, recorded before the run:** the agent will get the Stripe URL from `create_checkout` but has no way to open it. Q2 will likely fail as designed. It may ask the user to open the link, which would break "no human clicking".
- **Its logs:** the model server keeps a log of requests and responses **in memory only** (last 500 entries, no file writes found). The log dashboard needs `WEBMCP_AUTH_TOKEN`, and the server binds to `127.0.0.1`. These logs will contain the one-time code and the Stripe URL. That is acceptable for a local, single-use code, and both are redacted in `docs/test-runs/`. `WEBMCP_LOG_REDACT_BODIES=1` would hide them, but would also hide the transcript we need.
- `npm install`: added 78 packages, "found 0 vulnerabilities". `npm run build`: "Generated and saved new WEBMCP_AUTH_TOKEN in .env" and "Build complete with WebMCP auth token injected." `dist/manifest.json` exists.

### Model choice
- Current IDs and prices are from Anthropic's model list (cached 2026-11-03), shown to the user: Opus 5.5 `claude-opus-5-5` ($4/$20 per M tokens), Sonnet 5.5 `claude-sonnet-5-5` ($2/$10), Haiku 5.5 `claude-haiku-5-5` ($0.10/$0.50), Fable 5.2 `claude-fable-5-2` ($8/$40).
- The extension's built-in Anthropic default is `anthropic:claude-sonnet-4-5` (`server/providers.ts:58`), an older model.
- Compatibility check: the extension calls `streamText({ model, system, messages, tools, abortSignal })` with no `temperature` and no forced `toolChoice`, both of which current models reject. The installed `@ai-sdk/anthropic` 4.0.88 contains the `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5` IDs.
- **The user chose Opus 5.5.** Wrote `MODEL=anthropic:claude-opus-5-5` and an empty `ANTHROPIC_API_KEY=` line to the extension's `.env`. The user fills in the key themselves.

### Secrets audit and guard (asked for by the user)
The user asked to make sure no sensitive data is exposed now or later. The audit compared exact secret values loaded in memory; no values were printed:
```
Anthropic key format: starts sk-ant-: yes | length 106 | spaces/quotes: no
1. .env (project): ignored | webmcp-extension/.env: ignored
2. .env-type files ever committed (all history): only .env.example
3. Exact values of STRIPE_SECRET_KEY, ADMIN_TOKEN, ANTHROPIC_API_KEY, WEBMCP_AUTH_TOKEN in any commit: not found (x4)
4. Key-shaped strings anywhere in history: 0
5. GitHub (origin/main) == local HEAD: yes
6. All 11 server/test/agent output logs from this session: secrets 0, Stripe URLs 0
7. Extension clone remote: GoogleChromeLabs/webmcp-extension (fetch). Push URL now disabled.
```
Added the pre-commit guard (D17) and **tested it by trying bad commits on purpose**:
```
Test A: git add -f .env                -> refused (secret file, key-shaped, STRIPE_SECRET_KEY value, ADMIN_TOKEN value)
Test B: file with fake sk_test_ key    -> refused (key-shaped string)
Test C: file with real ADMIN_TOKEN     -> refused (exact secret value)
Test D: harmless file                  -> allowed (then undone)
```
HEAD was unchanged afterwards (`f91b300`); no test commit remains.

**Remaining exposure paths and their status:**
- The extension bundle (`webmcp-extension/dist/`) contains `WEBMCP_AUTH_TOKEN`, as its README warns. `dist/` is git-ignored there and the token only unlocks the local model server on 127.0.0.1.
- The extension's in-memory log will hold the one-time code and the Stripe URL during the agent run. It is in memory only, behind a token, local.
- Wrangler's local state (`.wrangler/`) holds only hashes of codes and sessions. It is git-ignored.
- **For when the repo goes public:** consider turning on GitHub's secret scanning / push protection in the repo settings (on GitHub, under Settings → Security). It blocks key-shaped pushes on GitHub's side, even if the local hook were skipped. Availability for private repos depends on the plan; for public repos it's generally available. Not verified here.

---

## 2026-11-13 (UTC-7): Agent run 1, then a fix for payment and download

### Run 1
Details are in `docs/test-runs/2026-11-13-1417-opus55-run1.md`. Summary:
- **Worked:** the agent signed in, saw the five new tools on the next turn, and called `get_product` and `create_checkout` in parallel, with no clicking on the page.
- **Stopped at payment:** "none of my tools can open or type into the Stripe checkout page."
- **Answered:** Q1 yes, Q12 yes, Q2 no.

### Reading the extension's code after the run
- `extension/sidepanel/services/extensionBridge.ts` `executeTabTool` handles the case where a **page tool navigates**: when the message channel closes, it waits for the new document's content script and tools, waits for page load, then asks the new page for a cross-document result. It also follows a tool that opens a new tab (`onTabChanged`).
- So the fix belongs on our page, not in the agent.

### User decision (asked with options)
- Payment: **new `open_checkout` tool** (recommended). Rejected: Stripe Embedded Checkout (conflicts with rule 3), and stopping to record the failure as the result.
- Download: **`get_download` saves the file itself** (recommended). Rejected: leaving the link only, and returning the PDF text.
- Recorded as D18 and D19.

### What was built
- Server: `POST /api/open-checkout`, through `withSession`. It returns the stored Stripe URL only for the session's own unpaid, unexpired order. It logs `open_checkout: <order> -> navigating to Stripe`, never the URL.
- Page:
  - the `open_checkout` tool (fetches the URL, `location.assign`, promise left pending);
  - `savePdf()` used by `get_download` (same-origin fetch, `%PDF-` check, detached `<a download>` on a `blob:` URL);
  - updated "next step" hints in `get_product` and `create_checkout`, and a new `get_download` description.
- Tests:
  - `purchase-checks.sh` gains 6 `open_checkout` checks: no session → 401; another session → 404; malformed → 400; owner → 200 with a `cs_test_` URL; cross-origin → 403.
  - **Bug in the test helper found and fixed:** `post()` silently dropped extra curl arguments, so the cross-origin header would never have been sent.
  - `tools-checks.sh`: the rule-3 check now looks for a checkout **session** URL (`checkout.stripe.com/c/` or `cs_test_`/`cs_live_`), because `app.js` now contains the bare prefix `https://checkout.stripe.com/` as a validation check.

### Results
`node --check` OK. purchase-checks **26/26**, tools-checks **20/20**, auth-checks **33/33**.

---

## 2026-11-13 (UTC-7): Agent run 2, then a local patch to the extension

### Run 2
Details are in `docs/test-runs/2026-11-13-1428-opus55-run2.md`.
- `open_checkout` took the tab to Stripe with no human help, and the agent switched to Stripe's tools: `get_order_summary`, `select_payment_method` and `submit_payment`.
- `fill_payment_form` never reached the agent. The user saw it in DevTools, but not in the side panel.
- **The user confirmed the extension showed an "Allow" permission prompt before `submit_payment`** (Q4, extension side).
- The agent asked before submitting. After the user's explicit "Submit the checkout form…", it submitted. With empty card fields, and after the session had expired, nothing was paid.

### Diagnosis
- First hypothesis (a stale list): **ruled out by the code.** `useAgentSession.ts` calls `waitForToolsToSettle(… requestTools: () => requestTabTools(turnTabId))` after every tool round, a full re-list with fresh frame origins.
- Actual cause: the only tool source is the top frame's `getTools({ fromOrigins })`, which needs the subframe to have exposed the tool to the top origin, and the side panel drops subframe reports.

### Patch (D20)
- 2 files, +94/−2. The diff is saved as `docs/extension-patch.diff`.
- `npm run typecheck` passed. `npm run test:unit`: **209/209 passed**. `npm run build` OK, reusing the existing auth token, so no server restart was needed.
- The clone's push URL is still disabled. Nothing is sent upstream.

---

## 2026-11-13 (UTC-7): Agent run 3, then extension patch D21

Run 3 details are in `docs/test-runs/2026-11-13-1540-opus55-run3.md`. With D20, the agent got all six Stripe tools, selected card, and called `fill_payment_form` with complete test details. The call never returned and the user stopped the run.

Fixes (D21, in `extensionBridge.ts`):
- a 30-second tool timeout with an explanatory error;
- a navigation note instead of an error or `null` when the frame that ran the tool is gone or the page gives no result.

The second fix pre-empts a failure the code review found: after `submit_payment` redirects the tab to our store, the model would have seen an error even on a successful payment.

`npm run typecheck`: OK. `npm run test:unit`: 209/209. `npm run build`: OK. The diff is updated: 3 files, +139/−12.

---

## 2026-11-13 (UTC-7): Agent run 4, then Checkout made card-only without Link (D22)

Run 4 details are in `docs/test-runs/2026-11-13-1556-opus55-run4.md`.
- D21 worked: there was a navigation note and the timeout was recovered from.
- The agent asked before paying and submitted on "yes".
- Stripe showed "Your phone number is incomplete", from Link's save-info opt-in.
- The agent called `check_order` while still on Stripe, then the extension's server lost the chat (409, cause not determined).

Fix D22:
- Docs check: `payment_method_types` is not allowed on API `2026-09-30.endive` and later. The documented replacements are `allowed_payment_method_types` and `wallet_options.link.display=never`.
- Added both to `createCheckoutSession`. A test session read back `payment_method_types ["card"]`, Link `never`, `phone_number_collection.enabled false`. `purchase-checks.sh` 26/26.

---

## 2026-11-13 (UTC-7): Agent run 5, then extension patch D23

Run 5 details are in `docs/test-runs/2026-11-13-1606-opus55-run5.md`.
- After `open_checkout`, the model was sent **zero tools** and answered with nothing (the user typed "try again").
- D22 confirmed: 4 Stripe tools, no Link.
- The form filled completely, but `fill_payment_form` timed out twice. The agent asked the user to check the form or retry. Nothing was submitted.

Fix D23:
- `waitForToolsToSettle` `emptyTimeoutMs` (15 s) for a navigated-to page that has no tools yet.
- The server turns late tool results into a note instead of a 409 for a chat that still exists.
- My first version of the settle change **failed the new unit test** (it returned without the quiet period once tools arrived late). Fixed.
- typecheck OK, unit tests **210/210**, rebuilt, model server restarted ("Answering with anthropic:claude-opus-5-5").

---

## 2026-11-13 (UTC-7): Agent run 6, **first complete purchase**; Phase 1 pass assessment

Run 6 details are in `docs/test-runs/2026-11-13-1614-opus55-run6.md`. From sign-in to a saved PDF took about 2.5 minutes. Human input: one "yes" in the chat, plus the extension's Allow prompts. **No clicks on either page.**

Verification:
- Server log: `stripe=complete/paid -> paid`, then `link issued, order delivered`, then `served PDF`.
- File `you-now-own-this (1).pdf`: 596 bytes, `pdftotext` = "You now own this PDF."
- Fresh negative checks: auth **33/33**, tools **20/20**, purchase **26/26**. `check-env` refuses `sk_live_`, `rk_test_REPLACE_ME` and `pk_test_`.

### Phase 1 pass condition (brief section 11): assessment
| # | Condition | Result |
|---|---|---|
| 1 | Agent finds the tools and signs in with a one-time code | **Met** (every run) |
| 2 | Creates a checkout, pays with the test card, server confirms `paid` | **Met in run 6.** It needed: our `open_checkout` (D18), card-only/no-Link Checkout (D22), and **local patches to the test agent** (D20, D21, D23) |
| 3 | Receives the download and retrieves the PDF containing exactly the sentence | **Met in run 6**, via `get_download` saving the file (D19). The model did not read the text itself |
| 4 | Negative checks: no purchase tool works without a valid session; a wrong or reused code fails; lockout; kill switch; refuses a non-test key | **Met** (79 checks + 3 refuse-to-start cases, re-run after run 6) |
| — | "No human clicking on the page" | **Met.** The human input was a chat "yes" and extension Allow prompts |

**Caveats for the write-up:**
- The stock extension cannot complete this purchase. Three local patches were required (D20, D21, D23; 7 files, `docs/extension-patch.diff`).
- Stripe's `fill_payment_form` never resolves.
- The approval was given before the form was filled and was carried over to `submit_payment`.
- The empty tool list after navigation persisted in run 6 (possibly the extension was not reloaded after D23; to confirm).

### Clarifications after run 6, and closing Phase 1 (user decisions)
- The user **had not reloaded the extension** before run 6. The side panel therefore ran patches D20 and D21 only, and **D23's 15-second "wait for tools" was not active**, which explains the empty tool list after `open_checkout`. D23's server-side late-results note *was* active (the model server had been restarted) and fired in step 9. **D23's client-side fix remains untested live.**
- Optional control Q6 (Claude in Chrome): **not run**, by the user's choice.
- **The user closed Phase 1.**

## Phase 1: closing summary (2026-11-13)
- **Result:** an AI agent (the Example Agentic Chrome Extension + Claude Opus 5.5) completed the purchase using only WebMCP tools: sign-in with a one-time code → product → checkout → Stripe's own WebMCP tools (card fill and submit, after the user's confirmation) → server-verified `paid` → single-use download → PDF saved. There were no clicks on the page, in Stripe test mode, after six runs.
- **What it took** (see DECISIONS.md):
  - **Site:** `open_checkout` navigates the tab to Stripe (D18); `get_download` saves the file itself (D19); card-only Checkout with Link off (D22).
  - **Agent:** three local patches to the extension (D20 subframe tools, D21 timeout and navigation result, D23 settle wait and late results). They are not upstream; the diff is in `docs/extension-patch.diff`.
- **What breaks, for the write-up:**
  1. The stock extension cannot open links, so a store must move the tab itself.
  2. Stripe exposes only some of its Checkout tools to the top frame; `fill_payment_form` lives in an iframe and isn't exposed.
  3. `fill_payment_form` fills the form but never resolves.
  4. Stripe Link adds a phone field no tool fills.
  5. After navigation, the agent can be sent a turn with no tools.
  6. An approval given up front was reused for a later submit.
- **Left for Phase 2 / later:**
  - a live run with D23 loaded;
  - Q13 (abuse protection once live);
  - whether to report the subframe-tool and `fill_payment_form` behaviour to Google or Stripe (**needs the user's OK**);
  - the custom Claude harness, deployment, the domain, a real $1 charge (brief section 12).

---

## 2026-11-13 (UTC-7): After Phase 1, the owner's goals and a change of focus (no code changes)

Discussion only, until the owner asked for it to be recorded:
- **Can Phase 1's lessons go on the page so any agent succeeds?** Answer given: partly. Two problems were already fixed on the site (`open_checkout`; card-only, no Link). Two can be helped by factual wording in tool messages, which stays in the agent's conversation after the tab moves to Stripe. Two cannot be fixed from the page: Stripe's iframe-only `fill_payment_form`, and the timing of the extension and Stripe. Caveat: the extension tells the model never to follow instructions in tool results, so the wording must be factual.
- **Goal stated:** "send an agent to do the entire transaction on its own." Options given: improve the page wording; a custom agent harness (the brief's Phase 2) that handles discovery, waiting, timeouts, step order and a spending rule; agentic commerce; reporting to Google and Stripe.
- **Owner's sequence:** first an agent with all the context, later one without it.
- **Owner's interest:** agentic commerce, "could remove a significant amount of friction".
- **Owner's framing (D24):** the subject is the WebMCP tools on the owner's own page, not the payment page's.

Recorded: `docs/PLAN.md` (plain-language plan, **awaiting owner confirmation**) and D24. All Phase 1 records are kept as they are.
- **Owner confirmed the plan (2026-11-13)** and decided (D25):
  - Stage B "without context" = their own agent with the extra layer off;
  - their agent has a **spending rule only** ("dispatch it from my terminal and it returns with the pdf"), which changes the brief's Phase 2 "confirmation step";
  - **do not report** problems to Stripe or Google.
  - `docs/PLAN.md` is marked confirmed.

---

## 2026-11-13 (UTC-7): Phase 2 start, a feasibility check for the owner's own agent

The owner asked to begin Phase 2 (`docs/PLAN.md`). First question: can a program *outside* the browser read and run WebMCP tools in every frame, including Stripe's iframe, which the extension couldn't see?

- **How Chrome is launched:** the extension's own smoke tests (`tests/smoke/chromeHarness.ts`) launch Chrome via Puppeteer with **`--enable-features=WebMCP`** (headless works). That is the command-line equivalent of the `#enable-webmcp-testing` flag.
- **Spike** (scratchpad script, nothing changed in the project): it used the `puppeteer-core` already installed in the extension folder, created one Stripe test Checkout Session with our real parameters, opened it in headless Chrome 157, and listed each frame's own tools.
- **Three script bugs found and fixed on the way:**
  1. It stopped at the first frame that returned an error.
  2. It reused a fixed test order ID; Stripe's idempotency check refused it ("Keys for idempotent requests can only be used with the same parameters"). That is our own safeguard working.
  3. It needed a fresh ID per run.

Result:
```
[top]    https://checkout.stripe.com: (none)
[iframe] https://js.stripe.com: fill_payment_form,
         get_order_summary {"consequentialHint":false,"readOnlyHint":true,"untrustedContentHint":true},
         select_payment_method,
         submit_payment {"consequentialHint":true,"readOnlyHint":false,"untrustedContentHint":false}
(about 11 other Stripe, Google Pay and hCaptcha frames: "Access to the feature "tools" is disallowed by permissions policy")

Ran get_order_summary from outside the browser:
{"content":[{"type":"text","text":"{\"livemode\":false,\"currency\":\"usd\",\"totalAmount\":100,...,\"lineItems\":[{\"name\":\"The PDF Supplier: one PDF\",\"minorUnitsAmount\":100,\"quantity\":1}]}"}]}
```
Conclusions:
1. An outside program sees **all 4 Stripe tools on load, including `fill_payment_form`**, and can run them in the owning frame.
2. **Stripe's own annotations:** `submit_payment` is `consequentialHint: true`; `get_order_summary` is read-only and untrusted-content; `fill_payment_form` and `select_payment_method` have none set (consistent with no Allow prompt for the form fill in run 3).
3. `get_order_summary` gives the agent's code a dependable amount, currency and `livemode` to **enforce the spending rule before `submit_payment`**, independent of the model.

---

## 2026-11-13 (UTC-7): Phase 2, building the owner's agent (Stage A)

Owner choices: install deps; copy the key locally; Stage B switches off only the knowledge; hidden window with `--show` (D26).

1. **Installed** `puppeteer-core` 25.17.0 and `@anthropic-ai/sdk` 1.8.0 in the project ("found 0 vulnerabilities").
2. **Copied `ANTHROPIC_API_KEY`** from `webmcp-extension/.env` to the project `.env`, file to file, never displayed (106 characters, `sk-ant-`). `.env.example` gains an empty `ANTHROPIC_API_KEY=` line. `wrangler.jsonc` `secrets.required` limits the store to its two secrets. **Verified:** the bindings list shows only `STRIPE_SECRET_KEY` and `ADMIN_TOKEN`.
3. **Plan step 1, page wording:** `create_checkout` now adds a factual "What to expect on Stripe's page" paragraph (the form tool may not report back; submitting returns the tab to the store). `open_checkout`'s description says the store's tools are unavailable until the tab returns.
4. **Read the SDK's current TypeScript tool-use reference** (manual agentic loop; forced `tool_choice` is not allowed on Opus 5.5) before writing the loop.
5. **Built `agent/`:** `policy.mjs` (spending rule), `browser.mjs` (Chrome and tools), `knowledge.md` (the context layer), `run.mjs` (`npm run agent`). Design in D26.
6. **Checks:**
   - `node --check` on all agent files: OK.
   - Spending rule: `tests/agent-policy.test.mjs`, **15/15**. Allows exactly $1.00 test-mode USD; refuses $1.01, live mode, missing livemode, EUR, recurring, a non-integer amount, the wrong page or tool origin, a missing, unreadable or timed-out summary, and a second purchase.
   - Browser only (no model call): the agent sees `sign_in` on the store with its schema; settled in 1680 ms.
   - Store suites after the wording change: auth 33/33, tools 20/20, purchase 25/25 (the server-log check was skipped because its log variable wasn't set).
7. **Not yet run end to end with the model:** that spends the owner's Anthropic credit, so it is the owner's first dispatch.

---

## 2026-11-13 (UTC-7): Owner's first agent dispatch (`npm run agent -- --show`) and fixes

The run record is in `docs/test-runs/agent/2026-11-14T00-29-12-context-full.md` (redacted; checked: 0 code-shaped strings, 0 Stripe session URLs, 0 keys, 0 download tokens). Analysis appended there.
- **Paid, but no PDF.** Every step through `check_order` = paid worked, including **the spending rule allowing exactly 100 usd test mode** before `submit_payment`. Turn 9 was given **no tools**, so the model ended before `get_download`.
- **Cause:** a `settle()` bug. The network-idle wait consumed the whole budget and the tool check never ran.
- **Reproduction without the model** (`scratchpad/repro-turn9.mjs`, scripted tool calls, free in Stripe test mode):
  1. It did not reproduce turn 9 headless (7 tools seen in 6 samples).
  2. It **found a second issue:** `settle()` returned while still on Stripe, before Stripe's redirect, after `submit_payment`.
- **Fixes (general abilities, not store knowledge):**
  1. Cap the network wait at 5 s and always run the tool check at least once.
  2. After a consequential action, wait up to 30 s for navigation before settling (the listener starts before the action).
  3. If an allowed page shows no tools, settle once more.
- **Checks:** a busy-network test (the page fetches every 150 ms) → `settle` returns `[sign_in]` in about 1.6 s; policy tests 15/15; syntax OK.
- **Not confirmed:** whether a visible window had any other cause. The next `--show` run will show it.
- The owner asked about Chrome download settings: not needed. The agent's Chrome uses its own temporary profile and download folder (`agent-downloads/`).
- The owner typed `get_download` into PowerShell after the run. Harmless: it's a tool name on the page, not a terminal command.

---

## 2026-11-13 (UTC-7): Owner's second dispatch, **first fully autonomous purchase (Stage A)**

`npm run agent -- --show`, context full. Record: `docs/test-runs/agent/2026-11-14T01-03-44-context-full.md`.
- 10 turns, about 1 minute of model time plus the 30 s form timeout. sign_in → get_product → create_checkout → open_checkout → (Stripe) get_order_summary + select_payment_method → fill_payment_form (timeout, expected) → **spending rule allowed 100 usd, livemode false** → submit_payment → the agent waited for the redirect ("page moved to http://localhost:8787") → check_order = paid → get_download (596 bytes, delivered) → final report.
- **Verified independently:** store log `stripe=complete/paid -> paid` and `served PDF`; the file is 596 bytes and `pdftotext` = "You now own this PDF."; 0 secrets in the record or the store log.
- **No human input during the run.** This is the goal in `docs/PLAN.md` step 2: dispatched from the terminal, it returned with the PDF.
- **Next per the plan:** Stage B (`npm run agent -- --context none`).

---

## 2026-11-13 (UTC-7): Stage B, the agent without store knowledge, **success**

The owner asked whether Stage B was worthwhile, given the ultimate goal of *outside* agents completing the purchase. Advice: yes, but keep it small. It shows whether the page explains itself; it does not stand in for outside agents, whose success on the Stripe-page route depends mostly on Stripe and agent makers. Agentic commerce makes "is the page enough?" the whole question. The owner ran it.

Record: `docs/test-runs/agent/2026-11-14T01-15-21-context-none.md`.
- **Result:** bought, paid (`stripe=complete/paid`), delivered (596 bytes, "You now own this PDF."), signed out. No human input.
- **Key finding:** the hint that Stripe's form tool doesn't report back reached the model **from the store page's `create_checkout` text** (plan step 1), not from `knowledge.md`. Without the knowledge, the model was slightly more careful: it re-checked the order summary before paying.
- **Takeaway for outside agents:** with capable general abilities, the store side is now self-explanatory. The remaining risk for outside agents is in their own abilities (iframe tools, waiting, timeouts) and in Stripe's tool behaviour, not in this page.

---

## 2026-11-13 (UTC-7): Plan updated; agentic commerce research (track 4)

- `docs/PLAN.md`: steps 1–3 marked ✅ with links to the run records. New step 5 (test real outside agents). Step 4 marked "research done, awaiting decision".
- Research: three parallel doc reads (Stripe seller side; Stripe agent side; the ACP spec). One fetched page contained unrelated injected text; the reader ignored it and it was treated as data only.
- Findings and recommendation in **`docs/research/AGENTIC-COMMERCE.md`**:
  - **Shared Payment Tokens** let a seller charge an agent-created, limited, single-use credential with one PaymentIntent call. There is a **sandbox test helper**. The preview API is `2026-09-30.preview`, with preview terms.
  - ACP is an open REST checkout spec (OpenAI and Stripe); an MCP binding is unreleased; WebMCP is not mentioned.
  - **Recommendation:** a test-mode prototype of a `pay_order` WebMCP tool that accepts an SPT, alongside the Stripe-page route.
  - **Prerequisites are the owner's:** preview terms; adding PaymentIntents permission to the restricted key.
  - **Key unverified point:** whether any agent's SPT can be charged without a prior "commerce relationship".

---

## 2026-11-14 (UTC-7): SPT preview terms reviewed; sandbox-and-free-only decision

- The owner pasted Stripe's "Agentic Commerce Seller Services (Preview)" terms (last modified 2026-09-28) and asked about concerns. A practical reading (not legal advice): no concern for test-mode use. Token rules (3.5: single authorization, no expired or revoked tokens) already match the design. The catalogue and brand licences (4, 5) apply only to catalogue or AI-platform listing. The merchant duties (3.2–3.4, 3.8, 3.9) matter only for real transactions.
- **Owner decision (D27):** "remain free and in Stripe's sandbox mode". No real business, no real charge, no paid services. `PLAN.md` updated: the brief's real $1 charge and paid domain are dropped; the test-mode guards are permanent.

- **2026-11-16:** the owner clarified that **a domain is the one allowed cost**; no legal work or business formation (D27a). Approved starting the Shared Payment Token prototype (plan step 4).

- **2026-11-16:** the owner asked for a refresher and an options review before the Dashboard step. Docs re-checked; summary appended to `docs/research/AGENTIC-COMMERCE.md`.

---

## 2026-11-16 (UTC-7): Shared Payment Token prototype, Dashboard setup and a free sandbox probe

**Owner, in the sandbox Dashboard:**
- added **PaymentIntents: Write** and **Shared Payment Token: Write** to `pdf-supplier-local`; key unchanged (checked: `rk_test_`, length 107);
- shared their public Stripe profile handle (for outside agents later; not recorded here).

**Probe** (scratchpad `spt-probe.mjs`, `Stripe-Version: 2026-09-30.preview`, key never printed):
- First run: **403 `more_permissions_required`**. Stripe's error named the missing permission: "**Shared Payment Token Test Helpers Write** (`shared_payment_token_test_helper_write`)". The docs don't list it. The owner added it (key unchanged).
- Second run:
```
1. Create test SPT (limit 100 usd, 1 h)      ok: spt_…, livemode=false, usage_limits {currency usd, max_amount 100, expires_at …}
2. Charge it 100                              ok: PaymentIntent pi_… status=succeeded amount=100 livemode=false
3. Charge the same token again                refused: 400 "…already in a deactivated state."
4. New token (limit 100), charge 101          refused: 400 "…greater than the remaining amount capturable with this shared payment granted token."
5. Token 1 afterwards                         deactivated_reason=consumed
```
**Conclusion:** SPTs work in this sandbox with a restricted key holding **PaymentIntents Write + Shared Payment Token Write + Shared Payment Token Test Helpers Write**. Single use and the amount cap are enforced by Stripe. **Building** the `pay_with_token` tool and the agent's test wallet next.

### Built: the Shared Payment Token route (D28)
- Store: `pay_with_token` tool plus `/api/pay-with-token`; `check_order` handles token orders; `open_checkout` refuses them. `get_product` lists both ways to buy.
- Agent: `agent/wallet.mjs` (test SPT per run), `--route token|stripe-page` (default token), a token-payment spending check, the post-payment navigation wait limited to other sites' tools, `spt_` redaction, and a `knowledge.md` note.
- **Tests:** `node --check` OK. `tests/agent-policy.test.mjs` **22/22** (7 new token cases). New `tests/token-checks.sh` against the sandbox: **17/17**, including "same token again → 402 'not accepted by Stripe'" and "no payment token in the server log". Regression: auth 33/33, tools 20/20, purchase 26/26.
- **Not yet run with the model:** that uses the owner's Anthropic credit, so it is the owner's dispatch.

---

## 2026-11-16 (UTC-7): Token route, owner's agent runs (both succeeded)

| Run | Route | Context | Turns | Result |
|---|---|---|---|---|
| `2026-11-17T05-05-53-token-context-full` | token | full | 4 | sign_in → pay_with_token (spending rule allowed: run's own token) → get_download → report. **PDF correct** |
| `2026-11-17T05-09-35-token-context-none` | token | none | 5 | sign_in → get_product → pay_with_token → get_download → report. **PDF correct** |
| *(for comparison)* `2026-11-14T01-03-44-context-full` | stripe-page | full | 10 | including a 30 s form timeout and a cross-site redirect |
| *(for comparison)* `2026-11-14T01-15-21-context-none` | stripe-page | none | 11 | ditto |

- Store log: `pay_with_token: … stripe=succeeded -> paid` and `download: served PDF` for both orders. **Payment tokens in the store log: 0.** Records checked: 0 codes, 0 tokens, 0 keys.
- **No human input during either run.** The owner hit an unrelated terminal error between runs (details not shared; resolved by restarting the terminal). It didn't affect the runs.
- **Finding:** on the token route the whole purchase happens through **the store's own WebMCP tools**: no third-party page, no iframe tools, no timeouts, no navigation. Without context, the agent found `pay_with_token` from the page alone (it read `get_product`, which lists both ways to buy, then paid).
- **What this still doesn't show:** whether an *outside* agent can obtain a token addressed to this store (a real agent needs its own Stripe account or a person's Link agent wallet, plus the store's Stripe profile ID), and whether Stripe requires a prior seller–agent relationship for that. Here the token came from the store's own sandbox test helper.

---

## 2026-11-16 (UTC-7): New goal, a public sandbox store for outside agents (D29)

- **Owner's goal:** the page live so that agents such as **Meta Muse** can buy and download. The owner asked to explore `say_hello`, `get_stats`, `leave_feedback` and `get_test_card`.
- **Web search on Meta Muse** (Wikipedia, ai.meta.com/muse, Meta help, Arcjet, Zapier, tjrobertson.com, anythingmcp.com): Muse runs in a Meta-hosted cloud VM with a full browser (seen by sites as Chrome on Linux). **One third-party source says Muse doesn't natively support WebMCP yet** (Meta AI does). Unconfirmed by Meta.
- **Owner decisions:** any visiting agent may buy (with limits); visitors pay by **page-issued test token and/or test card**; owner sign-in stays, optional.
- Plan drafted in plain terms: `docs/PLAN.md`, "Phase 3" (**awaiting confirmation**).

---

## 2026-11-16 (UTC-7): Phase 3 step 1, the public sandbox store, built and tested locally

- **Owner's working agreement (D30):** no step-by-step approvals; make sure the security walls are right for agentic traffic.
- **Built:** visitor sessions; the public tools `get_test_payment_token`, `get_test_card`, `say_hello`, `get_stats`, `leave_feedback`; public `get_product`; the limits table; admin brute-force cut-off; a clean-up alarm; `npm run report`; `unlock` also resets limits; agent `--route visitor`. Security reference: **`docs/SECURITY.md`**.
- **Checks:**
  - Chrome lists **12 tools**, all within the recommended name, description and parameter limits; `pay_with_token` is the only consequential one.
  - Local `wrangler dev` accepts a client-sent `CF-Connecting-IP`, which the tests use to simulate different visitors. **On Cloudflare this must be confirmed unforgeable before go-live.**
- **Tests:**
  - New `tests/public-checks.sh`: first run 41/42. The failure was a test mistake: it looked for the page script's "ways to buy" text in the server response. Fixed: **42/42**.
  - Earlier suites, adjusted for D29: auth 33, tools 22, purchase 25, token 17, policy 22. All pass.
  - Proven: a visitor buys and downloads without sign-in; orders isolated; names and feedback never in stats or the server log; feedback limited **per visitor**; 11th wrong admin password in an hour → 429; the kill switch closes everything and ends visitor sessions.
- **Bugs caught along the way:** shell quoting broke two of my ad-hoc check one-liners (replaced with a real in-Chrome tool listing).
- **Waiting:** a visitor-route agent run (the owner's Anthropic credit) and the owner's approval of new page text.
- **2026-11-16, owner changes:**
  - Admin brute-force cut-off lowered from 10 to **5 wrong tries per visitor per hour** (`ADMIN_FAILS_PER_HOUR`). The test now checks attempts 1–5 → 401, the 6th → 429, and that **the correct password is also refused** from that visitor for the rest of the hour.
  - **Page text updated** (paragraph 2, owner-approved wording: "Any AI agent is welcome to try buying it…"). "prove who it's acting for" in paragraph 1 kept pending the owner's answer.
  - The owner asked about "no raw visitors stored" and wants a **server log to analyse traffic** (design question pending).
  - Tests: public 48/48, tools 22/22.
  - A combined commit-and-push command was **blocked by the safety classifier**. Nothing ran. Pushes go back to asking the owner first.
- **Visitor run** (`docs/test-runs/agent/2026-11-17T05-36-57-visitor-context-none.md`; no code, no payment details, no context; task "Buy the PDF from the store open in this tab and download it."): **success in 4 turns**. `get_product` + `get_test_payment_token` → `pay_with_token` (spending rule allowed: a token the store issued during this run) → `get_download` (596 bytes, correct) → report. It didn't use `say_hello` or `leave_feedback` (optional). Record: 0 codes, tokens or keys. **Step 1's local goal is met:** a stranger agent can buy from the page alone.
- **2026-11-16, owner decisions:** traffic log with **no raw IPs**; drop "prove who it's acting for" from paragraph 1; push approved (done: `6033acd`).
  - **Page:** paragraph 1 now reads "…whether an AI agent can find a store, pay, and take delivery using only the tools this page publishes…".
  - **Traffic log built:** one entry per request (time, method, path, tool, status, daily-scrambled visitor ID, country, network operator, browser description), written after the response via `ctx.waitUntil`. **No IPs or secrets**; download paths stored as `/download/[token]`. Capped at 5,000 a day, kept 30 days (clean-up alarm). Owner: `npm run traffic [-- --days N] [--csv]` (exports to git-ignored `traffic-export/`). The Worker's `fetch` now wraps a `route()` function so every response can be logged.
  - **Tests:** public-checks **56/56** (8 new traffic checks: admin-only, summary works, CSV has no raw IPs, tokens, download secrets or feedback text, and is git-ignored); auth 33, tools 22, purchase 25, token 17, policy 22.
  - Locally, country and network are empty (Cloudflare supplies them in production).

---

## 2026-11-16 (UTC-7): Go-live research (Cloudflare and WebMCP origin trial)

The owner asked to start the go-live checks and whether they're likely to be accepted into the origin trial; they pasted the registration page and the trial blog post. Three parallel doc reads. Findings in **`docs/research/GO-LIVE.md`**:
- **Origin trial:** "public and open to all developers"; no review step documented, so acceptance is very likely (it's a registration, not an application). Trial: Chrome 149–162, ends **Mar 29, 2027** (registration page). Tokens last 6 weeks and are renewed with feedback. Deployed as an `Origin-Trial` header; tick "match all subdomains".
- **Cloudflare free plan:** over-limit gives errors, not charges (Workers 100k req/day; Durable Objects on Free, SQLite-backed: 100k requests, 100k rows written and 5M rows read per day, 5 GB). The domain needs a payment method (at cost).
- **⚠️ Capacity finding:** the store makes several storage calls and writes per request, so free storage quotas could be exhausted by about 15–25k site requests a day (estimate), knocking the store offline until midnight UTC. **Fix before launch:** one storage call per request, fewer writes.
- **Security:** whether Cloudflare overwrites a visitor-supplied `CF-Connecting-IP` is **not stated**; verify on the live site (global caps remain the backstop). Keep **Bot Fight Mode off** (it challenges automated traffic). AI agent policy defaults to Allow for new domains. Free WAF: 1 rate-limit rule (per IP, 10 s).

### Capacity fix (before go-live)
- **Problem (from the go-live research):** each request made several separate Durable Object calls and writes. The free plan's 100k DO requests a day and 100k rows written a day would run out at roughly 15–25k site requests a day.
- **Fix:** a single **`Store.gate()`** call per request (page, `/api/*`, `/download/*`). It does the kill switch, the session (`lastSeen` refreshed at most once a minute), the hourly API budget (per visitor + global) and the visit and tool counters, and decides whether to log. Writes: the visitor's hourly record `v:<cid>:<day>` + one shared record `g`. **A visitor already over the limit costs 0 writes**, and only its first refusal per hour is logged. Helpers (`validSession`, `isClosed`, `clientId`) read the gate's answer from a per-request context (`RC` WeakMap). The traffic log's daily cap is counted in memory (no extra write). Global API budget lowered **20,000 → 1,500/hour**, sized to the free plan. `npm run unlock` also clears the `v:` records and the shared hourly counter. The clean-up alarm removes old `v:` records.
- **Measured** with Wrangler's local observability query (3 requests: page, `get_product`, `get_stats`): **7 DO subrequests in total** (2, 2 and 3), with 6 put operations (about 2–3 rows each).
- **Estimated capacity:** about 33k requests a day before the free rows-written limit (before: about 15k). Rate-limited floods cost DO requests but no writes.
- **Tests after the fix:** public 56/56, auth 33/33, tools 22/22, purchase 25/25, token 17/17, policy 22/22.

---

## 2026-11-16 (UTC-7): Go-live code; the owner has a Cloudflare account and bought the domain

The owner reported signing up for Cloudflare and buying the domain (assumed **pdfsupplier.com**, to be confirmed).
- **`wrangler.jsonc`:** `workers_dev: false`, `preview_urls: false` (one public origin). Custom-domain routes for `pdfsupplier.com` and `www.pdfsupplier.com`. Public `vars`: `ORIGIN_TRIAL_TOKEN` (empty until registered) and `CANONICAL_HOST`.
- **Worker:** `www.` redirects (301) to the bare domain. The page sends an `Origin-Trial` header when a valid-looking token is configured.
- **Owner commands:** `--live` points them at the live site with a separate `ADMIN_TOKEN_LIVE`. **`npm run setup-live`** generates that password into `.env` and pipes it to `wrangler secret put ADMIN_TOKEN` without displaying it.
- **Bug found by the test suites:** with routes configured, `wrangler dev` presented requests as coming to `pdfsupplier.com`, so locally built download links pointed at the (not yet live) real domain (public 54/56, token 16/17). Fixed with `dev.host: "localhost:8787"` and `local_protocol: "http"`, then a dev-server restart.
- **Second test failure:** "traffic summary missing tools". Cause: `npm run traffic` listed only the top 10 tools, and after a day of tests `get_test_payment_token` ranked 11th. Fixed by listing all tools (the store has 13).
- **Unverified locally:** the www redirect (local dev doesn't present the www host). To check on the live site.
- `npx wrangler deploy --dry-run`: 74.88 KiB (gzip 20.47 KiB); bindings STORE, ORIGIN_TRIAL_TOKEN, CANONICAL_HOST.
- **Tests:** public 56, auth 33, tools 22, purchase 25, token 17, policy 22. All pass.

## 2026-11-17: Live on pdfsupplier.com

- Second restricted sandbox key created by the owner and kept in `.env` as `STRIPE_SECRET_KEY_LIVE` (checked: `rk_test_`, different from the local key; value never displayed).
- `npx wrangler login` done by the owner.
- First deploy failed: a brand-new Worker can't take `wrangler secret put` before it exists, and `secrets.required` blocks a deploy without them. Fix: `npm run setup-live` now deploys with `--secrets-file`, using a temporary file in a private temp folder that is deleted straight after.
- Second attempt failed with Cloudflare error 10063 ("You need a workers.dev subdomain"), which hits new accounts. Opening Workers & Pages in the dashboard once fixed it. (A "Cloudflare Access / Zero Trust" prompt appeared on that page and is not needed.) `workers_dev` stays false.
- Deployed version a63c5e89. Checked live: page 200 with CSP; `get_product` OK; `npm run report -- --live` works with the live admin password; `www` 301s to `https://pdfsupplier.com/` (the local DNS cache briefly said www didn't exist; Cloudflare DNS had it).
- Still to do: origin-trial token, Bot Fight Mode off and one rate-limit rule, live security and purchase checks.
- Origin-trial token registered by the owner (WebMCP, https://pdfsupplier.com:443, subdomains, expires 2027-03-30) and added to `wrangler.jsonc`. Deployed version 585452b5; the `Origin-Trial` header appeared live about a minute after deploy (propagation).
- Owner added the Cloudflare rate-limit rule on `/api/`.
- Live checks (`tests/live-checks.sh`, new; the local suites fake visitor IPs and run the password-guessing test, which would lock the owner out of the live owner commands for an hour). First run: 45/50. The real findings were: (1) `http://` served the page instead of redirecting, now fixed in the Worker with a 301 to https and an HSTS header; (2) Cloudflare **refuses** any visitor-supplied `CF-Connecting-IP` (403, error 1000), so the spoof test now checks that, and checks that `X-Forwarded-For` etc. don't change the visitor ID. The other three were test mistakes (no-session download requests get 401 by design; one missing status capture). After the fix: deployed 5a88a012, **52/52 live checks pass**, all local suites pass (56/33/22/25/17/22).

## 2026-11-17: What the live checks did NOT cover (card route)
- The store takes payment two ways. **Token route** (`get_test_payment_token` → `pay_with_token` → `get_download`): it's only messages between the agent and the server, so `tests/live-checks.sh` ran the whole purchase on the live site and passed.
- **Card route** (`create_checkout` → the agent goes to **Stripe's hosted payment page**, types the test card and pays → Stripe sends it back to pdfsupplier.com → `check_order` → `get_download`): the check script can't fill in a web page. On live it verified only that Stripe issued a real sandbox checkout page, and that downloading before paying is refused. **Untested on live:** paying on Stripe's page and the return trip to `https://pdfsupplier.com`. It worked locally (Phase 1 run 6; Phase 2 stripe-page route), and the code is unchanged; only the return address differs. Planned as the first run of Step 3: own agent, `stripe-page` route, against the live site.

## 2026-11-17: Step 3, first outside agent: Claude in Chrome (no purchase)
- The owner asked Claude in Chrome, in everyday Chrome 157 with no flag, to buy the PDF. It **stopped before calling any tool**. It said WebMCP wasn't available because `navigator.modelContext` doesn't exist, and that it wouldn't call the server directly. It suggested turning on a Chrome flag and adding an on-page message.
- **Checked:** wrong diagnosis. The page uses `document.modelContext`. A Puppeteer probe of the live page in the same installed Chrome 157 with **no flag** found `document.modelContext` present and the 12 public tools registered; `navigator.modelContext` is undefined. **The origin-trial token works in ordinary Chrome.**
- Takeaways: Claude in Chrome doesn't use WebMCP tools natively; it found them by reading `app.js` and looked under the wrong name. Its refusal to call the server directly shows the no-forms design holds against a general browsing agent. Write-up: `docs/test-runs/2026-11-17-0840-claude-in-chrome.md`.

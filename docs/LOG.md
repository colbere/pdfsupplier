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

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

## D18. New tool `open_checkout`: the page moves the tab to Stripe (changes the brief's six tools to seven)
- **Date:** 2026-11-13, after agent run 1. **Approved by the user.**
- **Decision:**
  - `open_checkout(order_id)` (sign-in only; `readOnlyHint: false`, `consequentialHint: false`).
  - It asks the server, through the session check, for the order's Stripe URL. The order must belong to this session, be unpaid and not be expired.
  - The page then runs `window.location.assign(url)` and leaves the tool's promise unresolved.
  - `create_checkout` still returns the URL (as the brief says), and its "Next" hint now points to `open_checkout`.
- **Why it works:** the extension has no navigation ability of its own (run 1), but `executeTabTool` handles a tool that navigates. When the message channel closes, it waits for the new document, its content script, its tools and page load, then carries the conversation on there ("A tool can also open a tab of its own, and the flow then carries on there"). Stripe's hosted page then publishes its own WebMCP tools (Q3).
- **Rule 3 check:** the URL is still never in our page's HTML or DOM. The navigation happens in script, only for a signed-in session's own order.
- **Alternatives (shown to the user):**
  - Stripe Embedded Checkout: rejected, because it puts a human-usable payment form on our page (rule 3) and its WebMCP behaviour differs.
  - Stop and record: rejected by the user.
  - `window.open` to a new tab: not chosen, because popups without a user gesture are likely to be blocked.
- **Open risk:** after navigation the extension asks the new page for a "cross-document result" (JSON-LD), which Stripe's page won't have, so the model may see an empty result for `open_checkout`. The extension's system prompt tells it to continue with newly available tools.

## D19. `get_download` saves the PDF itself
- **Date:** 2026-11-13, after agent run 1. **Approved by the user** ("get_download starts it").
- **Decision:**
  - `get_download` still gets the single-use link from the server.
  - The page then immediately `fetch`es it (same origin, with the session cookie), checks that the file starts with `%PDF-`, and saves it via a detached `<a download>` pointing at a local `blob:` URL. Nothing is added to the page and there is no navigation.
  - The tool reports the byte count and that the file was saved.
  - **Difference from what the user was shown:** the user's option said `get_download` would "still return the link". Because the link is single-use, fetching it uses it up, so on success the tool says it was used instead of returning a dead link. If the automatic save fails, the tool returns the (still unused) link as before.
- **Why:** the extension can't open links (run 1), so a returned link alone would leave the PDF undelivered. It also fixes most of D13's "known gap", because the link is used in the same step that marks the order delivered.
- **What it means for Q5:** the PDF reaches the owner's Downloads folder through the agent's tool call, but the *model* never sees the file's contents. It only sees the confirmation and the size.

## D20. Local patch to the test agent: accept subframe tools from `*.stripe.com`
- **Date:** 2026-11-13, after agent run 2. **Approved by the user** ("let's move on to 2. I'd like to see if we can make this work").
- **Finding that led here:** the extension already re-lists tools after every round (`waitForToolsToSettle` → `requestTabTools`), so the list wasn't stale. Instead, the extension learns tools **only** through the top frame's `getTools({ fromOrigins })`, which returns a subframe's tools only if that subframe **exposed** them to the top origin. Stripe exposes `get_order_summary`, `select_payment_method` and `submit_payment` this way (they arrived as frame `401`). `fill_payment_form`, visible in DevTools, never did. Separately, the side panel discards any report from a subframe (`if (sender.frameId !== 0) return`).
- **Decision:** patch the local clone only (`c:\claude\webmcp-extension`, base `051a93c`; full diff in `docs/extension-patch.diff`, 2 files, +94/−2):
  - `extension/content.ts`: in a subframe whose origin matches `^https://([a-z0-9-]+\.)*stripe\.com$`, list the tools that frame registered itself (`getTools()` filtered to `tool.window === window`). Report them as `{ subframeTools }` now and on every `toolchange`.
  - `extension/sidepanel/hooks/useActiveTabTools.ts`: accept a `subframeTools` report only if **Chrome's sender record** shows both the frame URL and the tab URL on that allow-listed origin. Stamp the tools with Chrome's `sender.frameId`, so a frame can only speak for itself. Merge with the top frame's list, de-duplicated by frame and name. Clear both on navigation.
  - Tool **execution** in a subframe was already supported upstream (`executeTool` finds `t.window === window` in the target frame).
- **Checks:** `npm run typecheck` passes; `npm run test:unit` **209/209 pass**; rebuilt `dist/` contains the patch.
- **Why limit it to Stripe:** the upstream rule (only exposed subframe tools reach the agent) is a deliberate safety boundary, so an arbitrary iframe such as an ad can't offer tools to the agent. The patch relaxes it only for Stripe frames on Stripe tabs.
- **For the write-up:** the agent is no longer stock. Runs from run 3 onward use "extension `051a93c` + local patch D20". The underlying question (should agents see tools that a subframe didn't expose to the top origin, and is Stripe's split intended?) is worth raising with Google and/or Stripe. **Not filed: needs the user's OK.**

## D21. Second local patch to the test agent: tool time limit and a result after navigation
- **Date:** 2026-11-13, after agent run 3. The user asked: "Review the process and make any required fixes."
- **Decision:** in `extension/sidepanel/services/extensionBridge.ts` (`executeTabTool`):
  1. **30-second limit** on a page tool's reply. On timeout the model gets an error: "The page's tool "X" did not finish within 30 seconds. It may still have taken effect on the page. Check the current state with another tool before trying it again."
  2. **After a navigation**, if the cross-document result request fails (the frame is gone) or returns nothing, the model gets: "The tool "X" caused a navigation. The tab is now on `<origin>`. Use the tools available on this page to continue." Before, it got an error or `null`.
- **Why:** run 3 froze at `fill_payment_form`. Code review also showed that `submit_payment`, which redirects the tab back to our store, would have returned an **error** to the model even after a successful payment. Fix 2 also improves `open_checkout`'s result, which was `null`.
- **Checks:** typecheck passes; unit tests **209/209**; rebuilt. The cumulative patch (D20 + D21) is 3 files, +139/−12, in `docs/extension-patch.diff`.

## D22. Checkout is card-only, with Link turned off
- **Date:** 2026-11-13, after agent run 4. The user asked for fixes. The user also spotted the "Save my information / Mobile number" section and suspected it.
- **Decision:** Checkout Sessions are created with `allowed_payment_method_types[0]=card` and `wallet_options[link][display]=never`.
- **Verified:** a test session created with these settings reads back `payment_method_types: ["card"]`, `allowed_payment_method_types: ["card"]`, `wallet_options: {"link":{"display":"never"}}`, `phone_number_collection: {"enabled":false}`, `livemode: false`. `purchase-checks.sh` gives 26/26.
- **Alternatives:**
  - `payment_method_types=["card"]`: **rejected by the docs.** "Starting with API version `2026-09-30.endive`, you can't pass `payment_method_types`…" (we pin `2026-10-28.endive`).
  - Turning Link off in the Dashboard: it works too, but it is an account setting outside the code, and not reproducible from the repo.
- **Reason:** Link's opt-in added a required phone field that no agent tool fills, which blocked payment in run 4. The brief only calls for a test card. Card-only also removes the Cash App and Klarna choices, so the agent has a simpler form.

## D23. Third local patch to the test agent: wait for a new page's tools; don't drop the chat on late results
- **Date:** 2026-11-13, after agent run 5. The user asked for fixes.
- **Decision:**
  1. `waitForToolsToSettle` gets an optional `emptyTimeoutMs`.
     - While the page reports **no** tools, it waits up to that long instead of `timeoutMs`.
     - Once tools arrive late, it still allows the normal quiet period after the last report, capped at the same limit.
     - The agent loop passes `emptyTimeoutMs: 15_000`. The default behaviour is unchanged for other callers, and the upstream tests are untouched.
     - New unit test added. **The first version failed that test:** it returned the instant tools appeared, skipping the quiet period, which could miss Stripe's later tools. Fixed, and the test passes.
  2. `server/server.ts`: if tool results arrive for a chat that **exists** but has no pending call (run 4's 409), the server passes them to the model as a clearly marked note ("[Note from the agent app, not the user] These tool results arrived after the conversation had moved on: …") instead of ending the chat. The 409 remains for a chat that is truly gone.
- **Checks:** typecheck passes; unit tests **210/210** (209 upstream + 1 new). Rebuilt; model server restarted. The cumulative patch (D20, D21, D23): 7 source/test files (plus a `package-lock.json` change from `npm install`), in `docs/extension-patch.diff`.
- **Not verified live yet:** the late-results path. Exercising it would need a real model call in the failure state from run 4.

## D24. The experiment's subject is the WebMCP tools on the owner's own page
- **Date:** 2026-11-13, after Phase 1 closed. **Stated by the owner:** "I'm less concerned about the agent using the payment page's webmcp tools. This is about the webmcp tools on my own page."
- **Decision:** what is being tested is whether an agent can complete a purchase through **the store's own WebMCP tools**. Stripe's hosted page and its tools are a means of taking payment, not the subject.
- **Consequences:**
  - Phase 1's failures (all on Stripe's page or in the extension) are recorded as obstacles *around* the subject, not failures of it.
  - **Agentic commerce** (paying through a tool on the store's page) becomes a candidate future track, because it keeps the whole purchase on the store's tools. Kept alongside the Stripe-page route for comparison.
  - The later "agent without context" test (Stage B) measures what the store's page alone gives an agent.
- **Owner intent (also stated):** first an agent with full context (Stage A), later one without (Stage B). Keep all documentation of what didn't work.
- **Plan:** `docs/PLAN.md`, a draft awaiting the owner's confirmation. Nothing built yet.

## D25. Owner's choices for the next phase
- **Date:** 2026-11-13. **The owner confirmed `docs/PLAN.md` ("that is all correct") and decided:**
  1. **Stage B's "agent without context"** = the owner's own agent with the extra-knowledge layer switched off (not the stock extension or another vendor's agent).
  2. **The owner's agent uses a spending rule only**, with no confirmation prompt: "ideally, I dispatch it from my terminal and it returns with the pdf." This **changes the brief's Phase 2**, which listed "spend caps and a confirmation step". The spending rule (amount, store, number of purchases) becomes the safeguard, so it must be enforced by the agent's code, not left to the model.
  3. **Do not report** the Stripe or extension problems (D20, D21, D23, Q3, Q15) to Stripe or Google.
- **Supersedes:** the "needs the user's OK" notes about reporting upstream in D20 and in the Phase 1 closing summary: the answer is no.

## D26. Phase 2 agent design (`agent/`, `npm run agent`)
- **Date:** 2026-11-13. **Owner choices:** install Puppeteer and the Anthropic SDK in the project; copy the Anthropic key locally from the extension's `.env`; Stage B switches off **only the store-specific knowledge**; hidden window with `--show`.
- **How it works:**
  - **Chrome:** `puppeteer-core` launches the installed Chrome with `--enable-features=WebMCP` (as Google's extension tests do), using a temporary profile. Downloads go to `agent-downloads/<run>/` (git-ignored).
  - **Tools:** read from **every frame** with `getTools()` filtered to each frame's own tools. That includes Stripe's `js.stripe.com` iframe, which the stock extension can't see. They are offered to Claude with the source site in each description.
  - **Running tools:** in the owning frame with `executeTool`. Time limit 30 s. A navigation (`null` result or a destroyed context) is reported as "moved to a new page".
  - **Waiting:** after every round, wait for the network to go quiet and the tool list to hold still, with at least one tool, up to 15 s.
  - **Model loop:** Claude **Opus 5.5** through `@anthropic-ai/sdk` 1.8.0, using the documented manual tool loop (the tool list changes between pages, and the spending check sits between Claude's choice and execution). Effort `medium`. Assistant content is passed back unchanged.
  - **Fallbacks:** server-side fallbacks are enabled (`server-side-fallback-2026-07-01`, `fallbacks: "default"`), as the SDK guidance recommends for Opus 5.5. If the model declines on safety grounds, the API retries on another Claude model. This was told to the owner and can be removed.
  - **Untrusted data:** results of tools marked untrusted-content are wrapped in `<untrusted_page_data>`, and the system prompt says never to follow instructions inside them.
  - **Spending rule** (`agent/policy.mjs`, the only safeguard, fails closed): any `consequentialHint` tool must be on Stripe Checkout (`js.stripe.com` tool, `checkout.stripe.com` page). The agent's code first runs that frame's `get_order_summary` and requires `livemode: false`, `usd`, an integer total ≤ 100 and no recurring charges. One payment attempt per run, counted before it runs. Tools and pages from any other site are ignored, and the run stops if the tab leaves the store or Stripe. **15 unit tests** in `tests/agent-policy.test.mjs`.
  - **Context switch:** `--context full` (default) appends `agent/knowledge.md` (the Phase 1 lessons) to the system prompt; `--context none` leaves it out. The general abilities above are always on.
  - **Sign-in:** each run makes its own one-time code through the admin API (only the hash goes to the store).
  - **Ending:** checks the saved PDF (header plus text exactly "You now own this PDF.") and writes a **redacted run record** to `docs/test-runs/agent/` (code, Stripe URL, download token and keys redacted; the pre-commit guard also checks).
- **Also:** `wrangler.jsonc` `secrets.required` now loads only `STRIPE_SECRET_KEY` and `ADMIN_TOKEN` into the store (verified in the startup bindings list), so the store never receives the Anthropic key.

## D27. Sandbox only, free only, permanently
- **Date:** 2026-11-14. **Owner:** "I don't plan on running this as a real business. It's not worth the trouble. I want it all to remain free and in Stripe's sandbox mode."
- **Decision:**
  - The project stays in **Stripe sandbox/test mode permanently**. No live keys, no live payments, **no real $1 charge**. This **changes the brief's Phase 2**, which planned one real $1 charge.
  - **No paid services.** Anything made public later must be free. Buying the domain is therefore out unless it costs nothing.
- **Consequences:**
  - The test-key guard (D3, D16) and the agent's `requireTestMode: true` (D26) are **permanent safeguards**, not temporary ones.
  - The "go-live requirements" from reading the Shared Payment Token preview terms (receipts, a terms of service and privacy policy, sales tax, being merchant of record for real customers) **do not apply**: there are no real transactions.
  - The SPT preview terms were reviewed with the owner (not legal advice). For sandbox use they raise no concern. Sections 4 and 5 (catalogue and brand licences) apply only to catalogue or AI-platform listing, which isn't planned.

## D27a. Clarification: a domain is the one allowed cost; no legal work or business formation
- **Date:** 2026-11-16. **Owner:** "What I am willing to pay for is a domain. I don't want any legal work or business formation."
- **Decision:** amends D27. **Buying a domain is allowed** (for example pdfsupplier.com, for a public sandbox demo). Everything else stays free and in Stripe's sandbox. No legal entity, no legal documents beyond what a free sandbox demo needs, no live payments.

## D28. Shared Payment Token route: `pay_with_token` on the store, and a test wallet for the agent
- **Date:** 2026-11-16. **Approved by the owner** ("continue with option A"). Research: `docs/research/AGENTIC-COMMERCE.md`.
- **Store:**
  - New WebMCP tool **`pay_with_token(payment_token)`**: `consequentialHint: true`, sign-in only.
  - `POST /api/pay-with-token` (through `withSession`) **creates the order and charges the token once**: `PaymentIntent` with `payment_method_data[shared_payment_granted_token]`, $1.00 USD, `confirm=true`, `metadata[order_id]`, `Idempotency-Key: pay-<order>`, `Stripe-Version: 2026-09-30.preview`.
  - It refuses a LIVE result. Paid only when `succeeded` and the amount and currency match.
  - `check_order` verifies token orders against the PaymentIntent (status, amount, currency, `metadata.order_id`, id, not live). `open_checkout` refuses token orders (409). `get_download` is unchanged.
  - **The token is a payment credential: it is never logged or echoed.** Stripe's refusal reason is passed back with any token text removed.
- **Why one step (create and pay) instead of the plan's `pay_order(order_id, …)`:** fewer calls for an agent and no half-finished orders. The token is single-use anyway.
- **Stripe key:** the restricted test key now holds Checkout Sessions Write, **PaymentIntents Write, Shared Payment Token Write, and Shared Payment Token Test Helpers Write**. The last one is undocumented; Stripe's 403 named it.
- **Agent:**
  - `--route token` (new default) or `--route stripe-page`.
  - **Test wallet** (`agent/wallet.mjs`): one sandbox SPT per run from Stripe's test helper (`pm_card_visa`, limit = the spending-rule maximum, 15-minute expiry). **This is a testing shortcut**: it uses the store's own test key. A real outside agent would get its token from its own Stripe account or a person's Link agent wallet, addressed to the store's Stripe profile.
  - **Spending rule** `checkTokenPayment`: a consequential tool on the store page only, once per run (shared with the Stripe-page route), and **only with the run's own token**.
  - The 30 s "wait for the tab to come back" now applies only to consequential tools from **other** sites (the store's tool doesn't navigate).
  - The run record redacts `spt_…`. `knowledge.md` gains a token-route note.
- **Tests:** `tests/token-checks.sh` **17/17** (sandbox: pay, verify, deliver, single use, isolation, cross-origin, no token in the log); `tests/agent-policy.test.mjs` **22/22**; the earlier suites still pass (33/20/26).

## D29. Public sandbox store: any visiting agent may buy (with limits); owner sign-in becomes optional
- **Date:** 2026-11-16. **Owner's goal:** "I ultimately want this page to be live and for agents such as Meta Muse to be able to go to this page, complete a transaction, and download the PDF." The owner asked to explore four new tools: `say_hello`, `get_stats`, `leave_feedback`, `get_test_card`.
- **Owner decisions:**
  1. **Any visiting agent may buy, with limits.** This **replaces the brief's** "the only visitor who should ever complete a purchase is the owner". It stays sandbox-only (D27), so no real money can move.
  2. **Visitors can pay two ways:** a $1 sandbox **test token** handed out by the page, used with `pay_with_token` on the page itself, **and** **`get_test_card`** for agents that pay on Stripe's page. Which agents use which is part of the data.
  3. **Owner sign-in stays, optional:** visitors buy without it; the one-time code still works for the owner's own runs and owner-only extras.
- **Design rules carried forward:** rule 3 (no human interface) stays. The server stays the gate (rule 4), now with visitor sessions plus **abuse limits**. Sandbox only, free except the domain (D27, D27a). Secrets stay local or in Cloudflare secrets.
- **Known caveats:**
  - `say_hello` identities are **self-reported and unverifiable**.
  - `leave_feedback` text is **stored privately and never shown to other agents** (it could otherwise carry instructions to the next agent). It is length-capped and rate-limited, and read by the owner from the terminal.
  - The page-issued test token is **circular** (the store's sandbox pays itself). It demonstrates on-page agent payment, not real delegated payment.
  - **Meta Muse's WebMCP support is unconfirmed** (one third-party source says not natively yet). It must be tested against the live site.
- **Plan:** `docs/PLAN.md`, "Phase 3: public sandbox store" (awaiting the owner's confirmation).

## D30. Working agreement for Phase 3, and the public store's design
- **Date:** 2026-11-16. **Owner:** "I don't think I need to have every sign up or payment get my go ahead… I just want to make sure that the site has the right security walls in place since it's inviting agentic traffic."
- **Working agreement:** Claude proceeds through `docs/PLAN.md` Phase 3 without step-by-step approval. It stops only for what needs the owner personally (sign-ups in their name, paying for the domain, typing secrets into Cloudflare) or anything outside the agreement (money beyond the domain, live keys, contacting third parties).
- **Built (step 1):**
  - **Visitor sessions** are created only by endpoints that *start* a purchase (`get_test_payment_token`, `pay_with_token`, `create_checkout`), within limits. Lookups (`check_order`, `open_checkout`, `get_download`) still require a session. Owner sessions come from `sign_in` (`kind: owner`), and `sign_out` appears only for the owner.
  - **New public tools:**
    - `get_test_payment_token`: a sandbox SPT capped at the product price, 15 min.
    - `get_test_card`.
    - `say_hello`: name ≤ 60 and model ≤ 80 characters, sanitised; names private.
    - `get_stats`: numbers only.
    - `leave_feedback`: 3–500 characters; private; capped.
  - `get_product` is public and lists both ways to buy. 12 tools, all within WebMCP's recommended limits (checked in Chrome).
  - **Walls:** see `docs/SECURITY.md` (limits table, privacy, admin brute-force cut-off, clean-up alarm, kill switch closes everything).
  - **Owner tools:** `npm run report` (counters, hello names, latest feedback). `npm run unlock` now also resets rate-limit counters.
  - **Agent:** `--route visitor` (no code, no payment details; it may pay only with a token the store issued to it during the run).
- **Tests:** public-checks **42/42** (new); auth 33, tools 22, purchase 25, token 17, policy 22, all passing. Several earlier assertions were changed deliberately because D29 made `get_product` public and lets purchase-starting endpoints create visitor sessions.

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

## D31: How purchases are scored: WebMCP vs direct server calls (2026-11-17)
**Decision (owner):** a purchase made by calling the store's server directly, without WebMCP (as Meta Muse did with `curl`), **counts as a success, in a separate category** from purchases made through the page's WebMCP tools.

**Categories used in write-ups:**
1. **Bought via WebMCP:** the agent called the page's tools through `document.modelContext` (e.g. Google's example extension, our own agent).
2. **Bought via the tools' server calls (no WebMCP):** the agent made the same HTTP requests the tools make, without a WebMCP browser (e.g. Meta Muse, 2026-11-17).
3. **Did not buy:** with the reason (e.g. Claude in Chrome: looked for `navigator.modelContext`, concluded WebMCP was off).

**Why:** the server is the gate and allows direct calls by design. Every wall applies either way. Blocking non-WebMCP clients isn't possible: anything a page script can call, an HTTP client can call too. Category 2 is still a meaningful result: the WebMCP tool definitions served as the agent's instructions.

**Related:** Q19 (the hint naming `document.modelContext`) stays open: "maybe, we'll see" (owner, 2026-11-17).

## D32: `redact()` also strips Shared Payment Tokens (2026-11-17, review B3)
**Change:** `redact()` in `src/stripe.js` now replaces `spt_…` with `[REDACTED_TOKEN]`, as well as keys and checkout URLs. Every Stripe error passes through it (`StripeError`, `stripeFailure`), so a token echoed in any Stripe error message is never logged or returned. Before, only the `pay_with_token` path stripped tokens itself.
**Why:** `docs/SECURITY.md` says payment tokens are never logged. The other Stripe error paths (e.g. `get_test_payment_token`, `check_order`) didn't guarantee it. Risk was low (sandbox, $1 cap, 15-minute life).
**Tests:** `tests/redact.test.mjs` (5, made-up values). Local suites still pass: token 17, public 56, purchase 25, policy 22.

## D33: License: MIT, copyright "colbere" (2026-11-17, review A1)
**Decision (owner):** the repo is MIT-licensed (`LICENSE`), copyright line "Copyright (c) 2026 colbere" (the GitHub username, so the real name isn't added to another file). `package.json` says `"license": "MIT"`.
**Exception:** `docs/extension-patch.diff` changes Google's Apache-2.0 extension and stays under Apache-2.0 (its header says so; D32-era review item A5).
**Why:** the repo is public; with no license nobody could legally reuse it. MIT is the simplest permissive choice.


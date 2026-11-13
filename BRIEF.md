# BRIEF: The PDF Supplier (Phase 1)

You are building an experiment called **The PDF Supplier** (pdfsupplier.com). Read this whole file before doing anything. Then do **Step 0** and stop for the user's go-ahead.

## 1. Goal

Find out whether an AI agent can find a store, prove who it is acting for, pay, and take delivery using **only WebMCP tools** that a web page publishes. WebMCP is an emerging Chrome browser standard, still an origin trial, and it changes often.

This is **not a real business**. Phase 1 runs locally, in Stripe **test mode**, with no real money. The product is one PDF for $1 containing only this text: `You now own this PDF.`

The only visitor who should ever complete a purchase is the owner, through an agent.

## 2. About the user and how to work with them

- The user does **not** know how to code and wants to learn how building with Claude Code works. Explain each step in plain language before you do it. Define jargon the first time you use it.
- Limit assumptions. When something in this brief is marked **VERIFY**, or you are unsure, check the official docs or ask. Do not guess.
- Ask before: installing anything globally, creating accounts, spending money, pushing code anywhere, or changing a decision in this brief.
- Work in small steps and show the user what each one did. Run the project yourself, read the errors, and fix them, and tell the user what went wrong and why.
- Initialize a local git repository and commit at milestones. **Never push anywhere** without asking.

## 3. Hard rules (never break these)

1. **Test mode only.** The backend must refuse to start if the Stripe secret key does not begin with `sk_test_`. Never accept, store or use a live key in Phase 1.
2. **Secrets stay local.** Keys live in `.env` (git-ignored). Provide `.env.example` with placeholder values only. Never print a key in logs, output, commits or LOG.md. Never ask the user to paste a key into chat; tell them to paste it into `.env` themselves.
3. **No human interface.** The homepage is text only: no buttons, links, forms, inputs or visible payment links. The checkout URL must never appear in the page or the DOM. It is returned only by a tool, only to a signed-in session.
4. **The server is the gate.** Every purchase-related endpoint verifies the session on the server. Never rely on which tools are registered in the browser as security.
5. **Keep a log.** Maintain the documentation described in section 10 from the first step. The user plans to publish a write-up.

## 4. Verify these docs first (Step 0)

Read the current versions and record anything that differs from this brief in `LOG.md`. The API is changing quickly.

- WebMCP overview: https://developer.chrome.com/docs/ai/webmcp
- Imperative API: https://developer.chrome.com/docs/ai/webmcp/imperative-api
- Tool security: https://developer.chrome.com/docs/ai/webmcp/secure-tools
- Best practices and building tools: https://developer.chrome.com/docs/ai/webmcp/best-practices and https://developer.chrome.com/docs/ai/webmcp/build-tools
- DevTools WebMCP debugging: https://developer.chrome.com/docs/devtools/application/webmcp
- Example Agentic Chrome Extension (our test agent): https://github.com/GoogleChromeLabs/webmcp-extension/
- Stripe WebMCP in Checkout: https://docs.stripe.com/agentic-commerce/agents/webmcp
- Stripe Checkout Sessions API and test cards (find the current pages on docs.stripe.com)
- Cloudflare Workers and KV docs, and Wrangler (for local development)

What the user's research found as of 2026-11-13. **VERIFY each:**
- Entry point is `document.modelContext`. `navigator.modelContext` is deprecated.
- `await document.modelContext.registerTool(tool, { signal })` takes `name`, `description`, `inputSchema` (JSON Schema) and `execute(input, { signal })`. Aborting the `AbortSignal` unregisters the tool.
- Annotations: `readOnlyHint`, `untrustedContentHint`, `consequentialHint`.
- `getTools()` and `executeTool()` exist. Passing JSON-stringified arguments to `executeTool` is deprecated from Chrome 155.
- Limits: tool description 500 characters, parameter description 150, tool or parameter name 30, tool output 1.5K.
- Chrome 149 or later is needed. For local development, enable `chrome://flags/#enable-webmcp-testing` and relaunch Chrome.
- Chrome's security page says nothing about authentication or server-side checks. That part of the design is ours.

## 5. The site

One page at `/`. No other pages.

Requirements:
- Plain, readable, semantic HTML: one `h1`, a tagline paragraph, then body paragraphs. Minimal CSS (legible type, centered, narrow column). No images, no JavaScript-driven visuals.
- A small script that feature-detects `document.modelContext` and registers the tools in section 6. The page must still render normally in browsers without WebMCP.
- Served over a secure context (`localhost` is fine for local work).

**Copy.** The user is reviewing this text. Use it as written until the user says otherwise.

> # The PDF Supplier
> Why make a PDF at home when you can get one here?
>
> The PDF Supplier is not a real business. It's an experiment in whether an AI agent can find a store, prove who it's acting for, pay, and take delivery using only the tools this page publishes through WebMCP, a new browser standard proposed by Chrome. There's no cart, no buttons and no checkout for a person to click through. If you're reading this, you're seeing everything a human gets.
>
> There is one product: a PDF that contains a single sentence, for $1. The only tool visible to the public is a sign-in. The purchase tools appear only after the site's owner signs in with a one-time code, so no one else can buy anything. Payments run through Stripe in test mode, so no real money moves.
>
> WebMCP is new, and it's changing quickly. I couldn't find much about what happens when an agent actually tries to buy something with it, so I'm finding out. I'll write up what works and what breaks.

## 6. Tools (six)

Use the imperative API. Tool names are at most 30 characters, descriptions at most 500, output at most 1.5K. Descriptions must say plainly what the tool does and what it needs. Return concise, clearly worded text results. Declare annotations honestly.

| Tool | Available | Purpose | Annotations |
|---|---|---|---|
| `sign_in` | always | Takes a one-time `code`. On success the server starts a session and the page registers the other tools. | consequentialHint false |
| `get_product` | after sign-in | Returns the product name, price ($1.00 USD) and what it is. | readOnlyHint true |
| `create_checkout` | after sign-in | Creates a single-use Stripe test Checkout Session and returns the Stripe payment URL and an `order_id`. | Decide and record in LOG.md. It starts a payment but spends nothing. Stripe's own submit tool carries the consequential hint. |
| `check_order` | after sign-in | Takes `order_id`. Asks the server whether Stripe reports it paid. | readOnlyHint true |
| `get_download` | after sign-in | Takes `order_id`. Only if paid, returns a single-use, short-lived download link for the PDF. Marks the order delivered. | consequentialHint false |
| `sign_out` | after sign-in | Ends the session and unregisters the purchase tools. | consequentialHint false |

Notes:
- Register the post-login tools with an `AbortController`. Abort it on `sign_out`, on session expiry, and if a server call returns "not authenticated."
- Tool output is limited to 1.5K, so `get_download` must return a link plus a short confirmation, not file contents. **Open question to test:** can the agent in the extension actually retrieve a file from that link? Record what happens.

## 7. Sign-in and lockdown

- A terminal command, for example `npm run new-code`, generates a one-time code and prints it to the user. It never appears anywhere else.
- Code format: at least 12 characters from an alphabet without look-alike characters (no `0/O`, `1/l/I`).
- Store only a **hash** of the code on the server, with a 10-minute expiry. Single use: it is deleted on first successful use.
- Brute-force protection: lock out after 5 failed attempts in 15 minutes (per IP and also globally) and return the same generic error for every failure.
- Compare hashes in constant time.
- Session: random token of at least 256 bits, in an `HttpOnly`, `SameSite=Strict` cookie (and `Secure` where the environment supports it, **VERIFY** how this behaves on `localhost`). Expires after 30 minutes of inactivity.
- Kill switch: one setting (environment variable or stored flag) that makes `sign_in` fail and invalidates all sessions. Test that it works.
- Never include the code, session token or Stripe URL in logs.

## 8. Backend and Stripe (test mode)

Suggested stack, which you may change after telling the user why: a **Cloudflare Worker** that serves the HTML and the API, **Cloudflare KV** for codes, sessions and orders, **Wrangler** for local development. Keep dependencies minimal. Calling the Stripe REST API directly with `fetch` is fine if it keeps things simple.

Flow:
1. `create_checkout` (session required) creates a Stripe **Checkout Session**: mode `payment`, one line item, $1.00 USD, product name "The PDF Supplier: one PDF," with `order_id` in metadata. `success_url` and `cancel_url` point at the homepage (the page has no other routes). Store `order_id` mapped to the Stripe session id and the owning app session.
2. The agent pays on Stripe's hosted page using Stripe's WebMCP tools.
3. `check_order` fetches the Checkout Session from Stripe and treats it as paid only when Stripe reports `payment_status` as `paid` and the metadata `order_id` matches. Polling is enough for Phase 1; webhooks are out of scope.
4. `get_download` verifies the order is paid, belongs to this session and has not been delivered, then returns a single-use link that expires in minutes. The link serves a generated PDF containing exactly: `You now own this PDF.`

The user has **no Stripe account yet.** When you reach this step, stop and walk them through creating a free account and finding the **test-mode** secret key. Tell them to paste it into `.env` themselves. As far as the user knows, test mode works before the account is activated; **VERIFY.** Test card: `4242 4242 4242 4242`, any future expiry, any CVC, any postal code (**VERIFY** on Stripe's current testing page).

## 9. The agent test

Agent: Google's **Example Agentic Chrome Extension**, with a Claude model behind it.
- Follow that repository's README. Per Chrome's docs it needs API keys stored on a local server. The user has an **Anthropic API key** (no Google or OpenAI key). Help them put it in the right place without it passing through chat.
- Do not assume a model name. Look up current Claude model IDs in Anthropic's docs, tell the user the options, and ask which to use.
- Chrome 149 or later with the WebMCP flag on.

Test script (run it, with the user, after the site and backend work):
1. Open the local site in Chrome. In DevTools, confirm that **only `sign_in`** is registered before sign-in.
2. Generate a code in the terminal.
3. In the extension, instruct the agent roughly: "Buy the PDF from this store. Sign-in code: ___. Use the test card 4242 4242 4242 4242, any future expiry, any CVC. Ask me before submitting payment."
4. Observe each tool call. Save the transcript (see section 10).

Open questions this test must answer. Record the answer to each:
- Does the extension discover the tools and call them without clicking?
- Does it follow `create_checkout`'s Stripe link to Stripe's page, or does something need to change? If it cannot, record exactly what failed and what option (new tab, embedded Checkout, and so on) would fix it, and ask the user before changing the design. Note that embedded Stripe forms would add a human-usable payment form, which conflicts with rule 3.
- Does Stripe's test checkout page expose its WebMCP tools? Which ones?
- Does the agent ask for confirmation before the consequential submit tool, as Stripe's docs say it should?
- Can the agent retrieve the PDF through `get_download`?
- Optional control: ask Claude in Chrome to do the same task. The page has nothing to click, so it is expected to fail. Record what it does.

## 10. Documentation (important)

Keep these from the start in a `docs/` folder. The user will build a public write-up and a Phase 2 on top of them.
- `docs/LOG.md`: chronological. For each entry: date and time, what was done, why, relevant command output, errors and fixes, and outcome. Redact secrets.
- `docs/DECISIONS.md`: each design decision, the alternatives considered and the reason.
- `docs/OPEN-QUESTIONS.md`: the questions in section 9 and anything new, with status and answers.
- `docs/test-runs/`: one file per agent run, with date, Chrome version, model, the prompt given, every tool call with arguments and result (secrets redacted), and the final outcome. Include screenshots if useful.
- `README.md`: what the project is and how to run it locally, written for a beginner.

## 11. Pass condition for Phase 1

All of the following in one run, with no human clicking on the page:
1. The agent finds the tools and signs in with a one-time code.
2. It creates a checkout, pays with the Stripe test card, and the server confirms `paid`.
3. It receives the download link and retrieves the PDF, which contains exactly `You now own this PDF.`
4. Negative checks pass: no purchase tool works without a valid session; a wrong or reused code fails; lockout triggers; the kill switch works; the app refuses to start with a non-`sk_test_` key.

If it fails, the result is still useful. Record exactly where and why in the docs.

## 12. Out of scope for Phase 1

Buying the domain, deploying, the Chrome origin trial token, webhooks, real money, and the custom Claude harness (that is Phase 2: a program that launches Chrome with the flag, hands the page's tools to Claude through the API, runs the calls Claude picks, adds spend caps and a confirmation step, and ends with one real $1 charge). Do not build any of these now.

## 13. Step 0: start here

Do only this, then stop:
1. Check what is installed (Node, npm, Chrome version) and tell the user what, if anything, is missing. Ask before installing.
2. Read the docs in section 4 and write your findings, including any differences from this brief, to `docs/LOG.md`.
3. Give the user a short plain-language plan for building the site, the backend and the sign-in, and wait for their go-ahead.

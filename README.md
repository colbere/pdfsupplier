# The PDF Supplier

**Live at https://pdfsupplier.com.** An experiment: can an AI agent, pointed at a store, pay and take delivery using **only the tools a web page publishes through WebMCP**?

[WebMCP](https://developer.chrome.com/docs/ai/webmcp) is a new Chrome feature that lets a web page offer "tools" (functions with a name, a description and inputs) for an AI agent in the browser to call. This store has no buttons, links or forms: a person sees three paragraphs of text, and everything else happens through tools.

**This is not a real business.** Payments run in Stripe's **sandbox (test mode)**, so no real money moves. The only product is a $1 PDF containing the sentence `You now own this PDF.` **Any AI agent is welcome to try buying it**; the page can even give an agent a sandbox payment token.

> WebMCP is experimental and changes often. Everything here was tested in Chrome 157 in November 2026.

## Results so far (2026-11-17)

Each agent got the same kind of request: go to the site and buy the PDF. Every agent was given the address, so whether an agent can find the store on its own wasn't tested. Purchases are scored in three categories ([D31](docs/DECISIONS.md)): **bought via WebMCP**, **bought via the tools' server calls** (no WebMCP), and **did not buy**.

| Agent | Result | How | Time |
|---|---|---|---|
| Google's [example WebMCP extension](https://github.com/GoogleChromeLabs/webmcp-extension) (with [local patches](docs/extension-patch.diff)), Claude Opus 5.5 | **Bought via WebMCP** | Chrome listed the page's tools; 4 tool calls: product → test payment token → pay → download | ~14 s |
| Our own agent (Puppeteer + Claude Opus 5.5, [agent/](agent/)) | **Bought via WebMCP** (local copy of the store) | Reads every frame's tools; also paid on Stripe's checkout page | — |
| Meta Muse | **Bought via the tools' server calls** | No WebMCP browser: made the same requests the tools make, with `curl`. It most likely read the page script; `/app.js` requests aren't logged, so this is inferred from the exact addresses and field names it used | ~32 s |
| Gemini (consumer app, remote browser) | **Did not buy** | Its browser had the tools registered (seen in the traffic log), but Gemini said its interaction tools were unavailable: it could only navigate, click and type | — |
| Claude in Chrome, and Claude in a chat using it | **Did not buy** | Looked for `navigator.modelContext` (the page uses `document.modelContext`), concluded WebMCP was off, and wouldn't call the server directly | — |

What stands out:
- **The origin trial works.** Ordinary Chrome 157 on desktop, with no setting changed, exposes all 12 tools, and so did Gemini's remote browser.
- **Of the agents we tried, only those built for it (the extension, our agent) called WebMCP tools.** The others failed in different ways, or went around them.
- **Tool definitions double as API documentation.** Muse bought without WebMCP by copying what the tools do. The server allows that by design: it checks everything, whoever calls it.
- **Paying on the page is far easier than paying on Stripe's page.** The token route takes four calls. The card route needs Stripe's own tools, which sit inside a frame many agents don't read.

Limits of the evidence: one run per agent for most of them, over two days, in one Chrome version, in a sandbox. Details for every run are in [docs/test-runs/](docs/test-runs/), and the open questions in [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md).

### Proving who the agent acts for

The project began as a test of whether an agent could prove who it acts for. In Phase 1 the agent had to sign in with the owner's one-time code (`sign_in`) before any purchase tools appeared. Sign-in worked in all six Phase 1 runs, and run 6 completed the purchase. The store was later opened to any agent ([D29](docs/DECISIONS.md)), so owner sign-in is now a separate, optional path. **Verifying an agent's identity itself** (for example with signed agent requests or Poppy) **was not tested.**

### What was changed to make it work for agents

- **Delivery without opening a link:** `get_download` fetches the single-use link itself and saves the PDF, because the test agent couldn't open links ([D19](docs/DECISIONS.md)).
- **No phone field on Stripe's page:** Checkout is card-only with the Link wallet turned off. Link's "Save my information / mobile number" field stopped agent run 4 ([D22](docs/DECISIONS.md)).
- **Seeing Stripe's tools:** three local patches let Google's extension see Stripe's payment tools inside a frame, wait for a new page's tools, and keep the chat going after late results ([D20, D21, D23](docs/DECISIONS.md), [patch](docs/extension-patch.diff)).
- **Paying on the page:** a Shared Payment Token route (`pay_with_token`) replaced Stripe's checkout page as the default. It takes four tool calls instead of a trip to another site ([D28](docs/DECISIONS.md)).
- **Wording that guides:** `get_product` lists both ways to buy step by step. Our agent bought the PDF with **no store-specific notes** (Stage B, [run](docs/test-runs/agent/2026-11-14T01-15-21-context-none.md)), guided only by the tools' names, descriptions and replies.

## How it works

The page registers 12 tools with `document.modelContext.registerTool()`. Each tool is a thin wrapper around one request to the server:

| Tool | What it does |
|---|---|
| `get_product` | The product, price and the two ways to buy |
| `get_test_payment_token` | A sandbox Shared Payment Token (`spt_…`), limited to $1 and 15 minutes |
| `pay_with_token` | Pays for the PDF with a Shared Payment Token |
| `get_test_card` | Stripe's public test card, for the checkout-page route |
| `create_checkout`, `open_checkout` | Creates a Stripe Checkout page and moves the tab there |
| `check_order` | Confirms payment with Stripe |
| `get_download` | Fetches the single-use download link and saves the PDF |
| `say_hello`, `get_stats`, `leave_feedback` | Introduce yourself, see the experiment's counters, tell the owner what was confusing |
| `sign_in` | Owner only (one-time code); not needed to buy |

**Two ways to buy:**
1. **On the page:** `get_test_payment_token` → `pay_with_token` → `get_download`.
2. **On Stripe's checkout page:** `get_test_card` → `create_checkout` → `open_checkout` (pay with Stripe's own WebMCP tools) → `check_order` → `get_download`.

**The server is the gate.** It runs on Cloudflare Workers with one Durable Object for storage, and checks every request: same-origin calls, a visitor session (an `HttpOnly`, `Secure`, `SameSite=Strict` cookie), per-visitor and store-wide limits, payment confirmed with Stripe, and single-use download links tied to the session. It refuses to run without a Stripe **test** key. The full list of protections, and what's been verified on the live site, is in [docs/SECURITY.md](docs/SECURITY.md).

**Known limits:**
- Anyone can trigger the owner sign-in lockout with five wrong codes. It blocks only the owner's sign-in, for 15 minutes, not buying.
- Per-visitor limits can't group an agent that changes address on every request (Muse used 8 addresses for 8 requests). Store-wide caps, the per-session order cap and Stripe's single-use $1 token still apply.
- It runs on Cloudflare's free plan. If a daily free quota runs out, the store answers with errors until midnight UTC instead of running up a bill.

## What this site logs

The store keeps a traffic log that only the owner can read, for **30 days**. Each entry has the time, the path or tool and the result code, a **visitor ID scrambled with the date** (it changes every day; IP addresses are never stored), the country and network operator from Cloudflare, and a shortened browser description. It also keeps anything an agent sends through `say_hello` or `leave_feedback`, which only the owner can read; `get_stats` returns numbers only. It never logs IP addresses, cookies, passwords, payment tokens or download links. Details: [docs/SECURITY.md](docs/SECURITY.md).

## Visiting it with an agent

- **Chrome** exposes the tools on https://pdfsupplier.com with no setting changed, through Chrome's WebMCP **origin trial**. Tested on Chrome 157 (desktop); the trial covers Chrome 149 to 162. The trial, and this site's token, end on **30 March 2027**.
- The agent needs a way to call WebMCP tools, such as Google's example extension. A general browsing agent may not have one (see the results above).
- No sign-in is needed. Limits apply per visitor and per day.

## Running it locally

What you need:
- Node.js 22.18 or newer
- A recent Chrome (tested on 157) with `chrome://flags/#enable-webmcp-testing` set to **Enabled**. The origin-trial token only works on pdfsupplier.com, so `localhost` needs the flag.
- A Stripe account, used only in a **sandbox**, with a restricted test key (`rk_test_…`) that has Write access to Checkout Sessions, PaymentIntents, Shared Payment Token and Shared Payment Token Test Helpers

All commands run in a terminal opened in this folder.

1. **Install:** `npm install`.
2. **Set up secrets:** `npm run setup` creates `.env` with a random admin password. Add `STRIPE_SECRET_KEY=rk_test_…` to `.env` yourself. `.env` is git-ignored, and a pre-commit hook blocks key-shaped text.
3. **Start the store:** `npm run dev`, then open http://localhost:8787.

### Owner commands
Add `--live` to any of these to run it against https://pdfsupplier.com, using a separate live admin password.

| Command | What it does |
|---|---|
| `npm run report` | Counters, agents that said hello, and feedback |
| `npm run traffic [-- --days N] [--csv]` | Traffic summary from the 30-day log (no IP addresses) |
| `npm run kill-switch -- on \| off \| status` | Emergency stop: closes every tool and deletes every session |
| `npm run unlock` | Clears lockouts and rate limits |
| `npm run new-code` | One-time owner sign-in code (10 minutes, single use) |

### Our agent
With the store running:
```
npm run agent                              # sign in, pay with the agent's own sandbox token
npm run agent -- --route visitor           # a stranger: no sign-in, uses the store's test token
npm run agent -- --route stripe-page       # pay on Stripe's checkout page
npm run agent -- --context none            # without the store-specific notes
npm run agent -- --show                    # watch the Chrome window
```
A spending rule enforced in code (at most $1.00, one purchase, this store only, test mode only) is in `agent/policy.mjs`. Each run writes a redacted record to `docs/test-runs/agent/`. It needs `ANTHROPIC_API_KEY` in `.env`.

### Tests
- `node --test tests/agent-policy.test.mjs tests/redact.test.mjs`: no server needed.
- With `npm run dev` running: `bash tests/public-checks.sh`, `auth-checks.sh`, `tools-checks.sh`, `purchase-checks.sh` and `token-checks.sh`. Set `PDFS_SERVER_LOG` to the dev server's output file to include the "nothing secret in the server log" checks.
- `bash tests/live-checks.sh` checks the live site. It leaves sandbox test orders behind, and deliberately skips the password-guessing test.

## Project documents

- [docs/PLAN.md](docs/PLAN.md): the plan, by phase (Phase 3, outside agents, in progress)
- [docs/LOG.md](docs/LOG.md): everything done, in order, including what failed
- [docs/DECISIONS.md](docs/DECISIONS.md): design decisions and why (D1 onward)
- [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md): what we're trying to find out, and the answers so far
- [docs/SECURITY.md](docs/SECURITY.md): the protections and how they were verified
- [docs/test-runs/](docs/test-runs/): one file per agent run
- [BRIEF.md](BRIEF.md): the original project brief

## How it was built

Designed and directed by colbere, and built with Claude Code. Claude Opus 5.5 was the model behind the test agents in several runs.

## License

MIT, see [LICENSE](LICENSE). The exception is [docs/extension-patch.diff](docs/extension-patch.diff), which changes Google's Example Agentic Chrome Extension and stays under that project's Apache License 2.0.

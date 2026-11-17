# The PDF Supplier

**Live at https://pdfsupplier.com.** An experiment: can an AI agent find a store, pay, and take delivery using **only the tools a web page publishes through WebMCP**?

[WebMCP](https://developer.chrome.com/docs/ai/webmcp) is a new Chrome feature that lets a web page offer "tools" (functions with a name, a description and inputs) for an AI agent in the browser to call. This store has no buttons, links or forms: a person sees three paragraphs of text, and everything else happens through tools.

**This is not a real business.** Payments run in Stripe's **sandbox (test mode)**, so no real money moves. The only product is a $1 PDF containing the sentence `You now own this PDF.` **Any AI agent is welcome to try buying it**; the page can even give an agent a sandbox payment token.

> WebMCP is experimental and changes often. Everything here was tested in Chrome 157 in November 2026.

## Results so far (2026-11-17)

Each agent got the same kind of request: go to the site and buy the PDF. Purchases are scored in three categories ([D31](docs/DECISIONS.md)): **bought via WebMCP**, **bought via the tools' server calls** (no WebMCP), and **did not buy**.

| Agent | Result | How | Time |
|---|---|---|---|
| Google's [example WebMCP extension](https://github.com/GoogleChromeLabs/webmcp-extension) (with [local patches](docs/extension-patch.diff)), Claude Opus 5.5 | **Bought via WebMCP** | Chrome listed the page's tools; 4 tool calls: product → test payment token → pay → download | ~14 s |
| Our own agent (Puppeteer + Claude Opus 5.5, [agent/](agent/)) | **Bought via WebMCP** (local copy of the store) | Reads every frame's tools; also paid on Stripe's checkout page | — |
| Meta Muse | **Bought via the tools' server calls** | No WebMCP browser: read the page script and made the same requests with `curl` | ~32 s |
| Gemini (consumer app, remote browser) | **Did not buy** | Its browser had the tools registered, but its agent can only look, click and type | — |
| Claude in Chrome, and Claude in a chat using it | **Did not buy** | Looked for `navigator.modelContext` (the page uses `document.modelContext`), concluded WebMCP was off, and wouldn't call the server directly | — |

What stands out:
- **The origin trial works.** Ordinary Chrome 157, with no setting changed, exposes all 12 tools, and so did Gemini's remote browser.
- **Most agents can't call WebMCP tools yet.** Only agents built for it (the extension, our agent) used them. The others failed in different ways, or went around them.
- **Tool definitions double as API documentation.** Muse bought without WebMCP by copying what the tools do. The server allows that by design: it checks everything, whoever calls it.
- **Paying on the page is far easier than paying on Stripe's page.** The token route takes four calls. The card route needs Stripe's own tools, which sit inside a frame many agents don't read.

Limits of the evidence: one run per agent for most of them, over two days, in one Chrome version, in a sandbox. Details for every run are in [docs/test-runs/](docs/test-runs/), and the open questions in [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md).

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

## Visiting it with an agent

- **Chrome 149 to 162** exposes the tools on https://pdfsupplier.com with no setting changed, through Chrome's WebMCP **origin trial**. The trial, and this site's token, end on **30 March 2027**.
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

## License

MIT, see [LICENSE](LICENSE). The exception is [docs/extension-patch.diff](docs/extension-patch.diff), which changes Google's Example Agentic Chrome Extension and stays under that project's Apache License 2.0.

# The PDF Supplier

An experiment: can an AI agent find a store, prove who it's acting for, pay, and take delivery using **only WebMCP tools** published by a web page?

[WebMCP](https://developer.chrome.com/docs/ai/webmcp) is a new Chrome feature, still in testing, that lets a web page offer "tools" (small functions with a name and description) for an AI agent in the browser to call. This store has no buttons, links or forms. A person visiting sees only text. Everything happens through tools.

**This is not a real business.** It runs on your own computer, and payments use Stripe **test mode**, so no real money moves. The only product is a $1 PDF containing the sentence `You now own this PDF.`

## Status

**Phase 1 complete (2026-11-13).** In run 6 an AI agent (Google's example WebMCP Chrome extension, with three local patches, running Claude Opus 5.5) signed in, paid in Stripe test mode using Stripe's own WebMCP tools, and saved the PDF, with no clicks on the page. See [docs/test-runs/](docs/test-runs/) for every run, [docs/LOG.md](docs/LOG.md) for the full history and pass assessment, and [docs/DECISIONS.md](docs/DECISIONS.md) for why each change was made.

## How it works (short version)

1. The page publishes one tool, `sign_in`.
2. The owner runs a command in the terminal to get a one-time code and gives it to the agent.
3. After sign-in, the page publishes the purchase tools: `get_product`, `create_checkout`, `open_checkout`, `check_order`, `get_download` and `sign_out`.
4. `open_checkout` moves the tab to Stripe's test checkout page, where Stripe's own WebMCP tools let the agent pay with the test card. Stripe then sends the tab back to the store.
5. `check_order` confirms payment with Stripe, and `get_download` saves the PDF to the browser's download folder.

The server checks the sign-in on every purchase request. Hiding tools in the browser is not treated as security.

## Running it locally

What you need:
- Node.js 22.18 or newer
- Google Chrome 155 or newer, with `chrome://flags/#enable-webmcp-testing` set to **Enabled** (then relaunch Chrome)
- A free Stripe account, used only in test mode / sandbox (needed from Step 5)

All commands run in a terminal opened in this folder.

1. **Install** (first time only): `npm install`. This downloads Wrangler, Cloudflare's local server tool, into `node_modules/`.
2. **Set up secrets** (first time only): `npm run setup`. This creates `.env` and fills in a random admin password. You'll add the Stripe key to `.env` yourself later. Never paste keys into chat. `.env` is never committed to git.
3. **Start the site:** `npm run dev`. Then open http://localhost:8787. Leave this terminal running.
4. **Get a sign-in code** (in a *second* terminal): `npm run new-code`. It prints a code like `K7QMX-R4PWZ-9HTNB`. The code works once and expires in 10 minutes.

### Owner commands
| Command | What it does |
|---|---|
| `npm run new-code` | Makes a one-time sign-in code (cancels any previous one) |
| `npm run kill-switch -- on` | Emergency stop: deletes every session and blocks sign-in |
| `npm run kill-switch -- off` | Turns sign-in back on |
| `npm run kill-switch -- status` | Shows kill switch, active code, sessions and recent failures |
| `npm run unlock` | Clears the lockout after too many wrong codes |

### Your own agent (Phase 2)
With the store running (`npm run dev`), in a second terminal:
```
npm run agent                    # with the store-specific knowledge (Stage A)
npm run agent -- --context none  # without it (Stage B)
npm run agent -- --show          # watch the Chrome window
```
It makes its own sign-in code, buys the PDF in Stripe test mode, and prints where the PDF was saved. The spending rule (at most $1.00, one purchase, this store and Stripe only, test mode only) is enforced in `agent/policy.mjs`. Each run writes a redacted record to `docs/test-runs/agent/`. It needs `ANTHROPIC_API_KEY` in `.env`.

### The test agent (Phase 1)
The agent is Google's [Example Agentic Chrome Extension](https://github.com/GoogleChromeLabs/webmcp-extension) (commit `051a93c`), cloned **next to** this folder. It needs the local changes in [docs/extension-patch.diff](docs/extension-patch.diff) (apply with `git apply` inside the clone, then `npm install`, `npm run build`, `npm run server`). Its own `.env` holds `ANTHROPIC_API_KEY` (you paste it yourself) and `MODEL=anthropic:claude-opus-5-5`.

### Tests
With the site running: `bash tests/auth-checks.sh`, `bash tests/tools-checks.sh` and `bash tests/purchase-checks.sh`. The agent's spending rule: `node --test tests/agent-policy.test.mjs`.

## Project documents

- [docs/PLAN.md](docs/PLAN.md): the plan after Phase 1 (draft, awaiting confirmation)
- [docs/LOG.md](docs/LOG.md): chronological log of everything done
- [docs/DECISIONS.md](docs/DECISIONS.md): design decisions and why
- [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md): what we're trying to find out
- [docs/test-runs/](docs/test-runs/): one file per agent test run
- [BRIEF.md](BRIEF.md): the original project brief

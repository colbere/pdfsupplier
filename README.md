# The PDF Supplier

An experiment: can an AI agent find a store, prove who it's acting for, pay, and take delivery using **only WebMCP tools** published by a web page?

[WebMCP](https://developer.chrome.com/docs/ai/webmcp) is a new Chrome feature, still in testing, that lets a web page offer "tools" (small functions with a name and description) for an AI agent in the browser to call. This store has no buttons, links or forms. A person visiting sees only text. Everything happens through tools.

**This is not a real business.** It runs on your own computer, and payments use Stripe **test mode**, so no real money moves. The only product is a $1 PDF containing the sentence `You now own this PDF.`

## Status

Phase 1, in progress. See [docs/LOG.md](docs/LOG.md) for the step-by-step history.

## How it works (short version)

1. The page publishes one tool, `sign_in`.
2. The owner runs a command in the terminal to get a one-time code and gives it to the agent.
3. After sign-in, the page publishes the purchase tools: `get_product`, `create_checkout`, `check_order`, `get_download` and `sign_out`.
4. The agent pays on Stripe's test checkout page using the test card, then collects a download link for the PDF.

The server checks the sign-in on every purchase request. Hiding tools in the browser is not treated as security.

## Running it locally

> Setup instructions will be filled in as each part is built.

What you need:
- Node.js 22.18 or newer
- Google Chrome 155 or newer, with `chrome://flags/#enable-webmcp-testing` set to **Enabled** (then relaunch Chrome)
- A free Stripe account, used only in test mode / sandbox

Secrets go in a file called `.env` in this folder. Copy `.env.example` to `.env` and fill in the values yourself. `.env` is never committed to git.

## Project documents

- [docs/LOG.md](docs/LOG.md): chronological log of everything done
- [docs/DECISIONS.md](docs/DECISIONS.md): design decisions and why
- [docs/OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md): what we're trying to find out
- [docs/test-runs/](docs/test-runs/): one file per agent test run
- [BRIEF.md](BRIEF.md): the original project brief

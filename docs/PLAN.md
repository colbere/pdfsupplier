# Plan after Phase 1

**Status: confirmed by the owner (2026-11-13).** "That is all correct."
Nothing in here has been built yet. What happened in Phase 1, including everything that didn't work, stays in `LOG.md`, `DECISIONS.md`, `OPEN-QUESTIONS.md` and `test-runs/`.

## What this experiment is about

**The subject is the WebMCP tools on my own page.** Can an AI agent find my store and complete a purchase using the tools my page publishes?

Stripe's payment page is not the subject. Sending the agent to Stripe was only a way to take payment.

## What Phase 1 showed

- **My page's tools worked in every run.** The agent found `sign_in` on its own, picked up the new tools after signing in, created orders, confirmed payment and delivered the PDF.
- **Every failure happened somewhere else:** on Stripe's payment page (a hidden form tool, and a form tool that never reports back) or inside Google's example agent (it can't open links, and sometimes it was given no tools after moving to a new page).
- To finish one purchase, I had to patch Google's agent three times and change how my store sends people to Stripe.

## The plan, in order

### 1. Small improvement to my page — ✅ done (2026-11-13)
**Done:** `create_checkout` now says what to expect on Stripe's page, and `open_checkout` says the store's tools return after payment. In Stage B this wording is what got the agent past Stripe's silent form tool.

Make the messages my tools send back more helpful, using facts rather than commands. For example: "after you pay, you'll come back to this store; then check the order", and "ask the person right before you pay". Any agent that visits benefits from this.

### 2. Build my own agent, with full context (Stage A) — ✅ done (2026-11-13)
**Done:** `npm run agent`. The first fully autonomous purchase was verified (`test-runs/agent/2026-11-14T01-03-44-context-full.md`). The first dispatch paid but stopped before the download because of an agent bug, since fixed (`test-runs/agent/2026-11-14T00-29-12-context-full.md`). Design: DECISIONS D26.

- A small program that opens Chrome, reads my page's tools, gives them to Claude, and runs the tools Claude chooses.
- It gets everything we learned: workarounds for Stripe's and the extension's quirks, waiting for a page's tools to load, time limits, and the right order of steps.
- **It runs on its own, with a spending rule only (no confirmation prompt).** For example: "this agent may spend up to $1, at this store, once".
- **How I use it:** I start it from my terminal, and it comes back with the PDF.
- **The extra knowledge is kept as a separate layer that can be switched off**, so the same agent can be run without it later.
- This shows what is possible when the agent knows everything.

### 3. Run an agent without that context (Stage B) — ✅ done (2026-11-13)
**Done:** `npm run agent -- --context none` **succeeded** (`test-runs/agent/2026-11-14T01-15-21-context-none.md`). The page's own wording was enough for a capable agent. This doesn't show that outside agents will succeed, because their general abilities may be weaker; the stock extension couldn't see Stripe's iframe tools.

- The same agent with the extra layer switched off, so it only has what my page itself provides.
- This shows what a stranger's agent would get from my site alone.
- **Expected:** it may still get stuck on Stripe's page, because those problems aren't on my site. That is still a useful result: it shows which problems a store owner can fix and which need Stripe or the browser agent to change.
- **Decided:** "without context" means **my own agent with the extra layer switched off**. The same agent is used every time, so results can be compared over time.

### 4. Explore agentic commerce — 🛠️ prototype approved (2026-11-16)
Findings: `docs/research/AGENTIC-COMMERCE.md`. **Recommendation:** a test-mode prototype using **Shared Payment Tokens** through a new `pay_order` tool on my page, alongside the Stripe-page route. Nothing is built until I approve.

- **Idea:** take payment through my own page instead of sending the agent to Stripe. My page would get a tool such as `pay_order`, which accepts a payment credential the agent has been given. My server charges it through Stripe behind the scenes.
- **Why:** the whole purchase would then happen through my page's tools, which is exactly what this experiment is about. It would also remove the trip to Stripe's page, where every Phase 1 failure happened.
- **What changes:** my page would have the payment step, so that tool would be marked "consequential" and agents should ask before using it. My server would carry the safeguards: a valid session, charge each order only once, exactly $1.00.
- **Keep the current Stripe-page route** as a comparison.
- **Questions to answer first (none verified yet):**
  - Which Stripe product is it? (Agentic commerce, shared payment tokens, the Agentic Commerce Protocol?)
  - Does it work in test mode, without an approved account?
  - What does the agent need in order to hold a payment credential?
  - How does the person approve and limit what the agent spends?
  - How does it fit with WebMCP?

### 5. Test real outside agents (after the agentic commerce decision)
Re-run Google's **stock** extension (no local patches) against the improved page, and try other browser agents as they gain WebMCP support. This is the true measure of the goal; my own agent can't stand in for them.

## Sandbox only, free only (decided 2026-11-14, D27)
This stays an experiment: **Stripe sandbox/test mode permanently, and no paid services.**
- **Dropped from the brief:** the real $1 charge.
- **Allowed cost:** a domain (2026-11-16, D27a). No legal work or business formation.
- **If anything is made public later:** a paid domain is fine; hosting free; still sandbox-only; abuse protection first (Q13).
- The test-key guard and the agent's test-mode-only rule stay as permanent safeguards.

## Decisions (made 2026-11-13)
- [x] The plan matches what I intend.
- [x] "Without context" (Stage B) = my own agent with the extra layer switched off.
- [x] My agent uses a **spending rule only**, no confirmation prompt. I start it from the terminal and it returns with the PDF.
- [x] **Do not report** the Stripe and extension problems to Stripe or Google.
- [x] **Sandbox and free only, permanently** (2026-11-14, D27). No real charge, no paid services, **except a domain** (2026-11-16, D27a). No legal work or business formation.
- [x] **Start the Shared Payment Token prototype** (2026-11-16).

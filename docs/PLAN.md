# Plan after Phase 1

**Status: draft, waiting for the owner to confirm (2026-11-13).**
Nothing in here has been built yet. What happened in Phase 1, including everything that didn't work, stays in `LOG.md`, `DECISIONS.md`, `OPEN-QUESTIONS.md` and `test-runs/`.

## What this experiment is about

**The subject is the WebMCP tools on my own page.** Can an AI agent find my store and complete a purchase using the tools my page publishes?

Stripe's payment page is not the subject. Sending the agent to Stripe was only a way to take payment.

## What Phase 1 showed

- **My page's tools worked in every run.** The agent found `sign_in` on its own, picked up the new tools after signing in, created orders, confirmed payment and delivered the PDF.
- **Every failure happened somewhere else:** on Stripe's payment page (a hidden form tool, and a form tool that never reports back) or inside Google's example agent (it can't open links, and sometimes it was given no tools after moving to a new page).
- To finish one purchase, I had to patch Google's agent three times and change how my store sends people to Stripe.

## The plan, in order

### 1. Small improvement to my page (soon)
Make the messages my tools send back more helpful, using facts rather than commands. For example: "after you pay, you'll come back to this store; then check the order", and "ask the person right before you pay". Any agent that visits benefits from this.

### 2. Build my own agent, with full context (Stage A)
- A small program that opens Chrome, reads my page's tools, gives them to Claude, and runs the tools Claude chooses.
- It gets everything we learned: workarounds for Stripe's and the extension's quirks, waiting for a page's tools to load, time limits, and the right order of steps.
- Instead of asking me before every payment, it follows a spending rule I set, for example "this agent may spend up to $1, at this store, once".
- **The extra knowledge is kept as a separate layer that can be switched off**, so the same agent can be run without it later.
- This shows what is possible when the agent knows everything.

### 3. Run an agent without that context (Stage B)
- The same agent with the extra layer switched off, so it only has what my page itself provides.
- This shows what a stranger's agent would get from my site alone.
- **Expected:** it may still get stuck on Stripe's page, because those problems aren't on my site. That is still a useful result: it shows which problems a store owner can fix and which need Stripe or the browser agent to change.
- To decide: which "agent without context" to use (my agent with the layer off, Google's stock extension, or another company's agent), and then keep using the same one so results can be compared over time.

### 4. Explore agentic commerce (a separate track, later)
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

## Still planned, unchanged from the brief
Phase 2 still includes deploying the site to pdfsupplier.com, the Chrome origin-trial token, and one real $1 charge with a spending cap and a confirmation step. Abuse protection for the public site (Q13) has to come before going live.

## Decisions waiting on me
- [ ] Confirm this plan matches what I intend.
- [ ] Which agent counts as "without context" for Stage B.
- [ ] Spending rule only, or spending rule plus a confirmation, for the Stage A agent.
- [ ] Whether to report the Stripe and extension problems to Stripe and Google (public; not done without my OK).

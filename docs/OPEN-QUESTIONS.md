# OPEN QUESTIONS

Status values: **Open**, **Answered**, **Partly answered**.

## From the brief (section 9): to be answered by the agent test

| # | Question | Status | Answer |
|---|---|---|---|
| Q1 | Does the extension discover the tools and call them without clicking? | Open | |
| Q2 | Does it follow `create_checkout`'s Stripe link to Stripe's page? If not, what failed exactly, and what would fix it (new tab, embedded Checkout, ...)? | Open | Step 0 doc reading: the extension's README does not say it can navigate, open tabs or follow links. **Likely to fail.** Embedded Checkout would put a human-usable form on our page, which conflicts with rule 3, so ask the user before changing the design. |
| Q3 | Does Stripe's test Checkout page expose WebMCP tools? Which ones? | Open | Stripe's docs list hosted Checkout as supported but publish no tool names ("Don't hard-code tool names"). They don't say whether test mode or sandboxes are supported. |
| Q4 | Does the agent ask for confirmation before Stripe's consequential submit tool? | Open | Per its README, the extension "always" asks before `consequentialHint: true` tools, even with alerts off. |
| Q5 | Can the agent retrieve the PDF through `get_download`? | Open | Same concern as Q2: no documented download or navigation ability. |
| Q6 | (Optional control) What does Claude in Chrome do with the same task? | Open | Expected to fail: nothing to click. |

## Raised during Step 0

| # | Question | Status | Answer |
|---|---|---|---|
| Q7 | Is `navigator.modelContext` officially deprecated? | Open | Chrome docs only use `document.modelContext` and don't mention `navigator.modelContext`. Not blocking: we use `document.modelContext`. |
| Q8 | Can a new Stripe account use test mode or a sandbox before activation? | **Answered** | **Yes.** Stripe docs: "Immediately after you create a Stripe account, you can use a sandbox… without moving any money." The user created an account, switched to a sandbox, created a restricted test key, and it worked for Checkout Sessions (2026-11-13). |
| Q9 | Does `wrangler dev` (purely local) require a Cloudflare login? | **Answered** | **No.** Wrangler 4.162.0 started and served `http://localhost:8787` with no login prompt and no Cloudflare account (2026-11-13, Step 2). |
| Q10 | Does inline `price_data` on Checkout Session create work as expected with API version `2026-10-28.endive`? | **Answered** | **Yes.** `line_items[0][price_data][currency/unit_amount/product_data][name]` created a hosted `cs_test_` session. A restricted key with **only "Checkout Sessions: Write"** was enough: no Products or Prices permission was needed, even though inline price data creates those objects behind the scenes. Retrieve also works with that key. |
| Q14 | How did Stripe's restricted-key screen differ from the docs? | Answered | The docs describe choosing per-resource permissions. The live screen first offers four choices: "Start with a template", "Custom permissions", "Full access—except sensitive operations", and "Full access" (labelled High risk). We chose **Custom permissions**, set Checkout Sessions to Write, and left everything else at None. |
| Q11 | Does Chrome accept the `Secure` session cookie on `http://localhost`? | **Answered** | **Yes.** In Chrome 157, after `sign_in` was run from the DevTools WebMCP pane, Application → Cookies showed `__Host-pdfs_session` with HttpOnly, Secure and SameSite=Strict (user check, 2026-11-13). The `__Host-` prefix is also accepted on localhost. |
| Q12 | Do tools registered after sign-in reach the extension mid-conversation? | Open | The README says tools that appear during a conversation are "picked up before the next model turn" (via `toolchange`). Confirm in the agent test. |
| Q13 | Once live, does the design stop other people from spamming the site? (Asked by the user, 2026-11-13.) | Partly answered | **Yes, against:** buying anything; creating Stripe Checkout Sessions (which also blocks "card testing" fraud); and guessing codes (lockout). **No, against:** flooding the page or `sign_in` with requests (volume and cost). The global lockout can also be triggered on purpose to lock the owner out for 15 minutes. **For going live (Phase 2):** Cloudflare rate-limiting rules in front of the Worker, use the real client IP (`CF-Connecting-IP`), and reconsider the global lockout. |
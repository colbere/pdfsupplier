# Outside agent run: Claude in Chrome on the live site

- **Date:** 2026-11-17, about 15:40 UTC (time it was reported; exact start not recorded)
- **Site:** https://pdfsupplier.com (live, deployed version 5a88a012, with the WebMCP origin-trial token)
- **Browser:** the owner's everyday Chrome, **157.0.8103.52**, with no WebMCP flag turned on
- **Agent:** Claude in Chrome (Anthropic's browser extension). Version and model were not recorded.
- **Prompt:** not recorded. It asked the agent to order the PDF from the site.
- **Context given:** none about WebMCP or the store's tools, as far as the owner recalls.
- **Outcome: did not buy.** It stopped before calling any tool.

## What the agent reported (verbatim, as pasted by the owner)

> I couldn't order the PDF, because the page's tools never showed up in your browser.
>
> The site's script (app.js) is written to register 13 tools, including get_product, create_checkout, pay_with_token and get_download. It hands them to the browser through navigator.modelContext, but that doesn't exist in this Chrome. So the tools were never registered, and I had nothing to call. There's no form or button to use as a fallback either, which is what the page says.
>
> I also didn't fake the purchase by calling the site's back-end directly with a script. That would skip the WebMCP step you're trying to test, and I don't run payment steps that way even when they're in test mode.
>
> To get it working:
>
> Turn on WebMCP in Chrome. It's still experimental, so it's usually behind a flag in chrome://flags or only in Chrome Canary. Once navigator.modelContext exists, reload the page and ask me again.
> Or try a client that already supports WebMCP, if you have one set up.
>
> This could be useful for your write-up. An agent using a normal Chrome extension can find the store and read the tool names in your script, but can't use them until the browser supports WebMCP. Adding a short message to the page for when navigator.modelContext is missing would explain the dead end to agents and people who land there.

## What we checked afterwards

**The agent's diagnosis was wrong. WebMCP *was* on, and the tools *were* registered.**

- The page uses **`document.modelContext`** (`src/page/app.browser.js` line 10), not `navigator.modelContext`.
- We opened the live page in the same installed Chrome 157 (headless, via Puppeteer, **no** flag):
  - `document.modelContext`: **object**, with methods `registerTool`, `getTools`, `executeTool`, `ontoolchange`, `ontoolactivated` and `ontoolcancel`.
  - `navigator.modelContext`: **undefined**.
  - `document.modelContext.getTools()` listed the **12 public tools**: check_order, create_checkout, get_download, get_product, get_stats, get_test_card, get_test_payment_token, leave_feedback, open_checkout, pay_with_token, say_hello and sign_in. (The 13th, `sign_out`, appears only after an owner signs in, so the agent's count of 13 came from reading the script, not from the browser.)
- So the **origin-trial token works**: ordinary Chrome exposes the tools without any setting. That is the first confirmation in the owner's everyday browser.

## What this run tells us

1. **Claude in Chrome doesn't use WebMCP tools natively** (at least in this version). It has no list of page tools; it found the tools only by **reading the page's script**.
2. **It looked for WebMCP under the wrong name.** It checked `navigator.modelContext`, an older or guessed name (see OPEN-QUESTIONS Q7), found nothing, and concluded the browser didn't support WebMCP. Its advice to turn on a Chrome flag was therefore **wrong for this browser**.
3. **It refused a shortcut on principle.** It wouldn't call the store's server directly, because that would skip the WebMCP step and because it won't run payment steps that way. That is reasonable behaviour, and it shows the "no buttons, no forms" design does stop a general browsing agent that doesn't speak WebMCP.
4. It could in principle have called the tools through `document.modelContext.executeTool(...)` from page script. It didn't try, because it believed WebMCP was absent.
5. **Its suggestion:** a short on-page message when WebMCP is missing. That's worth considering, but this run would **not** have shown it, because WebMCP was present. A message that names the right API (`document.modelContext`) might help agents that inspect the page the way this one did. Logged as a question, not done.

## Status

Counts as Step 3's first outside-agent run (and the Phase 1 "optional control", Q6). Result: **no purchase**, because the agent can't see WebMCP tools. The site and the trial token are fine.

# Outside agent run: Google's WebMCP example extension on the live site: PASS

- **Date:** 2026-11-17, 15:45 UTC (from the live traffic log)
- **Site:** https://pdfsupplier.com (live, version 5a88a012, origin-trial token)
- **Browser:** the owner's everyday Chrome 157.0.8103.52, **no WebMCP flag** (the origin trial switches it on)
- **Agent:** Google's WebMCP example extension, **our patched build** from Phase 1 (D20, D21, D23: Stripe iframe tools, following the store to Stripe, saving the PDF). Not the unmodified extension. The run never went to Stripe, so the first two patches played no part; the PDF save happens inside our own `get_download` tool (D19).
- **Model:** Claude Opus 5.5 (`anthropic:claude-opus-5-5`) through the extension's local model server (`npm run server` in `c:\claude\webmcp-extension`, using the owner's Anthropic key).
- **Prompt:** not recorded. It was a plain request to buy the PDF, with no instructions about the tools.
- **Outcome: PASS.** Bought and downloaded the PDF with no help, no Allow prompts reported, and no Stripe page.

## Tool calls (from the live traffic log; same visitor ID 657e8e…)

| Time (UTC) | Tool | Result |
|---|---|---|
| 15:45:01.6 | `get_product` | 200 |
| 15:45:06.7 | `get_test_payment_token` | 200 (sandbox `spt_` issued by the store) |
| 15:45:11.9 | `pay_with_token` | 200, paid: `ord_cevbwd34u6wz29tgaew9` |
| 15:45:15.3 | `get_download` | 200 |
| 15:45:15.4 | (the tool fetched `/download/[token]`) | 200, PDF |

**About 14 seconds** from first tool call to file saved. It skipped `check_order`, which isn't needed after `pay_with_token` reports `paid`.

## What the agent said (verbatim, as pasted by the owner)

> I'll start by getting product info.
>
> [Get product ✓ · Get test payment token ✓ · Pay with token ✓ · Get download ✓]
>
> I ordered the PDF and it downloaded to your browser's Downloads folder as you-now-own-this.pdf.
>
> Order ID: ord_cevbwd34u6wz29tgaew9
> Price: $1.00 USD, paid with a test payment token from the store. The store runs in Stripe test mode, so no real money was charged.
> What's in it: one sentence: "You now own this PDF."
> The download link only worked once and has now been used, so keep the file you have.

Note: the model knows the sentence from `get_product`'s description, not from reading the file (`get_download` only reports that a PDF was saved).

## What this run shows

- **The live store works for a WebMCP agent in ordinary Chrome**, with no flag, no context and no Stripe page: the token route is a four-call path.
- Compared with Phase 1 (card route, many prompts, `fill_payment_form` hanging), the token route removes all the friction.
- Contrast with Claude in Chrome the same morning (`2026-11-17-0840-claude-in-chrome.md`): it couldn't use the tools at all.
- Still open: the **unmodified** extension (Q18), and the card route on live (Q17).

## Also seen in the traffic log
Strangers arrived within the first hour of going live: a "RecordedFuture Global Inventory Crawler", scanners on Linux/Firefox user agents, and `http://` requests now getting 301s. That's normal for a new domain: new HTTPS certificates are published in public certificate logs, which scanners watch. None of them called a tool.

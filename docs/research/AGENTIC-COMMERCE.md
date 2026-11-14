# Research: agentic commerce for the PDF Supplier

**Date:** 2026-11-13. **Status:** findings and recommendation, **for the owner's decision**. Nothing has been built.
**Sources:** Stripe's docs and the Agentic Commerce Protocol site, read the same day (URLs in the appendix). Anything not confirmed on a page is marked *unverified*.

## The short version

- **Stripe has a ready-made way for an agent to pay my store directly: "Shared Payment Tokens" (SPTs).** An SPT is a single-use payment credential that the agent's side creates, with a built-in limit (maximum amount, currency, expiry, and which business may charge it). My server charges it with one normal Stripe call. No Stripe payment page is involved.
- **It fits my experiment well.** My page would get one new WebMCP tool, for example `pay_order(order_id, payment_token)`. The whole purchase would then happen through my page's own tools: sign in, product, order, pay, check, download.
- **It can be tested for free.** Stripe has a test helper that creates a test SPT "without an agent", using a test card.
- **The spending limit becomes part of the credential.** An SPT carries its own maximum amount and expiry, so even a badly behaved agent couldn't charge more than the token allows. My agent's code rule stays on top as a second check.
- **But it is a preview feature.** It uses a preview API version and separate preview terms of service, and some details (listed below) are unverified.
- **Outside agents would still need something:** a way to create SPTs, through their own Stripe account or a Stripe Link "agent wallet" that the person approves. They would no longer depend on Stripe's payment page behaving well for them.

## Plain explanation of the pieces

| Name | What it is | Relevant to me? |
|---|---|---|
| **Shared Payment Token (SPT)** | A one-time, limited payment credential the agent side creates and gives to a seller. The seller charges it. | **Yes: the core of option A below.** |
| **Agentic Commerce Protocol (ACP)** | An open standard (OpenAI and Stripe, Apache 2.0, "beta") for a seller's *checkout API* that agents call: create, update, complete and cancel a checkout session. Payment comes in as a delegated token. ChatGPT was the first agent platform to use it. | Maybe later. It's a server API (REST, with an MCP binding in development), **not WebMCP**. My page would need a second interface. |
| **Universal Commerce Protocol (UCP)** | Stripe's protocol page now describes this "open standard" (ucp.dev). How it relates to ACP is *unverified*. | Watch it. |
| **Agentic Commerce Suite** | Stripe-run product catalogue and checkout that agent platforms connect to. Retail-focused, with Dashboard onboarding, and parts in private preview. | No. It's built for catalogues sold through AI platforms, not my own page's tools. |
| **Link Agent Wallet** | A person's Stripe Link account issues one-time credentials, including SPTs, to their agent. The person approves each request in the Link app within 30 minutes. US and Canada customers. Has a test mode. | Yes, as one answer to "how does an *outside* agent get an SPT?" |
| **Stripe WebMCP** | Stripe's tools on its payment pages, which we used in Phase 1. | That's the current route. |

## How option A (SPT on my own page) would work

1. The agent signs in, gets the product and creates an order, as now.
2. The agent side creates an SPT limited to **$1.00, USD, my business, expires soon**.
3. The agent calls my new **`pay_order(order_id, payment_token)`** tool. It is marked **consequential**, so agents should ask (or follow a spending rule) before using it.
4. My server checks the session and that the order belongs to it and is unpaid, then asks Stripe to charge the token for exactly $1.00.
5. The order is marked paid, and `get_download` works as now.

**For testing (both roles played by me):** my agent would get a **test SPT from Stripe's test helper** (test card, limit $1.00) and hand it to `pay_order`. That makes the agent's spending limit part of the credential itself.

## Questions answered (from the plan)

| Question | Answer |
|---|---|
| Which Stripe product? | **Shared Payment Tokens** for paying my page directly. ACP and UCP are bigger checkout protocols for later. |
| Test mode without an approved account? | **Yes for SPTs:** a sandbox test helper creates test tokens "without an agent". No waitlist was found for SPTs. *Unverified:* whether my account needs anything enabled. Using SPTs means agreeing to a separate **preview** terms of service. |
| What does the agent need? | Something that can create an SPT: its own Stripe account (with a payment method) or a person's **Link Agent Wallet**. For my test: the test helper. |
| How does the person approve and limit spending? | Every SPT carries **max amount, currency, expiry** and is single-use. With Link, the person approves each request in the app. My agent's code rule stays as a second check. |
| How does it fit WebMCP? | **Through my own tool.** None of the docs connect SPTs or ACP to WebMCP; passing the token through a `pay_order` WebMCP tool would be my own design. |

## Unverified points and risks
1. **Preview status:** the SPT examples use API version `2026-09-30.preview`, and the feature has its own preview terms. Behaviour may change.
2. **Is a "relationship" with each agent required?** Stripe's managed checkout and UCP flows require a confirmed commerce relationship. Whether a seller can charge **any** agent's SPT with a plain PaymentIntent is *unverified*. This decides whether outside agents could pay me directly.
3. **Countries:** SPTs are listed for the US, Canada and about 30 European countries. Link Agent Wallet is for US and Canada customers. (My country isn't recorded in this project.)
4. **Key permissions:** my restricted test key currently allows only Checkout Sessions. It would need **PaymentIntents (write)** and perhaps SPT read access. That's a Dashboard change I would make myself.
5. **One developer as both agent and seller:** the test helper covers testing. Whether the "issue an SPT" API may target my own seller profile is *unverified*.

## Recommendation

**Build a small test-mode prototype of option A, alongside the current Stripe-page route:**
1. Confirm the two prerequisites myself: accept the SPT preview terms (if I agree with them), and add PaymentIntents write permission to the restricted test key.
2. One free test call: create a test SPT with the test helper and charge it for $1.00. That proves my account and key can do it before any building.
3. Add the `pay_order` tool and the server check. Give my agent a "test wallet" that obtains a $1.00 test SPT.
4. Run Stage A and Stage B again on the new route, and compare with the Stripe-page route.

Not now: implementing ACP or UCP checkout APIs, and live Link wallets. Revisit those after the prototype, and before inviting outside agents.

## Appendix: technical details (for later building)
- **Charge an SPT (seller):** `POST /v1/payment_intents` with `amount=100`, `currency=usd`, `payment_method_data[shared_payment_granted_token]=spt_…`, `confirm=true`, header `Stripe-Version: 2026-09-30.preview`. Rejects `setup_future_usage`. Non-recurring SPTs are single use (a 400 if used again). Webhook `shared_payment.granted_token.deactivated` when consumed, expired or revoked. Retrieve: `GET /v1/shared_payment/granted_tokens/{id}`.
- **Test SPT (sandbox):** `POST /v1/test_helpers/shared_payment/granted_tokens` with `payment_method=pm_card_visa`, `usage_limits[currency]`, `usage_limits[max_amount]`, `usage_limits[expires_at]`.
- **Issue an SPT (agent side):** `POST /v1/shared_payment/issued_tokens` with `payment_method`, `seller_details[network_business_profile]`, `usage_limits[…]`, `return_url`. A sandbox test seller profile is documented. Revoke: `POST …/issued_tokens/{id}/revoke`.
- **Link Agent Wallet test mode:** `link-cli spend-request create … --test` returns test credentials and never charges.
- **ACP (2026-04-17 stable):**
  - Seller REST endpoints: `/checkout_sessions` (create, update, get, `/complete`, `/cancel`), with an `Idempotency-Key` required.
  - Delegate Payment allowance: `reason: one_time`, `max_amount` (minor units), `currency`, `checkout_session_id`, `merchant_id`, `expires_at`.
  - An MCP transport binding is listed as unreleased.
  - "Any AI agent can call an ACP-enabled checkout"; platform onboarding is per platform (ChatGPT requires applying). WebMCP is not mentioned.
- **Sources:**
  - Stripe: docs.stripe.com/agentic-commerce; /agentic-commerce/concepts/shared-payment-tokens (seller and agent variants); /agentic-commerce/sellers/use-cases/retail (+ /checkout, /ucp); /agents; /agents/how-it-works; /agentic-commerce/agents/embedded; /agentic-commerce/agents/webmcp; /agentic-commerce/agents/link-agent-wallet (+ /use-link-wallet-pay-online); /agentic-commerce/protocol (now titled UCP).
  - ACP: agenticcommerce.dev (+ /docs, /docs/concepts/security); github.com/agentic-commerce-protocol/agentic-commerce-protocol (spec 2026-04-17 OpenAPI files, changelog).
- **Not read:** ucp.dev; developers.openai.com/commerce; Google AP2 and card-network agent programs (worth a look before going public).

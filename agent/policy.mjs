// The spending rule and the site allow-list for the owner's agent (docs/DECISIONS.md D25).
// This is the agent's only safeguard: there is no human confirmation. It is enforced here,
// in code, and FAILS CLOSED: if the payment can't be verified, it is refused.

const STRIPE_PAGE = "https://checkout.stripe.com";
const STRIPE_JS = "https://js.stripe.com"; // Stripe Checkout's tools live in an iframe on this origin

export function makePolicy({ storeOrigin, maxCents, currency, maxPurchases, requireTestMode }) {
  const pageOrigins = new Set([storeOrigin, STRIPE_PAGE]);
  const toolOrigins = new Set([storeOrigin, STRIPE_PAGE, STRIPE_JS]);
  let paymentAttempts = 0;

  return {
    describe() {
      return (
        `at most ${(maxCents / 100).toFixed(2)} ${currency.toUpperCase()} in total, ` +
        `${maxPurchases} purchase${maxPurchases === 1 ? "" : "s"}, ` +
        `only at ${storeOrigin} with payment on ${STRIPE_PAGE}` +
        (requireTestMode ? ", Stripe test mode only" : "")
      );
    },

    /** Pages the tab may be on. Anything else stops the run. */
    isAllowedPage(origin) {
      return pageOrigins.has(origin);
    },

    /** Frames whose tools the agent may see and use. */
    isAllowedToolOrigin(origin) {
      return toolOrigins.has(origin);
    },

    /** A tool that moves money: the page marked it consequential. */
    needsPaymentCheck(tool) {
      return tool.annotations?.consequentialHint === true;
    },

    /**
     * Decide whether a consequential tool may run. `summaryTool` is the order-summary tool
     * in the same frame, and `runTool` runs a tool and returns { kind, value }.
     * Returns { ok: true, summary } or { ok: false, reason }.
     */
    async checkPayment({ tool, pageOrigin, summaryTool, runTool }) {
      if (paymentAttempts >= maxPurchases) {
        return { ok: false, reason: `the spending rule allows ${maxPurchases} purchase(s) and that limit has been used` };
      }
      if (pageOrigin !== STRIPE_PAGE || tool.origin !== STRIPE_JS) {
        return { ok: false, reason: `payments are only allowed through Stripe Checkout (tab is on ${pageOrigin}, tool from ${tool.origin})` };
      }
      if (!summaryTool) {
        return { ok: false, reason: "the amount could not be verified (no order-summary tool on this page)" };
      }
      const r = await runTool(summaryTool, {});
      if (r.kind !== "ok" || typeof r.value !== "string") {
        return { ok: false, reason: "the amount could not be verified (order summary did not return)" };
      }
      const summary = parseStripeSummary(r.value);
      if (!summary) return { ok: false, reason: "the amount could not be verified (order summary unreadable)" };
      if (requireTestMode && summary.livemode !== false) {
        return { ok: false, reason: "this is not a Stripe test-mode payment" };
      }
      if (String(summary.currency).toLowerCase() !== currency) {
        return { ok: false, reason: `currency is ${summary.currency}, the rule allows ${currency}` };
      }
      if (!Number.isInteger(summary.totalAmount) || summary.totalAmount < 0 || summary.totalAmount > maxCents) {
        return { ok: false, reason: `the total (${summary.totalAmount} minor units) exceeds the limit of ${maxCents}` };
      }
      if (summary.recurring_or_may_have_future_charges !== false) {
        return { ok: false, reason: "the payment may include recurring or future charges" };
      }
      paymentAttempts++; // counted before the payment runs, so a retry can't exceed the limit
      return { ok: true, summary };
    },
  };
}

// Stripe's get_order_summary returns {"content":[{"type":"text","text":"<json>"}]}.
export function parseStripeSummary(raw) {
  try {
    let v = JSON.parse(raw);
    if (Array.isArray(v?.content)) v = JSON.parse(v.content.find((c) => c.type === "text")?.text ?? "null");
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

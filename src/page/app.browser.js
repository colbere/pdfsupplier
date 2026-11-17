// Runs in the visitor's browser. Registers WebMCP tools if the browser supports them.
// Browsers without WebMCP ignore all of this; the page is plain text either way.
//
// Security lives on the SERVER: every tool calls an endpoint that applies the session checks,
// ownership checks and abuse limits. Registering tools here is only about what agents see.
// Any visiting agent may try a purchase (Stripe test mode only). See docs/SECURITY.md.
(() => {
  "use strict";

  const mc = document.modelContext;
  if (!mc || typeof mc.registerTool !== "function") return; // No WebMCP: do nothing.

  // ---------- Server calls ----------

  async function callServer(path, { method = "POST", body } = {}) {
    const res = await fetch(path, {
      method,
      headers: method === "POST" ? { "Content-Type": "application/json" } : {},
      credentials: "same-origin",
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON reply */ }
    return { status: res.status, data };
  }

  const UNREACHABLE = "Could not reach the store's server. Try again shortly.";
  const errorText = (data, fallback) => (data && data.error) || fallback;

  // Fetches the PDF (same-origin, with the session cookie) and hands it to the browser as a download.
  // The temporary <a> is never attached to the page, and its href is a local blob: URL, not the link.
  async function savePdf(downloadUrl) {
    try {
      const u = new URL(downloadUrl, location.href);
      if (u.origin !== location.origin || !u.pathname.startsWith("/download/")) return { ok: false, error: "unexpected link" };
      const res = await fetch(u.pathname, { credentials: "same-origin" });
      if (!res.ok) return { ok: false, error: `server answered ${res.status}` };
      const blob = await res.blob();
      const head = new TextDecoder().decode(await blob.slice(0, 5).arrayBuffer());
      if (head !== "%PDF-") return { ok: false, error: "the file is not a PDF" };
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = "you-now-own-this.pdf";
      a.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      return { ok: true, bytes: blob.size };
    } catch (err) {
      return { ok: false, error: (err && err.message) || "network error" };
    }
  }

  const NO_INPUT = { type: "object", properties: {} };
  const ORDER_INPUT = {
    type: "object",
    properties: { order_id: { type: "string", description: "The order_id from pay_with_token or create_checkout (starts with ord_)." } },
    required: ["order_id"],
  };
  const hints = (readOnly, consequential = false) => ({ readOnlyHint: readOnly, consequentialHint: consequential, untrustedContentHint: false });

  // ---------- Public tools (any visiting agent) ----------

  const publicTools = [
    {
      name: "get_product",
      description:
        "Returns the store's only product (a PDF for $1.00 USD), what it contains, and the ways to buy it. " +
        "Any agent may try buying; payments run in Stripe test mode, so no real money moves.",
      inputSchema: NO_INPUT,
      annotations: hints(true),
      async execute() {
        try {
          const { data } = await callServer("/api/product");
          if (!data || !data.ok) return errorText(data, "Could not get the product.");
          const p = data.product;
          return [
            `Product: ${p.name}`,
            `Price: ${p.price}`,
            `What it is: ${p.description}`,
            `Delivery: ${p.delivery}`,
            p.note,
            "Ways to buy:",
            "A) On this page: get_test_payment_token, then pay_with_token, then get_download. (If you already have your own Shared Payment Token for this store, use it with pay_with_token.)",
            "B) On Stripe's checkout page: get_test_card, then create_checkout, then open_checkout (pay with Stripe's tools), then check_order, then get_download.",
            "Optional: say_hello to introduce yourself, leave_feedback to tell the owner what was confusing, get_stats to see how the experiment is going.",
          ].join("\n");
        } catch {
          return UNREACHABLE;
        }
      },
    },
    {
      name: "get_test_payment_token",
      description:
        "Gives you a sandbox Stripe Shared Payment Token (starts with spt_) for this store, limited to $1.00 USD and " +
        "valid for 15 minutes, so you can buy the PDF with pay_with_token without leaving this page. " +
        "Stripe test mode only: no real money. Limited per visitor per day.",
      inputSchema: NO_INPUT,
      annotations: hints(false),
      async execute() {
        try {
          const { data } = await callServer("/api/test-token");
          if (!data || !data.ok) return errorText(data, "Could not get a test payment token.");
          return `Your sandbox payment token: ${data.payment_token} (limit ${data.limit}, expires ${data.expires_at}). Next: call pay_with_token with it, then get_download.`;
        } catch {
          return UNREACHABLE;
        }
      },
    },
    {
      name: "pay_with_token",
      description:
        "Buys the PDF ($1.00 USD, Stripe test mode) with a Stripe Shared Payment Token (starts with spt_) limited to at " +
        "least $1.00 USD, such as one from get_test_payment_token. Creates an order, charges the token once and returns " +
        "the order_id. Then call get_download.",
      inputSchema: {
        type: "object",
        properties: { payment_token: { type: "string", description: "The Shared Payment Token to charge (starts with spt_)." } },
        required: ["payment_token"],
      },
      annotations: hints(false, true),
      async execute({ payment_token } = {}) {
        try {
          const { data } = await callServer("/api/pay-with-token", { body: { payment_token } });
          if (!data) return "Could not complete the payment.";
          if (!data.ok) return (data.order_id ? `Order ${data.order_id}: ` : "") + errorText(data, "The payment failed.");
          return `Order ${data.order_id} is paid (${data.amount}, charged to the shared payment token). Call get_download with this order_id to get the PDF.`;
        } catch {
          return UNREACHABLE;
        }
      },
    },
    {
      name: "get_test_card",
      description:
        "Returns Stripe's public test card details, for paying on Stripe's checkout page (see create_checkout and " +
        "open_checkout). It only works in Stripe test mode; no real money moves.",
      inputSchema: NO_INPUT,
      annotations: hints(true),
      async execute() {
        try {
          const { data } = await callServer("/api/test-card");
          if (!data || !data.ok) return errorText(data, "Could not get the test card.");
          const c = data.card;
          return `Test card number ${c.number}; expiry ${c.expiry}; CVC ${c.cvc}; ${c.other_fields}. ${data.note}`;
        } catch {
          return UNREACHABLE;
        }
      },
    },
    {
      name: "create_checkout",
      description:
        "Starts a purchase of the PDF ($1.00 USD, Stripe test mode) on Stripe's checkout page. Returns the Stripe page's " +
        "URL and an order_id; nothing is charged yet. Payment happens on Stripe's page, which has its own tools " +
        "(see get_test_card). If an unpaid order already exists, it is returned again.",
      inputSchema: NO_INPUT,
      annotations: hints(false),
      async execute() {
        try {
          const { data } = await callServer("/api/checkout");
          if (!data || !data.ok) return errorText(data, "Could not create a checkout.");
          return [
            data.reused ? "An unpaid order already exists; here it is again." : "Order created.",
            `order_id: ${data.order_id}`,
            `Stripe checkout URL: ${data.checkout_url}`,
            `The checkout page expires at ${data.expires_at}.`,
            "Next: call open_checkout with this order_id. It takes this tab to the Stripe page, where Stripe's own tools let you pay. " +
              "After payment Stripe returns to this store; then call check_order with this order_id.",
            "What to expect on Stripe's page: its tools let you choose a payment method, fill in the payment form and submit it. " +
              "Its form-filling tool can fill the form without reporting back that it finished. " +
              "Submitting starts the payment; the tab then returns to this store, and this store's tools are available again once it has loaded.",
          ].join("\n");
        } catch {
          return UNREACHABLE;
        }
      },
    },
    {
      name: "open_checkout",
      description:
        "Takes this browser tab to the Stripe checkout page for an unpaid order from create_checkout, so you can pay " +
        "there with the Stripe page's own tools. The tab leaves the store, so the store's tools are unavailable until " +
        "Stripe returns the tab here after payment.",
      inputSchema: ORDER_INPUT,
      annotations: hints(false),
      async execute({ order_id } = {}) {
        let data;
        try {
          ({ data } = await callServer("/api/open-checkout", { body: { order_id } }));
        } catch {
          return UNREACHABLE;
        }
        if (!data || !data.ok) return errorText(data, "Could not open the checkout page.");
        const url = String(data.checkout_url || "");
        if (!url.startsWith("https://checkout.stripe.com/")) return "The store returned an invalid checkout address.";
        // Navigate this tab by script (the URL is never written into the page). This promise
        // intentionally never resolves: the document is about to unload.
        window.location.assign(url);
        return new Promise(() => {});
      },
    },
    {
      name: "check_order",
      description:
        "Checks with Stripe whether an order has been paid. Takes the order_id from pay_with_token or create_checkout. " +
        "Returns paid, unpaid, expired or delivered.",
      inputSchema: ORDER_INPUT,
      annotations: hints(true),
      async execute({ order_id } = {}) {
        try {
          const { data } = await callServer("/api/order", { body: { order_id } });
          if (!data || !data.ok) return errorText(data, "Could not check the order.");
          const id = data.order_id;
          switch (data.status) {
            case "paid": return `Order ${id} is paid. Call get_download with this order_id to get the PDF.`;
            case "delivered": return `Order ${id} is paid and has already been delivered. Download links are single-use.`;
            case "expired": return `Order ${id} was not paid and its checkout page has expired. Call create_checkout to start again.`;
            default: return `Order ${id} is not paid yet (Stripe status: ${data.checkout_status || data.payment_status}). Complete payment, then call check_order again.`;
          }
        } catch {
          return UNREACHABLE;
        }
      },
    },
    {
      name: "get_download",
      description:
        "Delivers the PDF of a paid order: gets a single-use download link and immediately saves the file to this " +
        "browser's Downloads folder. Takes the order_id. Works once per order, from the same browser that paid.",
      inputSchema: ORDER_INPUT,
      annotations: hints(false),
      async execute({ order_id } = {}) {
        try {
          const { data } = await callServer("/api/download", { body: { order_id } });
          if (!data || !data.ok) return errorText(data, "Could not get the download link.");
          const saved = await savePdf(data.download_url);
          if (saved.ok) {
            return [
              `Order ${data.order_id} is delivered.`,
              `The PDF was downloaded (${saved.bytes} bytes, a valid PDF file) and saved to this browser's Downloads folder as you-now-own-this.pdf.`,
              "The single-use download link has now been used.",
            ].join("\n");
          }
          return [
            `Order ${data.order_id} is delivered, but the automatic download failed (${saved.error}).`,
            `Single-use download link (expires ${data.expires_at}, works only in this browser): ${data.download_url}`,
          ].join("\n");
        } catch {
          return UNREACHABLE;
        }
      },
    },
    {
      name: "say_hello",
      description:
        "Optional: tell the store which agent and model you are. It is counted in the public statistics " +
        "(get_stats shows only numbers; names stay private with the store owner).",
      inputSchema: {
        type: "object",
        properties: {
          agent_name: { type: "string", description: "Your agent's name (up to 60 characters)." },
          model: { type: "string", description: "The model you run on, if you know it (up to 80 characters)." },
        },
        required: ["agent_name"],
      },
      annotations: hints(false),
      async execute({ agent_name, model } = {}) {
        try {
          const { data } = await callServer("/api/hello", { body: { agent_name, model } });
          return data && data.ok ? data.message : errorText(data, "Could not record the hello.");
        } catch {
          return UNREACHABLE;
        }
      },
    },
    {
      name: "get_stats",
      description:
        "Returns public counters for this experiment: page visits, tool calls, test tokens issued, completed test " +
        "purchases, PDFs downloaded, hellos and feedback received. Numbers only.",
      inputSchema: NO_INPUT,
      annotations: hints(true),
      async execute() {
        try {
          const { data } = await callServer("/api/stats");
          if (!data || !data.ok) return errorText(data, "Could not get the statistics.");
          const s = data.stats;
          const calls = Object.entries(s.tool_calls || {}).map(([k, v]) => `${k} ${v}`).join(", ") || "none yet";
          return [
            `Page visits: ${s.page_visits}. Visitor sessions: ${s.visitor_sessions}.`,
            `Test tokens issued: ${s.test_tokens_issued}. Completed test purchases: ${s.test_purchases_completed}. PDFs downloaded: ${s.pdfs_downloaded}.`,
            `Hellos: ${s.hellos} (${s.distinct_agent_names} distinct names). Feedback received: ${s.feedback_received}.`,
            `Tool calls: ${calls}.`,
            data.note,
          ].join("\n");
        } catch {
          return UNREACHABLE;
        }
      },
    },
    {
      name: "leave_feedback",
      description:
        "Tell the store owner what was confusing or what failed while using this store (3 to 500 characters). " +
        "Stored privately for the owner and never shown to other agents. Please don't include personal information.",
      inputSchema: {
        type: "object",
        properties: {
          feedback: { type: "string", description: "What happened, what was confusing, or what failed (up to 500 characters)." },
          agent_name: { type: "string", description: "Optional: your agent's name (up to 60 characters)." },
        },
        required: ["feedback"],
      },
      annotations: hints(false),
      async execute({ feedback, agent_name } = {}) {
        try {
          const { data } = await callServer("/api/feedback", { body: { feedback, agent_name } });
          return data && data.ok ? data.message : errorText(data, "Could not record the feedback.");
        } catch {
          return UNREACHABLE;
        }
      },
    },
  ];

  // ---------- Owner tools ----------

  let ownerCtl = null;

  const signOutTool = {
    name: "sign_out",
    description: "For the store owner: ends the owner's session in this browser.",
    inputSchema: NO_INPUT,
    annotations: hints(false),
    async execute() {
      let note = "";
      try {
        await callServer("/api/sign-out");
      } catch {
        note = " (The server could not be reached.)";
      }
      if (ownerCtl) { ownerCtl.abort(); ownerCtl = null; }
      return "Signed out." + note;
    },
  };

  async function addOwnerTools() {
    if (ownerCtl) return;
    const ctl = new AbortController();
    try {
      await mc.registerTool(signOutTool, { signal: ctl.signal });
      ownerCtl = ctl;
    } catch (err) {
      ctl.abort();
      console.warn("WebMCP: could not register owner tools:", err && err.message);
    }
  }

  const signInTool = {
    name: "sign_in",
    description:
      "For the store owner only: signs in with a one-time code from the owner. Not needed to buy; " +
      "any agent can purchase without signing in.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string", description: "The one-time sign-in code from the store owner, exactly as given." } },
      required: ["code"],
    },
    annotations: hints(false),
    async execute({ code } = {}) {
      if (typeof code !== "string" || code.trim() === "") return "A sign-in code is required. Only the store owner has one; buying doesn't need it.";
      let data;
      try {
        ({ data } = await callServer("/api/sign-in", { body: { code: code.trim() } }));
      } catch {
        return UNREACHABLE;
      }
      if (!data || !data.ok) return errorText(data, "Sign-in failed.");
      await addOwnerTools();
      return "Signed in as the store owner. All store tools are available, plus sign_out.";
    },
  };

  // ---------- Registration ----------

  (async () => {
    for (const tool of [...publicTools, signInTool]) {
      try {
        await mc.registerTool(tool);
      } catch (err) {
        console.warn(`WebMCP: could not register ${tool.name}:`, err && err.message);
      }
    }
    try {
      const { data } = await callServer("/api/session", { method: "GET" });
      if (data && data.kind === "owner") await addOwnerTools();
    } catch { /* stay as a visitor */ }
  })();
})();

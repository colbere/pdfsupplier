// Runs in the visitor's browser. Registers WebMCP tools if the browser supports them.
// Browsers without WebMCP ignore all of this; the page is plain text either way.
//
// Security lives on the SERVER: every purchase tool calls an endpoint that checks the
// session cookie. Registering or hiding tools here is only about what the agent sees.
(() => {
  "use strict";

  const mc = document.modelContext;
  if (!mc || typeof mc.registerTool !== "function") return; // No WebMCP: do nothing.

  const IDLE_MS = 30 * 60 * 1000; // matches the server's session inactivity limit

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
    if (data && data.code === "not_authenticated") removePurchaseTools("server says not authenticated");
    else if (res.ok && purchaseCtl) resetIdleTimer();
    return { status: res.status, data };
  }

  const UNREACHABLE = "Could not reach the store's server. Try again shortly.";

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

  // ---------- Purchase tools (only while signed in) ----------

  let purchaseCtl = null; // AbortController for every post-sign-in tool
  let idleTimer = null;

  function resetIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => removePurchaseTools("session idle for 30 minutes"), IDLE_MS);
  }

  function removePurchaseTools(reason) {
    if (!purchaseCtl) return;
    purchaseCtl.abort(); // unregisters every tool registered with this signal
    purchaseCtl = null;
    clearTimeout(idleTimer);
    console.info(`WebMCP: purchase tools removed (${reason}).`);
  }

  const purchaseTools = [
    {
      name: "get_product",
      description:
        "Returns the store's only product: its name, price and what it contains. " +
        "Requires being signed in.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, consequentialHint: false, untrustedContentHint: false },
      async execute() {
        try {
          const { data } = await callServer("/api/product");
          if (!data || !data.ok) return (data && data.error) || "Could not get the product.";
          const p = data.product;
          return [
            `Product: ${p.name}`,
            `Price: ${p.price}`,
            `What it is: ${p.description}`,
            `Delivery: ${p.delivery}`,
            p.note,
            "To buy it: create_checkout, then open_checkout to pay on Stripe's page, then check_order and get_download.",
          ].join("\n");
        } catch {
          return UNREACHABLE;
        }
      },
    },
    {
      name: "create_checkout",
      description:
        "Starts a purchase of the PDF ($1.00 USD, Stripe test mode). Creates a Stripe Checkout page and " +
        "returns its URL and an order_id. This does not charge anything: payment happens on the Stripe " +
        "page, which has its own tools. If an unpaid order already exists, it is returned again. Requires being signed in.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: false, consequentialHint: false, untrustedContentHint: false },
      async execute() {
        try {
          const { data } = await callServer("/api/checkout");
          if (!data || !data.ok) return (data && data.error) || "Could not create a checkout.";
          return [
            data.reused ? "An unpaid order already exists; here it is again." : "Order created.",
            `order_id: ${data.order_id}`,
            `Stripe checkout URL: ${data.checkout_url}`,
            `The checkout page expires at ${data.expires_at}.`,
            "Next: call open_checkout with this order_id. It takes this tab to the Stripe page, where Stripe's own tools let you pay. " +
              "After payment Stripe returns to this store; then call check_order with this order_id.",
          ].join("\n");
        } catch {
          return UNREACHABLE;
        }
      },
    },
    {
      name: "open_checkout",
      description:
        "Takes this browser tab to the Stripe checkout page for an unpaid order, so you can pay there " +
        "using the Stripe page's own tools. Takes the order_id from create_checkout. The tab leaves the store; " +
        "after payment Stripe returns to the store and its tools come back. Requires being signed in.",
      inputSchema: {
        type: "object",
        properties: {
          order_id: { type: "string", description: "The order_id returned by create_checkout (starts with ord_)." },
        },
        required: ["order_id"],
      },
      annotations: { readOnlyHint: false, consequentialHint: false, untrustedContentHint: false },
      async execute({ order_id } = {}) {
        let data;
        try {
          ({ data } = await callServer("/api/open-checkout", { body: { order_id } }));
        } catch {
          return UNREACHABLE;
        }
        if (!data || !data.ok) return (data && data.error) || "Could not open the checkout page.";
        const url = String(data.checkout_url || "");
        if (!url.startsWith("https://checkout.stripe.com/")) return "The store returned an invalid checkout address.";
        // Navigate this tab by script (the URL is never written into the page). The WebMCP
        // extension treats a tool that navigates as "carry on with the new page's tools".
        // This promise intentionally never resolves: the document is about to unload.
        window.location.assign(url);
        return new Promise(() => {});
      },
    },
    {
      name: "check_order",
      description:
        "Checks with Stripe whether an order has been paid. Takes the order_id from create_checkout. " +
        "Returns paid, unpaid, expired or delivered. Requires being signed in.",
      inputSchema: {
        type: "object",
        properties: {
          order_id: { type: "string", description: "The order_id returned by create_checkout (starts with ord_)." },
        },
        required: ["order_id"],
      },
      annotations: { readOnlyHint: true, consequentialHint: false, untrustedContentHint: false },
      async execute({ order_id } = {}) {
        try {
          const { data } = await callServer("/api/order", { body: { order_id } });
          if (!data || !data.ok) return (data && data.error) || "Could not check the order.";
          const id = data.order_id;
          switch (data.status) {
            case "paid": return `Order ${id} is paid. Call get_download with this order_id to get the PDF.`;
            case "delivered": return `Order ${id} is paid and has already been delivered. Download links are single-use.`;
            case "expired": return `Order ${id} was not paid and its checkout page has expired. Call create_checkout to start again.`;
            default: return `Order ${id} is not paid yet (Stripe checkout status: ${data.checkout_status}). Complete payment on the Stripe checkout page, then call check_order again.`;
          }
        } catch {
          return UNREACHABLE;
        }
      },
    },
    {
      name: "get_download",
      description:
        "Delivers the PDF of a paid order: gets a single-use download link and immediately saves the file " +
        "to this browser's Downloads folder. Takes the order_id. Marks the order delivered, so it works " +
        "once per order. Call check_order first. Requires being signed in.",
      inputSchema: {
        type: "object",
        properties: {
          order_id: { type: "string", description: "The order_id of a paid order (starts with ord_)." },
        },
        required: ["order_id"],
      },
      annotations: { readOnlyHint: false, consequentialHint: false, untrustedContentHint: false },
      async execute({ order_id } = {}) {
        try {
          const { data } = await callServer("/api/download", { body: { order_id } });
          if (!data || !data.ok) return (data && data.error) || "Could not get the download link.";

          // Use the single-use link right away to save the file (no navigation, nothing added to the page).
          const saved = await savePdf(data.download_url);
          if (saved.ok) {
            return [
              `Order ${data.order_id} is delivered.`,
              `The PDF was downloaded (${saved.bytes} bytes, a valid PDF file) and saved to this browser's Downloads folder as you-now-own-this.pdf.`,
              "The single-use download link has now been used.",
            ].join("\n");
          }
          // Automatic save failed: hand back the (still unused) link instead.
          return [
            `Order ${data.order_id} is delivered, but the automatic download failed (${saved.error}).`,
            `Single-use download link (expires ${data.expires_at}, needs this signed-in browser): ${data.download_url}`,
          ].join("\n");
        } catch {
          return UNREACHABLE;
        }
      },
    },
    {
      name: "sign_out",
      description:
        "Signs out of the store and ends the session. The purchase tools are removed " +
        "until someone signs in again with a new one-time code.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: false, consequentialHint: false, untrustedContentHint: false },
      async execute() {
        let note = "";
        try {
          await callServer("/api/sign-out");
        } catch {
          note = " (The server could not be reached, but the tools were removed here.)";
        }
        removePurchaseTools("signed out");
        return "Signed out. The purchase tools have been removed. Signing in again needs a new one-time code." + note;
      },
    },
  ];

  // Registers all purchase tools, or none (rolls back on any failure).
  // Returns the list of tool names that are now available.
  async function addPurchaseTools() {
    if (purchaseCtl) return purchaseTools.map((t) => t.name); // already registered
    const ctl = new AbortController();
    try {
      for (const tool of purchaseTools) {
        await mc.registerTool(tool, { signal: ctl.signal });
      }
    } catch (err) {
      ctl.abort();
      console.warn("WebMCP: could not register purchase tools:", err && err.message);
      return [];
    }
    purchaseCtl = ctl;
    resetIdleTimer();
    return purchaseTools.map((t) => t.name);
  }

  // ---------- sign_in (always available) ----------

  const signInTool = {
    name: "sign_in",
    description:
      "Signs in as the store owner's agent using a one-time code. The owner gives you the code; " +
      "ask them for it if you don't have it. Codes work once and expire after 10 minutes. " +
      "After a successful sign-in, more store tools become available.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "The one-time sign-in code from the store owner, exactly as given.",
        },
      },
      required: ["code"],
    },
    annotations: { readOnlyHint: false, consequentialHint: false, untrustedContentHint: false },
    async execute({ code } = {}) {
      if (typeof code !== "string" || code.trim() === "") {
        return "A sign-in code is required. Ask the store owner for their one-time code.";
      }
      let data;
      try {
        ({ data } = await callServer("/api/sign-in", { body: { code: code.trim() } }));
      } catch {
        return UNREACHABLE;
      }
      if (!data || !data.ok) return (data && data.error) || "Sign-in failed.";
      const names = await addPurchaseTools();
      return names.length
        ? `Signed in. These tools are now available: ${names.join(", ")}.`
        : "Signed in, but the page could not add the store's tools. Reload the page and try again.";
    },
  };

  mc.registerTool(signInTool).catch((err) => {
    console.warn("WebMCP: could not register sign_in:", err && err.message);
  });

  // ---------- On page load: restore tools if already signed in ----------

  callServer("/api/session", { method: "GET" })
    .then(({ data }) => { if (data && data.signedIn) return addPurchaseTools(); })
    .catch(() => { /* server unreachable: stay signed out */ });
})();

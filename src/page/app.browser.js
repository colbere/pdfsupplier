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

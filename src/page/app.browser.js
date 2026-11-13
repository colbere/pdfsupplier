// Runs in the visitor's browser. Registers WebMCP tools if the browser supports them.
// Browsers without WebMCP ignore all of this; the page is plain text either way.
// Security lives on the server: these tools only call the server, which checks everything.
(() => {
  "use strict";

  const mc = document.modelContext;
  if (!mc || typeof mc.registerTool !== "function") return; // No WebMCP: do nothing.

  async function callServer(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body ?? {}),
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON reply */ }
    return { status: res.status, data };
  }

  const signInTool = {
    name: "sign_in",
    description:
      "Signs in as the store owner's agent using a one-time code. The owner gives you the code; " +
      "ask them for it if you don't have it. Codes work once and expire after 10 minutes. " +
      "After a successful sign-in, tools to see the product, pay and download the PDF become available.",
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
      try {
        const { data } = await callServer("/api/sign-in", { code: code.trim() });
        if (data && data.ok) {
          // Step 3 registers the purchase tools here.
          return data.message || "Signed in.";
        }
        return (data && data.error) || "Sign-in failed.";
      } catch {
        return "Could not reach the store's server. Try again shortly.";
      }
    },
  };

  mc.registerTool(signInTool).catch((err) => {
    console.warn("WebMCP: could not register sign_in:", err && err.message);
  });
})();

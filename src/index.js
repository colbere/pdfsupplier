// The PDF Supplier: Cloudflare Worker (server).
// Serves the single text-only page, its WebMCP script, and the API.
import PAGE_HTML from "./page/index.html";
import APP_JS from "./page/app.browser.js";

// Strict security headers on every response.
// The CSP only lets the browser run our own script (/app.js) and talk to our own server.
const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

function respond(body, contentType, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType, ...SECURITY_HEADERS, ...extra },
  });
}

function json(obj, status = 200) {
  return respond(JSON.stringify(obj), "application/json; charset=utf-8", status);
}

// Every sign-in failure returns exactly this (see docs/DECISIONS.md D6).
const SIGN_IN_FAILED = { ok: false, error: "Sign-in failed." };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (pathname === "/" && (method === "GET" || method === "HEAD")) {
      return respond(PAGE_HTML, "text/html; charset=utf-8");
    }

    if (pathname === "/app.js" && (method === "GET" || method === "HEAD")) {
      return respond(APP_JS, "text/javascript; charset=utf-8");
    }

    if (pathname === "/api/sign-in" && method === "POST") {
      // Step 2 placeholder: no codes exist yet, so every attempt fails. Real logic arrives in Step 3.
      return json(SIGN_IN_FAILED, 401);
    }

    return respond("Not found.", "text/plain; charset=utf-8", 404);
  },
};

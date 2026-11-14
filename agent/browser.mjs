// Chrome control for the owner's agent: launch with WebMCP, read every frame's own tools,
// run a tool in the frame that owns it, and wait for a page's tools to settle.
// These are general abilities; nothing here is specific to the PDF Supplier.
import puppeteer from "puppeteer-core";

export const CHROME_PATH =
  process.env.PDFS_CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchBrowser({ show, downloadDir }) {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: !show,
    defaultViewport: show ? null : { width: 1280, height: 900 },
    // --enable-features=WebMCP is how Google's own extension tests turn WebMCP on.
    args: ["--enable-features=WebMCP", "--no-first-run", "--no-default-browser-check"],
  });
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  const cdp = await browser.target().createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir, eventsEnabled: true });
  return { browser, page };
}

export function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** Lists the tools each allowed frame registered itself. Frames that block WebMCP are skipped. */
export async function listTools(page, isAllowedToolOrigin) {
  const out = [];
  for (const frame of page.frames()) {
    const origin = originOf(frame.url());
    if (!origin || !isAllowedToolOrigin(origin)) continue;
    let tools;
    try {
      tools = await frame.evaluate(async () => {
        const mc = document.modelContext;
        if (!mc) return [];
        let list;
        try {
          list = await mc.getTools();
        } catch {
          return []; // e.g. blocked by the frame's permissions policy
        }
        return list
          .filter((t) => t.window === window)
          .map((t) => ({
            name: t.name,
            description: t.description || "",
            inputSchema: t.inputSchema ?? null,
            annotations: t.annotations ?? {},
          }));
      });
    } catch {
      continue; // frame navigating or detached
    }
    for (const t of tools) {
      let schema = t.inputSchema;
      if (typeof schema === "string") {
        try { schema = JSON.parse(schema); } catch { schema = null; }
      }
      out.push({ ...t, inputSchema: schema, frame, origin });
    }
  }
  return out;
}

/**
 * Runs a tool in its own frame. Returns one of:
 *   { kind: "ok", value }         value is a string (objects are JSON-stringified)
 *   { kind: "navigated" }         the tool moved the tab (its document went away)
 *   { kind: "timeout" }           no answer within timeoutMs (it may still have taken effect)
 *   { kind: "error", message }
 */
export async function runTool(tool, input, timeoutMs) {
  const exec = tool.frame
    .evaluate(
      async (name, args) => {
        const mc = document.modelContext;
        const t = (await mc.getTools()).find((x) => x.name === name && x.window === window);
        if (!t) throw new Error(`Tool "${name}" is no longer available on this page.`);
        const r = await mc.executeTool(t, args);
        if (r === null) return { __navigated: true }; // WebMCP returns null when a navigation is triggered
        return typeof r === "string" ? r : JSON.stringify(r);
      },
      tool.name,
      input ?? {},
    )
    .then(
      (v) => (v && typeof v === "object" && v.__navigated ? { kind: "navigated" } : { kind: "ok", value: v ?? "" }),
      (e) => {
        const m = String(e?.message || e);
        return /context was destroyed|detached|navigat|Target closed/i.test(m)
          ? { kind: "navigated" }
          : { kind: "error", message: m.replace(/^Error:\s*/, "").slice(0, 500) };
      },
    );
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  try {
    return await Promise.race([exec, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Waits until the page has stopped changing: network quiet, then the same URL and tool list
 * for `quietMs`, with at least one tool. Gives up after `maxMs` and returns what is there.
 */
export async function settle(page, isAllowedToolOrigin, { maxMs = 15000, quietMs = 800 } = {}) {
  const start = Date.now();
  try {
    await page.waitForNetworkIdle({ idleTime: 600, timeout: maxMs, concurrency: 2 });
  } catch {
    // Some pages never go fully quiet; carry on with the tool check.
  }
  let lastSig = null;
  let stableSince = Date.now();
  let tools = [];
  while (Date.now() - start < maxMs) {
    tools = await listTools(page, isAllowedToolOrigin);
    const sig = page.url() + "|" + tools.map((t) => `${t.origin}:${t.name}`).sort().join(",");
    if (sig !== lastSig) {
      lastSig = sig;
      stableSince = Date.now();
    } else if (tools.length > 0 && Date.now() - stableSince >= quietMs) {
      return tools;
    }
    await sleep(250);
  }
  return tools;
}

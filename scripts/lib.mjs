// Shared helpers for the admin scripts. Never prints secret values.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ENV_PATH = join(ROOT, ".env");
export const BASE_URL = process.env.PDFS_BASE_URL || "http://localhost:8787";

// Minimal .env parser: KEY=value lines, # comments, optional quotes.
export function readEnv() {
  if (!existsSync(ENV_PATH)) return {};
  const out = {};
  for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

// Calls the local server's admin API with ADMIN_TOKEN from .env.
export async function admin(path, method = "GET", body) {
  const token = readEnv().ADMIN_TOKEN;
  if (!token || token.length < 32) fail("ADMIN_TOKEN is missing from .env. Run `npm run setup` first.");
  let res;
  try {
    res = await fetch(BASE_URL + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    fail(`Could not reach the server at ${BASE_URL}. Is it running? (npm run dev)`);
  }
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok || !data || !data.ok) fail((data && data.error) || `Server returned HTTP ${res.status}.`);
  return data;
}

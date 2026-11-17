// npm run setup-live
// Deploys the LIVE site together with its two secrets (never printed, never typed into chat):
//   - STRIPE_SECRET_KEY  <- STRIPE_SECRET_KEY_LIVE from .env (must be a restricted SANDBOX key, rk_test_)
//   - ADMIN_TOKEN        <- ADMIN_TOKEN_LIVE from .env (generated here on first run; separate from
//                           the local ADMIN_TOKEN), so the owner commands work with --live.
// Requires `npx wrangler login` first. Safe to re-run (re-deploys and re-sends the same secrets).
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ENV_PATH, readEnv, fail } from "./lib.mjs";

const env = readEnv();

const stripeKey = env.STRIPE_SECRET_KEY_LIVE || "";
if (!stripeKey.startsWith("rk_test_") || /\s/.test(stripeKey) || stripeKey.length < 40) {
  fail("STRIPE_SECRET_KEY_LIVE in .env must be a restricted SANDBOX key starting rk_test_ (see docs/SECURITY.md).");
}
if (stripeKey === env.STRIPE_SECRET_KEY) fail("STRIPE_SECRET_KEY_LIVE must be a different key from the local STRIPE_SECRET_KEY.");

let token = env.ADMIN_TOKEN_LIVE;
if (!token || token.length < 32) {
  token = randomBytes(32).toString("base64url"); // 256 bits
  const text = readFileSync(ENV_PATH, "utf8").replace(/\s*$/, "\n");
  writeFileSync(ENV_PATH, `${text}\n# LIVE site admin password (npm run setup-live). Separate from ADMIN_TOKEN.\nADMIN_TOKEN_LIVE=${token}\n`);
  console.log("Generated ADMIN_TOKEN_LIVE in .env (value not shown).");
}

// Deploy with both secrets in one step via a temporary secrets file (a brand-new Worker can't
// take `wrangler secret put` before its first deploy). The file lives in a private temp folder
// and is deleted straight after, whatever happens.
const dir = mkdtempSync(join(tmpdir(), "pdfs-"));
const file = join(dir, "secrets.json");
let r;
try {
  writeFileSync(file, JSON.stringify({ STRIPE_SECRET_KEY: stripeKey, ADMIN_TOKEN: token }), { mode: 0o600 });
  r = spawnSync("npx", ["wrangler", "deploy", "--secrets-file", file], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (r.status !== 0) fail("wrangler deploy failed (logged in with `npx wrangler login`?).");
console.log("Deployed with STRIPE_SECRET_KEY and ADMIN_TOKEN set. Later code changes: npx wrangler deploy");
console.log("Check: npm run report -- --live");

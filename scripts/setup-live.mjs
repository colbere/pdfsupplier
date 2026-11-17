// npm run setup-live
// Sends the LIVE site's two secrets to Cloudflare, piped straight to `wrangler secret put`
// (never printed, never typed into chat):
//   - STRIPE_SECRET_KEY  <- STRIPE_SECRET_KEY_LIVE from .env (must be a restricted SANDBOX key, rk_test_)
//   - ADMIN_TOKEN        <- ADMIN_TOKEN_LIVE from .env (generated here on first run; separate from
//                           the local ADMIN_TOKEN), so the owner commands work with --live.
// Requires `npx wrangler login` first and a deployed Worker (`npx wrangler deploy`).
import { readFileSync, writeFileSync } from "node:fs";
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

function put(name, value) {
  const r = spawnSync("npx", ["wrangler", "secret", "put", name], {
    input: value + "\n",
    stdio: ["pipe", "inherit", "inherit"],
    shell: process.platform === "win32",
  });
  if (r.status !== 0) fail(`wrangler secret put ${name} failed (logged in with \`npx wrangler login\`? Worker deployed?).`);
  console.log(`Stored ${name} in Cloudflare.`);
}

put("STRIPE_SECRET_KEY", stripeKey);
put("ADMIN_TOKEN", token);
console.log("Live secrets set. Check: npm run report -- --live");

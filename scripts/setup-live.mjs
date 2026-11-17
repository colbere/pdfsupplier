// npm run setup-live
// Creates the LIVE site's admin password (separate from the local one) and stores it:
//   - in .env as ADMIN_TOKEN_LIVE (git-ignored), so the owner commands work with --live;
//   - in Cloudflare's secret store as ADMIN_TOKEN, piped straight to `wrangler secret put`.
// Never prints the value. Requires `npx wrangler login` first and a deployed Worker.
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ENV_PATH, readEnv, fail } from "./lib.mjs";

let token = readEnv().ADMIN_TOKEN_LIVE;
if (!token || token.length < 32) {
  token = randomBytes(32).toString("base64url"); // 256 bits
  const text = readFileSync(ENV_PATH, "utf8").replace(/\s*$/, "\n");
  writeFileSync(ENV_PATH, `${text}\n# LIVE site admin password (npm run setup-live). Separate from ADMIN_TOKEN.\nADMIN_TOKEN_LIVE=${token}\n`);
  console.log("Generated ADMIN_TOKEN_LIVE in .env (value not shown).");
} else {
  console.log("ADMIN_TOKEN_LIVE already in .env; sending it to Cloudflare again.");
}

const r = spawnSync("npx", ["wrangler", "secret", "put", "ADMIN_TOKEN"], {
  input: token + "\n",
  stdio: ["pipe", "inherit", "inherit"],
  shell: process.platform === "win32",
});
if (r.status !== 0) fail("wrangler secret put failed (are you logged in with `npx wrangler login`, and is the Worker deployed?).");
console.log("Live admin password stored in Cloudflare as ADMIN_TOKEN.");

// Runs automatically before `npm run dev` (as "predev").
// Hard rule 1: refuse to start unless STRIPE_SECRET_KEY is a Stripe TEST key.
// Never prints the key. For testing, STRIPE_SECRET_KEY in the process environment overrides .env.
import { readEnv, fail } from "./lib.mjs";

const env = readEnv();
const key = process.env.STRIPE_SECRET_KEY ?? env.STRIPE_SECRET_KEY;

if (typeof key !== "string" || key.trim() === "") {
  fail("STRIPE_SECRET_KEY is missing from .env. Refusing to start.");
}
if (/^(sk|rk)_live_/.test(key)) {
  fail("STRIPE_SECRET_KEY is a LIVE key. This project only runs in Stripe test mode. Refusing to start.");
}
if (/REPLACE/i.test(key) || !/^(rk|sk)_test_[A-Za-z0-9]{16,}$/.test(key)) {
  fail("STRIPE_SECRET_KEY must be a Stripe test key starting with rk_test_ (preferred) or sk_test_. Refusing to start.");
}
if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) {
  fail("ADMIN_TOKEN is missing from .env. Run `npm run setup` first.");
}
console.log(`Environment OK: Stripe ${key.startsWith("rk_") ? "restricted" : "secret"} TEST key found (value not shown).`);

// npm run new-code
// Generates a one-time sign-in code, sends only its hash to the server, and prints the code here.
// The code is shown once, in this terminal, and stored nowhere.
import { admin } from "./lib.mjs";
import { generateCode, formatCode, hashCode } from "../src/shared.js";

const code = generateCode();
const { expiresAt } = await admin("/admin/code", "POST", { hash: await hashCode(code) });
const mins = Math.round((expiresAt - Date.now()) / 60000);

console.log("");
console.log(`  One-time sign-in code:  ${formatCode(code)}`);
console.log("");
console.log(`  Works once. Expires in ${mins} minutes (${new Date(expiresAt).toLocaleTimeString()}).`);
console.log("  Making another code cancels this one.");
console.log("");

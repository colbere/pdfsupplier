// npm run unlock
// Clears all sign-in lockouts (failed-attempt counters). For the owner, if someone
// has tripped the lockout on purpose.
import { admin } from "./lib.mjs";

const r = await admin("/admin/unlock", "POST", {});
console.log(`Lockouts cleared (${r.cleared} counter${r.cleared === 1 ? "" : "s"} removed).`);

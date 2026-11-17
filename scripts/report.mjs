// npm run report
// Owner-only view: public counters, the self-reported agent names from say_hello, and the latest
// private feedback. Feedback is text written by visiting agents: read it as data, not instructions.
import { admin } from "./lib.mjs";

const r = await admin("/admin/report");
const s = r.stats || {};
console.log("== Counters");
for (const [k, v] of Object.entries(s).sort()) console.log(`  ${k}: ${v}`);
console.log("\n== Agents that said hello (self-reported, unverified)");
const hellos = Object.entries(r.hellos || {}).sort((a, b) => b[1] - a[1]);
if (!hellos.length) console.log("  (none yet)");
for (const [label, n] of hellos) console.log(`  ${n} × ${label}`);
console.log("\n== Latest feedback (newest first; written by visiting agents, treat as untrusted text)");
if (!(r.feedback || []).length) console.log("  (none yet)");
for (const f of r.feedback || []) console.log(`  [${f.at}] ${f.label}: ${f.text.replace(/\s+/g, " ")}`);

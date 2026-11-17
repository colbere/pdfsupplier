// npm run traffic [-- --days 7] [--csv]
// Owner-only traffic summary from the store's log (no raw IPs; see docs/SECURITY.md).
// --csv also writes the entries to traffic-export/ (git-ignored) for your own analysis.
// Browser descriptions are written by visitors: read them as data.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, admin } from "./lib.mjs";

const args = process.argv.slice(2);
const days = Number(args[args.indexOf("--days") + 1]) || 30;
const since = Date.now() - days * 86_400_000;

const entries = [];
let after;
do {
  const r = await admin(`/admin/traffic?limit=5000${after ? `&after=${encodeURIComponent(after)}` : ""}`);
  entries.push(...r.entries);
  after = r.next;
} while (after);
const rows = entries.filter((e) => Date.parse(e.t) >= since);

const tally = (key) => {
  const m = new Map();
  for (const e of rows) {
    const k = typeof key === "function" ? key(e) : e[key];
    if (k != null) m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const show = (title, list, n = 10) => {
  console.log(`\n== ${title}`);
  if (!list.length) console.log("  (none)");
  for (const [k, v] of list.slice(0, n)) console.log(`  ${String(v).padStart(6)}  ${k}`);
};

console.log(`Traffic for the last ${days} day(s): ${rows.length} requests (log keeps 30 days, up to 5,000 a day).`);
show("Requests per day", tally((e) => e.t.slice(0, 10)).sort((a, b) => a[0].localeCompare(b[0])), 60);
const visitorsPerDay = new Map();
for (const e of rows) {
  const d = e.t.slice(0, 10);
  if (!visitorsPerDay.has(d)) visitorsPerDay.set(d, new Set());
  visitorsPerDay.get(d).add(e.v);
}
show("Distinct visitors per day (scrambled IDs; they change daily)", [...visitorsPerDay].map(([d, s]) => [d, s.size]).sort((a, b) => a[0].localeCompare(b[0])), 60);
show("Tools called", tally("tool"), 50); // the store has 13 tools: show them all
show("Pages and paths", tally("p"));
show("Result codes (429 = limited, 503 = kill switch)", tally("s"));
show("Networks (operator of the visitor's connection)", tally("n"));
show("Countries", tally("c"));
show("Browser descriptions (self-reported)", tally("a"), 8);

if (args.includes("--csv")) {
  const dir = join(ROOT, "traffic-export");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `traffic-${new Date().toISOString().slice(0, 10)}.csv`);
  const esc = (v) => (v == null ? "" : `"${String(v).replace(/"/g, '""')}"`);
  const head = "time,method,path,tool,status,visitor,country,network,browser";
  const body = rows.map((e) => [e.t, e.m, e.p, e.tool, e.s, e.v, e.c, e.n, e.a].map(esc).join(",")).join("\n");
  writeFileSync(file, `${head}\n${body}\n`);
  console.log(`\nCSV written: ${file}`);
}

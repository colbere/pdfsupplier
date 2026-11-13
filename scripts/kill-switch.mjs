// npm run kill-switch -- on | off | status
//   on:     sign_in always fails, every session is deleted, the active code is deleted.
//   off:    sign-in works again. (Old sessions stay deleted.)
//   status: shows the current state.
import { admin, fail } from "./lib.mjs";

const arg = (process.argv[2] || "status").toLowerCase();

if (arg === "on" || arg === "off") {
  const r = await admin("/admin/kill-switch", "POST", { on: arg === "on" });
  if (r.killSwitch) console.log(`Kill switch is ON. Sessions removed: ${r.sessionsRemoved}. Sign-in is disabled.`);
  else console.log("Kill switch is off. Sign-in works again (old sessions stay invalid).");
} else if (arg === "status") {
  const r = await admin("/admin/status");
  console.log(`Kill switch:          ${r.killSwitch ? "ON" : "off"}`);
  console.log(`Active code:          ${r.codeActive ? "yes" : "no"}`);
  console.log(`Active sessions:      ${r.activeSessions}`);
  console.log(`Recent failed logins: ${r.recentGlobalFailures} (lockout at 5 within 15 minutes)`);
} else {
  fail("Use: npm run kill-switch -- on | off | status");
}

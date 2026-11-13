#!/usr/bin/env bash
# Sign-in and lockdown checks against the local server (npm run dev must be running).
# Run from the project root:  bash tests/auth-checks.sh
# Never prints codes, session tokens or the admin token.
# NOTE: resets lockouts and toggles the kill switch off at the end.
set -u
B="${PDFS_BASE_URL:-http://localhost:8787}"
PASS=0; FAILN=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAILN=$((FAILN+1)); }
expect() { # expect <label> <wanted> <got>
  if [ "$2" = "$3" ]; then ok "$1 (got $3)"; else bad "$1 (wanted $2, got $3)"; fi
}
newcode() { npm run --silent new-code 2>&1 | grep -oE '[2-9A-Z]{5}-[2-9A-Z]{5}-[2-9A-Z]{5}'; }
signin() { # signin <code> [extra curl args...] -> prints HTTP status; cookie jar in $JAR
  local code="$1"; shift
  curl -s -o /tmp/pdfs_body -w "%{http_code}" -c "$JAR" -X POST -H 'Content-Type: application/json' \
    "$@" -d "{\"code\":\"$code\"}" "$B/api/sign-in"
}
session() { curl -s -o /dev/null -w "%{http_code}" "$@" "$B/api/session"; }
JAR=$(mktemp); JAR2=$(mktemp)

echo "== Setup"
npm run --silent kill-switch -- off >/dev/null; npm run --silent unlock >/dev/null; echo "  lockouts cleared, kill switch off"

echo "== 1. Admin API needs the admin token"
expect "admin status, no token"    401 "$(curl -s -o /dev/null -w '%{http_code}' "$B/admin/status")"
expect "admin status, wrong token" 401 "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer wrongwrongwrongwrongwrongwrongwrong' "$B/admin/status")"

echo "== 2. Sign-in with no active code fails generically"
npm run --silent unlock >/dev/null
expect "no code -> 401" 401 "$(signin 'AAAAA-BBBBB-CCCCC')"
expect "generic error body" '{"ok":false,"error":"Sign-in failed."}' "$(cat /tmp/pdfs_body)"

echo "== 3. Valid code signs in (typed lower-case, no dashes) and sets a locked-down cookie"
npm run --silent unlock >/dev/null
CODE=$(newcode); [ -n "$CODE" ] && ok "new-code produced a code (not shown)" || bad "new-code produced no code"
LOOSE=$(echo "$CODE" | tr -d '-' | tr 'A-Z' 'a-z')
expect "valid code -> 200" 200 "$(signin "$LOOSE" -D /tmp/pdfs_hdr)"
SC=$(tr -d '\r' < /tmp/pdfs_hdr | grep -i '^set-cookie:' | sed -E 's/=[A-Za-z0-9_-]{20,};/=[REDACTED];/')
echo "        $SC"
for attr in "__Host-pdfs_session=" "Path=/" "Secure" "HttpOnly" "SameSite=Strict"; do
  echo "$SC" | grep -q "$attr" && ok "cookie has $attr" || bad "cookie missing $attr"
done

echo "== 4. Session checks"
expect "with cookie -> 200"        200 "$(session -b "$JAR")"
expect "no cookie -> 401"          401 "$(session)"
expect "forged cookie -> 401"      401 "$(session -H 'Cookie: __Host-pdfs_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')"

echo "== 5. Code is single use"
expect "reuse same code -> 401" 401 "$(signin "$CODE" -c "$JAR2")"

echo "== 6. Cross-origin request refused"
npm run --silent unlock >/dev/null
CODE=$(newcode)
expect "Origin: https://evil.example -> 403" 403 "$(signin "$CODE" -H 'Origin: https://evil.example' -c "$JAR2")"
expect "same code still valid from our origin -> 200" 200 "$(signin "$CODE" -H "Origin: $B" -c "$JAR2")"

echo "== 7. Lockout after 5 failures (generic error throughout)"
npm run --silent unlock >/dev/null
CODE=$(newcode)
for i in 1 2 3 4 5; do expect "wrong code #$i -> 401" 401 "$(signin "WRONG-WRONG-WRON$i" -c "$JAR2")"; done
expect "CORRECT code while locked -> 401" 401 "$(signin "$CODE" -c "$JAR2")"
expect "locked error body is identical" '{"ok":false,"error":"Sign-in failed."}' "$(cat /tmp/pdfs_body)"
expect "different client IP also locked (global) -> 401" 401 "$(signin "$CODE" -H 'CF-Connecting-IP: 203.0.113.9' -c "$JAR2")"
npm run --silent unlock >/dev/null; echo "  (npm run unlock)"
expect "after unlock, same code works -> 200" 200 "$(signin "$CODE" -c "$JAR2")"

echo "== 8. Kill switch"
expect "session 2 valid before kill -> 200" 200 "$(session -b "$JAR2")"
npm run --silent kill-switch -- on | sed 's/^/        /'
expect "session 2 after kill -> 401"   401 "$(session -b "$JAR2")"
expect "session 1 after kill -> 401"   401 "$(session -b "$JAR")"
if npm run --silent new-code >/dev/null 2>&1; then bad "new-code refused while killed"; else ok "new-code refused while killed"; fi
expect "sign-in while killed -> 401" 401 "$(signin 'AAAAA-BBBBB-CCCCC' -c /dev/null)"
npm run --silent kill-switch -- off | sed 's/^/        /'
expect "session 2 still dead after kill off -> 401" 401 "$(session -b "$JAR2")"
npm run --silent unlock >/dev/null
CODE=$(newcode)
expect "fresh sign-in after kill off -> 200" 200 "$(signin "$CODE" -c "$JAR2")"

echo "== Cleanup"
npm run --silent unlock >/dev/null; rm -f "$JAR" "$JAR2" /tmp/pdfs_body /tmp/pdfs_hdr
echo ""
echo "RESULT: $PASS passed, $FAILN failed"
[ "$FAILN" -eq 0 ]

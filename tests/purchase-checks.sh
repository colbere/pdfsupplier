#!/usr/bin/env bash
# Purchase-flow checks that don't need a payment (npm run dev must be running; real Stripe TEST calls).
# Run from the project root:  bash tests/purchase-checks.sh
# Never prints codes, session tokens or Stripe URLs.
set -u
B="${PDFS_BASE_URL:-http://localhost:8787}"
PASS=0; FAILN=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAILN=$((FAILN+1)); }
expect() { if [ "$2" = "$3" ]; then ok "$1 (got $3)"; else bad "$1 (wanted $2, got $3)"; fi; }
has()    { if grep -q -- "$2" /tmp/pdfs_body; then ok "$1"; else bad "$1 (body: $(cat /tmp/pdfs_body))"; fi; }
newcode() { npm run --silent new-code 2>&1 | grep -oE '[2-9A-Z]{5}-[2-9A-Z]{5}-[2-9A-Z]{5}'; }
signin()  { npm run --silent unlock >/dev/null; curl -s -o /dev/null -c "$1" -X POST -H 'Content-Type: application/json' -d "{\"code\":\"$(newcode)\"}" "$B/api/sign-in"; }
post() { local jar="$1" path="$2" body="${3:-{\}}"; curl -s -o /tmp/pdfs_body -w "%{http_code}" -b "$jar" -X POST -H 'Content-Type: application/json' -d "$body" "$B$path"; }
JA=$(mktemp); JB=$(mktemp); NOJAR=$(mktemp)

npm run --silent kill-switch -- off >/dev/null
signin "$JA"; signin "$JB"

echo "== 1. Purchase endpoints need a session"
for p in /api/checkout /api/order /api/download; do expect "$p without session -> 401" 401 "$(post "$NOJAR" $p)"; done
expect "GET /download/<random> without session -> 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$B/download/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")"

echo "== 2. create_checkout (real Stripe test call)"
expect "create_checkout -> 200" 200 "$(post "$JA" /api/checkout)"
OID=$(grep -oE 'ord_[a-z2-9]{20}' /tmp/pdfs_body | head -1)
[ -n "$OID" ] && ok "order_id returned ($OID)" || bad "no order_id"
grep -qE '"checkout_url":"https://checkout\.stripe\.com/[^"]*cs_test_' /tmp/pdfs_body && ok "checkout_url is a Stripe TEST checkout URL (not shown)" || bad "checkout_url missing or not test"
expect "create_checkout again -> 200" 200 "$(post "$JA" /api/checkout)"
has "  ...reuses the open order" "\"reused\":true,\"order_id\":\"$OID\""

echo "== 3. Before payment"
expect "check_order -> 200" 200 "$(post "$JA" /api/order "{\"order_id\":\"$OID\"}")"
has "  ...status unpaid, Stripe status open" '"status":"unpaid","checkout_status":"open"'
expect "get_download unpaid -> 409" 409 "$(post "$JA" /api/download "{\"order_id\":\"$OID\"}")"
has "  ...explains not paid" 'not marked paid'

echo "== 4. Orders belong to the session that created them"
expect "session B check_order on A's order -> 404" 404 "$(post "$JB" /api/order "{\"order_id\":\"$OID\"}")"
expect "session B get_download on A's order -> 404" 404 "$(post "$JB" /api/download "{\"order_id\":\"$OID\"}")"

echo "== 5. Input validation"
expect "malformed order_id -> 400" 400 "$(post "$JA" /api/order '{"order_id":"../../etc"}')"
expect "missing order_id -> 400"   400 "$(post "$JA" /api/download '{}')"
expect "bogus download token (signed in) -> 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' -b "$JA" "$B/download/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")"

echo "== 6. Stripe URL never in the server log"
LOG="${PDFS_SERVER_LOG:-}"
if [ -n "$LOG" ] && [ -f "$LOG" ]; then
  grep -aqE 'checkout\.stripe\.com|cs_test_|rk_test_|sk_test_' "$LOG" && bad "server log contains a Stripe URL/key" || ok "no Stripe URL or key in server log"
else
  echo "  (skipped: set PDFS_SERVER_LOG to the wrangler output file)"
fi

npm run --silent unlock >/dev/null; rm -f "$JA" "$JB" "$NOJAR" /tmp/pdfs_body
echo ""
echo "RESULT: $PASS passed, $FAILN failed"
[ "$FAILN" -eq 0 ]

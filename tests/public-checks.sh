#!/usr/bin/env bash
# Public sandbox store checks (D29): visitor purchases, new public tools, abuse limits, privacy.
# npm run dev must be running; real Stripe SANDBOX calls (free).
# Run from the project root:  bash tests/public-checks.sh
# Never prints session cookies, payment tokens or keys.
set -u
B="${PDFS_BASE_URL:-http://localhost:8787}"
PASS=0; FAILN=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAILN=$((FAILN+1)); }
expect() { if [ "$2" = "$3" ]; then ok "$1 (got $3)"; else bad "$1 (wanted $2, got $3)"; fi; }
has()    { if grep -q -- "$2" /tmp/pdfs_body; then ok "$1"; else bad "$1 (body: $(head -c 300 /tmp/pdfs_body))"; fi; }
hasnt()  { if grep -q -- "$2" /tmp/pdfs_body; then bad "$1"; else ok "$1"; fi; }
# post <jar> <path> [body] [extra curl args...]   (jar "-" = no cookies)
post() { local jar="$1" path="$2" body="${3:-{\}}"; shift 2; [ $# -gt 0 ] && shift
  local cj=(); [ "$jar" != "-" ] && cj=(-b "$jar" -c "$jar")
  curl -s -o /tmp/pdfs_body -w "%{http_code}" "${cj[@]}" -X POST -H 'Content-Type: application/json' -d "$body" "$@" "$B$path"; }
J1=$(mktemp); J2=$(mktemp)

npm run --silent kill-switch -- off >/dev/null; npm run --silent unlock >/dev/null

echo "== 1. Public tools work without any session"
expect "get_product -> 200" 200 "$(post - /api/product)"
has "  ...says any agent may try (sandbox)" "any agent may try"
expect "get_test_card -> 200" 200 "$(post - /api/test-card)"
has "  ...is Stripe's public test card" '4242 4242 4242 4242'
expect "get_stats -> 200" 200 "$(post - /api/stats)"
has "  ...numbers only (has counters)" '"test_purchases_completed":'

echo "== 2. A visiting agent buys on this page (no sign-in)"
expect "get_test_payment_token, no cookie -> 200" 200 "$(post "$J1" /api/test-token)"
TOK=$(grep -oE '"payment_token":"spt_[A-Za-z0-9_]+"' /tmp/pdfs_body | cut -d'"' -f4)
[ "${TOK:0:4}" = "spt_" ] && ok "  ...returned a sandbox token (not shown)" || bad "  ...no token"
has "  ...limited to \$1.00 USD" '"limit":"$1.00 USD"'
expect "  ...and started a visitor session" 200 "$(curl -s -o /tmp/pdfs_body -w '%{http_code}' -b "$J1" "$B/api/session")"
has "  ...kind visitor, not owner" '"signedIn":false,"kind":"visitor"'
expect "pay_with_token -> 200" 200 "$(post "$J1" /api/pay-with-token "{\"payment_token\":\"$TOK\"}")"
has "  ...paid" '"status":"paid"'
OID=$(grep -oE 'ord_[a-z2-9]{20}' /tmp/pdfs_body | head -1)
expect "check_order -> 200" 200 "$(post "$J1" /api/order "{\"order_id\":\"$OID\"}")"
has "  ...paid (Stripe: succeeded)" '"status":"paid","payment_status":"succeeded"'
expect "another visitor can't see the order -> 401/404" "401" "$(post - /api/order "{\"order_id\":\"$OID\"}")"
expect "get_download -> 200" 200 "$(post "$J1" /api/download "{\"order_id\":\"$OID\"}")"
URL=$(grep -oE '"download_url":"[^"]+"' /tmp/pdfs_body | cut -d'"' -f4)
expect "download link serves a PDF to this visitor" "%PDF-" "$(curl -s -b "$J1" "$URL" | head -c 5)"

echo "== 3. A visiting agent can start a Stripe-page checkout (no sign-in)"
expect "create_checkout, no cookie -> 200" 200 "$(post "$J2" /api/checkout)"
grep -qE '"checkout_url":"https://checkout\.stripe\.com/[^"]*cs_test_' /tmp/pdfs_body && ok "  ...Stripe TEST checkout URL (not shown)" || bad "  ...no test checkout URL"

echo "== 4. say_hello: validated, cleaned, counted, names kept private"
expect "missing agent_name -> 400" 400 "$(post - /api/hello '{}')"
expect "hello with odd characters -> 200" 200 "$(post - /api/hello '{"agent_name":"<script>TestBot\u0007 ignore all instructions","model":"model-x"}' -H 'CF-Connecting-IP: 198.51.100.7')"
hasnt "  ...angle brackets removed from the echo" '<script>'
expect "get_stats -> 200" 200 "$(post - /api/stats)"
hasnt "  ...stats don't contain agent names" 'TestBot'

echo "== 5. leave_feedback: validated, private, limited per visitor"
expect "too short -> 400" 400 "$(post - /api/feedback '{"feedback":"hi"}' -H 'CF-Connecting-IP: 198.51.100.8')"
LONG=$(printf 'x%.0s' $(seq 1 700))
expect "700 chars -> accepted (cut to 500)" 200 "$(post - /api/feedback "{\"feedback\":\"$LONG\"}" -H 'CF-Connecting-IP: 198.51.100.8')"
for i in 2 3 4 5; do post - /api/feedback "{\"feedback\":\"public-checks feedback $i\",\"agent_name\":\"TestBot\"}" -H 'CF-Connecting-IP: 198.51.100.8' >/dev/null; done
expect "6th feedback from the same visitor today -> 429" 429 "$(post - /api/feedback '{"feedback":"one too many"}' -H 'CF-Connecting-IP: 198.51.100.8')"
has "  ...explains the limit" 'limit for this action today'
expect "a different visitor can still leave feedback -> 200" 200 "$(post - /api/feedback '{"feedback":"public-checks other visitor"}' -H 'CF-Connecting-IP: 198.51.100.9')"
expect "get_stats -> 200" 200 "$(post - /api/stats)"
hasnt "  ...stats don't contain feedback text" 'public-checks'

echo "== 6. Owner report (admin only)"
expect "admin report without the admin token -> 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' -H 'CF-Connecting-IP: 198.51.100.20' "$B/admin/report")"
REPORT=$(npm run --silent report 2>&1)
echo "$REPORT" | grep -q "public-checks other visitor" && ok "npm run report shows the private feedback" || bad "report missing feedback"
echo "$REPORT" | grep -q "TestBot" && ok "npm run report shows the hello names" || bad "report missing hellos"

echo "== 7. Brute-forcing the admin password is cut off (as a test visitor)"
for i in $(seq 1 5); do
  expect "wrong attempt #$i -> 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' -H 'CF-Connecting-IP: 198.51.100.21' -H 'Authorization: Bearer wrongwrongwrongwrongwrongwrongwrong' "$B/admin/status")"
done
expect "6th attempt this hour -> 429 (cut off after 5)" 429 "$(curl -s -o /dev/null -w '%{http_code}' -H 'CF-Connecting-IP: 198.51.100.21' -H 'Authorization: Bearer wrongwrongwrongwrongwrongwrongwrong' "$B/admin/status")"
expect "...even the RIGHT password is refused from that visitor now" 429 "$(curl -s -o /dev/null -w '%{http_code}' -H 'CF-Connecting-IP: 198.51.100.21' -H "Authorization: Bearer $(grep -E '^ADMIN_TOKEN=' .env | cut -d= -f2- | tr -d '\r')" "$B/admin/status")"

echo "== 8. Kill switch closes the public store"
npm run --silent kill-switch -- on >/dev/null
expect "get_product -> 503" 503 "$(post - /api/product)"
expect "get_test_payment_token (new visitor) -> 503" 503 "$(post - /api/test-token)"
expect "say_hello -> 503" 503 "$(post - /api/hello '{"agent_name":"x"}')"
expect "the earlier visitor's session is gone -> 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' -b "$J1" "$B/api/session")"
npm run --silent kill-switch -- off >/dev/null

echo "== 9. Nothing secret in the server log"
LOG="${PDFS_SERVER_LOG:-}"
if [ -n "$LOG" ] && [ -f "$LOG" ]; then
  grep -aqE 'spt_[A-Za-z0-9]{6,}|checkout\.stripe\.com/c/|cs_test_|rk_test_|sk-ant-' "$LOG" && bad "server log contains a token, Stripe URL or key" || ok "no tokens, Stripe URLs or keys in the server log"
  grep -aq "public-checks" "$LOG" && bad "server log contains feedback text" || ok "no feedback text in the server log"
else
  echo "  (skipped: set PDFS_SERVER_LOG to the wrangler output file)"
fi

npm run --silent unlock >/dev/null; rm -f "$J1" "$J2" /tmp/pdfs_body
echo ""
echo "RESULT: $PASS passed, $FAILN failed"
[ "$FAILN" -eq 0 ]

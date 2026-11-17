#!/usr/bin/env bash
# Shared Payment Token route checks (npm run dev must be running; real Stripe SANDBOX calls, free).
# Run from the project root:  bash tests/token-checks.sh
# Never prints codes, session tokens, payment tokens or keys.
set -u
B="${PDFS_BASE_URL:-http://localhost:8787}"
PASS=0; FAILN=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAILN=$((FAILN+1)); }
expect() { if [ "$2" = "$3" ]; then ok "$1 (got $3)"; else bad "$1 (wanted $2, got $3)"; fi; }
has()    { if grep -q -- "$2" /tmp/pdfs_body; then ok "$1"; else bad "$1 (body: $(cat /tmp/pdfs_body))"; fi; }
newcode() { npm run --silent new-code 2>&1 | grep -oE '[2-9A-Z]{5}-[2-9A-Z]{5}-[2-9A-Z]{5}'; }
signin()  { npm run --silent unlock >/dev/null; curl -s -o /dev/null -c "$1" -X POST -H 'Content-Type: application/json' -d "{\"code\":\"$(newcode)\"}" "$B/api/sign-in"; }
post() { local jar="$1" path="$2" body="${3:-{\}}"; shift 2; [ $# -gt 0 ] && shift
  curl -s -o /tmp/pdfs_body -w "%{http_code}" -b "$jar" -X POST -H 'Content-Type: application/json' -d "$body" "$@" "$B$path"; }
# A $1.00 sandbox test token from the agent's test wallet (uses the store's TEST key from .env).
token() { node --input-type=module -e '
  import { readEnv } from "./scripts/lib.mjs"; import { createTestToken } from "./agent/wallet.mjs";
  const t = await createTestToken({ stripeKey: readEnv().STRIPE_SECRET_KEY, maxCents: 100, currency: "usd" });
  process.stdout.write(t.token);'; }
JA=$(mktemp); JB=$(mktemp); NOJAR=$(mktemp)

npm run --silent kill-switch -- off >/dev/null
signin "$JA"; signin "$JB"
T1=$(token); [ "${T1:0:4}" = "spt_" ] && ok "test wallet created a token (not shown)" || bad "test wallet failed"

echo "== 1. Needs a session, a valid token and our own origin"
# (Without a session, pay_with_token starts a visitor session (D29), so it isn't refused for that.)
expect "no session + malformed token -> 400" 400 "$(post "$NOJAR" /api/pay-with-token '{"payment_token":"nope"}')"
expect "malformed token -> 400" 400 "$(post "$JA" /api/pay-with-token '{"payment_token":"not-a-token"}')"
expect "missing token -> 400" 400 "$(post "$JA" /api/pay-with-token '{}')"
expect "cross-origin -> 403" 403 "$(post "$JA" /api/pay-with-token "{\"payment_token\":\"$T1\"}" -H 'Origin: https://evil.example')"

echo "== 2. Pay with a valid \$1.00 token"
expect "pay_with_token -> 200" 200 "$(post "$JA" /api/pay-with-token "{\"payment_token\":\"$T1\"}")"
has "  ...status paid, \$1.00 USD" '"status":"paid","amount":"$1.00 USD"'
OID=$(grep -oE 'ord_[a-z2-9]{20}' /tmp/pdfs_body | head -1)
grep -q "spt_" /tmp/pdfs_body && bad "  ...response echoes the token" || ok "  ...response does not echo the token"

echo "== 3. check_order verifies with Stripe"
expect "check_order -> 200" 200 "$(post "$JA" /api/order "{\"order_id\":\"$OID\"}")"
has "  ...paid (PaymentIntent succeeded)" '"status":"paid","payment_status":"succeeded"'
expect "other session can't see it -> 404" 404 "$(post "$JB" /api/order "{\"order_id\":\"$OID\"}")"
expect "open_checkout on a token order -> 409" 409 "$(post "$JA" /api/open-checkout "{\"order_id\":\"$OID\"}")"

echo "== 4. Delivery works as before"
expect "get_download -> 200" 200 "$(post "$JA" /api/download "{\"order_id\":\"$OID\"}")"
URL=$(grep -oE '"download_url":"[^"]+"' /tmp/pdfs_body | cut -d'"' -f4)
expect "download link serves a PDF" "%PDF-" "$(curl -s -b "$JA" "$URL" | head -c 5)"

echo "== 5. Stripe's single use and limit, through our tool"
expect "same token again -> 402" 402 "$(post "$JA" /api/pay-with-token "{\"payment_token\":\"$T1\"}")"
has "  ...explains Stripe refused it" 'not accepted by Stripe'

echo "== 6. Payment tokens never reach the server log"
LOG="${PDFS_SERVER_LOG:-}"
if [ -n "$LOG" ] && [ -f "$LOG" ]; then
  grep -aq "spt_[A-Za-z0-9]\{6,\}" "$LOG" && bad "server log contains a payment token" || ok "no payment token in the server log"
else
  echo "  (skipped: set PDFS_SERVER_LOG to the wrangler output file)"
fi

npm run --silent unlock >/dev/null; rm -f "$JA" "$JB" "$NOJAR" /tmp/pdfs_body
echo ""
echo "RESULT: $PASS passed, $FAILN failed"
[ "$FAILN" -eq 0 ]

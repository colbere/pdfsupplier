#!/usr/bin/env bash
# Session-protected tool endpoint checks (npm run dev must be running).
# Run from the project root:  bash tests/tools-checks.sh
# Never prints codes or session tokens.
set -u
B="${PDFS_BASE_URL:-http://localhost:8787}"
PASS=0; FAILN=0
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAILN=$((FAILN+1)); }
expect() { if [ "$2" = "$3" ]; then ok "$1 (got $3)"; else bad "$1 (wanted $2, got $3)"; fi; }
has()    { if grep -q -- "$2" /tmp/pdfs_body; then ok "$1"; else bad "$1 (body: $(cat /tmp/pdfs_body))"; fi; }
newcode() { npm run --silent new-code 2>&1 | grep -oE '[2-9A-Z]{5}-[2-9A-Z]{5}-[2-9A-Z]{5}'; }
post() { curl -s -o /tmp/pdfs_body -w "%{http_code}" -X POST -H 'Content-Type: application/json' -d '{}' "$@"; }
JAR=$(mktemp)

npm run --silent kill-switch -- off >/dev/null; npm run --silent unlock >/dev/null

echo "== 1. get_product is public (D29); order lookups still need a session"
expect "get_product, no cookie -> 200 (public)" 200 "$(post "$B/api/product")"
expect "check_order, no cookie -> 401"     401 "$(post -d '{"order_id":"ord_aaaaaaaaaaaaaaaaaaaa"}' "$B/api/order")"
has    "  ...says not_authenticated" '"code":"not_authenticated"'
expect "check_order, forged cookie -> 401" 401 "$(post -H 'Cookie: __Host-pdfs_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' -d '{"order_id":"ord_aaaaaaaaaaaaaaaaaaaa"}' "$B/api/order")"
expect "get_product, GET instead of POST -> 404 (not served)" 404 "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/product")"

echo "== 2. Signed in: get_product works"
CODE=$(newcode)
expect "sign in -> 200" 200 "$(curl -s -o /tmp/pdfs_body -w '%{http_code}' -c "$JAR" -X POST -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\"}" "$B/api/sign-in")"
expect "get_product with session -> 200" 200 "$(post -b "$JAR" "$B/api/product")"
has    "  ...name is 'The PDF Supplier: one PDF'" '"name":"The PDF Supplier: one PDF"'
has    "  ...price is \$1.00 USD" '"price":"\$1.00 USD"'
has    "  ...describes the sentence" 'You now own this PDF.'
echo "        body: $(cat /tmp/pdfs_body)"
expect "get_product cross-origin -> 403" 403 "$(post -b "$JAR" -H 'Origin: https://evil.example' "$B/api/product")"

echo "== 3. sign_out ends the session"
expect "sign_out cross-origin -> 403" 403 "$(post -b "$JAR" -H 'Origin: https://evil.example' "$B/api/sign-out")"
expect "session still valid after refused cross-origin sign_out" 200 "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$B/api/session")"
expect "sign_out -> 200" 200 "$(curl -s -o /tmp/pdfs_body -D /tmp/pdfs_hdr -w '%{http_code}' -b "$JAR" -X POST -H 'Content-Type: application/json' -d '{}' "$B/api/sign-out")"
tr -d '\r' < /tmp/pdfs_hdr | grep -qi '^set-cookie: __Host-pdfs_session=; .*Max-Age=0' && ok "  ...cookie cleared (Max-Age=0)" || bad "  ...cookie not cleared"
expect "old cookie after sign_out -> 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$B/api/session")"
expect "sign_out again (no session) -> 200, harmless" 200 "$(post "$B/api/sign-out")"

echo "== 4. Kill switch also blocks tool endpoints"
npm run --silent unlock >/dev/null
CODE=$(newcode)
curl -s -o /dev/null -c "$JAR" -X POST -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\"}" "$B/api/sign-in"
expect "get_product before kill -> 200" 200 "$(post -b "$JAR" "$B/api/product")"
npm run --silent kill-switch -- on >/dev/null
expect "get_product after kill -> 503 (store closed)" 503 "$(post -b "$JAR" "$B/api/product")"
expect "owner session after kill -> 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$B/api/session")"
npm run --silent kill-switch -- off >/dev/null

echo "== 5. Page still clean"
curl -s "$B/" > /tmp/pdfs_page
grep -ioqE '<(a|button|form|input|select|textarea|iframe|img)[ >]' /tmp/pdfs_page && bad "page has interactive/visual elements" || ok "page has no links/buttons/forms/inputs/images"
# Rule 3: no checkout URL in the page or its script. (The word "checkout" is fine: the copy uses it.)
curl -s "$B/app.js" >> /tmp/pdfs_page
# (app.js may contain the bare prefix "https://checkout.stripe.com/" as a validation check; that is not a payment link.)
grep -oqiE 'checkout\.stripe\.com/c/|cs_(test|live)_' /tmp/pdfs_page && bad "page or app.js contains a Stripe checkout session URL" || ok "no Stripe checkout session URL in page HTML or app.js"

npm run --silent unlock >/dev/null; rm -f "$JAR" /tmp/pdfs_body /tmp/pdfs_hdr /tmp/pdfs_page
echo ""
echo "RESULT: $PASS passed, $FAILN failed"
[ "$FAILN" -eq 0 ]

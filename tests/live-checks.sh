#!/usr/bin/env bash
# Checks against the LIVE site (https://pdfsupplier.com). Run from the project root:
#   bash tests/live-checks.sh
# Safe for live use: no admin password guessing (that would lock this connection out of the owner
# commands for an hour), and the kill switch is only on for a few seconds.
# Leaves a few sandbox test orders and counter bumps in the live report.
# Never prints the admin password, payment tokens, download links or this machine's IP.
set -u
B="${PDFS_LIVE_URL:-https://pdfsupplier.com}"
HOST="${B#https://}"
PASS=0; FAILN=0
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
ok()  { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL  $1"; FAILN=$((FAILN+1)); }
expect() { if [ "$2" = "$3" ]; then ok "$1 (got $3)"; else bad "$1 (wanted $2, got $3)"; fi; }
ADMIN=$(grep -E '^ADMIN_TOKEN_LIVE=' .env | cut -d= -f2- | tr -d '\r')
[ ${#ADMIN} -ge 32 ] || { echo "ADMIN_TOKEN_LIVE missing from .env (npm run setup-live)"; exit 1; }
post() { local jar="$1" path="$2" body="${3:-{\}}"; shift 2; [ $# -gt 0 ] && shift
  curl -s -o "$TMP/body" -w "%{http_code}" -b "$jar" -c "$jar" -X POST -H 'Content-Type: application/json' -d "$body" "$@" "$B$path"; }
field() { node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=j[process.argv[2]];process.stdout.write(v==null?"":String(v))}catch{}' "$TMP/body" "$1"; }
RUN="live$(date +%s)"   # marks this run's requests in the traffic log

echo "== Transport and page"
expect "http:// redirects to https" "301" "$(curl -s -o /dev/null -w '%{http_code}' "http://$HOST/")"
curl -s -D "$TMP/h" -o /dev/null "https://www.$HOST/some/path?x=1"
grep -qiE "^HTTP/[0-9.]+ 301" "$TMP/h" && grep -qiE "^location: https://$HOST/some/path\s*$" "$TMP/h" && ok "www -> https://$HOST/some/path (301, query dropped)" || bad "www redirect: $(grep -iE '^(HTTP|location)' "$TMP/h" | tr -d '\r' | tr '\n' ' ')"
curl -s -D "$TMP/h" -o "$TMP/page" "$B/"
grep -qi "^origin-trial: Ap3I" "$TMP/h" && ok "page sends the WebMCP Origin-Trial header" || bad "no Origin-Trial header"
grep -qi "^content-security-policy: default-src 'none'" "$TMP/h" && ok "strict CSP on the page" || bad "CSP missing"
grep -qi "frame-ancestors 'none'" "$TMP/h" && ok "page can't be framed" || bad "frame-ancestors missing"
grep -qi "^x-content-type-options: nosniff" "$TMP/h" && ok "nosniff" || bad "nosniff missing"
grep -qi "^strict-transport-security: max-age=31536000" "$TMP/h" && ok "HSTS: browsers stick to https" || bad "HSTS header missing"
grep -qiE "<(a|button|form|input)[ >]" "$TMP/page" && bad "page has links/buttons/forms" || ok "page has no links, buttons or forms"
grep -qiE "^set-cookie" "$TMP/h" && bad "plain page visit sets a cookie" || ok "plain page visit sets no cookie"

echo "== Gate and request rules"
expect "GET /api/product -> 404 (POST only)" 404 "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/product")"
expect "cross-origin POST -> 403" 403 "$(post "$TMP/jx" /api/test-token '{}' -H 'Origin: https://evil.example')"
expect "admin without password -> 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$B/admin/report")"
expect "admin with ONE wrong password -> 401 (no brute-force run on live)" 401 "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer wrongwrongwrongwrongwrongwrongwrong' "$B/admin/status")"
expect "unknown path -> 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' "$B/.env")"
expect "made-up download link, no session -> 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$B/download/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")"

echo "== Visitor address can't be faked (spoofed CF-Connecting-IP / X-Forwarded-For)"
expect "visitor-supplied CF-Connecting-IP -> refused by Cloudflare (403)" 403 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' -H 'CF-Connecting-IP: 198.51.100.77' "$B/api/stats")"
curl -s -o /dev/null -X POST -H 'Content-Type: application/json' -d '{}' -A "$RUN-real" "$B/api/stats"
curl -s -o /dev/null -X POST -H 'Content-Type: application/json' -d '{}' -A "$RUN-spoofA" -H 'X-Forwarded-For: 198.51.100.77' -H 'True-Client-IP: 198.51.100.77' "$B/api/stats"
curl -s -o /dev/null -X POST -H 'Content-Type: application/json' -d '{}' -A "$RUN-spoofB" -H 'X-Forwarded-For: 203.0.113.88' -H 'X-Real-IP: 203.0.113.88' "$B/api/stats"
sleep 3   # traffic log is written just after each response
curl -s -H "Authorization: Bearer $ADMIN" "$B/admin/traffic?limit=5000" > "$TMP/traffic.json"
SPOOF=$(node -e '
  const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const run=process.argv[2];
  const v=k=>(j.entries.find(e=>e.a===`${run}-${k}`)||{}).v;
  const r=v("real"),a=v("spoofA"),b=v("spoofB");
  console.log(!r||!a||!b?"missing":(r===a&&a===b?"same":"different"));' "$TMP/traffic.json" "$RUN")
expect "X-Forwarded-For / True-Client-IP / X-Real-IP ignored: SAME visitor ID" same "$SPOOF"

echo "== Session cookie (visitor)"
JA="$TMP/ja"
expect "get_test_payment_token -> 200" 200 "$(curl -s -w '%{http_code}' -D "$TMP/h" -o "$TMP/body" -c "$JA" -X POST -H 'Content-Type: application/json' -d '{}' "$B/api/test-token")"
C=$(grep -i '^set-cookie' "$TMP/h" | tr -d '\r')
echo "$C" | grep -q "__Host-" && ok "cookie uses the __Host- prefix" || bad "cookie prefix"
echo "$C" | grep -qi "; *Secure" && ok "cookie is Secure" || bad "cookie not Secure"
echo "$C" | grep -qi "; *HttpOnly" && ok "cookie is HttpOnly" || bad "cookie not HttpOnly"
echo "$C" | grep -qi "SameSite=Strict" && ok "cookie is SameSite=Strict" || bad "cookie not SameSite=Strict"
echo "$C" | grep -qi "Domain=" && bad "cookie has a Domain attribute" || ok "cookie has no Domain (this host only)"
SPT=$(field payment_token)
case "$SPT" in spt_*) ok "store issued a sandbox payment token (not shown)";; *) bad "no spt_ token";; esac

echo "== Full purchase: token route"
expect "pay_with_token -> 200" 200 "$(post "$JA" /api/pay-with-token "{\"payment_token\":\"$SPT\"}")"
OID=$(field order_id); [ "$(field status)" = "paid" ] && ok "order paid ($OID)" || bad "not paid: $(cat "$TMP/body")"
expect "same token again -> refused" 402 "$(post "$JA" /api/pay-with-token "{\"payment_token\":\"$SPT\"}")"
expect "check_order -> 200" 200 "$(post "$JA" /api/order "{\"order_id\":\"$OID\"}")"
expect "a visitor without the buyer's session can't get the download -> 401" 401 "$(post "$TMP/jb" /api/download "{\"order_id\":\"$OID\"}")"
expect "get_download -> 200" 200 "$(post "$JA" /api/download "{\"order_id\":\"$OID\"}")"
URL=$(field download_url)
case "$URL" in "$B/download/"*) ok "download link is on $HOST";; *) bad "download link on wrong host";; esac
curl -s -b "$JA" -o "$TMP/out.pdf" "$URL"
expect "download serves a PDF" "%PDF-" "$(head -c 5 "$TMP/out.pdf")"
grep -aq "You now own this PDF" "$TMP/out.pdf" && ok "PDF says \"You now own this PDF.\"" || ok "PDF downloaded (text is compressed; not checked)"
expect "link is single-use -> second try refused" 404 "$(curl -s -o /dev/null -w '%{http_code}' -b "$JA" "$URL")"

echo "== Card route (Stripe Checkout page is created; paying there needs a browser)"
expect "create_checkout -> 200" 200 "$(post "$JA" /api/checkout)"
COID=$(field order_id)
expect "open_checkout -> 200" 200 "$(post "$JA" /api/open-checkout "{\"order_id\":\"$COID\"}")"
case "$(field url)$(field checkout_url)" in https://checkout.stripe.com/*) ok "Stripe sandbox checkout page issued";; *) bad "no checkout URL: $(head -c 200 "$TMP/body")";; esac
expect "check_order on unpaid card order -> 200" 200 "$(post "$JA" /api/order "{\"order_id\":\"$COID\"}")"
expect "get_download before paying -> refused" 409 "$(post "$JA" /api/download "{\"order_id\":\"$COID\"}")"

echo "== Kill switch (a few seconds)"
npm run --silent kill-switch -- on --live >/dev/null && ok "kill switch on" || bad "kill switch on failed"
sleep 1
expect "store closed while killed -> 503" 503 "$(post "$TMP/jc" /api/product)"
npm run --silent kill-switch -- off --live >/dev/null && ok "kill switch off" || bad "kill switch off failed"
expect "store open again -> 200" 200 "$(post "$TMP/jc" /api/product)"

echo "== Owner tools and privacy"
MYIP=$(curl -s "$B/cdn-cgi/trace" | grep '^ip=' | cut -d= -f2)
[ -n "$MYIP" ] && ok "found this machine's IP via Cloudflare (not shown)" || bad "couldn't find own IP"
curl -s -H "Authorization: Bearer $ADMIN" "$B/admin/traffic?limit=5000" > "$TMP/traffic.json"
grep -qF "$MYIP" "$TMP/traffic.json" && bad "traffic log contains a raw IP" || ok "traffic log has no raw IP"
grep -qE 'spt_|rk_test_|sk_test_|cs_test_' "$TMP/traffic.json" && bad "traffic log contains a token or key" || ok "traffic log has no tokens or keys"
grep -qE '/download/[A-Za-z0-9_-]{20,}' "$TMP/traffic.json" && bad "traffic log contains a download link" || ok "download links logged as /download/[token]"
REPORT=$(npm run --silent report -- --live 2>&1)
echo "$REPORT" | grep -q "test_purchases" && ok "npm run report -- --live works" || bad "report: $(echo "$REPORT" | head -3)"
echo "$REPORT" | grep -qF "$MYIP" && bad "report contains a raw IP" || ok "report has no raw IP"
npm run --silent traffic -- --live --days 1 >/dev/null 2>&1 && ok "npm run traffic -- --live works" || bad "traffic command failed"

echo "== Cloudflare rate-limit rule (70 quick API calls; expect blocks near 50)"
CODES=$(for i in $(seq 1 70); do curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' -A "$RUN-burst" "$B/api/stats" & done; wait)
N429=$(echo "$CODES" | grep -c '^429$'); N200=$(echo "$CODES" | grep -c '^200$')
echo "        200s: $N200   429s: $N429"
[ "$N429" -gt 0 ] && ok "Cloudflare blocked the burst" || bad "no blocks in a 70-request burst (rule not matching?)"
sleep 12
expect "after the 10 s block, API works again" 200 "$(post "$TMP/jc" /api/product)"

echo
echo "Live checks: $PASS passed, $FAILN failed."
[ "$FAILN" -eq 0 ]

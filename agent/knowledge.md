Store-specific knowledge from Phase 1 of the PDF Supplier experiment. (This whole section is
switched off for the "without context" runs: `--context none`.)

- The store's tools appear in this order of use: sign_in → get_product → create_checkout →
  open_checkout → (pay on Stripe) → check_order → get_download.
- open_checkout moves the tab to Stripe's checkout page. The store's tools disappear while the
  tab is on Stripe.
- On Stripe's page: call select_payment_method with "card" first, then fill_payment_form with
  the card details (number, expiry as "MM / YY", cvc, name, email, country, postalCode), then
  submit_payment.
- Stripe's fill_payment_form usually fills the form but never reports back, so it times out.
  That is expected: do not keep retrying it. One call is enough; then submit_payment.
- After submit_payment, the tab returns to the store on its own. Wait for the store's tools to
  appear again before calling check_order; calling store tools while still on Stripe fails.
- get_download saves the PDF to the browser's download folder itself and reports its size.
  It works once per order.

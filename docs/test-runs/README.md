# Test runs

One file per agent run, named `YYYY-MM-DD-HHMM-<short-label>.md`. Each file records:

- Date and time
- Chrome version
- Agent (extension version or commit) and model ID
- The exact prompt given
- Every tool call, with arguments and result (secrets redacted: codes, session tokens and Stripe URLs replaced with `[REDACTED]`)
- Final outcome, and where and why it stopped if it failed
- Screenshots, if useful (stored alongside, same base name)

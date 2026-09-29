# OpenCode Go and T3Code: Verified Triage Notes

These notes capture a reusable provider distinction, not a guarantee that the catalog or policy is unchanged forever.

## Provider routes

- OpenCode Zen uses the standard route `https://opencode.ai/zen/v1`.
- OpenCode Go uses the Go route `https://opencode.ai/zen/go/v1`.
- T3Code may display the generic driver label `OpenCode` while the selected provider instance is `opencode-go`.

## Model IDs

The OpenCode Go `/models` response can advertise both:

- `muse-spark-1.2`
- `muse-spark-1.2-contributor`

The Go contributor model is the discounted/data-training tier. Do not silently replace it with the standard model or accept the policy on the user's behalf.

## Confirmed T3Code failure pattern

A T3Code event log can show the intended turn before the request fails:

```text
model: opencode-go/muse-spark-1.2-contributor
HTTP 403
DataPolicyError: This model collects data used to improve its quality and requires explicit opt in
```

The provider's response may include an account-specific destination of the form:

```text
https://opencode.ai/workspace/<workspace-id>/go
```

Treat that destination as a privacy/terms decision. After the user explicitly opts in, restart or refresh the T3Code session and verify a minimal request plus a new provider event log entry.

## Diagnostic order

1. Query the exact Go `/models` route and confirm the exact wire ID.
2. Refresh T3Code/Hermes model caches and reopen the picker.
3. Confirm the selected row/turn preserves `opencode-go` and the exact model ID.
4. Read the provider event log after a minimal request.
5. Classify 401, 403 policy, 429 quota, model-not-found, and tool/schema errors separately.

---
name: provider-model-availability-triage
description: Use when a provider model is missing or will not run.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [providers, models, opencode, t3code, hermes, debugging, entitlements]
    related_skills: [coding-agent-clis, t3-code-operations, hermes-agent]
---

# Provider and Model Availability Triage

## Overview

Use this skill when a model is absent from a picker, appears greyed out, is selectable but fails to start, or works in one client but not another. The central rule is that model availability has multiple independent layers:

1. **Catalog** — the provider advertises the model in `/v1/models` or a static registry.
2. **Cache and picker** — the client has refreshed and surfaced that catalog entry.
3. **Configuration** — the selected provider instance and exact wire model ID are correct.
4. **Entitlement** — the account, plan, billing balance, quota, region, or workspace can use it.
5. **Policy and consent** — the provider may require explicit data-use/training consent.
6. **Runtime compatibility** — the request format, tools, reasoning controls, and client adapter are accepted.

Do not call a model "unsupported" until these layers have been distinguished with evidence.

## Trigger

- A user says a model is missing from Hermes, T3Code, OpenCode, an IDE, or another coding-agent UI.
- A model appears in search but is disabled or greyed out.
- A model picker accepts a selection but the first request fails.
- The same provider/model works in one client but not another.

## Workflow

### 1. Preserve exact identities

Record all three values without normalizing them away:

- **Driver/display provider:** what the UI calls the adapter, such as `opencode`.
- **Provider instance/route:** the account or endpoint, such as `opencode-go` versus `opencode-zen`.
- **Wire model ID:** the exact provider-owned ID, such as `muse-spark-1.2-contributor`.

Do not substitute a Zen model for a Go model, or a standard model for a contributor model, merely because their display names are similar.

### 2. Verify the live catalog

Query the provider's actual model endpoint with the configured credential, or use the provider's own model-list command. Confirm the exact model ID is present. A models.dev entry or a UI label alone is not proof that the account's endpoint currently advertises it.

For OpenAI-compatible providers, inspect the relevant route, for example:

```text
GET <provider-base-url>/models
```

Keep the response out of logs if it contains account or credential data; print only matching model IDs and provider metadata.

### 3. Check cache and picker behavior

If the live catalog contains the model:

- Refresh the client's provider model cache.
- Restart or reopen the client if its process holds an in-memory snapshot.
- Search by the exact model substring.
- Check pagination/scroll limits and featured-only views.
- Confirm the selected provider row is the intended provider instance.

A model near the end of a long list is not missing. A stale cache is not a provider entitlement failure.

### 4. Test the exact runtime path

Run one minimal request through the same client and provider route the user will use. Capture:

- HTTP status
- request endpoint
- provider instance and model ID
- provider error body
- whether the failure is retryable

A catalog success followed by a 401, 403, quota error, or policy error means discovery is working and runtime access is the next layer to fix.

### 5. Read the client/service logs

For T3Code or another server-backed UI, inspect the provider event log and server log rather than inferring from muted UI text. Verify that the turn actually contains the intended provider/model pair. A UI can list a model while the runtime routes it differently, and a grey visual style can be normal secondary text rather than a disabled state.

### 6. Configure Hermes subagents through a custom OpenAI-compatible endpoint

When only delegated children should use a self-hosted or proxy route, change `delegation.*`, not the top-level `model.*`; otherwise the parent agent moves too. Register the custom provider with its endpoint, model, and secret environment-variable name, then set the delegation route explicitly:

```bash
hermes config set delegation.model <exact-model-id>
hermes config set delegation.provider <custom-provider-name>
hermes config set delegation.base_url http://<endpoint>/v1
hermes config set delegation.api_mode chat_completions
```

Use `chat_completions` for a normal OpenAI-compatible `/v1/chat/completions` proxy. Keep the API key in `.env` via the provider's `key_env`; do not print or put it in `config.yaml`. Restart the gateway or launch a fresh CLI process after changing config, because long-lived Hermes processes retain their loaded settings.

Validate the same route in order: query `GET <base_url>/models`, confirm the exact wire model ID, send one minimal `POST <base_url>/chat/completions`, then verify the Hermes service is active. A successful catalog lookup alone does not prove delegated runtime access. Parse dotenv values without shell-sourcing them when values may contain shell metacharacters, because sourcing can execute or split configuration data.

See `references/hermes-custom-delegation.md` for the compact configuration and verification recipe.

### 7. Handle billing and privacy gates explicitly

Classify common provider failures:

- **401 / insufficient balance:** account billing or credit problem.
- **403 / data policy or explicit opt-in:** provider requires consent, often for a discounted contributor tier.
- **429:** quota/rate limit; do not treat as model absence.
- **model-not-found/invalid model:** wrong route, stale catalog, or exact-ID mismatch.
- **tool/schema/unsupported-parameter error:** runtime adapter incompatibility.

Never auto-accept a contributor/data-training tier or disable a consent safeguard to make a model run. Show the provider's opt-in destination and obtain explicit user consent. After consent, refresh the provider session and verify a minimal request.

## OpenCode and T3Code notes

- OpenCode Go and OpenCode Zen are distinct routes and plans; do not infer one from the other.
- T3Code may display the generic `OpenCode` driver while the selected provider instance is `opencode-go`.
- T3Code model selection can succeed before the first request; the provider's response is authoritative for entitlement and policy.
- See `references/opencode-go-t3code.md` for the verified Go model IDs, endpoint distinction, and contributor-tier diagnosis.

## Verification checklist

- [ ] Exact driver, provider instance, and wire model ID recorded.
- [ ] Live provider catalog checked.
- [ ] Client cache refreshed or stale-process possibility ruled out.
- [ ] Same-client minimal request attempted.
- [ ] Service/provider log read back.
- [ ] Billing, quota, consent, and runtime compatibility classified separately.
- [ ] No privacy consent was accepted implicitly.
- [ ] After any account/policy change, the client session was refreshed and the request re-tested.

## Pitfalls

- Treating a provider-agnostic model directory as proof of account access.
- Assuming a model is absent because it is below the first visible page.
- Testing Zen while the user requested Go, or testing the standard model while the user requested the contributor tier.
- Changing Hermes configuration when the failing client is T3Code and has its own provider runtime.
- Reporting a greyed-looking row without checking whether a request was actually emitted.
- Silently enabling data collection/training consent.

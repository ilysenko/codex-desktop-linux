# API Key Service Tier

This opt-in feature exposes the desktop Fast/service-tier selector when Codex
is using API-key authentication with an OpenAI-compatible provider.

It is intended for providers that wrap the OpenAI Responses API and understand
Codex's `serviceTier` request setting. It does not grant OpenAI Fast mode
credits and does not bypass ChatGPT-account entitlement checks for the official
OpenAI service.

## Enable

Add the feature id to `linux-features/features.json`:

```json
{
  "enabled": [
    "api-key-service-tier"
  ]
}
```

Then rebuild the app:

```bash
./install.sh
```

Keep the model name as the upstream model name, for example:

```toml
model = "gpt-5"
model_provider = "openai-compatible"
service_tier = "fast"

[model_providers.openai-compatible]
name = "OpenAI-compatible"
base_url = "https://provider.example/v1"
wire_api = "responses"
```

Provider-specific API keys should be configured according to the provider's
normal Codex setup. Do not encode the tier into the model name unless the
provider explicitly documents such a model alias.

## Behavior

- API-key-authenticated hosts are allowed to show Fast service-tier controls.
  The current upstream access object keeps synthetic Ultrafast access disabled;
  ChatGPT, personal-access-token, and Amazon Bedrock hosts retain their upstream
  speed-mode requirements and pending state. Loaded API-key hosts receive Fast
  access only after host loading completes; changing the authentication method
  invalidates the access memo even between two non-account identities.
- The model catalog recomputes its API-key marker from that catalog's auth
  input on every normalization. Identity switches replace any stale marker;
  provider model fields, `serviceTiers`, and upstream reasoning-effort filtering
  remain intact.
- If an API-key host's active model has no `serviceTiers` metadata, the UI
  synthesizes one `fast` option so the selector can send
  `serviceTier: "fast"`.
- ChatGPT-, personal-access-token-, and Amazon Bedrock-authenticated hosts still
  use upstream account requirements for official Fast mode and do not receive
  synthetic API-key service-tier access or tiers.

## Implementation

The rspack webview has no stable chunk names, so each patch finds its owner by
content: the published speed-mode access hook (copied into every chunk that
renders a speed control), the model catalog filter that marks
API-key models, the service-tier resolver, and the active-model speed option
list. The synthetic Fast helper is declared inside the same webpack module as
each function that calls it. The gate validates its factory imports, host/auth
query, native entitlement resolver and memoized outputs before preparing every
physical copy of its module. The model marker validates the published catalog's
auth input, loop model, normalized output, and returned catalog through the shared
owner inspector. Only its exact output-field insertion qualifies as applied;
marker text in comments, strings, other objects, or another auth binding refuses
the patch. Both the gate and model patches prepare every physical copy before
writes. All copies must be pristine or exactly patched; a missing, ambiguous,
drifted, orphan, or partially patched owner refuses that patch's whole cohort.
A later write failure restores every attempted file, including a partially
written file. The resolver and option-list patches leave a missing or drifted
owner chunk unchanged and report a warning.

## Risks

The provider must accept and implement the `serviceTier` request setting. A
provider that rejects unknown fields may return an API error; a provider that
ignores unknown fields may show the UI without changing latency.

## Test

```bash
node --test linux-features/api-key-service-tier/test.js
```

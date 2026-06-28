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

- API-key-authenticated hosts are allowed to show service-tier controls.
- If an API-key host's active model has no `serviceTiers` metadata, the UI
  synthesizes one `fast` option so the selector can send
  `serviceTier: "fast"`.
- ChatGPT-authenticated hosts still use upstream account requirements for
  official Fast mode and do not receive synthetic service-tier metadata.

## Risks

The provider must accept and implement the `serviceTier` request setting. A
provider that rejects unknown fields may return an API error; a provider that
ignores unknown fields may show the UI without changing latency.

## Test

```bash
node --test linux-features/api-key-service-tier/test.js
```

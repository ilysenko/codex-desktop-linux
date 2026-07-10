# API Key Model Visibility

This opt-in feature makes the desktop model picker trust the non-hidden model
catalog returned by Codex CLI for API-key authenticated hosts.

The upstream desktop UI can apply a separate Statsig `available_models`
allowlist after `model/list` succeeds. That allowlist is useful for ChatGPT
rollouts, but it can hide models exposed by an OpenAI-compatible provider even
when the provider marks them as visible. This feature bypasses that extra
allowlist only when the active host reports `authMethod = "apikey"`.

## Enable

Add the feature id to `linux-features/features.json`:

```json
{
  "enabled": [
    "api-key-model-visibility"
  ]
}
```

Then rebuild the app:

```bash
./install.sh
```

## Behavior

- API-key hosts show every `model/list` entry whose `hidden` field is false.
- ChatGPT, Copilot, and Amazon Bedrock hosts keep the upstream filtering rules.
- Models that the CLI marks as hidden remain hidden.
- The feature does not grant model access. The configured provider must accept
  the selected model id.
- Reasoning choices such as Max or Ultra appear only when the selected model
  advertises those efforts and the desktop UI enables them.

## Risks

The CLI can list a model that the configured provider or current API key cannot
actually use. In that case the model will appear in the picker but the provider
may reject requests at runtime.

## Test

```bash
node --test linux-features/api-key-model-visibility/test.js
```

# API Key Model Visibility

This opt-in feature lets the desktop model picker show non-hidden models
returned by Codex CLI for API-key authenticated hosts, while preserving the
upstream access-program checks and explicit catalog exceptions.

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

- API-key hosts bypass the extra desktop allowlist for non-hidden `model/list`
  entries. The upstream `codex-auto-review` exclusion and access-program checks
  still apply.
- Upstream's API-key access-program check still applies first: a model that
  is restricted to non-standard `cyber` access programs stays hidden unless
  the host supports them.
- ChatGPT, Copilot, and Amazon Bedrock hosts keep the upstream filtering rules.
- Hidden models stay excluded by the API-key visibility path. Upstream
  `additionalAvailableModels` overrides remain intact, including an explicit
  override for a hidden model or `codex-auto-review`. An override still cannot
  bypass the API-key access-program check.
- The feature does not grant model access. The configured provider must accept
  the selected model id.
- Reasoning choices such as Max or Ultra appear only when the selected model
  advertises those efforts and the desktop UI enables them.

The patch qualifies the published catalog normalizer and its native visibility
condition, then validates every physical copy of that module before writing.
Missing, ambiguous, partially patched, or noncanonical copies fail the enabled
feature gate without changing the catalog assets. Opaque marker text does not
count as an applied patch.

## Risks

The CLI can list a model that the configured provider or current API key cannot
actually use. In that case the model will appear in the picker but the provider
may reject requests at runtime.

## Test

```bash
node --test linux-features/api-key-model-visibility/test.js
```

# Flatten automation_update schema for strict providers

The Codex desktop app registers an `automation_update` tool (scheduled
automations) whose emitted JSON Schema uses a root-level `oneOf` and has no
top-level `"type": "object"` (`type` is `null`). OpenAI's own Responses
endpoint tolerates this, but strict OpenAI-compatible providers that validate
function schemas server-side (DeepSeek, Azure structured outputs) reject every
request carrying the tool with:

```text
Invalid schema for function 'codex_app__automation_update':
schema must be a JSON Schema of 'type: "object"', got 'type: null'
```

This feature rewrites the `automation_update` input schema in the shipped
webview bundle before it reaches the model: it merges the properties of the
root `oneOf` variants, emits a top-level `"type": "object"`, and keeps
`additionalProperties` enabled so strict providers accept the tool. Tool calls
are still validated app-side by the existing schema (`safeParse`), so this only
relaxes the wire-level schema.

## Enable

```json
{
  "enabled": [
    "automation-schema-flatten"
  ]
}
```

in the git-ignored `linux-features/features.json`, then rerun the install/build
step so the patch is applied to the generated app.

## How to test

1. Build with the feature enabled and run the app.
2. Configure a strict provider such as DeepSeek
   (`wire_api = "responses"`, `deepseek-v4-flash`) in `~/.codex/config.toml`.
3. Start a thread; requests that include `codex_app__automation_update` should
   no longer return the 400 schema error above.

Run the self-contained tests with:

```bash
node --test linux-features/automation-schema-flatten/test.js
```

## Known risks

- The merged schema is more permissive than the original `oneOf`: the model may
  see fields from multiple variants at once. Runtime argument validation is
  unchanged, so invalid calls are still rejected by the app.
- The patch targets the current upstream bundle's emitter line. If upstream
  renames or restructures the `automation_update` tool emitter, the patch
  warns and skips instead of failing the build.
- This feature is not a substitute for an upstream fix; it only adapts the
  wire-level schema on Linux builds.

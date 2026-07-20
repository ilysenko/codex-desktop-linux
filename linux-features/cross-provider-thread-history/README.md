# Cross-Provider Thread History

This feature is disabled by default. Enable it when one Desktop installation
uses more than one Codex model provider and locally stored threads disappear
from Recent or Projects after the active provider changes.

```json
{
  "enabled": [
    "cross-provider-thread-history"
  ]
}
```

Codex app-server treats an omitted or `null` `modelProviders` field on ordinary
`thread/list` calls as “the currently configured provider.” An explicit empty
array means “do not filter by provider.” The upstream Desktop webview currently
sends `modelProviders: null` from its recent, archived, lookup, and related
thread enumeration paths. This feature changes those thread-enumeration
parameters to explicit empty arrays.

The feature does not rewrite SQLite rows, JSONL session files, provider
metadata, authentication state, project assignments, or thread contents. It
also does not bypass host, workspace, `sourceKinds`, archive, recent-limit, or
relation filters.

When Desktop cold-resumes a visible thread, the feature explicitly prefers the
special provider selected by Desktop (for example, Copilot), then the current
`model_provider` from Codex config, and finally Codex's normal default. The
stored thread keeps its original `modelProvider` as provenance, while new turns
are routed through the provider that is active when the thread is reopened.
Provider choice is sticky for a running thread, so reopen the thread after
changing `model_provider`. If the thread has already been loaded by the current
app-server process, fully restart Desktop first; app-server intentionally
rejoins loaded threads instead of rebinding them in place.

## ChatGPT account plus a custom provider

Do not replace the global ChatGPT login with API-key login when ChatGPT account
features such as Remote Control must remain available. Keep the custom
credential inside its exact provider table instead:

```toml
model_provider = "custom"

[model_providers.custom]
name = "Custom"
base_url = "https://example.invalid/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "<custom-provider-token>"
```

Then use the normal ChatGPT browser login (`codex login`). In this arrangement,
the provider-scoped bearer token authenticates only custom-provider model
requests; the global ChatGPT login remains the account identity used by
subscription features and Remote Control. Set `model_provider` to the desired
provider, restart Desktop, and reopen an existing thread to switch its
continuation route. No login/logout cycle is required.

Never commit a real token, `~/.codex/config.toml`, `~/.codex/auth.json`, or
Remote Control device keys to this repository.

## Test

```bash
node --test linux-features/cross-provider-thread-history/test.js
```

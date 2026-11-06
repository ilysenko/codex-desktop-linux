# Fork Sidebar Fallback

An opt-in workaround for **Failed to fork chat** with
`AppServerForkNotReadyError: execution-config-loading` when the background
settings owner has no ready Statsig client. This can occur with API-key or
compatible-provider workflows without ChatGPT rollout assignments.

The fork placement reader requires two sidebar settings before sending
`thread/fork`. The local-section setting is a boolean, but the background
app-server-section setting returns `undefined` without a ready rollout client.
The renderer already treats an unavailable sidebar rollout as disabled.
This feature gives the background reader the same `false` fallback.

## Enable

Add `fork-sidebar-fallback` to `enabled` in `linux-features/features.json`,
preserving your other selections, then rebuild:

```json
{
  "enabled": ["fork-sidebar-fallback"]
}
```

```bash
./install.sh
```

The feature is disabled by default. It changes only the optional sidebar
rollout fallback. Ready `true` and `false` values, local custom-section
eligibility, saved placement, owner validation, execution configuration,
permissions, and authentication retain their upstream behavior. The reader
continues checking the live client, so later rollout assignments take effect.
Other reasons for `execution-config-loading` are outside this workaround.

The patch locates the background settings owner by both semantic setting
names, independently of chunk filenames and minified bindings. Missing,
ambiguous, or changed contracts preserve the source and reject an enabled
feature build through the existing patch-report enforcement.

## Validation

```bash
node --test linux-features/fork-sidebar-fallback/test.js
CODEX_SIGNED_EXTRACTED_APP=/path/to/extracted-official-asar \
  node --test linux-features/fork-sidebar-fallback/test.js
```

Retire this workaround when the current signed stable official package returns
a boolean for the background sidebar rollout without a ready client. Disabling
the feature and rebuilding restores the upstream behavior.

# Fork Sidebar Fallback

An opt-in workaround for **Failed to fork chat** with
`AppServerForkNotReadyError: execution-config-loading` when the background
settings owner has no ready Statsig client. The trigger is the unavailable
sidebar rollout; an authentication method or model provider alone does not
establish that condition.

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

The patch requires one sidebar rollout gate reference across all main-process
chunks, then validates the reader using both semantic setting names,
independently of chunk filenames and minified bindings. Missing,
ambiguous, or changed contracts preserve the source and reject an enabled
feature build through the existing patch-report enforcement.

## Validation

```bash
node --test linux-features/fork-sidebar-fallback/test.js
CODEX_SIGNED_EXTRACTED_APP=/path/to/extracted-official-asar \
  node --test linux-features/fork-sidebar-fallback/test.js
```

The signed-bundle regression executes the actual background settings reader
and fork placement function together. Without a ready rollout client, the
unmodified code must report `execution-config-loading` before reading saved
placement. With the fallback, the same function must return a ready placement.
It also checks that the complete patched owner chunk still parses.

Retire this workaround when the current signed stable official package returns
a boolean for the background sidebar rollout without a ready client. Disabling
the feature and rebuilding restores the upstream behavior.

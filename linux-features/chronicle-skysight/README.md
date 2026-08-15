# Chronicle / Skysight Activity Memory

Opt-in Linux activity memory for recent desktop context. This feature is usable
without Record & Replay and never starts continuous capture merely because it
is installed or queried.

Record & Replay requires this feature and adds the bounded demo-to-skill
workflow on top. The feature loader validates dependencies; it does not change
the configured list automatically. Enable Chronicle by itself with
`"enabled": ["chronicle-skysight"]`, or enable both features for Record &
Replay:

```json
{
  "enabled": [
    "chronicle-skysight",
    "record-and-replay"
  ]
}
```

Existing `record-and-replay` configurations must add `chronicle-skysight`.
To disable Chronicle when Record & Replay is enabled, remove both IDs in one
edit or remove `record-and-replay` first.

The standalone bundled plugin runs `codex-record-replay-linux skysight mcp`
and exposes only Skysight activity-memory tools. It does not register the
Record & Replay composer plugin, recording HUD, bundle compiler, or skill
import tools.

Stop continuous capture before disabling or uninstalling the feature. Cleanup
removes the staged plugin and backend, but intentionally leaves local memory
under `${CODEX_HOME:-$HOME/.codex}/memories/extensions/chronicle/resources`.

See [Linux Chronicle / Skysight](../../docs/linux-chronicle-skysight.md) for the
capture lifecycle, privacy boundaries, runtime paths, and OCR configuration.

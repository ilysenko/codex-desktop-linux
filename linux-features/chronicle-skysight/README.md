# Chronicle / Skysight Activity Memory

Opt-in Linux activity memory for recent desktop context. This feature is usable
without Record & Replay and never starts continuous capture merely because it
is installed or queried.

Record & Replay requires this feature and adds the bounded demo-to-skill
workflow on top. Enabling Record & Replay therefore enables Chronicle /
Skysight automatically; disabling Chronicle / Skysight also disables Record &
Replay through the feature dependency contract.

The standalone bundled plugin runs `codex-record-replay-linux skysight mcp`
and exposes only Skysight activity-memory tools. It does not register the
Record & Replay composer plugin, recording HUD, bundle compiler, or skill
import tools.

See [Linux Chronicle / Skysight](../../docs/linux-chronicle-skysight.md) for the
capture lifecycle, privacy boundaries, runtime paths, and OCR configuration.

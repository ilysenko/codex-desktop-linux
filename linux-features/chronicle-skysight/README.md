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

## Catalog subfeatures

The community feature catalog lists these user-facing capabilities separately:

- **Chronicle controls** (`chronicle-controls`): Provide Chronicle activity-capture controls; capture still requires runtime opt-in.
- **Skysight MCP** (`skysight-mcp`): Ship the standalone activity-memory MCP plugin for querying captured desktop context.

These declarations use `enabledWhen: "parent"`: all are included whenever this
feature is built. They add no independent configuration switches and do not
report runtime activation, permissions, external dependencies or backend health.

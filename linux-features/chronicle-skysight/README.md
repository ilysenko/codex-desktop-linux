# Chronicle / Skysight Activity Memory

Opt-in Linux activity memory for recent desktop context. This feature is usable
without Record & Replay and never starts continuous capture merely because it
is installed or queried.

Enabling the build-time feature stages these capabilities. A runtime recorder
enable, tray toggle, or explicit Skysight start is a capture opt-in; ordinary
permissions, status and exclusion reads do not issue a start command. Failed or
malformed backend status is reported as unavailable with its diagnostic data.

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

## How it is wired

The main-process patch resolves the recorder controller, its initialization and
getter through the current exported startup and actual Host scope. It points
that controller at the Linux `codex-record-replay-linux skysight` backend while
leaving the macOS-only Chronicle settings service gated. It also adds an outer
CommonJS chunk-scope bridge registry
(`chronicle-permissions`, sidecar state, and the
`linux-record-replay-skysight-*` controls). The desktop main process no longer
serves `vscode://codex/<method>` fetches from a handler map, so the bridge is
routed from the desktop fetch wrapper's request entry: a webview `fetch`
message for `vscode://codex/<bridge method>` is answered with a
`fetch-response` through the inline view-message sender. Unknown methods fall
through to the upstream handling. The shared request inspector proves the
wrapper's live request path and inline sender. Chronicle checks every main
chunk before a transactional write, including marker-free copies of the native
factory; missing, duplicate, partial or mixed owners reject the whole bridge.

The registry and helper declarations remain in the outer CommonJS scope.
Canonical inspection checks their complete source, lexical bindings and actual
route position inside the wrapper prefix. Record & Replay adds literal handlers
at the returned registry extension slot; extensions cannot replace Chronicle's
owned methods. Its complete recording payload remains the Record & Replay
contract.

Bridge bodies default to an empty object when omitted. Non-object JSON bodies
are rejected before any handler or backend command runs. Backend command
failures retain their result/error data, while unsupported native settings and
history methods continue to reject on Linux.

## Catalog subfeatures

The community feature catalog lists these user-facing capabilities separately:

- **Chronicle controls** (`chronicle-controls`): Provide Chronicle activity-capture controls; capture still requires runtime opt-in.
- **Skysight MCP** (`skysight-mcp`): Ship the standalone activity-memory MCP plugin for querying captured desktop context.

These declarations use `enabledWhen: "parent"`: all are included whenever this
feature is built. They add no independent configuration switches and do not
report runtime activation, permissions, external dependencies or backend health.

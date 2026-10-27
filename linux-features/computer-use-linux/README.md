# Linux Computer Use

Disabled-by-default Linux Computer Use integration. It owns the Linux
ASAR descriptors and the native MCP backend staged only when explicitly enabled.
Immutable Nix packages receive their bundled-marketplace staging permission
repair from the separate internal `nix-store-bundled-marketplace-permissions`
feature.

Enable it in `linux-features/features.json`:

```json
{ "enabled": ["computer-use-linux"] }
```

In Settings → Computer use, **Any App** controls native access. Use that row to
install or enable it on a fresh profile. Browser access is configured separately,
and existing opt-outs remain respected.

See the [Linux Computer Use guide](../../docs/linux-computer-use.md) for supported
desktops, dependencies, permissions, and troubleshooting.

## Supported operations

The in-app API supports window listing, accessibility inspection, screenshots,
coordinate clicks, keyboard input, text entry, and scrolling. Use the IDs returned
by `cua.listApps()` with `cua.getApp()`.

Click and scroll coordinates are window-relative; use the coordinate dimensions
reported with screenshots. Accessibility bounds are screen coordinates and must
not be passed directly to input methods because display scaling can differ.
Accessibility observations retain `window_context` for geometry inspection.
Element-index actions, drag, rich-text paste, selection editing, and secondary
accessibility actions are not exposed by the in-app API.

`getApp()` emits one compact accessibility observation. Select a window through
`getApp({windowId: window.id})` after
`listWindows()`, or retain the string app ID API. Window IDs exceeding JavaScript's
safe integer range are returned as decimal strings and must remain strings.
The adapter combines native inventory with upstream's public browser APIs so
`getState()` can discover browsers without calling missing native methods.

Later `getAXState()`
calls omit an unchanged compact projection; pass `disableDiffing: true` for a fresh
compact tree or `compact: false` for the complete backend node metadata. Bound
tree traversal with `maxNodes` (1–10000) and `maxDepth` (0–64). The equivalent
`max_nodes` and `max_depth` spellings are accepted for direct backend parity.
When the backend returns a large tree as its leading nodes, the host service pages
the rest from the backend's cached snapshot with `get_tree_page` and returns the
whole tree. If it would not fit the host bridge, the result keeps what fits, sets
`accessibility_tree_truncated`, and says so in `accessibility_tree_note`.
`accessibility_tree_truncated` is also set when traversal itself stopped early.

Screenshot methods emit their image, so do not emit the returned bytes again.
They accept `maxWidth`, `maxHeight`, `maxBytes`, `scale`, `format`, and `quality`;
`getAXStateAndScreenshot()` accepts both the accessibility and screenshot option
sets. Use these limits to request more detail deliberately instead of repeatedly
loading a large default observation.

Native control retains OS permission requirements and target-window focus
checks. Consequential-action approval remains the host/model's responsibility;
Linux does not provide saved per-app approvals through this integration.

## Implementation and validation

The adapter and native helpers are packaged together inside the upstream
`unified-computer-use` plugin. A feature-owned host service starts the native
backend outside the code-mode sandbox and the trusted adapter reaches it through
NodeREPL's native-pipe bridge; the agent JavaScript kernel remains sandboxed.
The separate `computer-use` component stores the Any App setting and exposes no
MCP tools. Upstream owns browser control. Missing or ambiguous bundle contracts
abort an enabled build.

The current signed app's `nativeApplications` service supplies the native app
picker. On Linux this feature uses the running-window backend and desktop-entry
icons. It returns at most 20 running apps. Default and usage ordering put focused
apps first; display-name ordering sorts that inventory alphabetically. It does
not provide an installed-app catalog, usage history, or date-based filtering.
The service preserves its array, nullable lookup, and icon-size contracts.
The macOS and Windows implementations remain upstream-owned.

`make install-native` builds `codex-computer-use-linux` and
`codex-computer-use-cosmic` and `codex-computer-use-indicator` once before staging the package. Direct
`./install.sh` builds may provide binaries in `target/release/` or set
`CODEX_COMPUTER_USE_BINARY_SOURCE`, `CODEX_COMPUTER_USE_COSMIC_BINARY_SOURCE` and
`CODEX_COMPUTER_USE_INDICATOR_BINARY_SOURCE`.
Updater rebuilds reuse the packaged artifacts and never invoke Cargo.

Validate descriptor ownership and artifact-only staging with:

```bash
node --test linux-features/computer-use-linux/test.js linux-features/computer-use-linux/*.test.js
```

## Catalog subfeatures

The community feature catalog lists these user-facing capabilities separately:

- **Native computer control** (`native-control`): Ship the native computer-use bridge and backend; Any App access still requires runtime enablement and OS permissions.
- **Running application picker** (`running-app-picker`): Populate the native application picker with running Linux windows and desktop-entry icons.

These declarations use `enabledWhen: "parent"`: all are included whenever this
feature is built. They add no independent configuration switches and do not
report runtime activation, permissions, external dependencies or backend health.

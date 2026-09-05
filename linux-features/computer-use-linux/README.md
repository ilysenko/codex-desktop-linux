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

Native control retains OS permission requirements and target-window focus
checks. Consequential-action approval remains the host/model's responsibility;
Linux does not provide saved per-app approvals through this integration.

## Implementation and validation

The adapter and native helpers are packaged together inside the upstream
`unified-computer-use` plugin. The separate `computer-use` component stores the
Any App setting and exposes no MCP tools. Upstream owns browser control.
Missing or ambiguous bundle contracts abort an enabled build.

`make install-native` builds `codex-computer-use-linux` and
`codex-computer-use-cosmic` once before staging the package. Direct
`./install.sh` builds may provide binaries in `target/release/` or set
`CODEX_COMPUTER_USE_BINARY_SOURCE` and `CODEX_COMPUTER_USE_COSMIC_BINARY_SOURCE`.
Updater rebuilds reuse the packaged artifacts and never invoke Cargo.

Validate descriptor ownership and artifact-only staging with:

```bash
node --test linux-features/computer-use-linux/test.js linux-features/computer-use-linux/*.test.js
```

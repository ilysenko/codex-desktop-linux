# Linux Computer Use

Disabled-by-default native desktop access through the upstream unified Computer
Use runtime. Browser access remains independent. In Settings → Computer use,
**Any App** controls native access; no separate Computer Use plugin activation is
needed. On a fresh profile, use the **Any App** row to install or enable native
access. Existing opt-outs remain respected. The retained `computer-use` component
stores that setting and exposes no MCP tools. It is omitted from the Plugins page.

The feature stages a small JavaScript adapter and the existing Rust backend
inside `unified-computer-use`. It preserves the backend's OS permissions, input
serialization, and targeted-window focus checks. Consequential-action approval
remains the host/model's responsibility, as in the original Linux MCP integration.
It does not implement macOS per-app saved approvals.

The native API supports window listing, accessibility inspection, screenshots,
coordinate clicks, keyboard input, text, and scrolling. Use the IDs returned by
`cua.listApps()` with `cua.getApp()`. Click and scroll coordinates are window-relative;
follow the coordinate dimensions reported with screenshots. Accessibility bounds
are screen coordinates and must not be passed directly to input methods because
display scaling can differ. Accessibility observations retain `window_context`
for geometry inspection. Element-index actions, drag,
rich-text paste, selection editing, and secondary accessibility actions are not
exposed by this adapter.

Upstream owns browser APIs and the unified REPL lifecycle. Missing or ambiguous
bundle contracts abort an enabled build. Plugin versions change with this
integration so upstream's cache materialization replaces browser-only resources.

Enable it in `linux-features/features.json`:

```json
{ "enabled": ["computer-use-linux"] }
```

`make install-native` builds `codex-computer-use-linux` and
`codex-computer-use-cosmic` once before staging the package. Direct
`./install.sh` builds may provide binaries in `target/release/` or set
`CODEX_COMPUTER_USE_BINARY_SOURCE` and `CODEX_COMPUTER_USE_COSMIC_BINARY_SOURCE`.
Updater rebuilds reuse the packaged artifacts and never invoke Cargo.

Validate descriptor ownership and artifact-only staging with:

```bash
node --test linux-features/computer-use-linux/test.js linux-features/computer-use-linux/*.test.js
```

# MCP Helper Reaper

Some MCP helper trees can survive after their owning Codex process exits. On
Linux this is especially costly when a helper owns language servers, build
daemons, or desktop sidecars.

This feature is bundle-native. It installs a small Rust reaper plus runtime
triggers:

- Desktop cold-start/after-exit scan hooks;
- a Codex `SessionStart` hook merged into `CODEX_HOME/hooks.json`.

These triggers schedule short delayed cleanup passes for configured or
app-scoped helper roots that were adopted by init or user systemd after their
Codex owner exited. Live Codex parents are inspected only to discover their MCP
configuration; their helper children are never reaped.

## Scope

The reaper removes only helper roots whose live Codex ancestor is gone. A
candidate must be adopted by init/user systemd, carry evidence that it
originated from Codex, and match a configured MCP server command or this app's
staged helper paths. Identical command lines, working directories, or process
ages under a live Codex parent are not treated as proof that a helper is stale.

Helper detection is generic:

- configured MCP server commands are read from Codex config, including
  interpreter-launched scripts and same-directory wrapper sidecars;
- bundled plugin helpers are recognized by staged app plugin/resource paths;
- command lines with MCP/stdio-style conventions are recognized;
- shell `-c` children are ignored so normal tool executions are not reaped.

Bare MCP/stdio-style convention matching is insufficient for orphan cleanup.
The feature does not hardcode local tools or providers.

## Compatibility

This feature can be enabled together with `node-repl-reaper`. It does not wrap
or reap live `node_repl` processes. The dedicated feature handles leaked
Browser Use helpers only after their Codex owner exits.

## Enable

Add to `linux-features/features.json`:

```json
{ "enabled": ["mcp-helper-reaper"] }
```

then rebuild/reinstall. The feature is disabled by default.

When upgrading from a version that wrapped `resources/node_repl`, staging
restores the original entrypoint and removes the old backup. When disabled on a
later rebuild, the cleanup hook also restores any remaining legacy wrapper,
removes staged launcher hooks and binaries, and removes this feature's
`SessionStart` command marker from `CODEX_HOME/hooks.json` when that file is
available.

## Runtime Controls

- `CODEX_MCP_HELPER_REAPER_DISABLE=1` disables all cleanup triggers.
- `CODEX_MCP_HELPER_REAPER_DISABLE_HOOK=1` skips installing the `SessionStart`
  hook from Desktop runtime hooks.
- `CODEX_MCP_HELPER_REAPER_DELAY` sets the first delayed pass in seconds
  (default `3`).
- `CODEX_MCP_HELPER_REAPER_PASSES` sets how many cleanup passes run
  (default `3`).
- `CODEX_MCP_HELPER_REAPER_INTERVAL` sets seconds between passes
  (default `2`).
- `CODEX_MCP_HELPER_REAPER_TERM_TIMEOUT` sets the SIGTERM grace period
  (default `2`).

## Test

```bash
rtk cargo test --manifest-path linux-features/mcp-helper-reaper/reaper/Cargo.toml
node --test linux-features/mcp-helper-reaper/test.js
```

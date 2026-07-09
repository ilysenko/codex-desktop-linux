# MCP Helper Reaper

Codex can reload MCP helpers under the same live backend process without
reaping the older generation, and some helper trees can survive after their
owning Codex process exits. On Linux this is especially costly when a helper
owns language servers, build daemons, or desktop sidecars.

This feature is bundle-native. It installs a small Rust reaper plus three
runtime triggers:

- a wrapper around the staged `resources/node_repl` entrypoint;
- Desktop cold-start/after-exit scan hooks;
- a Codex `SessionStart` hook merged into `CODEX_HOME/hooks.json`.

When a Codex backend starts a new MCP helper generation, these triggers schedule
short delayed cleanup passes scoped to each live Codex parent PID. The
`node_repl` wrapper targets its direct parent; the scan hooks inspect live Codex
parents independently and also reap configured/app-scoped helper roots that were
adopted by init or user systemd after their Codex owner exited. Separate Codex
sessions remain independent.

## Scope

The reaper deduplicates direct MCP helper children under one Codex parent. It
keeps the newest process for each helper signature and reaps older duplicates
plus their descendants. Its orphan cleanup reaps stale helper roots whose live
Codex ancestor is gone, but only when the process is adopted by init/user
systemd and matches configured MCP server commands or this app's staged helper
paths.

Helper detection is generic:

- configured MCP server commands are read from Codex config, including
  interpreter-launched scripts and same-directory wrapper sidecars;
- bundled plugin helpers are recognized by staged app plugin/resource paths;
- replaced app/plugin generations are recognized by app-relative helper paths
  and deleted `/proc` cwd markers under the same live Codex parent;
- command lines with MCP/stdio-style conventions are recognized;
- shell `-c` children are ignored so normal tool executions are not reaped.

Bare MCP/stdio-style convention matching is used only for live Codex-parent
deduplication, not for orphan cleanup. The feature does not hardcode local tools
or providers.

## Compatibility

This feature can be enabled together with `node-repl-reaper`. When enabled, this
feature wraps `resources/node_repl` and keeps the original entrypoint at
`resources/node_repl.codex-linux-original`; `node-repl-reaper` recognizes both
paths so leaked Browser Use helpers remain in scope.

## Enable

Add to `linux-features/features.json`:

```json
{ "enabled": ["mcp-helper-reaper"] }
```

then rebuild/reinstall. The feature is disabled by default.

When disabled on a later rebuild, the cleanup hook restores
`resources/node_repl` from this feature's backup, removes staged launcher hooks
and binaries, and removes this feature's `SessionStart` command marker from
`CODEX_HOME/hooks.json` when that file is available.

## Runtime Controls

- `CODEX_MCP_HELPER_REAPER_DISABLE=1` disables the `node_repl` wrapper trigger.
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

# Browser Use node_repl Reaper

Codex spawns `node_repl` helper processes for Browser Use and does not always
reap them: helpers accumulate over long sessions and survive their owner
(observed in production: six helpers leaked in fifteen minutes, persisting for
over a day under a hidden-to-tray instance). Each holds memory and file
descriptors indefinitely.

This feature reaps **leaked** helpers — those with no live Codex owner in their
process ancestry. Helpers with a live Desktop `codex app-server` ancestor
or a live CLI Codex ancestor such as `codex resume` are never touched, so active
Browser Use sessions are unaffected. Matching is scoped to this install's
`resources/cua_node/bin/node_repl` path, so side-by-side installs reap
independently.

The unified Computer Use launcher starts helpers through Node, so the direct
parent need not be Codex. The reaper follows up to 64 ancestors and leaves the
helper alone if process information is unreadable, an ancestor disappears,
or traversal does not reach a root within that bound. It checks ownership again before
each signal. A surviving launcher does not protect the helper after its Codex
ancestor exits.

The walk also passes through `codex-linux-sandbox` and
`codex-mcp-helper-reaper`. These processes do not count as Codex owners.

## How it runs

- **Cold start**: the launcher hook starts one watchdog per install
  (pid file: `<state-dir>/node-repl-reaper.pid`). The watchdog reaps every
  5 minutes (`CODEX_NODE_REPL_REAPER_INTERVAL` seconds to override), waits up
  to 120 seconds for the launching official `ChatGPT` process to appear
  (`CODEX_NODE_REPL_REAPER_STARTUP_GRACE` seconds to override), and
  self-terminates with a final pass once no `ChatGPT` process from the install is
  running.
- **App exit**: the after-exit hook runs one immediate pass.
- Reaping sends SIGTERM, then SIGKILL after a grace period
  (`CODEX_NODE_REPL_REAPER_KILL_GRACE` seconds, default 5), re-checking
  process identity and ancestry before escalating.

## Compatibility

This feature requires Bash 4.4 or newer.

This feature can be enabled together with `mcp-helper-reaper`. If that feature
wraps `resources/cua_node/bin/node_repl`, this reaper also matches
`resources/cua_node/bin/node_repl.codex-linux-original` so leaked helpers
remain in scope.

## Enable

Add to `linux-features/features.json`:

```json
{ "enabled": ["node-repl-reaper"] }
```

then rebuild/reinstall. Logs go to the launcher log
(`~/.cache/codex-desktop/launcher.log`), prefixed `node-repl-reaper:`.

## Test

```bash
node --test linux-features/node-repl-reaper/test.js
```

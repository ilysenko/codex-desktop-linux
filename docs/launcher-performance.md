# Launcher Performance Notes

## Context

This decision record captures a performance comparison between ChatGPT Desktop
and another Electron 42 app (Claude Desktop) running side by side on the same
X11 GNOME 4K host, what the launcher changed as a result, and — just as
importantly — what was reviewed and deliberately left alone so future work
does not re-litigate it without new evidence.

Evidence came from live process command lines, `/proc/<pid>/maps`, the
launcher log, and repository history rather than synthetic benchmarks.

## What Changed

- `--disable-dev-shm-usage` is now passed only when `/dev/shm` is missing,
  not writable, or smaller than 1 GiB. The flag exists for containers with a
  tiny `/dev/shm` (Docker defaults to 64 MiB); everywhere else it pushed
  Chromium's renderer/GPU shared-memory buffers into disk-backed temp storage
  (observable as `/tmp/.org.chromium.Chromium.*` mappings in every process).
  Override: `CODEX_ELECTRON_DISABLE_DEV_SHM_USAGE=auto|0|1`.
- `--force-renderer-accessibility` is now added only when an assistive
  technology is detected: Orca or brltty running, the GNOME screen-reader
  setting, the AT-SPI state that `codex-computer-use-linux setup` enables
  (`org.a11y.Status IsEnabled` via busctl, or its
  `org.gnome.desktop.interface toolkit-accessibility` gsettings fallback), or
  accessibility env markers. Keeping the accessibility engine on in every
  renderer makes each DOM update also rebuild and serialize the accessibility
  tree; the WSLg and wayland-gpu profiles already skipped the flag for that
  reason. Session-bus probes (gsettings/busctl) run under the launcher's
  ppid-guarded watchdog pattern capped at 0.5 s, so a broken session bus
  counts as "not detected" instead of delaying launch.
  Override: `CODEX_FORCE_RENDERER_ACCESSIBILITY=1|0`.

Both decisions are visible at runtime in the `Electron launch mode:` line of
`~/.cache/codex-desktop/launcher.log` (`dev_shm_usage_disabled=`,
`renderer_accessibility_forced=`).

## Reviewed And Deliberately Not Changed

### `--no-sandbox` and `--disable-gpu-sandbox`

These are security-posture flags, not measurable rendering-performance
factors. Removing them is a separate compatibility project: the Electron
SUID/user-namespace sandbox behaves differently across distributions and
container/AppImage environments, and the troubleshooting docs currently
promise `--no-sandbox` behavior. Out of scope for performance work.

### Wayland `--disable-gpu-compositing` workaround

On Wayland sessions the launcher intentionally trades compositing performance
for side-panel rendering stability. That is a documented workaround with an
explicit opt-out (`CODEX_ELECTRON_DISABLE_GPU_COMPOSITING=0`); do not remove
it for performance reasons without re-testing the side-panel flicker it
papers over.

### Webview server model

The bundled Python server already uses `ThreadingHTTPServer` and serves
webview files with explicit `no-store` headers. The Linux packaging flow
patches upstream webview assets without renaming every hashed chunk, so the
server must force revalidation to keep Electron from reusing stale renderer
code after rebuilds or updates. Replacing it with a Rust server was evaluated
and rejected until evidence shows Python itself is the bottleneck — see
[Webview server evaluation](webview-server-evaluation.md).

### Startup ordering (partially overlapped)

The invariant is unchanged: Electron never launches before the webview
origin is verified, so Chromium cannot race a server that has not bound
yet. Within that constraint the cold-start path now overlaps independent
work instead of serializing it:

- The Python webview server is spawned first
  (`start_webview_server`), and its readiness wait plus origin
  verification run later (`await_webview_server_ready`), after the CLI
  lookup and plugin cache syncs — the server finishes booting while the
  launcher does unrelated work, leaving ~35 ms of residual wait instead
  of ~150 ms.
- The five bundled plugin cache syncs run concurrently and are all
  awaited before cold-start hooks dispatch (~110 ms instead of ~285 ms).
  They only touch disjoint per-plugin cache directories; the shared
  bundled marketplace metadata they previously each rewrote is staged
  exactly once beforehand (`stage_bundled_marketplace_metadata`), which
  is also what makes the concurrency safe.

Launching Electron itself in parallel with any of this remains rejected:
the renderer needs a verified local origin, and the warm-start handoff
markers depend on the current ordering.

### In-app startup latency

Most of the visible loading-screen time is spent inside the upstream app:
the renderer blocks on `codex app-server` RPCs after the static assets load
(the launcher log shows individual calls such as `app/list` taking multiple
seconds on cold start). That is upstream application behavior inside
`app.asar`, not Linux adaptation glue, and is out of scope for this
repository beyond faithfully reporting it.

### CLI preflight

Launcher CLI preflight is best-effort, recently hardened, and not part of the
rendering path. One launch-path cost hid there, though: the CLI version log
line reads `codex_cli_version` through command substitution, and the probe's
watchdog subshell inherited that pipe. Its `sleep 1` child survived the
watchdog kill and held the pipe open, so every cold launch stalled for the
full watchdog second even when the CLI answered in ~50 ms. The watchdog now
runs with stdout/stderr detached (`>/dev/null 2>&1`), which cut the
`launch_state_refreshed_under_lock` → `electron_launch` gap from ~1010 ms to
~74 ms. When adding bounded probes, keep watchdog subshells detached from any
caller pipe — an orphaned `sleep` holding an inherited fd blocks command
substitution until it exits.

The default update/version preflight remains asynchronous, but every generated
launcher first runs its bundled synchronous, execution-free trust check. This
applies to native packages with or without the updater, AppImage, Nix, and
user-local installs, without depending on the version of any system updater. A
managed standalone CLI that fails this check blocks startup before any CLI
version probe; a successful check pins launch to the canonical verified release
binary so replacement of its visible symlink cannot redirect execution.
`CODEX_SYNC_CLI_PREFLIGHT=1` still opts into the full synchronous check while
preserving fail-soft behavior for a CLI that is not known broken. A detected
npm-managed CLI missing
`@openai/codex-linux-x64` or `@openai/codex-linux-arm64` is the blocking
exception: Electron cannot use that CLI, so the launcher waits for one repair
attempt. The updater's initial and post-repair CLI version probes are each
bounded to 5 seconds, the repair to 90 seconds, and the follow-up npm registry
lookup to 20 seconds. Each command runs in a dedicated process group that is
terminated on timeout, including child processes; failure then stops startup
with manual reinstall instructions instead of leaving the loading screen stuck.

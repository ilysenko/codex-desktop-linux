# Agent Workspaces Linux Feature

`agent-workspace` is an opt-in Codex Desktop for Linux feature that adds the
`agent-workspace-linux` control surface to the app settings UI.

Enable it in `linux-features/features.json` before running the install/build
pipeline:

```json
{
  "enabled": [
    "agent-workspace"
  ]
}
```

When enabled, the feature stages the bundled `agent-workspace-linux` skill
inside the generated app and installs it for the current user at launch time to
`${CODEX_HOME:-~/.codex}/skills/agent-workspace-linux/SKILL.md`. The skill is
the agent-facing progressive routing entrypoint; the feature does not write
`~/.codex/config.toml` or register a generic MCP server at startup.

The feature adds a Linux-only settings section named **Agent Workspaces**. The
page can point Codex Desktop at an `agent-workspace-linux` binary, list and edit
saved profiles, validate profile JSON without saving, preview profile-backed
workspace starts, require an explicit approval card before starting a hidden
workspace, stop running workspaces, run stale workspace cleanup, and create a restricted Chrome
starter profile that keeps the `--no-sandbox` browser tradeoff visible. It can
also prepare a browser-session profile from a picked browser data directory,
defaulting to a managed copy under Agent Workspace data and keeping direct
read-write mounting behind an explicit profile-lock warning.
The friendly profile editor intentionally exposes only three network choices:
**Closed** (`network.mode=disabled`), **Local** (`network.mode=local_only`), and
**Open** (`network.mode=inherit_host`). More complex host allowlists are not a
current product path; advanced JSON can still show older/internal profile data
without making the normal UI promise filtering that the runtime does not
enforce.
The startup-app picker accepts ordinary executable files and Linux `.desktop`
launchers; when a launcher is selected, the bridge reads its `Name`/`Exec`
fields, removes desktop field codes such as `%U`, and stores the parsed command
array without invoking a shell. Manual startup commands typed into the profile
editor are also parsed into an argv array directly; shell syntax such as
redirection, pipes, or environment assignment is not interpreted unless the user
explicitly chooses a shell binary as the program.

When this feature is enabled, it also sets `CODEX_LINUX_PIN_RENDERER_URL=1` for
the launcher so Electron keeps using the managed local webview origin even if
the environment contains an inherited `ELECTRON_RENDERER_URL`. Set
`CODEX_LINUX_ALLOW_RENDERER_URL_OVERRIDE=1` only for explicit debugging.

Install `agent-workspace-linux` (v0.1.1 or newer) from the **Agent Workspaces**
page with **Install from npm**, or install it manually. v0.1.1 is the first
release whose default `./install.sh` no longer writes to `~/.codex/config.toml`,
matching this feature's app-owned configuration model. If a previous v0.1.0
install left a stale `agent-workspace-linux` entry in the generic Codex MCP
config, run `./install.sh --clean-codex-config` once from a v0.1.1+ checkout
to remove it; the **Agent Workspaces** settings page then owns command path,
permission file, and viewer launch.

The npm package is published as:

```bash
npm i -g @agent-sh/agent-workspace-linux
```

The npm package name is `@agent-sh/agent-workspace-linux`; the installed
CLI/binary is still called `agent-workspace-linux`. You can also install a
GitHub release binary from
<https://github.com/agent-sh/agent-workspace-linux/releases>, placed on `PATH`
or at `~/.local/bin/agent-workspace-linux`.

The bridge is intentionally allowlisted. It invokes `agent-workspace-linux`
through `execFile`, never through a shell, and exposes only profile/workspace
lifecycle actions needed by the UI. The install button also uses `execFile` with
the fixed npm package name. When no npm prefix is already configured, the
install button runs `npm install -g --prefix ~/.local
@agent-sh/agent-workspace-linux` so packaged installs do not try to write into
the bundled managed Node.js runtime or a system directory.
It resolves the binary in this order (highest priority first):

1. the settings-page command field, persisted as
   `codex-linux-agent-workspace-command`
2. `CODEX_AGENT_WORKSPACE_BIN=/absolute/path/to/agent-workspace-linux`
3. an existing binary in Cargo's global bin dir (`$CARGO_HOME/bin` or
   `~/.cargo/bin`)
4. npm global bin/package locations (`$NPM_CONFIG_PREFIX/bin`, common home
   prefixes, `/usr/local/bin`, and the published package bin)
5. an `agent-workspace-linux` found on `PATH`
6. `~/.local/bin/agent-workspace-linux` when `$HOME` is available
7. a bare `agent-workspace-linux` (left for the OS to resolve, or to fail with a
   clear error)

The settings command field and `CODEX_AGENT_WORKSPACE_BIN` both expand a leading
`~/`. The feature does not inspect generic Codex MCP config to locate or control
the backend; published npm installs and already-present global binaries are the
default path, with the command field kept as an explicit override.

The **Agent Workspaces** settings page is the single user-facing place for this
feature. The page owns the command path, optional permission file path,
page-authored permission rules, Reconnect, Smoke test, profile templates,
workspace start/stop, and viewer launch. The feature does not require the user
to visit another settings page or edit shared Codex configuration for Agent
Workspace permissions.
It does not patch the generic MCP settings page, general configuration page, or
conversation/composer surfaces; those pages should remain byte-for-byte
unchanged by this feature. Agent-facing workspace tools are expected to be
introduced through the bundled skill's progressive, on-demand routing rather
than by dumping the entire Agent Workspace MCP tool family into Codex startup
context.

**Reconnect** reruns the backend doctor check and refreshes page-owned state.
**Smoke test** runs doctor, guardrails, profile path, profile list, workspace
list, and permission-file inspection so a user can validate the install before
approving a real profile directory.

The **Permission rules** editor controls the actual runtime ceiling shape:
network mode, local host entries, allowed file/folder mounts, mount access mode,
and app allowlist. Saving those rules writes a page-owned JSON permission file
under the Agent Workspace data directory, stores that file path in app state,
and immediately makes it the `--permissions` file for future CLI actions.
Reconnect/Smoke test are page-owned backend control paths; changing permission
rules does not require the user to visit the generic MCP server page.

If the page has a permission file path, the bridge prepends
`--permissions PATH` to CLI profile/workspace actions. Invalid or missing
permission files fail before spawning the CLI, so the page can report the
failure directly. If no permission file is configured, the page stays in the
existing app-owned permission mode: after the user approves the hidden
workspace, normal workspace-local actions follow the Codex session permission
choice, including full-access sessions that should not ask again for every
click, launch, screenshot, or keystroke.

The feature does not maintain its own hand-listed table of per-action approval
defaults. Approval is gated once, at hidden-workspace start, via the dry-run plus
approval card; after that the configured permission file and the Codex session
permission mode govern individual actions. Per-action classification is owned by
the binary and is surfaced through the page instead of duplicated across Codex
settings surfaces.

After the user approves a workspace start, the settings page opens the native
GPUI viewer with `agent-workspace-linux viewer --id WORKSPACE_ID
--exit-when-workspace-gone`. The active/stopped workspace controls can reopen
the same viewer explicitly. This is a detached child process rather than another
Codex conversation surface, keeps always-on-top disabled unless explicitly
requested, and uses the same page-owned `--permissions` path when one is
configured.
Viewer launch errors are reported through the bridge instead of falling back to
a shell or crashing the app on an asynchronous spawn failure.

The feature intentionally does not inject a conversation workspace screen. The
planned visible monitor is the native GPUI viewer launched by the settings
page/bridge, so the Codex conversation stays focused on the thread instead of
competing with the floating viewer.
The feature only patches the Electron bridge and the Settings webview bundles;
conversation and composer webview assets stay untouched.

The dedicated Settings page owns local start approvals: pressing
**Start** first runs a dry-run preview and renders an **Approve hidden
workspace** card with the request, profile, purpose, setup/startup choices, and
required acknowledgements. The bridge sends `--ack-hidden-workspace` and any
needed policy acknowledgement only after the user presses **Approve and start**.

Manual validation checklist for a build that enables this feature:

1. Launch a side-by-side dev app from clean patched assets.
2. Open **Settings → Agent Workspaces** and run **Smoke test**.
3. Create or preview the Project, Chrome, and Browser session templates.
4. Start a workspace only through the dry-run approval card.
5. Confirm the detached native GPUI viewer opens, then stop the workspace and
   run stale cleanup.

The removed in-conversation monitor must stay absent: the bridge should not
expose the old screenshot-backed `workspaceObserve` action, and active
workspaces should be controlled from Settings plus the native viewer.

Run the feature tests with:

```bash
node --test linux-features/agent-workspace/test.js
```

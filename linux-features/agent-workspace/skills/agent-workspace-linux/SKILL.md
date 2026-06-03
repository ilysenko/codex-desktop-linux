---
name: agent-workspace-linux
description: "Use when a task needs an isolated hidden Linux desktop or workspace-owned browser: GUI app QA, web/browser/shopping automation, sandboxed app observation, or stale workspace cleanup. Routes agent-workspace-linux MCP tools on demand. Does NOT apply to host desktop/Chrome control, generic MCP setup, or pure code/file edits."
---

# agent-workspace-linux

Drive an isolated, agent-owned Linux desktop and workspace-owned browser through
the `agent-workspace-linux` MCP server. The workspace runs apps, browser
automation, screenshots, clipboard, and input inside its own hidden display,
never the user's real desktop, focus, or host Chrome.

This skill is the lightweight entry point. The MCP exposes many tools; do not
load, list, or paste them all up front. Route by phase and ask the host to load
only the tool schemas needed for the next action.

## Critical Boundaries

### Use the dedicated Codex for Linux feature page for setup
Codex for Linux owns Agent Workspace setup through the **Agent Workspaces** page:
binary path, page-authored permission rules, permission file mutation,
Reconnect/Smoke test, profile creation, workspace start/stop, and viewer launch.
Do not send users to generic MCP settings, general configuration pages, or
`~/.codex/config.toml` for normal Codex for Linux setup.

Skip unless: the host is Codex for Linux and the task is setup, permission
changes, reconnect/restart, or the workspace tools are unavailable.

### Keep tools progressive
The bundled installer is skill-first. `./install.sh` installs this skill under
`~/.codex/skills` by default and leaves generic Codex MCP config untouched
unless the user explicitly chooses `--codex-configure` or `--permissions`.
For migration only, `./install.sh --clean-codex-config` removes stale generic
Codex MCP entries left by older installs; restart or reconnect Codex afterward.

Skip unless: the user asks how to install/register the backend or why the tool
family should not be loaded at startup.

### Never target the host desktop
Use this skill only for the hidden workspace. For the user's real Linux desktop,
real Chrome profile, existing tabs, or host focus/mouse/keyboard, use the
appropriate host-desktop or browser tool instead.

Skip unless: the requested action can run inside the isolated workspace display
or workspace-owned browser.

## When To Use

- GUI app QA in a throwaway desktop.
- Browser/web/shopping automation that must not hijack host Chrome.
- Observation of sandboxed windows, logs, events, screenshots, or artifacts.
- Cleanup of stale or orphaned agent workspaces.

Skip unless: the user task requires running or driving a real GUI app/browser in
isolation. For pure code, shell, or file edits, do not start a workspace.

## Permission Model

- **Default**: no MCP ceiling is configured; the host/client owns approvals.
  Call `mcp_permissions` once before mutating to confirm `configured=false`.
- **Permission ceiling**: `--permissions PATH` or
  `AGENT_WORKSPACE_PERMISSIONS` caps network, mounts, and app allowlist for the
  life of that MCP process. It can only be broadened by changing the config and
  restarting/reconnecting the backend from the owning setup surface.
- **Live control**: `mcp_control_state` read-only/paused/active is a
  best-effort runtime control, not the authoritative security boundary.
- **Real-world actions**: checkout, purchases, account changes, and messages
  require explicit user approval. Keep drafting separate from final action.

Skip unless: you are about to start a workspace, open a profile, launch/run an
app, send input, or act on an external account/site.

## Phase Router

Always orient before mutating.

| Phase | Load only these tools |
| --- | --- |
| Orient | `mcp_agent_context`, `mcp_session_brief`, `mcp_task_plan`, `mcp_permissions`, `mcp_action_catalog`, `workspace_doctor`, `workspace_list`, `workspace_status` |
| Profiles | `profile_list`, `profile_get`, `profile_template`, `profile_put`, `profile_check` |
| Start | `workspace_start`, `workspace_open_profile` |
| Observe | `workspace_observe`, `workspace_screenshot`, `workspace_list_windows`, `workspace_active_window`, `workspace_read_app_log`, `workspace_events` |
| Act | `workspace_launch_app`, `workspace_run_app`, `workspace_click`, `workspace_type_text`, `workspace_key`, `workspace_paste_text`, `workspace_focus_window`, `workspace_close_window` |
| Browser | `workspace_open_browser`, `workspace_browser_targets`, `workspace_browser_snapshot`, `workspace_browser_navigate`, `workspace_browser_search_results`, `workspace_browser_click` |
| Viewer/control | `mcp_control_state`, `mcp_control_update`, `workspace_open_viewer`, `workspace_list_viewers`, `workspace_close_viewer` |
| Teardown | `workspace_stop`, `workspace_kill_app`, `workspace_cleanup_stale` |

Skip unless: the current phase needs one of the listed capabilities. Do not load
schemas for later phases until the plan reaches them.

## Safe Workflow

1. Orient: call `mcp_agent_context` or `mcp_session_brief`, then use
   `mcp_task_plan` for app-QA, browser, observe, or cleanup intent.
2. Check permissions: call `mcp_permissions` before mutating.
3. Start: use `workspace_start` with `ack_hidden_workspace=true` and a clear
   `purpose`, or `workspace_open_profile` for a saved profile.
4. Observe: use `workspace_observe` or focused screenshot/window/log/event
   tools before sending input.
5. Act: launch apps, run commands, click/type/paste/key only inside the
   workspace.
6. Stop: use `workspace_stop` when finished; use `workspace_cleanup_stale` for
   orphaned runtimes.

Skip unless: each step's precondition is visible in the previous tool result
(workspace id, app id, target window, browser target, or explicit user approval).

## Browser Tasks

Use the workspace-owned browser over its loopback DevTools endpoint. Start with
`workspace_open_browser`, discover pages with `workspace_browser_targets`, read
with `workspace_browser_snapshot` or `workspace_browser_search_results`, then
navigate or click with browser tools.

Skip unless: the task is web/browser automation that can run in the isolated
workspace. Do not attach to host Chrome, Playwright, or Computer Use as a
shortcut.

## Do NOT

- Do not dump all MCP tools into the agent context at startup.
- Do not send users to generic MCP/configuration pages for Codex for Linux
  Agent Workspace setup.
- Do not start a workspace without `ack_hidden_workspace=true` and a `purpose`.
- Do not send input to or screenshot the user's real desktop.
- Do not perform purchases, checkout, account changes, or sends without explicit
  user approval.
- Do not leave workspaces running after the task.

## Example Trajectory

Task: "QA the settings dialog of myapp."

1. `mcp_agent_context` and `mcp_task_plan` for app-QA.
2. `mcp_permissions` to confirm the active boundary.
3. `workspace_start` with `ack_hidden_workspace=true` and purpose
   `"QA myapp settings"`.
4. `workspace_launch_app` with the app command.
5. `workspace_observe` to find the window.
6. `workspace_click` / `workspace_type_text` to exercise Settings.
7. `workspace_screenshot` and `workspace_read_app_log` for evidence.
8. `workspace_stop`.

## Constraints

- Keep activation low-noise: only use this skill for isolated GUI/browser work.
- Keep context small: frontmatter loads by default; body loads on activation;
  tool schemas load on demand.
- Omit `allowed-tools` intentionally: different hosts namespace MCP tools
  differently, and the skill routes the full family progressively.
- Validate with `agnix --target generic|claude-code|cursor|codex|kiro`
  when changing this file.

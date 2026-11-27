# Local App Server Privileges

This opt-in feature starts the local Codex app-server as a child of the Desktop
main process, through a private Electron message port. The current upstream Owl
runtime sets `no_new_privs` on its app-server utility process. Without this
feature, the app-server inherits that flag even in Full access, preventing
otherwise authorized `sudo` commands.

The feature does not change Codex's per-command sandbox policy or grant sudo
permissions. Sandboxed commands remain subject to the restrictions selected in
Codex. Full access permits commands to exercise the privileges already available
to the user; enable this feature only if that is desired. If the main process
itself already has `no_new_privs`, its child inherits it and sudo remains
unavailable. Remote hosts and non-local transports retain the upstream path.

The port is transferred directly to the utility process and is not exposed as a
filesystem socket. App-server standard input, output, error, and lifecycle are
forwarded over that port; no app-server messages are interpreted. The feature is
experimental and disabled by default. Select `app-server-main-process` with
`make setup-native` and rebuild with `make install-native` to enable it.

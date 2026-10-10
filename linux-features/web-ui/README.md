# Web UI (experimental)

Open ChatGPT Community's official interface in a Chromium browser on Linux.
The installed signed Linux Owl/Electron app remains the host for authentication,
app-server requests, workers, terminals, files, and agent work. This feature
adapts the renderer boundary; it does not implement a replacement Codex client.

The design is inspired by [mkreminskii/codex-web](https://github.com/mkreminskii/codex-web).
This is an independent implementation for this repository's Linux payload and
feature lifecycle. It does not copy that project's source, download a macOS
bundle, replace Electron, rebuild native modules, or install npm dependencies.
The WebSocket server comes from the verified package's bundled `ws` library.

## Enable and launch

Add `web-ui` to the gitignored `linux-features/features.json`, or select **Web UI
(experimental)** in `make setup-native`, then rebuild:

```json
{ "enabled": ["web-ui"] }
```

```bash
./install.sh
CODEX_WEB_UI=1 ./codex-app/start.sh

# Installed native package:
CODEX_WEB_UI=1 codex-desktop
```

Open the complete `ChatGPT Community Web UI:` URL printed in the terminal.
It grants access to the application and its workspaces: keep it private. The
service exchanges its random 256-bit capability for an HttpOnly, SameSite=Strict
cookie and redirects to a URL without the secret. A restart rotates the secret.
Only one browser tab can connect at a time; close the old tab before reconnecting.

Even with the feature built in, ordinary launches keep the desktop interface
and do not start a network listener. Web mode uses the official headless Ozone
backend. Chromium sandboxing remains enabled. Do not run the host as root.
The normal upstream single-instance/profile restrictions still apply: quit
ChatGPT and ChatGPT Community before changing launch modes.

## Listener and remote access

The listener always binds to `127.0.0.1`; it cannot expose itself to the LAN.
Its default port is `4310`. Choose a port from `1` to `65535`, or `0` for a random
available port:

```bash
CODEX_WEB_UI=1 CODEX_WEB_UI_PORT=4311 codex-desktop
```

For access from another machine, forward the **same port** over SSH:

```bash
ssh -N -L 4310:127.0.0.1:4310 USER@LINUX_HOST
```

Open the printed URL unchanged on the browser machine. Host and WebSocket Origin
must match the exact `http://127.0.0.1:PORT` origin. Public reverse proxies, HTTPS
termination, multi-user deployment, and custom hostnames are outside this
initial feature's supported surface.

Bridge messages are limited to 16 MiB. Larger transfers and file attachments
need a dedicated browser adapter.

External HTTP/HTTPS links, including sign-in, appear as a browser link prompt.
ChatGPT OAuth completion may also require forwarding its separate loopback
callback port when using SSH; use the callback address in the authorization
URL. Signing in on the Linux host before starting web mode is another option.

## Lifecycle and compatibility

The HTTP server runs inside the official main process and ends with it. No
background daemon or systemd unit is installed. Browser disconnection disposes
its RPC port and worker subscriptions; a page reload reconnects. Closing the
browser does not quit the host. Stop the launching process to stop web mode.

The framework stages two regular JS resources and a launcher hook. Native
packages, AppImage, Nix, and the minimal update-builder can carry these resources
through the existing declarative machinery. There are no added package runtime
dependencies. Gentoo support has not been audited.

The adapter validates the entire current preload, MessagePort string codec,
inline IPC delivery, window load boundary, and bundled WebSocket server before
writing any patch. Missing or ambiguous anchors reject an enabled-feature
candidate. Desktop launches keep their original structured-clone RPC codec and
IPC delivery. There are no historical-version fallback paths.

## Limits and validation

The workspace folder button opens a browser dialog that lists directories on
the host computer and accepts an absolute host path. Upstream project creation
and workspace trust handling still run after selection.

This is an experimental single-user browser adapter. Native file dialogs,
desktop drag-and-drop, native menu accelerators, pets, embedded Owl browser,
voice/native capture, and other desktop integrations need further browser
adapters. Unsupported bridge operations report that they require the desktop
interface. Account/service rollouts remain upstream-controlled.

Run the adjacent tests and the framework tests:

```bash
node --test linux-features/web-ui/test.js scripts/lib/linux-features.test.js
```

`acceptance.cjs` exercises Chromium against a running Linux host without signing
in or making an inference request. Install Playwright and its Chromium browser
in a development-only directory, start web mode with output redirected to a
private log, and run:

```bash
CODEX_WEB_UI_PLAYWRIGHT_PATH=/absolute/dev-tools/node_modules/playwright \
CODEX_WEB_UI_TEST_LOG=/absolute/private/host.log \
node linux-features/web-ui/acceptance.cjs
```

The driver and host must run on the same Linux machine/user so its temporary
file fixture is visible to the host. Bubblewrap must be installed for the
sandboxed command check. It covers authenticated bootstrap, official app-server
IPC/RPC, reading a file, running an inert command, choosing a folder, rejecting
a second tab, and reloading. After a host restart, optionally set
`CODEX_WEB_UI_TEST_PREVIOUS_LOG` to the previous private log to check secret
rotation. The driver never prints connection capabilities or account responses.

An official-bundle build with only `web-ui` enabled is required in addition to
unit tests. Check in Chromium that the upstream interface renders, the app-host
RPC establishes, authentication and Codex workflows operate, and a second tab
is rejected. Test a host restart with its newly printed URL and verify that old
capabilities stop working. Signed package verification must remain enabled.

## Disable and cleanup

Quit the host and launch without `CODEX_WEB_UI=1` to return to desktop mode.
Remove `web-ui` from `features.json` and rebuild to remove its patches, staged
resources, and hook. The feature creates no user-home files and has no cleanup
hook. Clear the browser's site data to remove its cookie and upstream local
renderer state if desired; upstream account and workspace data stay under the
normal application profile.

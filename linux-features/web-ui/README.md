# Web UI (experimental)

Open ChatGPT Community's official interface in a Chromium browser on Linux.
The installed signed Linux Owl/Electron app remains the host for authentication,
app-server requests, workers, terminals, files, and agent work. This feature
adapts the renderer boundary; it does not implement a replacement Codex client.

Web mode disables the embedded browser capability and rejects its native
browser-panel commands. New tabs use upstream's tool-only workspace screen;
terminals, files, changes, and side chats remain available. External web links
open directly in a separate browser tab. This does not change agent web-search
settings or disable separately configured browser plugins. Ordinary desktop
launches keep their original browser capability.

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

The listener binds to `0.0.0.0` (all interfaces) on port `4310` by default, so
a headless host in a container or on a server is reachable through a published
port, a LAN address, or a reverse proxy. Every route except the one-time
capability exchange requires the capability cookie, and the bridge WebSocket
accepts only a same-origin `Origin`. Select the address with `CODEX_WEB_UI_HOST`
(an IPv4/IPv6 literal, for example `127.0.0.1` for loopback only) and the port
with `CODEX_WEB_UI_PORT` (`1`–`65535`, or `0` for a random available port):

```bash
CODEX_WEB_UI=1 CODEX_WEB_UI_PORT=4311 codex-desktop
CODEX_WEB_UI=1 CODEX_WEB_UI_HOST=127.0.0.1 codex-desktop   # loopback only
```

The printed URL uses `127.0.0.1`. From another machine or through a published
container port, keep its `/?cap=…` part and replace the host and port, for
example `http://SERVER:4310/?cap=…`.

Plain HTTP exposes the capability and session cookie to the network path. On
an untrusted network, use HTTPS through a reverse proxy, an SSH tunnel, or bind
to loopback:

```bash
ssh -N -L 4310:127.0.0.1:4310 USER@LINUX_HOST
```

Browsers treat `http://127.0.0.1`/`localhost` as secure contexts, but not plain
HTTP on other names. In those cases browser features that require a secure
context, such as clipboard and microphone (dictation), are unavailable; the
interface itself still works.

### Docker

The official Chromium sandbox stays enabled, so the container must allow the
user namespaces it needs (for example `--security-opt seccomp=unconfined`). Run
the host as a non-root user and publish the port:

```bash
docker run --security-opt seccomp=unconfined -p 127.0.0.1:4310:4310 \
  -e CODEX_WEB_UI=1 IMAGE codex-desktop
```

Read the connection URL from `docker logs`. A restart rotates it.

Bridge messages are limited to 16 MiB. Larger transfers and file attachments
need a dedicated browser adapter.

External HTTP/HTTPS links, including sign-in, open directly in a browser tab.
ChatGPT OAuth completion may also require forwarding its separate loopback
callback port when using SSH; use the callback address in the authorization
URL. Signing in on the Linux host before starting web mode is another option.

Background cloud-history sync uses the real browser's request profile, just as
ChatGPT mode does. Before enabling that source, the adapter publishes the
profile through upstream's account-checked service. It waits for that profile
and binds each request to the authenticated principal and sign-out signal.
This avoids sending the headless host's profile for browser history requests.
Authentication, workspace routing, and ordinary desktop requests retain their
upstream behavior.

Codex dictation uploads use Work mode's existing browser request headers in web
windows. The original multipart audio, cancellation, recording recovery, and
Retry flow are retained; ordinary desktop windows keep their native headers.

Local account authentication and agent turns do not guarantee access to every
ChatGPT cloud service. Other headless-host routes can still receive HTTP 403
Cloudflare challenges. Inspect the failing endpoint and response headers before
attributing an error to Cloudflare; the presence
of `cf-mitigated: challenge` identifies a challenge response. The history
adapter does not establish that other cloud integrations work.

For an opt-in dictation check, run `dictation-acceptance.cjs` against an isolated,
authenticated signed install with Playwright. Set `CODEX_WEB_UI_TEST_LOG` to its
private readiness log and `CODEX_WEB_UI_TEST_AUDIO` to a generated speech WAV
containing “purple robot” (or set `CODEX_WEB_UI_TEST_TRANSCRIPT`). Chromium uses a
fake microphone; no personal audio is captured and no chat messages are sent.
The check exercises Codex transcription plus a failed upload followed by Retry,
asserting that Retry inserts text without another recording. Set
`CODEX_WEB_UI_TEST_WORK=1` to also test Work when its dictation control is
available for the account. This optional authenticated check is separate from
the unauthenticated CI suite.

## Lifecycle and compatibility

The HTTP server runs inside the official main process and ends with it. No
background daemon or systemd unit is installed. Browser disconnection disposes
its RPC port and worker subscriptions; a page reload reconnects. Closing the
browser does not quit the host. Stop the launching process to stop web mode.

The framework stages three regular JS resources and a launcher hook. Native
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

External HTTP/HTTPS links open directly without a confirmation dialog. Link
clicks retain the browser's native navigation and user gesture; buttons using
the desktop opener are handled locally. Background host requests also attempt
to open a tab, but the browser may block them under its popup policy.

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

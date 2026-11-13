# Core patch registry

OpenAI's latest signed stable Linux package is the compatibility baseline. The
registry contains required launch/work repairs backed by reproduced failures
and regression tests. Product extensions and workflow-specific behavior belong
in disabled-by-default `linux-features/<id>/` directories.

Core descriptors are discovered from `scripts/patches/core/*/patch.js`. The
current registry contains only `shell-env-startup`, implemented by the adjacent
`shell-env-startup/shell-env.js` source transformer. Main-process CommonJS
factory snapshots come from `scripts/patches/lib/main-process-factories.js`,
including canonical numeric identities and original-source body ranges.
Each required descriptor
validates its current upstream ownership and source contract before committing
an edit, and fails the build when that contract drifts.

## `shell-env-startup`

The retained workaround addresses a reproduced Fedora 44/KDE startup failure.
The official package started its shell environment subprocess before Chromium's
POSIX startup replaced SIGCHLD with a no-op handler. A startup syscall trace
showed libuv registering its handler first, then Chromium overwriting it.
Subsequent shell, Git, tar, and CLI preflight children exited but remained
zombies, and new chats hung at “Starting your task”. The failure reproduced
with empty Codex state and a fresh browser profile. Restoring the captured libuv
handler in the running test process immediately reaped the children and allowed
a new chat to start and reply.

The historical 26.1103 source qualification found the same normalized shell-loader
body and synchronous spawn timing as the reproduced path. The current patch
resolves the anonymous loader IIFE through the published shell request
function. It verifies that request, its startup caller, exports, pending-request
ownership and direct IIFE call, then inserts one Linux-only
`await new Promise(setImmediate)` before the loader body. Upstream owns the
timeout, environment processing, cache and error handling.

The historical bounded headless matrix completed raw and deferred cases for its
then-current package and the older calibration package. Both versions completed
that harness, including the older version associated with the reported desktop
failure. These results retain their original package epochs and cover headless
completion. The retained whole-turn workaround addresses the reproduced desktop
startup ordering. Retirement requires calibrated evidence that the affected
ordering is resolved.

Regression tests execute actual request/startup function fragments with inert
spawn and timer collaborators. They cover whole-turn deferral, other platforms,
upstream failure results, source ownership, exact insertion, idempotence,
required-descriptor inventory checks, partial-write rollback and both latest
signed architectures. The descriptor applies to every portable payload because
build and runtime distributions may differ.

## Retired Quit confirmation repair

The former `quit-confirmation-focus` repair and compound descriptor are retired.
The current signed package owns approval checks and pending local
Git review confirmation in its `before-quit` handler. The core registry retains
that native lifecycle.

The native callback first evaluates the macOS privacy-termination veto. Its subsequent approval and pending-review checks can request confirmation
for unsent Git review comments. Approved confirmation marks quit approved before
the application transitions to quitting. Ordinary quits with no pending review
read approval and pending state once, then mark the application quitting. An
existing approval or an active quitting transition short-circuits the relevant
checks. The signed-bundle regression in `../runner.test.js` executes these
current branches with inert collaborators across the native platform cases.
Desktop quit behavior is tracked by the runtime acceptance evidence.

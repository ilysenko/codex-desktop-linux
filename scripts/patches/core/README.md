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

The latest signed 26.1103 package retains the same normalized shell-loader body
and synchronous spawn timing. Its loader is now an anonymous IIFE called by the
published shell request function. The patch verifies that request, its startup
caller, exports, pending-request ownership and direct IIFE call, then inserts
one Linux-only `await new Promise(setImmediate)` before the loader body.
Upstream owns the timeout, environment processing, cache and error handling.

A bounded headless native qualification completed both raw and deferred cases
on the latest package and the older package used for positive calibration.
Because that harness also failed to reproduce the older reported failure, it
provides no evidence that the desktop-specific ordering failure is resolved.
The existing whole-turn workaround is retained with its original runtime
payload. Retirement requires evidence that the affected startup ordering is
resolved.

Regression tests execute actual request/startup function fragments with inert
spawn and timer collaborators. They cover whole-turn deferral, other platforms,
upstream failure results, source ownership, exact insertion, idempotence,
required-descriptor inventory checks, partial-write rollback and both latest
signed architectures. The descriptor applies to every portable payload because
build and runtime distributions may differ.

## Retired Quit confirmation repair

The latest signed package removed the old before-quit confirmation flow and its
`desktop.quitConfirmation.quit` anchor. The former `quit-confirmation-focus`
repair and compound descriptor have been retired. The current core registry
preserves the latest native Quit lifecycle.

The current `before-quit` handler negates the macOS privacy-termination check.
On Linux and Windows that native check returns false, so the handler already
marks the application quitting and permits the event without consulting
`canQuitWithoutPrompt()`. Adding approval consumption to its other branch would
instead change macOS privacy-termination handling. The signed-bundle regression
in `../runner.test.js` evaluates the original callback with inert collaborators
to preserve this platform boundary; it is not a live desktop quit test.

The current native
`before-quit` owner now reads `canQuitWithoutPrompt()`, records local approval
through `markQuitApproved()`, and reaches the existing `markAppQuitting()`
transition without a downstream repair. `../runner.test.js` binds that native
contract to unique semantic anchors in the current signed ASAR.

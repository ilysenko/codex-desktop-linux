# Core patch registry

OpenAI's official Linux package is the compatibility baseline. The registry
contains only required compatibility patches for reproduced mandatory failures
in the current signed stable package.

Product extensions and measured workarounds belong in disabled-by-default
`linux-features/<id>/` directories. A new core descriptor is allowed only when
the current signed official package cannot pass a mandatory launch/work smoke
test without it. Every descriptor needs reproduction evidence and a required
regression test. Remove the patch, its tests, and this record when upstream
resolves the blocker.

## `shell-env-startup`

The current signed stable package has one reproduced mandatory Linux blocker.

On Fedora 44 with KDE, the current signed stable package starts its shell
environment subprocess before Chromium's POSIX startup replaces SIGCHLD with a
no-op handler. A startup syscall trace shows libuv registering its handler
first, then Chromium overwriting it. Subsequent shell, Git, tar, and CLI
preflight children exit but remain zombies, and new chats hang at “Starting
your task”. This reproduces in the unmodified official package, including
empty Codex state and a fresh browser profile. Restoring the captured libuv
handler in the running test process immediately reaped the children; a new
chat then started and replied.

Defer the Linux shell environment loader by one `setImmediate` turn so its
first spawn occurs after synchronous browser initialization. Preserve the
upstream timeout, environment loading, policy validation, and error handling.
The isolated repaired official build starts without accumulating zombies.
Tests cover actual deferral, other-platform behavior, failure propagation,
unique semantic matching, idempotence, and the signed official module.
Because deb, RPM, pacman, AppImage, and Nix payloads can be built on a different
distribution from the machine that runs them, the required descriptor is
applied to every portable payload. The injected deferral is guarded by the
runtime platform and is safe on other targets. Retire this patch when upstream
orders these startup operations correctly.

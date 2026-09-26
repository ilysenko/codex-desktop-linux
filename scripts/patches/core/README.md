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

On Fedora 44 / KDE, signed stable 26.924.20706 starts its shell environment
subprocess before Chromium's POSIX startup replaces SIGCHLD with a no-op
handler. A startup syscall trace shows libuv registering its handler first,
then Chromium overwriting it. Subsequent shell, Git, tar, and CLI preflight
children exit but remain zombies, and new chats hang at “Starting your task”.
This reproduces in the unmodified official package, including empty Codex
state and a fresh browser profile. Restoring the captured libuv handler in
the running test process immediately reaped the children; a new chat then
started and replied.

Defer the Linux shell environment loader by one `setImmediate` turn so its
first spawn occurs after synchronous browser initialization. Preserve the
upstream timeout, environment loading, policy validation, and error handling.
The isolated repaired official build starts without accumulating zombies.
Tests cover actual deferral, other-platform behavior, failure propagation,
unique semantic matching, idempotence, and the signed official module.
Retire this patch when upstream orders these startup operations correctly.

## `quit-confirmation-focus`

The current signed stable package opens its synchronous Quit confirmation
without a parent window. On affected Linux desktops the modal can appear
behind the application and leave Quit blocked with no focusable prompt. The
required patch selects the focused visible window, then the visible primary
window, then another visible live window; it opens a parented asynchronous
dialog and guards duplicate `before-quit` events until the user responds.

The adjacent regression test covers approval, cancellation, reentrancy,
window selection, fail-closed semantic matching, and application to the signed
campaign bundle. Retire this descriptor only after the signed stable bundle
provides an equivalent focusable confirmation or removes the blocker.

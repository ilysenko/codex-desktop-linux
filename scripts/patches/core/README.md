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

## Quit confirmation focus

The signed stable `chatgpt/amd64` 26.917.71314 package still handles
`before-quit` with an unparented synchronous confirmation dialog. On GNOME
Wayland/XWayland this dialog can remain hidden and unfocused while the main
process blocks, leaving the File menu empty and new requests stalled until the
dialog is found and answered.

`quit-confirmation-focus/patch.js` locates that handler through its unique
`desktop.quitConfirmation.quit` message anchor, parents the prompt to a visible
app window, and waits for it asynchronously. Approval resumes the official Quit
path; cancellation leaves the app running. The patch does not alter cleanup or
MCP shutdown. `quit-confirmation-focus/test.js` covers parenting, approval,
cancellation, duplicate Quit requests, window fallback, the current signed
ASAR, and fail-closed missing, ambiguous, or changed contracts. The default
build applies this required patch even when no optional features are enabled.

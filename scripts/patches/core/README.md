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

The current signed stable package still handles **File > Quit ChatGPT** with an
unparented, synchronous dialog. The main process waits for that response, so a
dialog that opens behind the app can make the File menu and new requests appear
stalled until the hidden prompt is answered.

`quit-confirmation-focus/patch.js` finds that handler through its unique
semantic contract, parents the prompt to a visible app window, and waits for it
asynchronously. Approval resumes the official Quit path; cancellation leaves
the app running. The patch does not alter cleanup or MCP shutdown.
`quit-confirmation-focus/test.js` covers the official confirmation shape,
approval, cancellation, duplicate Quit requests, window selection, and
fail-closed drift handling. The default build applies this required patch even
when no optional Linux features are enabled.

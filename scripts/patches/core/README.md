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

The current signed stable package requires no core patches. Its unique
`before-quit` owner now reads `canQuitWithoutPrompt()`, records local approval
through `markQuitApproved()`, and reaches the existing `markAppQuitting()`
transition without a downstream repair. `../runner.test.js` binds that native
contract to unique semantic anchors in the current signed ASAR.

Upstream still owns shell-environment startup after awaited app readiness; no
core shell-startup patch is required.

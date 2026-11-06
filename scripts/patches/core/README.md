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

The current signed stable package requires one core patch:

- `quit-confirmation-focus`: the upstream quit coordinator records approval
  through `markQuitApproved()`, but its unique `before-quit` owner never reads
  `canQuitWithoutPrompt()` and unconditionally prevents every non-privacy quit.
  The patch consumes that approval in the existing owner and reuses its
  `markAppQuitting()` transition so approved quit flows can reach `will-quit`.
  `quit-confirmation-focus/test.js` covers the behavior and fail-closed drift
  handling; `../runner.test.js` binds the unique owner to the current signed
  ASAR. Retire the patch when the signed upstream owner uniquely consumes the
  approval itself.

Upstream still owns shell-environment startup after awaited app readiness; no
core shell-startup patch is required.

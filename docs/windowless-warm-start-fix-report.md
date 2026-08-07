# Windowless Warm-Start Fix

## Status

The Linux explicit-quit path now guarantees bounded cleanup followed by process
exit. A later desktop launch no longer attaches to a surviving Electron process
that has no window or launch-action socket.

The change is confined to the existing main-process lifecycle patch and its
regression coverage. Launcher handoff behavior is unchanged.

## Failure

Choosing **Quit** from the application menu could remove the last window and
partially dispose the main-process application context without terminating the
Electron process. A later launch then lost the Electron single-instance lock to
that process. The surviving process could not present a window because the
services needed by its launch handler had already been disposed.

The warm-start handoff exposed the failure but did not cause it. Reopening a
window or extending the launch-action socket lifetime after teardown begins
would route work into a partially destroyed application context.

## Root Cause

The current upstream main bundle has one targeted lifecycle `will-quit` handler
with two cleanup branches:

- a reduced branch flushes global state, stops Codex Micro, and flushes tracing;
- a full branch additionally flushes settings.

Both branches call `preventDefault()`, run lifecycle disposers, wait with
`Promise.allSettled()`, dispose the application context and shared disposable
collection, and then call `app.quit()` again.

That sequence was not total:

- a synchronous lifecycle-disposer or drain-setup exception could occur before
  the promise continuation was installed;
- a stalled drain had no deadline;
- a context or shared-disposable failure could skip the terminal action;
- rejected `Promise.allSettled()` members were not observable;
- the final `app.quit()` could re-enter Electron before the first quit attempt
  had finished unwinding.

Electron 42.3.0 sets `is_quitting_` before notifying `will-quit`. When the event
is prevented, Electron clears the flag only after the observer returns. Its
event bridge performs a microtask checkpoint while returning from JavaScript,
so a synchronously settled cleanup continuation can call `app.quit()` while the
flag is still set; `Browser::Quit()` then returns immediately. This is an
ordering race, not a claim that preventing `will-quit` leaves the flag set
permanently.

Relevant upstream behavior:

- [`Browser::Quit()` and `Browser::NotifyAndShutdown()`](https://github.com/electron/electron/blob/v42.3.0/shell/browser/browser.cc)
- [event-emission microtask scope](https://github.com/electron/electron/blob/v42.3.0/shell/common/gin_helper/event_emitter_caller.cc)
- [`app.exit()` lifecycle contract](https://www.electronjs.org/docs/latest/api/app#appexitexitcode)

## Fix

`applyLinuxWillQuitDrainTimeoutPatch()` semantically locates the single current
upstream handler. It verifies that both drain branches share the expected
event, lifecycle managers, drain functions, and finalizer before changing the
bundle.

On Linux, both branches now pass a cleanup factory to one bounded helper:

1. `Promise.resolve().then(factory)` contains synchronous disposer and drain
   setup exceptions.
2. `Promise.race()` limits the complete drain and context-disposal sequence to
   three seconds.
3. Rejected `Promise.allSettled()` results and deadline expiry are logged.
4. Context disposal runs inside the same three-second deadline, so the upstream
   timeout cannot extend the lifetime of an already windowless process.
5. Shared-disposable failure is logged and cannot suppress `app.exit(0)`.

`app.exit(0)` is deliberate. The patched path has already run the available
bounded cleanup, and Electron documents `app.exit()` as bypassing
`before-quit` and `will-quit`. It therefore terminates without re-entering the
graceful-quit sequence that produced the windowless survivor.

Non-Linux behavior remains on the upstream cleanup and `app.quit()` path.

The helper has no separate once-only state. A single `Promise.race()`
continuation invokes the Linux finalizer, and a promise settles only once.

## Drift And Idempotence

This repository supports only the latest upstream DMG. The patch does not retain
the obsolete lifecycle matcher.

An unchanged source is considered already patched only when the generated
markers and the scoped Linux `app.exit(0)` postcondition are present. Otherwise
the current handler must resolve to exactly one semantic target. Zero or
multiple targets emit a warning; because this descriptor is
`required-upstream`, the patch report records `failed-required` and candidate
promotion is rejected.

This prevents an unrelated `app.exit(0)`, a previous non-exiting finalizer, or
an upstream anchor rename from being mistaken for a successful application.

## Validation

Automated regression coverage exercises:

- both current upstream drain branches;
- synchronous lifecycle-disposer and drain-setup failures;
- asynchronous drain rejection and deadline expiry;
- context-disposal stalls and failures, plus shared-disposable failures;
- Linux forced exit and unchanged non-Linux graceful quit;
- late drain settlement after the deadline;
- exact idempotence and scoped postcondition detection;
- missing, renamed, malformed, and ambiguous current-upstream targets.

The complete patcher suite, script smoke suite, syntax checks, and
`git diff --check` must pass on the final source.

The manual exit-path gate used a packaged Arch Linux build under
Hyprland/Wayland. Ten consecutive top-bar **Quit** and relaunch cycles each
reached zero primary processes, zero packaged helper processes, no
launch-action socket, and no compositor window before the next launch. An
eleventh launch opened a healthy window after the tenth exit.

The manual A/B witness also distinguished the terminal operation: the
cleanup-factory build ending in `app.quit()` left the primary process alive and
windowless, while the otherwise equivalent `app.exit(0)` build completed all
ten cycles.

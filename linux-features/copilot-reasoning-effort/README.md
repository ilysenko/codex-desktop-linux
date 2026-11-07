# Copilot Reasoning Effort Defaults

This optional Linux feature patches Codex webview bundles so Copilot-auth
sessions can select the reasoning efforts supported by the chosen model.

By default, upstream collapses Copilot model reasoning effort choices to one
`medium` entry and disables the composer effort controls for Copilot auth. This
feature keeps the UI changes local and opt-in instead of shipping them as a
core Linux compatibility patch. Upstream saves the Copilot model preference,
but its current default reader always supplies `medium` and its Copilot writer
does not save effort. This feature keeps the native model writer and stores only
the selected effort in the Electron profile's web storage.

Enable it by copying `linux-features/features.example.json` to
`linux-features/features.json` and adding the feature id:

```json
{
  "enabled": [
    "copilot-reasoning-effort"
  ]
}
```

Then rerun the install or package build so the ASAR patch step can apply the
feature to the generated app.

## What It Patches

- The published native model-catalog owner keeps the model's full
  `supportedReasoningEfforts` list for Copilot auth. Its model, hidden-model,
  enabled-effort and ultra-effort filters remain in place. Stable catalog
  inputs identify the owner before and after patching; all physical copies
  are validated and changed together before any write. An applied state must
  contain the exact feature contribution at that owner's effort expression;
  a marker elsewhere does not count.
- The current dropdown and slash-command owners keep the reasoning effort
  controls and `/reasoning` command enabled when the normal model and effort
  prerequisites are present.
- Every copy of the model settings hook receives the same qualified default
  effort adapter. Its storage key includes the active host, native Copilot
  profile (`null` in the supported upstream package), and model. The Electron
  user profile supplies the outer storage scope; switching GitHub accounts in
  the same profile shares this preference, consistent with upstream's global
  Copilot model preference. This feature does not infer an account identifier.
- The reader intersects the saved effort with that host's current normalized
  model catalog, including upstream enabled-effort and ultra filters. Missing,
  unsupported, disabled, or different-model values use the native `medium`
  fallback. Switching provider leaves ordinary model/config defaults intact.
- A successful default/current-without-conversation write stores effort after
  the native model request and preference invalidation. An observable storage
  subscription refreshes same-model selections; fresh pages read the same key,
  and same-origin windows receive storage events. A delayed older write cannot
  replace a later effort intent for the same key.
- Storage errors still allow the native model write and invalidation to finish,
  then use upstream's existing model-settings error path to report that effort
  could not be saved. Native request rejection leaves the saved effort intact.
  Existing conversations continue to use upstream's active-host next-turn RPC.
  Disabling this feature leaves its private keys inert; it does not delete them.

The rspack webview has no stable chunk names, so each owner is found by content
(message ids, settings keys and model-list strings), not by file name.

## Validation

Run the feature tests with:

```bash
node --test linux-features/copilot-reasoning-effort/test.js linux-features/copilot-reasoning-effort/*.test.js
```

Or run the repository checks, including the complete Node test inventory:

```bash
./scripts/ci-local.sh all
```

When enabled, the feature must qualify every required owner. Missing,
ambiguous, damaged or partially patched model-catalog copies reject the
candidate before changing any model-list asset. The enabled-feature build
gate rejects a skipped or failed required descriptor; inspect its patch report
before retrying against changed upstream source.

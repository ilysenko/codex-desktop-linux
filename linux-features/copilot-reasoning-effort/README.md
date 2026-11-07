# Copilot Reasoning Effort Defaults

This optional Linux feature patches Codex webview bundles so Copilot-auth
sessions can select the reasoning efforts supported by the chosen model.

By default, upstream collapses Copilot model reasoning effort choices to one
`medium` entry and disables the composer effort controls for Copilot auth. This
feature keeps the UI changes local and opt-in instead of shipping them as a
core Linux compatibility patch. The current upstream app owns persistence via
its model settings service, so the feature does not patch a private storage
key.

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
- Every copy of the upstream model settings hook (rspack copies it into each
  composer surface chunk) is checked, without edits, to still persist the
  selection through the upstream model settings service.

The rspack webview has no stable chunk names, so each owner is found by content
(message ids, settings keys and model-list strings), not by file name.

## Validation

Run the feature tests with:

```bash
node --test linux-features/copilot-reasoning-effort/test.js
```

Or run all feature tests with:

```bash
node --test linux-features/*/test.js
```

When enabled, the feature must qualify every required owner. Missing,
ambiguous, damaged or partially patched model-catalog copies reject the
candidate before changing any model-list asset. The enabled-feature build
gate rejects a skipped or failed required descriptor; inspect its patch report
before retrying against changed upstream source.

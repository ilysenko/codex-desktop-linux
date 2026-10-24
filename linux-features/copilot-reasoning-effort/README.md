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

- The semantic model-list owner keeps the model's full
  `supportedReasoningEfforts` list for Copilot auth.
- The current dropdown and slash-command owners keep the reasoning effort
  controls and `/reasoning` command enabled when the normal model and effort
  prerequisites are present.

## Validation

Run the feature tests with:

```bash
node --test linux-features/copilot-reasoning-effort/test.js
```

Or run all feature tests with:

```bash
node --test linux-features/*/test.js
```

The patch is fail-soft. If the upstream minified bundle shape changes, the
build logs a warning and leaves the affected bundle unchanged.

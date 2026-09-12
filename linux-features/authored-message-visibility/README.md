# Keep Authored Messages Visible

The agent can mention useful information during a task, such as uncertainty about a result, and leave it out of the final answer.
These messages get hidden when activity collapses, so you can miss that uncertainty unless you expand the activity and read through it.

This feature keeps assistant commentary and user messages visible in their original order after the task finishes.
Ordinary tool activity remains collapsible.

This feature is disabled by default.
Add `authored-message-visibility` to the `enabled` list in `linux-features/features.json`, then rebuild with `./install.sh` or your normal package build.
Remove the ID and rebuild to disable it.

The transcript becomes longer and can include commentary repeated by the final answer.

The feature supports the current official Linux package on amd64 and arm64.
An upstream update can prevent the patch from applying, causing the build to fail when this feature is enabled.
Disable the feature and rebuild, or update the patch for the current package.

## Validation

```sh
node --test linux-features/authored-message-visibility/test.js
```

Build with this feature alone against the signed official package. Check that
commentary, an intervening tool, a steering message, and the final answer render
in order after completion. Expand and collapse again: authored messages must not
duplicate and ordinary tool activity must remain collapsible. Also check a turn
without tools. Tests exercise the official partition/classifier and feature
registration, idempotence, unique asset selection, and drift reporting.

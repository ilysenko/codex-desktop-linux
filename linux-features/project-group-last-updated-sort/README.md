# Project Group Last Updated Sorting

Optional current-DMG patch for the Projects sidebar.

Upstream applies `Last updated` to task rows inside each project, but it then
reapplies the saved manual project order to the project groups themselves. A
complete saved order therefore leaves every project header fixed even when a
different project has the newest task.

This feature makes `Last updated` sort both project groups and their task rows
by recency. `Priority` and `Manual order` keep upstream's saved project-group
ordering behavior.

The feature is disabled by default because it intentionally changes upstream
sidebar semantics. Enable it in `linux-features/features.json`:

```json
{
  "enabled": [
    "project-group-last-updated-sort"
  ]
}
```

Run the feature tests with:

```bash
node --test linux-features/project-group-last-updated-sort/test.js
```

The patch targets only the current upstream Projects sidebar chunk. Upstream
bundle drift leaves the asset unchanged and reports an optional patch warning.

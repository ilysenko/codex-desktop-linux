# Project Group Last Updated Sorting

Optional current-package patch for the Projects sidebar.

Upstream applies `Last updated` to task rows inside each project, but it then
reapplies the saved manual project order to the project groups themselves. A
complete saved order therefore leaves every project header fixed even when a
different project has the newest task.

This feature makes `Last updated` sort both project groups and their task rows
by recency. `Priority` and `Manual order` keep upstream's saved project-group
ordering behavior.

The current sidebar supplies thread references and a separate recency getter.
The feature reuses that getter for project ordering; it does not assume that
references contain task objects or timestamps. The patch selects a unique sidebar
contract across renderer assets and verifies the full helper and call context on
repeat application. Missing, ambiguous, or partial contracts leave the asset
unchanged and reject a build when this feature is enabled.

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

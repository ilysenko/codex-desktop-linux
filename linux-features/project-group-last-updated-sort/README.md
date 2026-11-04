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
module identity across current Rspack assets. It correlates the inline group
sorter with the same callback's sort preferences, cached recency getter, adjacent
projectless sorter, pinned-group split, and per-project task sorter. Equal or
missing timestamps retain the input group order.

If the module has several chunk copies, they are validated and patched together.
Repeat application verifies the complete generated sorter and its actual getter
and mode arguments. Missing, ambiguous, damaged, or partially applied module
copies leave every asset unchanged and reject a build when this feature is enabled.

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

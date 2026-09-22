# Project Task Created Sorting

Optional current-package patch for the alternate Projects sidebar.

When the upstream sidebar rollout exposes `Created`, populated local task rows
may omit `conversation.createdAt` even though their `local:<UUIDv7>` keys
contain a creation timestamp. The upstream `task.at` timestamp only covers
pending rows whose conversation is still null. This feature recovers the
timestamp from valid UUIDv7 keys for populated rows while preserving explicit
creation timestamps, remote tasks, and the existing Last updated behavior.

The feature is disabled by default because the affected alternate sidebar is
rollout-dependent upstream behavior. Enable it in
`linux-features/features.json`:

```json
{
  "enabled": [
    "project-task-sort"
  ]
}
```

Run the feature tests with:

```bash
node --test linux-features/project-task-sort/test.js
```

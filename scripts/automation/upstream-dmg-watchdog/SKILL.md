---
name: upstream-dmg-watchdog
description: Run the versioned upstream DMG probe, repair worker, guarded PR, and sequential Nix refresh flow.
---

# Upstream DMG watchdog

Read and follow `docs/upstream-dmg-watchdog.md` and repository `AGENTS.md`.
Use `scripts/automation/upstream-dmg-watchdog/watchdog.py` for every state
transition. Never edit state directly.

Probe mode runs only:

```bash
python3 scripts/automation/upstream-dmg-watchdog/watchdog.py probe
```

For `CHANGE_READY SHA EVENT_ID=ID` send `PROCESS_UPSTREAM_DMG SHA` to the
dedicated Worker without model/thinking overrides, then acknowledge `ID`.
For `NIX_REPAIR_READY SHA RUN_ID EVENT_ID=ID` send the complete event to that
same Worker, then acknowledge `ID`. Keep `UNCHANGED`, `WORKER_ACTIVE`,
`NIX_ACTIVE`, and `CAMPAIGN_WAITING` quiet.

Worker mode follows the complete worker flow in the documentation. In
particular, it must use immutable `sync-features`, commit before
`record-acceptance`, pass `nix-preflight`, require all six named repair gates,
call `validate-repair-pr` immediately before merge, and use `advance-to-nix`
instead of `campaign-complete` after an accepted main or confirmed repair merge.

Classify the changed paths before validation. When every changed path belongs
to the affected `linux-features/<id>/` directories, use the documented
feature-only fast path: run only their Node tests, current-DMG acceptance, and
`nix-preflight --target .#checks.x86_64-linux.nix-linux-features-multi-feature`.
Open the repair PR after these focused checks and let the six GitHub gates run
in parallel. Do not run `ci-local.sh pr` or local Debian/RPM/pacman builds for a
feature-only drift repair. Use the full local matrix for core, shared loader,
installer, updater, packaging, or mixed-scope changes.

Use the user's primary checkout as `sync-features --source-checkout`, not the
managed repair worktree; this is how its gitignored `features.json` and enabled
local feature trees enter the immutable round snapshot. When acceptance reports
an unchanged source head, skip Nix preflight and call `advance-to-nix` directly.

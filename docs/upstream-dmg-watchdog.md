# Upstream DMG watchdog

The local watchdog turns each upstream DMG SHA-256 into one persistent campaign:

```text
drift validation -> accepted source head -> Nix preflight -> repair merge
-> deterministic Nix refresh -> optional Nix repair round -> completion
```

The versioned engine lives in `scripts/automation/upstream-dmg-watchdog/`.
Personal Codex automation files are only adapters and must not contain a second
copy of the state machine.

## State and delivery

State defaults to
`~/.local/state/codex-automations/upstream-dmg-watchdog/state.json`. Never edit
it manually. Schema 1 is migrated to schema 2 on first write without dropping
an active campaign, lease, completed campaign, or Nix PR state. If schema 1
marked the DMG repair complete while its Nix refresh was still unfinished, the
migration resumes that campaign at `awaiting-nix` instead of losing the Nix PR.

`probe` emits durable events with an `EVENT_ID`. The watcher sends a worker
event first and then acknowledges it with `event-ack`. An unacknowledged event
is returned again on the next heartbeat; `worker-acquire` also acknowledges the
matching event. This prevents a heartbeat model from silently losing a
detected DMG or Nix repair request.

Nix refresh is gated by campaign phase. A newly detected DMG never dispatches
`update-codex-hash.yml`; the campaign must first reach `awaiting-nix` after an
accepted build and, for a changed source head, successful Nix preflight.

## Worker flow

1. Acquire the lease and create a managed worktree from current `origin/main`.
2. Record the worktree, branch, base, and full head SHA with `campaign-update`.
3. Run `sync-features` once with the user's primary checkout as
   `--source-checkout`, not the managed repair worktree. It uses the repository Linux feature loader,
   normalizes legacy aliases and settings, preserves supported symlinks, and
   stores an immutable per-round snapshot. Later builds materialize that same
   snapshot. Use `refresh-feature-snapshot` only before acceptance when an
   explicit new local configuration is intended.
4. Build the candidate from the campaign DMG. Repair only the latest DMG shape,
   commit the source change, record the new head, build again, and call
   `record-acceptance --decision FILE --head SHA`.
5. `record-acceptance` requires an accepted verdict for the campaign DMG, a
   clean matching source commit, the exact enabled feature snapshot, and a full
   patch report. It copies immutable decision and patch-report evidence into
   the state directory. Updating the campaign head invalidates this evidence.
6. For a changed source head, run `nix-preflight`. An unchanged accepted
   current `main` skips this step and advances directly to Nix refresh.
   Preflight uses a disposable detached worktree, permits changes only to the
   three Nix pin files, verifies the generated DMG SRI, retries transient
   failures at most three times, and records its log against the accepted head.
7. Create one repair PR for the round after checking the contributor PR limit.
   The body must contain `<!-- upstream-dmg-sha256:SHA -->`.
8. Wait for these exact gates: Rust and Smoke Tests, Debian, RPM, Pacman, Nix
   Package Builds, and Build App Against Upstream DMG. Run
   `validate-repair-pr` immediately before an expected-head admin merge.
9. After GitHub confirms the merge, call `advance-to-nix --pr-number NUMBER`.
   For an unchanged accepted `main`, omit `--pr-number`. This releases the
   Worker lease and enables deterministic Nix refresh. `campaign-complete` is
   intentionally not a Worker operation anymore.

### Feature-only fast path

A round is feature-only only when every changed tracked path is inside the
affected `linux-features/<id>/` directories. For that scope:

1. Run the affected feature tests, not every repository feature test.
2. Rebuild and record acceptance against the exact campaign DMG and immutable
   feature snapshot.
3. Run the focused preflight:

   ```bash
   python3 scripts/automation/upstream-dmg-watchdog/watchdog.py nix-preflight \
     --run-id RUN_ID \
     --target .#checks.x86_64-linux.nix-linux-features-multi-feature
   ```

4. Publish the repair PR as soon as those focused checks pass. The normal CI
   workflow and upstream-DMG build provide the six merge gates in parallel.

Do not run the full local `ci-local.sh pr`, Debian, RPM, or pacman matrix for a
feature-only repair. Those broad local checks are required when a round changes
core patches, the shared feature loader, installer, updater, packaging, or a
mixture of feature and shared paths. Reuse the immutable DMG download, feature
snapshot, extracted app, native-module cache, and Nix store within a round.

## Nix refresh and recovery

The probe adopts the exact workflow run and stores its run ID, head SHA,
conclusion, classification, URL, and a bounded failed-log excerpt.

Each refresh dispatch is keyed by the exact `main SHA:DMG SHA`. Repeated
heartbeats do not dispatch the same key twice. The GitHub workflow also runs in
one non-cancelling concurrency group, recognizes an already materialized key
from bot commit trailers, compares only the three allowed pin files, and adopts
an existing exact-head CI run. It has no independent cron: only the watchdog
may dispatch it, with the accepted exact `main SHA` and `DMG SHA` as required
inputs. This prevents Nix refresh from racing drift validation or repair.

- Cancelled, timed-out, runner, setup, and network failures are transient. The
  campaign gets at most three total attempts, with 15- and 30-minute backoffs
  between them, and then emits one durable `NIX_BLOCKED`.
- Build and test failures are source failures. The campaign moves to
  `nix-repair` and emits `NIX_REPAIR_READY SHA RUN_ID` to the same Worker.
- The Worker starts a new repair round from current `origin/main`, inspects the
  recorded run, and repeats acceptance, preflight, PR validation, and merge.
- CI dispatched with `workflow_dispatch` may not populate a PR rollup. The
  probe therefore resolves `ci.yml` runs by exact Nix PR head SHA and uses the
  job conclusions as the merge gates. An active exact-head run remains pending;
  it is never misreported as `required-checks-missing`.

Only the bot-authored `codex/nix-upstream-refresh` PR is eligible for automatic
Nix merge. It must contain the exact current SRI, touch only the three allowed
pin files, keep an unchanged expected head, and pass all five repository CI
jobs. Campaign completion happens only after the Nix PR merge is confirmed or
`main` already contains the expected SRI.

## Recovery commands

Revalidate only the latest observed DMG:

```bash
python3 scripts/automation/upstream-dmg-watchdog/watchdog.py campaign-requeue \
  --sha SHA --reason "manual revalidation"
```

Inspect state:

```bash
python3 scripts/automation/upstream-dmg-watchdog/watchdog.py status
```

Do not fabricate hashes, edit state, reuse merged campaign branches, remove
user worktrees, or merge a repair/Nix PR without the deterministic guards.

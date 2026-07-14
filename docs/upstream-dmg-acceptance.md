# Upstream DMG Acceptance

Local installs, updater rebuilds, and the scheduled upstream workflow use the
same release profile from `scripts/lib/upstream-dmg-release-profile.js`. Shell
and workflow entrypoints produce reports; `scripts/validate-upstream-dmg.js`
is the only component that decides whether the candidate can be promoted.

## Verdicts

| Verdict | Meaning | Local promotion | Scheduled issue |
|---|---|---:|---:|
| `accepted` | Build and every required release check passed | yes | close obsolete drift issues |
| `accepted_with_warnings` | Only fail-soft core diagnostics drifted | yes | close obsolete drift issues |
| `rejected` | A required core/integrity check or an enabled Linux Feature drifted | no | create or update the current fingerprint issue |
| `inconclusive` | Reports are missing or an infrastructure failure prevented a decision | no | no change |

The profile derives required core patches from patch descriptors and reads the
enabled feature set from the candidate's patch report. It never enables a
feature for diagnostics. Disabled features are not checked; any patch drift in
a user-enabled feature rejects the candidate so the working installation keeps
that feature intact. The user can disable the feature and retry the update.

## Transactional Local Install

`install.sh` builds into a hidden sibling candidate directory. It evaluates the
candidate patch report and writes
`dist-next/rebuild/upstream-dmg-decision.json`. After an accepted verdict, an
existing app and its sibling candidate are exchanged with Linux
`renameat2(RENAME_EXCHANGE)`, so the canonical app path always names either the
old or accepted app—even if the process is killed or power is lost. A durable
journal records the exchanged directory until it becomes the timestamped
backup; the next install recovers that journal before cleaning or rebuilding a
candidate. A synchronous backup failure exchanges the directories back. A
filesystem without atomic exchange support fails before changing the working
app. First installation remains a single atomic sibling rename.

Each build evaluates reports from its own transaction directory, and a
per-target promotion lock serializes the short final replacement and recovery
window. Automated user-local update paths explicitly disable the developer-only
running-app override. A timer or manual helper may finish building a candidate
while Electron is open, but promotion is refused until that exact installed
Electron process exits; the existing app and evidence remain unchanged.

After a successful promotion or journal recovery, cleanup retains exactly one
managed `<app>.backup-TIMESTAMP[-N]` directory: the app version that was working
immediately before the accepted candidate. Older managed backups are removed
under the promotion lock, including read-only local copies derived from Nix.
Symlinks, regular files, and non-exact/manual backup names are never removed.
Cleanup failures only warn and are retried by the next install or recovery.

`--fresh` refreshes the DMG and candidate without deleting the working app
early. Set `CODEX_KEEP_REJECTED_CANDIDATE=1` to retain a rejected or safely
unpromoted candidate for debugging; otherwise disposable candidates are
removed. `CODEX_ACCEPTANCE_OVERRIDE=1` is a developer-only emergency escape
hatch for a completely built candidate; CI and the updater do not set it.

The updater also publishes downloads to immutable, content-addressed paths
after a streamed hash, file sync, atomic rename, and parent-directory sync. A
cache lease remains held through state persistence and package consumption.
Cleanup keeps the state-referenced DMG and removes older managed hashes plus
temporary files abandoned by an interrupted download; unrelated files and
symlinks are ignored.

## Drift Issue Lifecycle

Scheduled runs use the DMG SHA-256 as the identity and the app version only as
a display value. One `area: upstream dmg` issue is kept per rejected fingerprint.
When a new fingerprint arrives, open issues for older DMGs are closed as
superseded. An accepted new DMG closes all remaining drift issues. Before any
mutation, the issue job compares the tested HTTP identity with the current DMG
headers so rerunning an obsolete workflow cannot reopen an old issue. The
identity must contain an ETag or both Last-Modified and Content-Length. If
either the tested or current identity is unavailable, reconciliation makes no
issue changes. The reconciler reads its classification from
`.github/labels.json` and leaves any issue carrying `workflow: manual only`
untouched.
Only issues carrying both the label and a valid hidden 64-character fingerprint
marker are managed. Manually created labeled issues and malformed markers are
never updated, reopened, superseded, or closed by the workflow.

## Manual Validation

Normal local builds run acceptance automatically:

```bash
./install.sh /path/to/Codex.dmg
./scripts/rebuild-candidate.sh /path/to/Codex.dmg
```

The generated decision and its referenced patch reports are sufficient to
reproduce the verdict; upstream intelligence reports remain diagnostic only.

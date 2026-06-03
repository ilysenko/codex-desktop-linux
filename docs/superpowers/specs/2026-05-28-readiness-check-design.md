# Readiness Check Design

## Goal

Add a single release/readiness command that answers: "Is this Linux Codex
Desktop install healthy enough to hand off or keep using?" The command should
combine existing checks into one sanitized report instead of asking users to
remember several commands.

## Chosen Approach

Implement `make readiness-check`, backed by a new Node script
`scripts/codex-readiness-check.js`.

This is preferred over expanding `codex-desktop-doctor` because readiness spans
repo state, package metadata, services, remote-control process presence, and
redacted session history. The installed doctor should stay focused on installed
system health. It is also preferred over docs-only polish because the highest
value is repeatable evidence, not another checklist humans can skip.

## Scope

The readiness check covers:

- Installed package version from `dpkg-query` when available.
- Installed Linux build metadata from
  `/opt/codex-desktop/.codex-linux/build-info.json`.
- Installed doctor result from `/usr/bin/codex-desktop-doctor`.
- User service activity for `codex-desktop.service` and
  `codex-update-manager.service`.
- Remote-control app-server process presence.
- Repository status for the current checkout.
- Existing redacted history/memory check from
  `scripts/codex-history-context-check.js`.

The readiness check does not:

- Print chat text, browser contents, screenshots, QR codes, pairing secrets,
  private key material, raw app-server payloads, key IDs, or raw rollout paths.
- Revoke mobile devices, re-pair mobile devices, restart services, log out, or
  reboot the machine.
- Replace `codex-desktop-doctor`; it composes doctor output at a higher level.
- Treat server-side feature rollout state as locally fixable.

## User Interface

Default command:

```bash
make readiness-check
```

Default output is human-readable and concise:

```text
Codex Desktop Linux readiness

PASS package       codex-desktop 2026.05.28.042624+paritycacd32b
PASS build-info    source=cacd32b branch=codex/local-parity-lab dirty=true
PASS doctor        25 pass / 0 warn / 0 fail / 3 info
PASS services      codex-desktop.service=active codex-update-manager.service=active
PASS remote        app-server --remote-control present
PASS history       memory ok, thread/list responded
WARN repo          untracked output/ is present

Summary: ready with 1 warning
```

JSON mode:

```bash
node scripts/codex-readiness-check.js --json
```

JSON output uses a stable schema:

```json
{
  "ok": true,
  "summary": {
    "status": "ready",
    "pass": 6,
    "warn": 1,
    "fail": 0
  },
  "checks": [
    {
      "id": "package",
      "status": "pass",
      "message": "codex-desktop 2026.05.28.042624+paritycacd32b"
    }
  ]
}
```

## Status Rules

Required pass conditions:

- `dpkg-query` can identify `codex-desktop`, or the script reports a clear
  non-Debian unsupported-package-manager warning when running outside Debian
  packaging.
- Installed build metadata is readable and has a source short commit.
- `codex-desktop-doctor` exits successfully and reports zero failures.
- `codex-desktop.service` is active when systemd user services are available.
- `codex-update-manager.service` is active when the installed package includes
  the updater.
- Existing history check returns `ok: true`.

Warnings, not failures:

- Build metadata reports `dirty=true` only because generated or ignored local
  artifacts are present.
- Git status has untracked `output/`.
- Remote mobile key file is absent.
- Repo-cwd filtered thread count is zero while global thread history responds.
- Remote-control process is absent when the user has not enabled mobile remote.

Failures:

- Doctor reports one or more failures.
- Installed app root or build metadata is missing.
- Required user service is inactive.
- History/memory check fails or prints invalid JSON.
- A subprocess times out.

## Data Flow

`scripts/codex-readiness-check.js` owns orchestration and output formatting. It
spawns existing commands with bounded timeouts and parses only the minimum
fields required for the report.

Flow:

1. Read CLI flags: default human output or `--json`.
2. Run package/build metadata checks.
3. Run `/usr/bin/codex-desktop-doctor` and parse the final summary line.
4. Run `systemctl --user is-active` for the desktop and updater services.
5. Run a bounded process lookup for `codex app-server --remote-control`.
6. Run `node scripts/codex-history-context-check.js --cwd <repo>`.
7. Read `git status --short --branch` and classify only known generated output.
8. Aggregate `pass`, `warn`, and `fail` statuses.
9. Print a redacted human or JSON report.

## Error Handling

Every subprocess has a timeout and returns a structured result:

- `status: "pass"` when the check confirms the requirement.
- `status: "warn"` when the condition is useful but not blocking.
- `status: "fail"` when the readiness claim cannot be trusted.

Raw stderr is not printed by default. Human output uses short normalized
messages. JSON output may include a sanitized `details` object with booleans,
counts, versions, and short commit IDs, but not raw private payloads.

## Tests

Add focused Node tests for:

- Doctor summary parsing.
- Status aggregation.
- Sanitized command-result formatting.
- Repository status classification where `output/` is a warning.
- JSON schema shape for `ok`, `summary`, and `checks`.

Add smoke coverage so `bash tests/scripts_smoke.sh` verifies:

- `node --check scripts/codex-readiness-check.js`.
- `node --test scripts/codex-readiness-check.test.js`.
- `make help` lists `readiness-check`.

Manual verification after implementation:

```bash
make readiness-check
node scripts/codex-readiness-check.js --json
```

Expected on the current machine: ready or ready-with-warnings, with no secrets
or private session content printed.

## Documentation

Update README near the installed doctor and history-check sections:

- Document `make readiness-check` as the recommended handoff/readiness command.
- Explain that it composes the installed doctor and redacted history check.
- State that it never revokes mobile access, restarts services, logs out, or
  reboots.

Update `CHANGELOG.md` with a short entry under Unreleased.

## Acceptance Criteria

- `make readiness-check` exists and runs from the repo root.
- Human output is concise and redacted.
- `--json` output is valid JSON with stable top-level keys.
- Existing doctor and history-check behavior are reused rather than duplicated.
- Failure exit code is nonzero only when at least one check has
  `status: "fail"`.
- Warnings do not prevent a zero exit code.
- Tests and smoke checks pass.

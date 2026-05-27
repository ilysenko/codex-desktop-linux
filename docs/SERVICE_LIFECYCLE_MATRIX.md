# Service Lifecycle Matrix

This matrix defines the redacted evidence format for live Linux service
lifecycle validation. It is read-only: the live probe may query
`systemctl --user show`, but it must not start, stop, restart, enable, disable,
or read logs for any service.

## Status Vocabulary

| Status | Meaning |
|---|---|
| `pass` | Live service state matches the expected installed package posture. |
| `warn` | Live service state was readable, but the service is inactive, disabled, missing a dependency marker, or otherwise not in the preferred posture. |
| `fail` | Strict mode was requested and a service state issue was found. |
| `skip` | The user service manager was unavailable, and strict mode was not requested. |

## Allowed Evidence Fields

The service lifecycle evidence may include only:

- `date`
- `status`
- `systemdUser`: availability boolean, status, and sanitized issue kind
- `appService`: load state, active state, unit-file state, result enum,
  restart policy, restart count, dependency booleans, status, and sanitized
  issue kinds
- `updaterService`: load state, active state, unit-file state, result enum,
  restart policy, restart count, dependency booleans, status, and sanitized
  issue kinds
- `notes`: short setup notes without paths, command output, journal text, or
  private environment values

## Forbidden Evidence

Do not record:

- `systemctl` raw output, `journalctl` output, service logs, stderr, or command
  lines
- environment variable values, filesystem paths, PIDs, user names, host names,
  working directories, profile paths, tokens, browser state, pairing material,
  private key material, or private conversation text
- service start/stop/restart attempts or suspend/resume/network toggles

## Commands

Run the committed static service marker check:

```bash
make parity-services
```

Run the read-only live service state probe:

```bash
make parity-services-live
```

For JSON automation:

```bash
node scripts/service-lifecycle-live.js --json
```

For strict installed-app validation, make warnings fail:

```bash
node scripts/service-lifecycle-live.js --strict --json
```

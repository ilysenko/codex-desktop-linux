# Automation extensions

Disabled-by-default product extensions for automation schedules. This feature
adds multi-time RRULE handling and eagerly exposes the `automation_update`
tool. Neither change is Linux runtime compatibility code.

Enable it in `linux-features/features.json` only when both product extensions
are wanted:

```json
{ "enabled": ["automation-extensions"] }
```

Multiple times keep the native custom-RRULE editor and save path. Local
multi-time recurrences use the existing custom mode and retain their recurrence
text when edited and saved. Existing single-time controls, cloud date/time-zone
normalization and upstream validation remain unchanged. `BYHOUR` and `BYMINUTE`
follow RRULE semantics: `BYHOUR=0,23;BYMINUTE=0,59` represents four times, and the
summary displays their sorted, distinct values.

The schedule patch identifies one Rspack module and validates every physical
copy before writing. Its applied state must regenerate exactly, including the
complete helper bodies, inclusive 23-hour/59-minute bounds, caller bindings and
module scope. Damaged or mixed copies reject the enabled build instead of
being reported as already applied.

The feature patches current upstream webview assets and therefore may require
an update when those private bundle shapes change. Validate it with:

```bash
node --test linux-features/automation-extensions/test.js
```

## Catalog subfeatures

The community feature catalog lists these user-facing capabilities separately:

- **Multiple schedule times** (`multi-time-schedules`): Support multiple times in an automation recurrence rule.
- **Eager automation tool** (`eager-automation-tool`): Expose automation_update without waiting for dynamic tool discovery.

These declarations use `enabledWhen: "parent"`: all are included whenever this
feature is built. They add no independent configuration switches and do not
report runtime activation, permissions, external dependencies or backend health.

# Automation extensions

Disabled-by-default product extensions for automation schedules. This feature
adds multi-time RRULE handling and eagerly exposes the `automation_update`
tool. Neither change is Linux runtime compatibility code.

Enable it in `linux-features/features.json` only when both product extensions
are wanted:

```json
{ "enabled": ["automation-extensions"] }
```

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

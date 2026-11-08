# Remote Control UI

Opt-in Linux UI patches for upstream `remote_control` and related settings surfaces.

This feature only opens the Linux UI gates. It does not fake backend state such
as connected clients, MFA completion, or remote control environments.

The official webview is an rspack build. The remote-connections entry patch
prepares one transaction for its boolean and loading/enabled/disabled gate
owners. It qualifies their complete current native grammar, shared imported
providers, published exports, and actual caller links, then validates every
physical copy before writing. Local identifiers and import module IDs may
change; changed behavior, missing publications, orphan callers, mixed applied
copies, and incomplete canonical gates are rejected. A repeat is accepted only
when the complete cohort is canonical. Linux opens both existing gate roots;
other platforms retain upstream rollout, configuration, and loading behavior.

The remote-control subview and experimental-filter descriptors retain their
separate contracts and patch every chunk carrying their shared modules. The
entry patch does not change catalog availability, access requirements, account
authorization, enrollment, connection lists, or mobile-host runtime state.

Enable it locally in `linux-features/features.json` with:

```json
{
  "enabled": [
    "remote-control-ui"
  ]
}
```

Run the feature tests with:

```bash
node --test linux-features/remote-control-ui/test.js
```

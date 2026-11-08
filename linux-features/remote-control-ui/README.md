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

The remote-control subview patch also prepares an atomic cohort. It qualifies
all physical copies of the published visibility predicate, state-reading hook,
and tab selector, together with the catalog-state and rollout-hook modules.
Its gate dependency accepts pristine source or the exact UP77 canonical entry
contribution. UI-only Linux adaptation adds a platform alternative to the
slingshot flag while retaining catalog availability and access requirements.
The entry and subview transactions work in either order and repeat unchanged.

The subview preparer specifies exact mobile-only and joint contribution forms,
including inverse removal of either contribution. Those forms preserve the
mobile adaptation that can display pre-enable/unavailable views, and always
retain the access-required refusal. This protocol does not qualify the current
remote-mobile-control descriptor: UP83 must adopt and verify its real adapter
in both orders before combined mobile behavior is accepted. The UI feature has
no source dependency on the disabled mobile feature directory.

The experimental-filter descriptor keeps its separate asset contract. Neither
UI transaction changes catalog data, account authorization, enrollment,
connection lists, service ownership, or mobile-host runtime state.

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
node --test linux-features/remote-control-ui/test.js linux-features/remote-control-ui/*.test.js
```

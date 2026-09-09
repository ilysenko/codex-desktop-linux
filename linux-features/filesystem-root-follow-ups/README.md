# Filesystem Root Follow-ups

Optional workaround for existing local tasks whose working directory is `/`.
The current official desktop composer rejects follow-ups with **Unable to send
message — Select a project to continue**, even when `/` is a saved project.
The submission guard treats `["/"]` as a missing-workspace placeholder.

This feature accepts `/` only for an existing local follow-up in local mode.
New-task placeholders, empty roots, projectless policy, cloud/worktree mode,
and the remaining submission checks retain their upstream behavior. It changes
neither task/project records nor filesystem permissions. It does not recover a
lost project association: a detached task already reporting `/` remains at `/`.

Related upstream reports:
[openai/codex#43845](https://github.com/openai/codex/issues/43845) and
[openai/codex#36548](https://github.com/openai/codex/issues/36548).

## Enable

The feature is disabled by default. Add it to `linux-features/features.json`
and rebuild the app:

```json
{
  "enabled": ["filesystem-root-follow-ups"]
}
```

```bash
./install.sh
```

Fully exit the running app and launch the rebuilt installation. Changing the
feature configuration alone does not update an already running renderer.
Remove the feature ID and rebuild to disable it; no user data cleanup is needed.

## Validation and limitations

The patch targets the current signed stable Linux package `26.903.61454` on
`amd64` and `arm64`. It has no display-server-specific behavior. A prior local
workaround was confirmed to restore follow-ups on CachyOS/X11 with Nix and
package `26.901.51231`; no obsolete package-specific branch is retained here.

The matcher requires one complete guard with the current semantics. Unknown,
ambiguous, or partially patched guards remain byte-identical and cause the
enabled feature's normal build enforcement to reject the candidate. Remove or
update the feature when upstream fixes or changes this guard.

```bash
node --test linux-features/filesystem-root-follow-ups/test.js
```

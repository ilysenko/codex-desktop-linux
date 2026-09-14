# Preferred editor file links

Open source and text file references in the selected editor with a plain click.
Without this feature, a source link can open Codex's internal file panel even
when an external editor is selected, requiring the context menu's **Open in**
action each time.

## Enable

Add `preferred-editor-file-links` to the `enabled` array in your local Linux
feature configuration, then rebuild. The feature is disabled by default and
appears in the normal native feature selector.

```json
{
  "enabled": ["preferred-editor-file-links"]
}
```

Choose your editor using Codex's **Default file open destination** setting or
the workspace **Open in** selector. The feature uses upstream's existing
per-workspace/global preference and availability resolution on each click.
Changing the selected editor does not require rebuilding. No editor name,
launch command, preference store or system file association is added.
If no preference is available, upstream's normal available-target fallback and
error handling apply. Choosing a non-editor destination retains its upstream
meaning.

## Behavior

- Source and text references covered by `sourcePath` in `patch.js` bypass the
  internal file panel. The original path, working directory, host, line and
  column are forwarded to the existing open dispatcher without an explicit
  target.
- HTML, media, rich documents and unknown extensions retain upstream previews.
  Directory handling, artifact-template skills, modified/middle clicks and
  context-menu choices retain their existing behavior.
- This is a frontend feature with no additional runtime dependencies or
  compositor integration. Enabled upstream drift rejects the candidate build.
- Disable the feature and rebuild to restore upstream click behavior. Native
  update-builder packaging preserves enabled feature resources.

## Validation

The frontend patch is shared by the official `amd64` and `arm64` packages and
is included through the existing feature pipeline for deb, RPM, pacman,
AppImage and Nix builds. It does not change any package-format implementation.
There are no session-specific hooks; the editor is launched by upstream.

Verified against signed official Linux `26.908.61612` on `amd64`: feature and
framework tests, a build with only this feature enabled, and execution of the
official click/dispatch code through its native mutation boundary. The latter
checks preference resolution and location arguments, not editor-process launch.
`arm64`, individual distributable formats, and desktop clicks on Wayland/X11
have not been validated for this feature.

```sh
node --test linux-features/preferred-editor-file-links/test.js
```

Build with this feature alone against the current signed official Linux package.
For a desktop smoke test, select two different installed editors in turn and
click a source reference with a line number. Verify the selected editor and
location, then check an HTML/image preview and an explicit context-menu target.

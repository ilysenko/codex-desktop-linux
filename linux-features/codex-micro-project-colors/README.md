# Codex Micro project working colors

Disabled-by-default per-project working colors for Codex Micro. Requires
[`codex-micro`](../codex-micro/README.md) and the official Linux runtime.

## Enable and use

Select `codex-micro-project-colors` in `make setup-native`, or add its ID to the
`enabled` list in the gitignored `linux-features/features.json`. The feature
loader also enables the required `codex-micro` feature. Rebuild through the
normal installer or package workflow.

After the app has detected a Micro:

1. Right-click a local or remote project in the sidebar and select **Edit**.
2. Select **Add override** to reveal the color picker.
3. Choose a swatch, use the spectrum and hue slider, or enter a hex color.
4. **Save** applies the color after the project saves successfully.

**Remove override** hides the picker; save to return to the standard working
color. **Cancel** discards unsaved changes. Failed or canceled project saves
leave preferences unchanged. The controls remain available when a previously
detected Micro is unplugged, and are hidden before first detection and in the
new-project dialog. There are no project color controls in Micro settings.

The inline picker follows the app's light and dark themes. Arrow keys in the
spectrum adjust saturation and brightness; Shift uses larger steps. The hex
field accepts six digits while typing and three-digit shorthand on Enter or
blur. Invalid hex drafts revert to the last valid color on blur.

A small dot beside the project name shows the saved override, including in
pinned projects. Its tooltip gives the hex value. It updates after saving and
disappears when the override is removed.

## Behavior and storage

Overrides apply only while a chat is working. Approval, input, error, unread
completion, idle, and unassigned states keep the normal colors. Brightness,
selection pulses, working animations, auto-dim, and voice lighting keep their
existing behavior. The Micro preview and hardware use the same color, and a
color-only edit triggers a lighting update.

Preferences live in the app's persistent signal store under
`codex-micro-project-color-overrides`, keyed by project kind, host ID, and project
ID. Renaming or pinning a project does not change its color. Membership uses the
complete project model, including individually pinned chats. Recent, priority,
pinned, and custom agent-key assignments share the mapping. No project names,
paths, chat titles, or IDs are hardcoded.

The feature changes only JavaScript UI and lighting mapping. It adds no native
payload, package dependency, launcher hook, or separate settings file. It does
not depend on Wayland or X11; hardware permissions come from `codex-micro`.
The descriptor is architecture-independent. The current signed `amd64` package
is validated; physical-device and `arm64` verification still require hardware.

To disable, deselect the feature and rebuild. Saved overrides remain for a
future re-enable. Remove individual overrides through **Edit project** before
disabling if they should be cleared.

## Validation

From the repository root:

```bash
node --test linux-features/codex-micro-project-colors/test.js
CODEX_MICRO_TEST_BUNDLES=/path/to/extracted/official/app \
  node --test linux-features/codex-micro-project-colors/test.js
```

Without `CODEX_MICRO_TEST_BUNDLES`, the suite runs color mapping, picker math,
keyboard/pointer interaction, and input-validation tests. With it, the suite
also checks current upstream bundle syntax and idempotence, actual local/remote
project Save handlers, Cancel/failure behavior, Micro visibility, sidebar labels,
lighting change detection, and hardware mapping. Missing or ambiguous upstream
contracts fail before any bundle is written.

Build against the current signed official package with only this feature
selected (and its automatically enabled `codex-micro` dependency). Review the
patch report and test on the device before activating a candidate.

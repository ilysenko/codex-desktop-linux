# UI Tweaks

`ui-tweaks` is an optional Linux feature for small ChatGPT Desktop UI
customizations. It is disabled by default and is intended as a shared place for
future visual tweaks that are useful to some Linux users but should not affect
the baseline app.

Enable it in the local, gitignored feature config:

```json
{
  "enabled": ["ui-tweaks"]
}
```

## Tweaks

| Tweak | Patch module | What it does | Settings |
| --- | --- | --- | --- |
| `appearance.dockIcon` | `patches/dock-icon.js` | Exposes the upstream Appearance setting and search result for switching Linux windows, the system tray, and supported launchers between the official ChatGPT and Codex icons. | `tweaks.appearance.dockIcon.enabled` |
| `home.suggestedPrompts` | `patches/suggested-prompts.js` | Exposes the upstream Suggested Prompts setting and enables generated project-aware cards on Home. | `tweaks.home.suggestedPrompts.enabled` |
| `modelPicker.showModelsByDefault` | `patches/model-picker-model-list.js` | Opens the advanced picker by default and shows model choices inline instead of hiding them behind the compact Power slider and a nested Model submenu. | `tweaks.modelPicker.showModelsByDefault.enabled` |
| `reasoning.keepEffortLabelsEnglish` | `patches/reasoning-effort-labels.js` | Keeps reasoning effort values in English in the Simplified Chinese UI while leaving the surrounding interface translated. | `tweaks.reasoning.keepEffortLabelsEnglish.enabled` |
| `sidebar.projectName` | `patches/sidebar-project-name.js` | Styles project names in the left sidebar project list. It does not style `Projects` / `Chats` section headings and does not style chat rows. | `tweaks.sidebar.projectName.enabled`, `tweaks.sidebar.projectName.style` |

## Settings

Tracked defaults live in `feature.json`, but local preferences should not be
edited there. Put user-specific overrides in the gitignored
`linux-features/features.json` file under `settings.ui-tweaks`.

Example local config:

```json
{
  "enabled": ["ui-tweaks"],
  "settings": {
    "ui-tweaks": {
      "tweaks": {
        "sidebar": {
          "projectName": {
            "style": "font-weight: 800 !important; color: red;"
          }
        }
      }
    }
  }
}
```

Each tweak documents its own config keys below.

### `appearance.dockIcon`

Exposes the upstream Dock icon selector on Linux and stages the original PNG
resources from the current macOS bundle. The selected icon is applied to open
and restored Electron windows and to the system tray. On KDE Plasma, the tweak
also creates and updates a managed user-local desktop entry so a pinned taskbar
launcher follows the selected icon without reloading Plasma Shell. The Codex
resources are cropped to the same visual occupancy as the ChatGPT icon because
Linux taskbars do not apply macOS Dock normalization. Existing user-managed
desktop entries remain untouched. Packaged launchers are discovered from the
runtime desktop hint or the standard `XDG_DATA_DIRS` application paths. The
source launcher must match the active app id before it can be copied, so a
side-by-side identity cannot inherit the default package's launch commands.

This tweak is independently disabled by default. Enable it while keeping the
rest of `ui-tweaks` configurable:

```json
{
  "enabled": ["ui-tweaks"],
  "settings": {
    "ui-tweaks": {
      "tweaks": {
        "appearance": {
          "dockIcon": {
            "enabled": true
          }
        }
      }
    }
  }
}
```

Config keys:

- `enabled`: `true` applies the three Dock icon descriptors and stages their
  resources. `false` skips Dock-specific asset checks and removes any staged
  Dock icon payload without disabling other UI tweaks. On the next cold start,
  a prelaunch hook also removes a marker-owned user-local launcher and its
  managed icon files. Unmanaged or symlinked desktop artifacts are preserved.

### `home.suggestedPrompts`

Exposes the upstream Suggested Prompts row in General Settings and enables the
existing generated-suggestion path on Home. Suggestions are generated from the
selected project and connected apps by the upstream implementation. Selecting a
card fills the composer with its proposed next action.

The patch continues to call the upstream rollout and account-eligibility
functions for diagnostics, then honors the explicit Linux opt-in. It also keeps
the upstream setting as the user's runtime on/off control after the feature is
built into the app.

This tweak is independently disabled by default:

```json
{
  "enabled": ["ui-tweaks"],
  "settings": {
    "ui-tweaks": {
      "tweaks": {
        "home": {
          "suggestedPrompts": {
            "enabled": true
          }
        }
      }
    }
  }
}
```

Config keys:

- `enabled`: `true` applies the four current-DMG Suggested Prompts descriptors.
  `false` leaves the upstream Settings and Home behavior unchanged while other
  UI tweaks remain independently configurable.

### `modelPicker.showModelsByDefault`

Makes the detailed model list the default Codex composer picker view. The model
rows are rendered inline, so newly available families such as GPT-5.6 Luna,
Terra, and Sol remain visible without first switching away from the compact
Power slider or opening a nested Model submenu. The compact GPT-5.6 Power
slider also derives Sol's positions from the model's `supportedReasoningEfforts`
after the app filters that list through the reasoning efforts enabled in
settings. Enabled efforts such as Max therefore appear without maintaining a
separate hard-coded effort list.

Config keys:

- `enabled`: `true` applies the tweak, `false` keeps the feature enabled but
  leaves the upstream model picker unchanged.

### `reasoning.keepEffortLabelsEnglish`

Leaves the reasoning effort values as `None`, `Minimal`, `Low`, `Medium`,
`High`, `XHigh`, `Max`, and `Ultra` in the Simplified Chinese locale. The
surrounding picker title and usage warning remain translated. This avoids
collapsing distinct upstream values such as `XHigh` and `Ultra` into the same
Chinese label.

Config keys:

- `enabled`: `true` applies the tweak, `false` keeps the feature enabled but
  uses the upstream translated effort labels.

### `sidebar.projectName`

Styles project names in the left sidebar project list.

Tracked default in `feature.json`:

```json
{
  "tweaks": {
    "sidebar": {
      "projectName": {
        "enabled": true,
        "style": "font-weight: 700 !important;"
      }
    }
  }
}
```

Config keys:

- `enabled`: `true` applies the tweak, `false` keeps the feature enabled but
  skips this specific tweak.
- `style`: CSS declaration list inserted into the project-name rule, such as
  `font-weight: 800 !important; color: red;`. It is not arbitrary CSS; unsafe
  syntax that could escape the scoped rule warns and falls back to the default.
  The default is `font-weight: 700 !important;`, so project names are bold
  without changing the fixed row geometry or forcing a color.

## Drift Behavior

The patches are fail-soft. If upstream bundle markers drift, the feature writes
a `WARN` message and leaves the asset unchanged. The patch report exposes that
warning, and acceptance rejects a candidate when the enabled feature has drifted.
Missing Dock icon resources also warn, remove only the Dock icon payload, and do
not abort staging. Suggested Prompts validates every current insertion point
before changing an asset and leaves mixed or drifted input byte-identical.
Invalid style values warn and fall back to the default bold style.

## Adding Tweaks

Add each tweak as a focused module under `patches/`, register it from `patch.js`,
document its JSON settings here, and add coverage in `test.js`.

Run the feature tests with:

```bash
node --test linux-features/ui-tweaks/test.js
```

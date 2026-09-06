# UI Tweaks

`ui-tweaks` is an optional Linux feature for small ChatGPT Community UI
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
| `appearance.dockIcon` | `patches/dock-icon.js` | Exposes the upstream Dock icon selector and synchronizes the selected icon across Linux windows, tray, and supported desktop launchers. | `tweaks.appearance.dockIcon.enabled` |
| `appearance.uiFontSize` | `patches/ui-font-size.js` | Raises the upstream 16 px UI font-size maximum to a configurable value. | `tweaks.appearance.uiFontSize.enabled`, `tweaks.appearance.uiFontSize.max` |
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

Exposes the upstream Appearance row on Linux and applies the selection to
existing and newly registered windows, the official Linux tray, and a managed
user-local desktop entry. The ChatGPT choice uses `icon-chatgpt.png` from the
signed official Linux package. The alternate choice uses the existing ChatGPT
Community package icon; retired macOS DMG icon resources are not imported.

Staging validates the official package's `chatgpt.desktop` identity before it
copies the ChatGPT icon. Missing or changed package resources reject the
candidate so an enabled Dock tweak cannot be installed without its runtime
payload. The desktop helper writes only a full-state-hash-owned launcher derived
from an identity-matching packaged entry. AppImage launch commands are rewritten
to the persistent AppImage path instead of the temporary mounted `AppRun`.
The prelaunch hook removes only an unchanged managed override after the nested
tweak is disabled. Desktop entries carry a full-content digest, while icon files
use content-addressed names whose digest must match their bytes. Any user edit or
pre-existing conflicting icon is preserved, and interrupted sync or cleanup can
resume without a separate ownership sidecar. A per-app lock serializes runtime
updates, and later runs remove only digest-verified orphan icons from the three
feature-owned selection namespaces.

This tweak is independently disabled by default:

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

- `enabled`: `true` applies the two current official-package Dock descriptors
  and stages their resources. `false` leaves official Linux behavior unchanged.

To remove `ui-tweaks` after using a custom Dock icon, first keep the feature
enabled, set `appearance.dockIcon.enabled` to `false`, rebuild and install, and
launch the app once. That launch lets the marker-safe prelaunch hook remove its
managed desktop override and icons. The feature can then be removed from the
next rebuild. Removing `ui-tweaks` directly does not run feature-owned local
cleanup, by design.

### `appearance.uiFontSize`

Raises the official app's hard-coded UI font-size maximum from 16 px. The same
upstream limit feeds both the numeric input and the persisted-setting schema.
That registry is compiled into the renderer, main-process support bundle, and
worker, so the patch requires and updates all three copies atomically instead of
bypassing only the visible control. Code font sizing is unchanged.

This tweak is independently disabled by default. Its default extended maximum
is 24 px and can be configured from 17 through 64 px:

```json
{
  "enabled": ["ui-tweaks"],
  "settings": {
    "ui-tweaks": {
      "tweaks": {
        "appearance": {
          "uiFontSize": {
            "enabled": true,
            "max": 24
          }
        }
      }
    }
  }
}
```

Config keys:

- `enabled`: `true` raises the UI font-size maximum; `false` preserves the
  official 11–16 px range.
- `max`: integer from `17` through `64`; invalid values warn and fall back to
  `24`.

### `home.suggestedPrompts`

Exposes the upstream Suggested Prompts row in General Settings and enables the
existing generated-suggestion path on Home. Suggestions are generated from the
selected project and connected apps by the upstream implementation. Selecting a
card fills the composer with its proposed next action.

The patch continues to call the upstream rollout and account-eligibility
functions for diagnostics, then honors the explicit Linux opt-in. It also keeps
the upstream setting as the user's runtime on/off control after the feature is
built into the app.

The current official package keeps the renderer feature-sync bridge in
`app-initial`, normal Home in `app-primary`, and Work Home in its `page` bundle.
Each bundle has its own semantic contract so a future filename hash change does
not silently select an unrelated asset.

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

- `enabled`: `true` applies the six current-package Suggested Prompts descriptors.
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
separate hard-coded effort list. This tweak is disabled by default and must be
enabled explicitly.

Config keys:

- `enabled`: `true` applies the tweak, `false` keeps the feature enabled but
  leaves the upstream model picker unchanged.

### `reasoning.keepEffortLabelsEnglish`

Leaves the current reasoning effort values as `None`, `Minimal`, `Medium`,
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

The ASAR patches are fail-soft. If upstream bundle markers drift, the feature
writes a `WARN` message and leaves the asset unchanged. The patch report exposes
that warning, and acceptance rejects a candidate when the enabled feature has
drifted. Missing Dock icon package resources or metadata fail the stage hook,
remove only the incomplete Dock icon payload, and reject candidate promotion.
Suggested Prompts validates every current insertion point
before changing an asset and leaves mixed or drifted input byte-identical.
Invalid style values warn and fall back to the default bold style.
The UI font-size tweak requires the three current settings-registry contracts
and leaves every target unchanged when any copy is missing, mixed, drifted, or
ambiguous.

## Adding Tweaks

Add each tweak as a focused module under `patches/`, register it from `patch.js`,
document its JSON settings here, and add coverage in `test.js`.

Run the feature tests with:

```bash
node --test linux-features/ui-tweaks/test.js
```

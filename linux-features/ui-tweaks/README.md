# UI Tweaks

`ui-tweaks` is an optional Linux feature for small Codex Desktop UI
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
        "style": "font-weight: 700 !important; padding-top: 0.25rem;"
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
  The default is `font-weight: 700 !important; padding-top: 0.25rem;`, so
  project names are bold with a small top offset and no color is forced.

## Drift Behavior

The patches are fail-soft. If upstream bundle markers drift, the feature writes
a `WARN` message and leaves the asset unchanged. Invalid style values also warn
and fall back to the default bold style. The feature should not block install,
rebuild, or packaging flows.

## Adding Tweaks

Add each tweak as a focused module under `patches/`, register it from `patch.js`,
document its JSON settings here, and add coverage in `test.js`.

Run the feature tests with:

```bash
node --test linux-features/ui-tweaks/test.js
```

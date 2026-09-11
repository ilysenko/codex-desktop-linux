# Model Picker Default Presets

This opt-in feature replaces the server-provided **Default** model-picker slider
for ChatGPT-authenticated chats with an ordered list of model and reasoning
effort pairs. It does not change the manual model list, API-key, Copilot, or
Aeon-managed sessions, account entitlements, workspace policy, or upstream
Ultra/XHigh gates.

For an existing chat, configured pairs are kept as the composer's optimistic
selection after the upstream next-turn settings RPC completes. This avoids a
race where a long conversation can briefly expose stale thread metadata and
reset the picker. Selecting a model/effort pair outside this feature's list
removes that local override and restores the normal upstream behavior.

The stock Settings page controls which reasoning efforts are visible and
whether Ultra may appear in the picker. It does not currently configure the
model/effort pairs behind **Default**.

## Configure

Add the feature and its settings to the gitignored
`linux-features/features.json`:

```json
{
  "enabled": ["model-picker-default-presets"],
  "settings": {
    "model-picker-default-presets": {
      "presets": [
        {
          "model": "gpt-6-astra",
          "effort": "medium",
          "default": true
        },
        {
          "model": "gpt-5.6-sol",
          "effort": "high"
        }
      ]
    }
  }
}
```

`presets` is an ordered array with no feature-defined maximum. Its order is the
slider order. Each entry has:

- `model`: a non-empty upstream model slug;
- `effort`: `none`, `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`;
- optional `default`: exactly one entry must set it to `true`.

An explicitly configured array must contain at least one entry. Duplicate
model/effort pairs, unknown fields, invalid efforts, and any other malformed
structure stop the feature build with a descriptive error. The tracked empty
manifest default exists only so CI can audit the current upstream bundle; it
does not define a user configuration.

Rebuild and reinstall after editing the file:

```bash
make install-native
```

One available pair makes **Default** a fixed selection. Two or more available
pairs display the slider. The feature never truncates the configured list.
The configured list replaces the upstream **Default** slider in both local
repository tasks and cloud/TPP chats. Those surfaces use separate upstream
catalog and slider-config paths, and the feature patches both; selecting a
model explicitly still uses the normal upstream effort choices for that model.

## Runtime fallback

At runtime, the feature keeps only presets whose model is present in the
current account catalog. It supplies the configured effort variants to the
existing upstream selection resolver; the picker still applies workspace
policy and its Ultra/XHigh visibility gates:

- if the configured default is unavailable, the first available configured
  pair becomes the default;
- if every configured pair is unavailable, the complete upstream **Default**
  configuration is returned unchanged.

Selecting **Default** again and creating a new chat both use the resolved
default pair. Manual model selection remains upstream-owned.

For an unsent local draft, selecting a configured pair is kept in draft state
instead of being persisted as the account's upstream default. This lets the
new conversation start with configured combinations that the server accepts
for a conversation but does not expose as persistable default presets.

## Updates

The update manager preserves the gitignored feature configuration during its
rebuild. Each upstream update is patched against semantic catalog and picker
contracts; drift or ambiguous matches fail closed and are reported instead of
partially changing the app.

## Test

```bash
node --test linux-features/model-picker-default-presets/test.js
```

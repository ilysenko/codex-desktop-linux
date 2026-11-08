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
repository tasks and cloud/TPP chats. The catalog integration covers the native
catalog owner, the TPP query reader, and the chat/gizmo/merged query readers.
Selecting a model explicitly still uses the normal upstream effort choices
for that model.

## Runtime fallback

At runtime, each configured pair must have an available, non-disabled native
model, pass the native capability and workspace clamps unchanged, and be
allowed by the current reasoning-effort visibility settings. Each effort needs
positive evidence for that exact pair from the pristine upstream catalog
through at least one of:

- a usable exact native model/effort option;
- an explicit capability entry for the model;
- the original server-provided slider pair;
- the original explicit default effort for the model.

If native exact lookup has no answer, the feature can supply the missing
explicit variant only from that evidence. An unchanged clamp result alone does
not prove support. Missing or empty capability metadata does not exclude a
model by itself, but it cannot authorize an otherwise unproven effort. An
exact native unavailable option remains an unavailable answer; another usable
option for that model cannot override it.

The query options readers track the current authenticated identity, plan, and
effective effort visibility. Their observer projection starts from the pristine
native catalog and applies that context together with the native workspace
clamp. A plan or visibility change can reproject the same cached catalog without
another model request. Workspace policy comes from that native catalog; a
refreshed catalog carries its updated policy into the next projection. Missing
identity or plan context returns the native query options unchanged.

The surviving configured pairs retain their configured order:

- if the configured default is excluded, the first surviving pair becomes
  the default;
- if every configured pair is excluded, the complete upstream **Default**
  configuration is returned unchanged.

Selecting **Default** again and creating a new chat both use the resolved
default pair. Native option arrays, manual model selection, null/default
lookup rules, and workspace policy precedence retain their upstream behavior.
When replacing the slider removes an original usable server-only pair,
separate compatibility metadata preserves its explicit native lookup so an
existing workspace policy does not lose that pair. It does not add that pair
to the configured slider or bypass later native clamps.

The upstream schema normalizer and native request functions remain unchanged.
Projection is applied to query observers through their options readers; it is
not written into the native query data or the raw TPP disk cache. TPP request
identity, abort handling, cache keys, and placeholder expiry remain native. The
chat/gizmo/merged queries retain their own native request and cache behavior.
A direct query fetch does not automatically apply an observer's projection;
the existing direct metadata formatter continues to consume the native catalog.

The catalog integration treats the tracked empty manifest default as a read-
only compatibility audit of the catalog, query owners, and their native
dependencies. It adds no helpers, imports, reader wrappers, or tracked
visibility/preferences reads, and leaves all audited source bytes unchanged.
Explicit user configuration still requires at least one preset.

The current local composer applies a selected Default pair through its normal
per-conversation model setter. No account-default persistence override is
needed.

## Updates

The update manager preserves the gitignored feature configuration during its
rebuild. Each upstream update is patched against semantic catalog and picker
contracts; drift or ambiguous matches fail closed and are reported instead of
partially changing the app.

The official webview is an rspack build whose application code lives in lazily
loaded `webview/assets/async/` chunks, so every descriptor finds its chunk by
stable content strings and then by its semantic contract, never by file name.
The catalog integration validates the current published schema normalizer,
selection resolver, query readers, and their native policy/cache references.
The catalog owner, TPP query owner, and chat/gizmo/merged query owner form one
transaction across every physical copy, including multiple owners in the same
asset. It preserves the normalizer and native query paths, adds a projection
export and explicit-miss lookup fallback, and wraps the query options readers.

Readonly-binding checks cover the original factory require/exports parameters
and captured bindings at every code-owned depth, including Unicode spellings
and compact rest assignments. Genuine nested local shadows, opaque text, and
member keys retain their native meaning. Ambiguous brace/slash source refuses
before its lexical census can be trusted. Exact inverse and replay must agree
for every owner; missing, ambiguous, opaque, orphan, stale-config, partial, or
mixed copies refuse the complete cohort before writes. Invalid syntax also
refuses before writes. A later write fault restores every attempted file and
preserves its mode. The retired separate catalog/selection-resolver format is
rejected.

The reset-effect audit validates the complete published native picker factory,
including its imports and actual imported reset resolver publication, props,
memoized fallback, reset context, latest callback, and effect dependencies.
It checks every physical copy without changing native behavior, and recognizes
only the exact configured slider contribution on repeat. The unrestricted reset
resolver dependency also proves its original factory loader and exports bindings
before trusting its publication.

The picker slider, local resolver, and local composer are each patched in one
chunk. Upstream inlines the model-settings hook into every composer surface,
so the existing-chat selection patch is applied to each copy and warns about
any copy that drifted.

The local resolver contract follows the current signed stable package's
`removeXHigh` filter and preset loop. The local composer takes its slider
config from either of two ChatGPT-gated upstream sources; the configured list
replaces whichever one is active. An enabled feature's descriptor mismatch
rejects the build/update candidate and preserves the working installation.
The composer context requires the current separate host-ID binding; the retired
host-object context shape is rejected.
The official-bundle CI audit includes populated presets so all seven
descriptors are checked, including the upstream Default-option compatibility
audit (the merged picker's Default option must use the catalog slider settings
exclusively) and the upstream reset-effect audit.

## Test

```bash
node --test linux-features/model-picker-default-presets/test.js linux-features/model-picker-default-presets/*.test.js
```

Set `CODEX_SIGNED_EXTRACTED_APP` to an extracted official `app.asar` to also
check every descriptor against the signed rspack chunks.

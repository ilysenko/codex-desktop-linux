# Model Picker Default Presets

This opt-in feature replaces the server-provided **Default** model-picker slider
for ChatGPT-authenticated chats with an ordered list of model and reasoning
effort pairs. It does not change the manual model list, API-key, Copilot, or
native managed-provider routing, account entitlements, workspace policy, or upstream
Ultra/XHigh gates.

For an existing chat, a configured choice stays visible after its native write
succeeds while thread metadata catches up. Both direct next-turn writes and
the ordinary queued current-selection path keep their native RPCs, targets,
service-tier fields, errors, and queue behavior. A rejected write follows native
cleanup and does not leave the rejected pair selected.

The temporary hold belongs to the latest choice in the current native host,
conversation, profile, authentication, and client-readiness context. A newer
choice or a committed context change supersedes older work. Actual thread model
and effort metadata release the hold after acknowledgement; an account-default
fallback alone is not acknowledgement. Later native refreshes then remain
visible. Selecting a pair outside the configured list restores normal upstream
behavior. This state stays in memory and does not change account-default
persistence.

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

The slider uses that same qualified picker and native reset dependency, prepares
every physical copy, and accepts only its exact configured helper and two
threshold changes. Hidden damage, mixed or orphan contributions refuse the
cohort before writes; a later write fault restores every attempted file.
The composer config descriptor prepares every physical caller copy before one
transaction. Upstream inlines the model-settings
hook into every composer surface. The existing-chat patch qualifies every
physical settings copy and its actual native queue, target, metadata, and React
hook references before one transaction. Its exact inverse and replay must
agree; hidden damage, stale configuration, orphan contributions, or mixed copies
refuse before writes. It composes with the canonical Copilot effort-persistence
contribution while preserving both native permission and persistence routing.

The local resolver validates the current published resolver, model normalizer,
exact supported model/effort intersection, native fallback arrays, and native
uniqBy import/interop use. Its effort predicate and label formatter dependencies
are qualified across every physical copy. Only a runtime config marked by this
feature lowers the preset-loop minimum from three surviving pairs to one.
Unmarked configs, the native `removeXHigh` filter, stable deduplication, list
order, and both fallback thresholds retain their upstream behavior. Unsupported
pairs are never synthesized. The resolver prepares every physical copy before
one transaction, requires exact inverse/replay, and rejects hidden damage,
mixed states, or orphan contributions before writes. The captured helpers must
be actual synchronous module-level declarations, and the native static loader
interop/publication calls must not be replaced by extra critical-method uses.

The composer keeps its two native config sources. Without a cloud context,
the caller selects the local source only for host ChatGPT auth and outside its
native Aeon delegate guard. That source also keeps the local-host,
active-profile/provider, model-catalog and reserve-mode checks. A non-null cloud
context selects the global source, which uses global ChatGPT auth loading,
token, account and user checks. Host auth and global auth remain separate;
the feature adds no blanket managed/cloud exclusion. The configured list is
substituted only after the selected native parsed config is non-null. Native
absence, rollout fallback and empty groups keep their upstream behavior.

The runtime marker consumed by the local resolver is added to the feature-owned
object after native schema parsing. The effective selected-profile query,
its host/cwd cache key and the caller's host, permissions and context arguments
remain native; no profile parameter or profile cache is added. Config data is
serialized with escaped string literals so opaque model names cannot impersonate
another feature's source marker, while runtime strings stay unchanged.

The caller audit follows the actual native Default callback, model normalizer,
per-conversation selector and fresh-selector memo dependency. The separately
available account-default setter is not substituted for that route. The native
home bridge, client-ready/availability checks and reset calls stay unchanged.
Configured pairs still pass through the native local resolver's supported-pair
intersection; unsupported pairs are never synthesized here. Missing, hidden,
mixed, stale or partial owner/dependency copies fail before writes. A partial
write restores every attempted asset and its mode. Exact inverse/replay retains
sibling contributions, including the canonical Copilot dropdown gate, and the
composer retains the separate host-ID context binding.

The upstream Default-selection descriptor is a read-only extracted-app audit.
It qualifies the synchronous native declarations behind the published Default,
ordinary-version, common-pair, and model-predicate paths, every physical copy,
and the actual named catalog-resolver and model-predicate dependencies before
reporting success. A bounded static census permits only the native loader
interop and publication method uses; owned replacements of those critical
methods refuse the audit, while genuine local shadows retain their meaning. The Default option uses
non-empty catalog slider settings exclusively; its native empty-slider fallback
is retained. Ordinary version options keep the native model/effort choices and
matching catalog pairs. The separate paid-model fallback branch uses the shared
catalog slider while retaining the version metadata.

The audit accepts a catalog already changed by this feature only through the
catalog contract's exact inverse and replay under the same configuration, and
rejects mixed pristine/applied dependency copies. It writes no source and adds
no Default-builder wrapper. The vendor deduplication import, default interop,
and native call routing are qualified without executing or replacing that
vendor. Tests execute selected small native helpers and controlled new-thread
fragments; a test deduplication stub does not verify the bundled vendor body or
GUI behavior.

The official-bundle CI audit includes populated presets so all seven
descriptors are checked, including the upstream Default-selection and
reset-effect audits.

## Test

```bash
node --test linux-features/model-picker-default-presets/test.js linux-features/model-picker-default-presets/*.test.js
```

Set `CODEX_SIGNED_EXTRACTED_APP` to an extracted official `app.asar` to also
check every descriptor against the signed rspack chunks.

# Community Features in GUI Settings

The optional `community-features-in-gui-settings` feature adds a separate
**Community features** section at the top of **Settings → General**, above the
existing General section. Expand its catalog to browse an explorer-style tree.
A prerequisite is the parent of its dependents; internal subfeatures appear
under their owning feature and are marked **Subfeature**. Each item
has its own **Installed** / **Not installed** build status. Installed is green
in both light and dark themes. Independent features
start in a collapsed folder. Select a feature to see its manifest description,
ID, requirements and conflicts below the tree. All published public repository
features are included, even when disabled. Local features appear only when
explicitly enabled; internal build plumbing is hidden.

This is a read-only view of the feature selection in this build. An installed
feature is included in the build; this is not a runtime health check. The list
does not edit configuration or enable, disable, rebuild or install anything.

## Enable

Add `community-features-in-gui-settings` to `enabled` in the gitignored
`linux-features/features.json`, preserving other choices, and rebuild/install:

```bash
export TMPDIR="${XDG_CACHE_HOME:-$HOME/.cache}/codex-desktop-dev/tmp"
mkdir -p "$TMPDIR"
CODEX_BOOTSTRAP_NONINTERACTIVE=1 \
CODEX_LINUX_FEATURES=community-features-in-gui-settings make setup-native
make install-native
```

The feature is disabled in committed defaults. Removing its ID and rebuilding
removes the section. It creates no user data and needs no cleanup.

## UI and data

The feature reuses the upstream section/header/content, row layout, secondary
button, React factory, theme and active locale. Disclosure and selection state are in memory
only. Click a disclosure arrow or double-click a parent feature to open/close a
branch. Arrow keys navigate, Right/Left expand/collapse, Home/End move to the
first/last visible node, and Enter/Space select or toggle a branch.
Chrome, a local server, a separate window, IPC handlers and an updater daemon
are not needed to display the tree.

## Language resources

Interface messages live in [locales/en.json](locales/en.json) and
[locales/zh_Hans_CN.json](locales/zh_Hans_CN.json). The app's active locale
selects the resource. Underscores and hyphens are interchangeable;
`zh_Hans_CN`, `zh-Hans-CN`, `zh-CN`, `zh-Hans`, `zh-SG` and generic `zh`
select Simplified Chinese. Unavailable locales use English. A Traditional
Chinese locale does not select the Simplified Chinese resource implicitly.

To add another language, add a JSON file under `locales/`, named for its locale
ID. No renderer changes are needed. For example, `locales/fr.json` can start
with partial translations:

```json
{
  "aliases": ["fr-FR"],
  "messages": {
    "title": "Fonctionnalités communautaires"
  },
  "features": {
    "community-features-in-gui-settings": {
      "title": "Fonctionnalités communautaires dans les paramètres"
    }
  }
}
```

`messages` keys follow the English resource. Missing messages fall back to
English. Named placeholders, such as `{enabled}`, `{total}` and `{name}`, must
match the corresponding English message; their order may change. Build-time
validation rejects conflicting aliases, unknown message keys and mismatched
placeholders. Optional `features.<id>.title` and `.description` translate
catalog text without modifying the catalog or feature IDs. Use
`features["<feature-id>/<subfeature-id>"]` for subfeature translations. Untranslated fields
retain their English resource override or original manifest text.

Resources are discovered and embedded at build time. Selected feature sources,
including `locales/`, travel in the minimal update-builder, so updater rebuilds
retain translations. Browsing the tree does not read files or fetch language
data at runtime.

## Public catalog and build state

[catalog.json](catalog.json) is this feature's checked-in public dataset. It
contains repository feature descriptions, relationships and subfeature defaults,
with no selected-feature state or local feature entries. It is display data;
feature manifests still own implementation, registration and configuration.

After changing public feature metadata or subfeature defaults, generate and
check the dataset from the **full source tree**:

```bash
node linux-features/community-features-in-gui-settings/generate-catalog.js
node linux-features/community-features-in-gui-settings/generate-catalog.js --check
```

The adjacent tests run the synchronization check. The generator only reads
top-level public feature manifests; it never descends into `local/`, reads
feature selections, or evaluates patch implementations. Invalid display entries
are omitted with a warning. Generation is rejected in a minimal update-builder,
whose source tree intentionally lacks disabled implementations.

At build time, the feature reads this dataset and merges the actual enabled set
and subfeature settings. Metadata for explicitly enabled local features can be
added to that build's view because their implementations are already selected
for delivery. Disabled local metadata is never added. Invalid selected local
display metadata is omitted with a diagnostic; normal feature configuration and
patch-integrity checks remain strict. The generated view is embedded in the
ASAR; browsing it does not read files or make network requests.

Catalog provenance accepts Git SHA-1 and SHA-256 commit hashes. Nix's
`<commit>-dirty` provenance is normalized to its underlying hash before writing
the snapshot; persisted snapshots contain only the canonical hash.

Declared `requires` relationships define dependency branches; declarative
`catalogSubfeatures` metadata defines internal branches. Names and conflicts do
not invent parentage. Each internal subfeature counts as one supported item;
its grouping parent does not add another item. A feature without internal
subfeatures counts as one, including when other features depend on it.
Shared dependency nodes are counted once. Folder counts and the summary use
the same rule. Missing catalog entries have an
unknown status. Cycle references remain visible but do not expand recursively.

The minimal update-builder carries the same public `catalog.json`, so disabled
public descriptions survive rebuilds without shipping their implementations.
Enabled local metadata is recomputed from selected source manifests rather than
copied into the public JSON. Legacy `catalog-snapshot.json` files are ignored;
native deb/RPM/pacman hooks remove that owned file from package staging and its
builder manifest. Source files are left untouched. Those hooks also reject an
ASAR catalog containing disabled local entries before packaging succeeds.
AppImage and Nix carry the same generated view without an update-builder.

### Declaring subfeatures

Feature manifests can expose user-facing modules without executing their patch
code. `ui-tweaks/feature.json` declares its nine modules this way:

```json
{
  "catalogSubfeatures": [{
    "id": "dock-icon",
    "title": "Dock icon",
    "description": "Expose and synchronize the Dock icon selector.",
    "settingPath": "tweaks.appearance.dockIcon.enabled"
  }],
  "tweaks": { "appearance": { "dockIcon": { "enabled": false } } }
}
```

The default comes from the boolean at `settingPath` in the manifest; local
`settings.<feature-id>` overrides it. `enabledWhen` defaults to `"true"`
(`=== true`); `"not-false"` matches modules using `!== false`.
`nullishFallback: true` matches modules using `override ?? default`.
Installed state also requires the owning feature to be included in the build.
Module IDs are unique within the feature and must use the same lowercase
letters/digits/hyphens as feature IDs. Low-level patch descriptors and ordinary
configuration values are not counted as modules.
Regenerate `catalog.json` after adding or changing these declarations.

## Validation

```bash
node --test linux-features/community-features-in-gui-settings/test.js
```

The adjacent tests cover semantic settings integration, ambiguous/missing
anchors, idempotence and incomplete patches, catalog snapshots, dependency
direction, shared edges/cycles, subfeature settings and counting, native section
placement, green statuses, locale resources/fallback/extension, tree interaction,
public-data synchronization, private-metadata isolation, and native builder
migration. Validate the
feature alone against the current signed stable official bundle. On the built
app, open **Settings → General**, expand/collapse branches, select features,
and check dark/light themes and keyboard navigation. No feature selection changes
when browsing.

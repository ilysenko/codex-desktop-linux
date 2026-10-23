# Community Features in GUI Settings

The optional `community-features-in-gui-settings` feature adds a **Community features** row to
**Settings → General**. Expand it to browse an explorer-style dependency tree.
A prerequisite is the parent; features requiring it are children. Each feature
has its own **Enabled** / **Not enabled** build status. Independent features
start in a collapsed folder. Select a feature to see its manifest description,
ID, requirements and conflicts below the tree. Public repository and local
features are included; internal build plumbing is hidden.

This is a read-only view of the feature selection in this build. An enabled
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
removes the row. It creates no user data and needs no cleanup.

## UI and data

The feature reuses the upstream General settings row, secondary button, React
factory, theme and active locale. Disclosure and selection state are in memory
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
catalog text without modifying the catalog or feature IDs. Untranslated fields
retain their English resource override or original manifest text.

Resources are discovered and embedded at build time. Selected feature sources,
including `locales/`, travel in the minimal update-builder, so updater rebuilds
retain translations. Browsing the tree does not read files or fetch language
data at runtime.

## Catalog snapshots

The complete catalog is generated at build time and embedded in the ASAR with
the actual enabled set and catalog source commit. It is the catalog of this
build's repository revision, not a live view of GitHub. No network requests
are made by the list.

Only declared `requires` relationships define the tree; names and conflicts do
not invent parentage. A feature with multiple prerequisites appears beneath
each required parent and is counted once. Missing catalog entries have an
unknown status. Cycle references remain visible but do not expand recursively.

Native deb/RPM/pacman package hooks preserve this small catalog in the selected
feature's minimal update-builder, keeping disabled feature descriptions across
updater rebuilds without shipping their implementations. Newly discovered
metadata is merged and enabled status is recomputed for each build. AppImage
and Nix carry the same embedded list; their source builds discover the catalog
from the repository.

## Validation

```bash
node --test linux-features/community-features-in-gui-settings/test.js
```

The adjacent tests cover semantic settings integration, ambiguous/missing
anchors, idempotence and incomplete patches, catalog snapshots, dependency
direction, shared edges/cycles, locale resources/fallback/extension, tree interaction, and preservation in
native update-builders. Validate the
feature alone against the current signed stable official bundle. On the built
app, open **Settings → General**, expand/collapse branches, select features,
and check dark/light themes and keyboard navigation. No feature selection changes
when browsing.

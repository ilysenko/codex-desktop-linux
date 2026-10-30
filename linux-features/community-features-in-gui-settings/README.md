# Community Features in GUI Settings

The optional `community-features-in-gui-settings` feature adds a separate
**Community features** section at the top of **Settings → General**, above the
existing General section. Expand its catalog to browse an explorer-style tree.
All root features appear together, without separate dependency/independent
folders. Every sibling list, including each subfeature/dependent group, sorts by
the displayed name in the active catalog language: Chinese uses pinyin order,
and English uses natural alphabetical order (for example, Item 2 before Item 10).
Sorting ignores case and uses the feature ID as a deterministic tie-breaker for
equivalent names. Subfeature declaration order does not control display order.
Feature branches start collapsed.
A prerequisite is the parent of its dependents; internal subfeatures appear
under their owning feature's **Subfeatures** section. Individual rows show their
name and installation status without a repeated **Subfeature** badge.
Every feature with subfeatures has a separate **Subfeatures (y)** section when
expanded, even when it has no dependent features. The section header shows its
installed/total count on the right, such as **1/9 installed**, and its accessible
label includes the count. Dependent features appear in a separate **Features
requiring this** section when both kinds of children exist. For example,
Chronicle's **Subfeatures (2)** header shows **0/2 installed** or **2/2 installed**;
Record & Replay belongs to the separate dependency section and is excluded.
Feature rows, subfeature rows and selected detail rows show their own
**Installed** / **Not installed** build status. Ratios appear only on the
subfeature section header; **0/9**, **1/9** and **9/9** distinguish none,
some and all installed. Zero-installed section counts are not marked green. Installed is green
in both light and dark themes. Select a feature to see its manifest description,
ID, requirements and conflicts below the tree. All public repository
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

### Gentoo

Gentoo uses the existing `make bootstrap-native` / `make install-native` path
with `PACKAGE_WITH_UPDATER=0`. This feature adds no bootstrap, Portage build,
runtime or merge dependencies, no launcher hook, and no OpenRC/systemd service.
Its Node.js code runs only in the regular-user builder, which already needs
Node.js for ASAR patching; the installed view runs inside upstream Electron.

The catalog is embedded in `resources/app.asar` and Portage installs that accepted
ASAR unchanged. Gentoo has no minimal update-builder, so the deb/RPM/pacman
snapshot hook is deliberately **not** registered for `ebuild`. It would have
nothing to preserve and does not justify a Node.js runtime dependency.
`make update-native` fast-forwards the source checkout and rebuilds the catalog
from that checkout's manifests and current feature configuration before
repackaging/reinstalling through Portage. No catalog snapshot or feature source
needs to be persisted outside the ASAR for this manual update path. This differs
from the updater's partial source tree described below.

Validation on amd64 OpenRC includes a signed official-bundle build with this
feature alone, plus a real Portage installation and same-version remerge in an
isolated ROOT. The second full-source build enabled UI Tweaks and its custom-font
subfeature; the installed ASAR remained byte-identical to the accepted build and
the embedded catalog reflected the new selection. The empty test ROOT used
`--nodeps`, so its expected unresolved-soname warnings are not a dependency-closure
audit or evidence of a fresh Gentoo installation working.

A temporary native Wayland launch of the rebuilt application was checked by the
user in Settings → General: the catalog, installed states and font subfeature
were visible. This did not replace the host package or local feature choices.
Keyboard navigation, theme switching, a host-root upgrade, Gentoo ARM64 and
systemd runtime acceptance are not claimed by these checks.

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

## Catalog discovery and build state

A full source build discovers public repository feature manifests in memory,
including disabled features, and merges the actual enabled set and subfeature
settings. New features and metadata changes appear on the next build without
regenerating or committing a catalog file. Feature manifests remain the source
of truth; no generated dataset or synchronization test is kept in the source
repository.

Discovery reads declarations, never patch implementations. Invalid display
entries are omitted with a diagnostic. Local metadata is considered only when
that feature is enabled; disabled local entries never enter the generated view.
Normal feature configuration and patch-integrity checks remain strict. The view
is embedded in the ASAR; browsing it does not read files or make network requests.

Catalog provenance accepts Git SHA-1 and SHA-256 commit hashes. Nix's
`<commit>-dirty` provenance is normalized to its underlying hash before writing
the snapshot; persisted snapshots contain only the canonical hash.

Declared `requires` relationships define dependency branches; declarative
`catalogSubfeatures` metadata defines internal branches. Names and conflicts do
not invent parentage. Each internal subfeature counts as one supported item;
its grouping parent does not add another item. A feature without internal
subfeatures counts as one, including when other features depend on it.
Shared dependency nodes are counted once in the summary. Missing catalog entries have an
unknown status. Cycle references remain visible but do not expand recursively.

Native deb/RPM/pacman package hooks write a generated `catalog.json` into this
feature's directory in the minimal update-builder. This snapshot comes from the
actual built ASAR: all public repository entries plus enabled local entries.
Disabled public descriptions survive rebuilds without shipping their
implementations. Nothing is written back to the source checkout.

A minimal builder uses the snapshot for absent public implementations and
refreshes entries from the manifests still present. It discards prior local
entries and recomputes selected local metadata, enabled flags and subfeature
settings from the current configuration. The snapshot lives inside the selected
feature tree so it survives the updater workspace copy, which omits top-level
`.codex-linux/` metadata. Malformed snapshots fail validation. Full source
checkouts have no generated snapshot and follow their current declarations.

Legacy `catalog-snapshot.json` files are ignored; native hooks remove that owned
file from package staging and its builder manifest, leaving source files alone.
The hooks also reject an ASAR catalog containing disabled local entries before
writing the new snapshot. AppImage and Nix carry the same generated view without
an update-builder.

### Declaring subfeatures

Feature manifests expose distinct user-facing capabilities without executing
their patch code. A subfeature can either have its own build setting or ship
whenever its parent feature is selected. Neither form reports runtime activation
or health.

For a setting-controlled subfeature, `ui-tweaks/feature.json` declares its nine
modules this way:

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
Changes to these declarations are discovered during the next full source build.

Capabilities that always ship together use an explicit parent-selection rule:

```json
{
  "catalogSubfeatures": [{
    "id": "multi-time-schedules",
    "title": "Multiple schedule times",
    "description": "Support multiple times in an automation recurrence rule.",
    "enabledWhen": "parent"
  }]
}
```

`"parent"` inherits the feature's build selection exactly. Do not supply
`settingPath` or `nullishFallback`, or create a setting merely to populate the
catalog. Generated snapshots retain the parent rule with `defaultEnabled: true`
and the effective `enabled` flag; this does not enable the parent feature by
default. Existing setting-controlled snapshots remain supported. During minimal
updater rebuilds, retained public subfeature descriptions keep their rule while
their installed flags are recomputed from the new selection.

The declared groups are:

| Feature | Separately listed capabilities | Selection |
|---|---|---|
| `agent-workspace` | Workspace controls; agent workspace skill | Parent |
| `automation-extensions` | Multiple schedule times; eager automation tool | Parent |
| `chronicle-skysight` | Chronicle controls; Skysight MCP | Parent |
| `computer-use-linux` | Native computer control; running application picker | Parent |
| `linux-performance-workarounds` | Sidebar scrolling; tab layout; streaming Markdown | Parent |
| `remote-mobile-control` | Mobile Remote host; control other devices | Parent |
| `shared-app-server-socket` | Shared app-server authority; attached CLI | Parent |
| `ui-tweaks` | Nine UI customization modules | Individual build settings |

The remaining features stay single entries. Do not split a single workflow into
its internal steps, count each patch descriptor or helper, or turn ordinary
options into catalog items. For example, dictation gestures, start-hidden login
options, model presets and Pet compositor backends are not separate installed
capabilities. Browser control remains upstream-owned and is not a subfeature of
Linux Computer Use. Record & Replay remains a dependent feature, not a Chronicle
subfeature. Backend installation, account eligibility, device pairing and runtime
permissions still follow each feature's README.

## Validation

```bash
node --test linux-features/community-features-in-gui-settings/test.js
```

The adjacent tests cover semantic settings integration, ambiguous/missing
anchors, idempotence and incomplete patches, catalog snapshots, dependency
direction, shared edges/cycles, subfeature settings and counting, native section
placement, green statuses, locale resources/fallback/extension, tree interaction,
dynamic public metadata discovery, private-metadata isolation, and native builder
migration. Validate the
feature alone against the current signed stable official bundle. On the built
app, open **Settings → General**, expand/collapse branches, select features,
and check dark/light themes and keyboard navigation. No feature selection changes
when browsing.

Gentoo regressions additionally cover default-off selection, empty dependency
phases, unchanged amd64/arm64 ebuilds and other native hooks, the updater and
unaudited-feature guards, and full-source catalog refresh without a builder
snapshot. The fixture tests do not perform a host Portage merge or live GUI
interaction.

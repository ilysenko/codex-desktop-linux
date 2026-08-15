# Nix bundled marketplace staging permissions

This feature is disabled by default and is enabled internally only by the Nix
`mkCodexDesktop` package. Native packages and `.#installer` keep the ordinary
descriptor-free build and do not enable it.

The Nix store supplies the bundled marketplace source with read-only `0444`
files and `0555` directories. When the signed app copies a bundled plugin into
a staging directory, an interrupted or failed materialization can preserve
those modes. Upstream cleanup then cannot remove the staging UUID and later
focus/startup reconciliation can accumulate more staging trees.

The descriptor attaches a `finally` to the unique bundled-marketplace copy
path. After either copy success or failure, it recursively adds owner write
permission to real directories and regular files in that copied destination.
It skips symlinks and every other node type, treats a missing destination as
harmless, and lets chmod errors propagate. It neither changes source-store
permissions nor scans/removes old staging directories or runtime marketplace
data. Existing leaked staging data must be cleaned up manually.

Upstream-contract drift is best-effort for package consumers: the patch report
records `skipped-optional`, the build warns, and an otherwise unchanged ASAR is
preserved byte-for-byte. Repository CI still requires the descriptor to apply
to the current signed official package so drift is repaired before release.

Run the adjacent regression test with:

```bash
node --test linux-features/nix-store-bundled-marketplace-permissions/test.js
```

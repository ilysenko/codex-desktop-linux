# AUR Packaging

This repository keeps AUR packaging separate from the local pacman package
builder.

The local pacman builder, `scripts/build-pacman.sh`, packages an already staged
`codex-app/` directory. That is useful for local native packages and CI
fixtures, but it is not a valid AUR source package because its generated
`PKGBUILD` copies from a temporary staging directory.

The AUR flow renders a standalone source package under `dist/aur/`:

```bash
make aur
make aur-srcinfo
```

The generated `PKGBUILD` downloads:

- this repository archive at `AUR_SOURCE_REF`
- the upstream `Codex.dmg`

It then runs `install.sh` during `build()` and stages a no-updater package
during `package()`. The AUR package intentionally sets
`PACKAGE_WITH_UPDATER=0`; updates should be handled by pacman and the user's
AUR helper, not by the bundled `codex-update-manager`.

The AUR `makedepends` include Arch's `7zip` package because current upstream
DMGs are APFS images and the installer rejects old p7zip extractors.

Useful overrides:

```bash
AUR_PKGVER=2026.06.05 make aur
AUR_SOURCE_REF="$(git rev-parse HEAD)" make aur
```

`AUR_SOURCE_REF` must be a full 40-character commit SHA. Resolve tags or
branches before rendering so the published AUR package does not depend on a
mutable ref or a slash-containing archive directory name.

`AUR_SOURCE_SHA256` and `AUR_DMG_SHA256` default to `SKIP`. Keep
`AUR_SOURCE_SHA256=SKIP` for GitHub-generated source archives because GitHub may
regenerate tarball compression bytes for the same commit. Keep
`AUR_DMG_SHA256=SKIP` because the Codex DMG URL is the stable upstream download
location for this project and package refreshes are handled by publishing a new
AUR revision.

This AUR package intentionally runs the same networked build flow as the rest
of this repository. During `build()`, `install.sh` can download the managed Node
runtime, Electron runtime, npm rebuild inputs, and bundled plugin fallback
resources. Listing every transient build input in AUR `source=()` would require
a larger source-cache mode that this repository does not currently have.

Publishing to AUR requires an SSH key registered with `aur.archlinux.org`.
Configure these GitHub secrets:

- `AUR_SSH_PRIVATE_KEY`
- optional `AUR_KNOWN_HOSTS`

The `Publish AUR Package` workflow renders `PKGBUILD`, generates `.SRCINFO`,
clones the AUR Git repository, copies the generated files, and pushes only when
the rendered package metadata changed.

## Publish After Merge

After this workflow exists on the default branch, a maintainer can publish or
update the AUR package manually:

1. Create the AUR package repository once, if it does not already exist:

   ```bash
   git clone ssh://aur@aur.archlinux.org/codex-desktop-linux.git
   ```

   The first successful push from the workflow can populate the empty AUR Git
   repository with `PKGBUILD`, `.SRCINFO`, and `codex-desktop-linux.install`.

2. Add an SSH private key that can push to the AUR package as the
   `AUR_SSH_PRIVATE_KEY` GitHub Actions secret. The matching public key must be
   registered on the maintainer's AUR account.

3. Optionally add `AUR_KNOWN_HOSTS`. If omitted, the workflow runs
   `ssh-keyscan aur.archlinux.org` during setup.

4. Open GitHub Actions in the repository and run `Publish AUR Package`
   manually with `publish` set to `true`.

5. Set `pkgver` when publishing a specific package version. If omitted, the
   workflow uses a UTC timestamp in `YYYY.MM.DD.HHMMSS` format.

6. Set `source_ref` when publishing a specific commit, tag, or branch. If
   omitted, the workflow uses the workflow run's commit SHA. The workflow
   resolves the value to a full commit SHA before rendering `PKGBUILD`.

The workflow keeps source checksums as `SKIP` so contributors can generate and
inspect AUR metadata without downloading all sources. The GitHub source archive
checksum stays `SKIP` because GitHub-generated tarball bytes are not stable
enough for a durable AUR checksum. The DMG checksum also stays `SKIP`; package
freshness is handled by rerunning the publish workflow for a new AUR revision.

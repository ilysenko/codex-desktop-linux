# Signed Linux package watchdog

This is the only upstream release watcher. It resolves `amd64` and `arm64`
through OpenAI's signed stable APT metadata, compares version/path/SHA256 with
`nix/upstream-linux-packages.json`, and can refresh that pin file. It never
trusts the moving `latest` URL.

```bash
node scripts/automation/upstream-linux-package-watchdog/watchdog.js --json
node scripts/automation/upstream-linux-package-watchdog/watchdog.js --write
```

This JavaScript command is the small signed-metadata and pin-file helper used
by CI. The standalone `upstream-linux-package-watchdog-v2` owns release
campaigns, source repair, internal review, pull requests, guarded merges, and
the ordered Nix refresh. The Nix workflow is dispatched only after accepted
source reaches `main`; it no longer polls independently.

CI follows a changed pin with clean baseline builds for both architectures and
the package matrix. Repository features are audited against the exact official
bundle before an automated repair can be published.

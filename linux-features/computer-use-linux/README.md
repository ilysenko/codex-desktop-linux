# Linux Computer Use

Disabled-by-default Linux Computer Use integration. It owns the seven ASAR
descriptors that used to be unconditional core port glue and the native MCP
plugin staged only when explicitly enabled. Immutable Nix packages receive
their bundled-marketplace staging permission repair from the separate internal
`nix-store-bundled-marketplace-permissions` feature.

Enable it in `linux-features/features.json`:

```json
{ "enabled": ["computer-use-linux"] }
```

`make install-native` builds `codex-computer-use-linux` and
`codex-computer-use-cosmic` once before staging the package. Direct
`./install.sh` builds may provide binaries in `target/release/` or set
`CODEX_COMPUTER_USE_BINARY_SOURCE` and `CODEX_COMPUTER_USE_COSMIC_BINARY_SOURCE`.
Updater rebuilds reuse the packaged artifacts and never invoke Cargo.

Validate descriptor ownership and artifact-only staging with:

```bash
node --test linux-features/computer-use-linux/test.js
```

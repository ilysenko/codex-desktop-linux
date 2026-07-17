# Nix

Run ChatGPT Desktop for Linux directly with:

```bash
nix run github:ilysenko/codex-desktop-linux
```

The flake handles dependencies and patches Electron for NixOS. A GitHub Actions
bot refreshes the upstream `Codex.dmg` hash and verifies the Nix package outputs
in `main`. If you hit a hash mismatch right after an upstream release, wait for
the next bot run and retry.

## Codex CLI Requirement

ChatGPT Desktop still needs the Codex CLI at runtime. The Nix package in this
repository does not install or maintain the CLI for you; it only needs a
working `codex` binary. Put `codex` on your user `PATH`, or set
`CODEX_CLI_PATH` to the exact binary that ChatGPT Desktop should launch.

Relying on `PATH` alone is fragile: a graphical autostart entry, an application
launcher, or a warm-start handoff to an already-running instance may not have
your Nix profile on `PATH`, in which case ChatGPT Desktop fails with
`Unable to locate the Codex CLI binary. Set CODEX_CLI_PATH ...`. Pinning the CLI
explicitly avoids this. The Home Manager and NixOS modules can do this for you
via [`programs.codexDesktopLinux.cliPackage`](#home-manager-nixos-module),
which wraps the launcher so `CODEX_CLI_PATH` is always set.

One direct upstream install path is the npm package:

```bash
npm i -g --include=optional @openai/codex
```

The `--include=optional` flag ensures npm also installs the Linux platform
binary package that the CLI loads at runtime.

### Community Nix CLI Packages

If you want a Nix-native CLI setup, one community-maintained option is the
`sadjow/codex-cli-nix` flake. It is not part of this repository and is not
maintained by this project or by OpenAI. We do not control its release cadence,
build recipe, binary cache, or support policy.

Use it only if that trade-off makes sense for your configuration. Pin it to a
tag or commit for reproducibility, review the flake and cache trust settings
before using them, and report package/cache-specific issues to that project.
Issues in this repository should be limited to ChatGPT Desktop discovering and
launching a working CLI binary.

The community flake exposes Nix packages for the native binary and Node.js
builds:

```bash
nix run github:sadjow/codex-cli-nix/main
```

For a declarative setup, add the CLI flake as an input:

```nix
{
  inputs.codex-cli-nix = {
    # Default branch is `main` on GitHub, not `master`.
    url = "github:sadjow/codex-cli-nix/main";
    inputs = {
      nixpkgs.follows = "nixpkgs";
      flake-utils.follows = "flake-utils";
    };
  };
}
```

The flake also publishes a third-party Cachix cache for prebuilt binaries. This
cache is independent from this repository's `codex-desktop-linux` cache. Enabling
it means trusting substitutes signed by that cache key; omit this step if you
prefer local builds.

```bash
cachix use codex-cli
```

For a declarative NixOS cache configuration:

```nix
{
  nix.settings = {
    substituters = [ "https://codex-cli.cachix.org" ];
    trusted-public-keys = [
      "codex-cli.cachix.org-1:1Br3H1hHoRYG22n//cGKJOk3cQXgYobUel6O8DgSing="
    ];
  };
}
```

Then install its package next to ChatGPT Desktop from Home Manager:

```nix
{ inputs, pkgs, ... }:
let
  codexCli = inputs.codex-cli-nix.packages.${pkgs.stdenv.hostPlatform.system}.default;
in
{
  home.packages = [
    codexCli
  ];

  programs.codexDesktopLinux = {
    enable = true;
    # Bake CODEX_CLI_PATH into the launcher so the Desktop app always finds this
    # CLI, even when launched from a graphical session that lacks the profile on
    # PATH.
    cliPackage = codexCli;
  };
}
```

Setting `cliPackage` wraps the installed ChatGPT Desktop launcher (and its
`.desktop` entry) so it always starts with `CODEX_CLI_PATH` pointing at the
package's `codex` binary. Because the value is baked into the launcher rather
than exported as a session variable, it works for graphical, terminal, and
warm-start launches and takes effect on the next app launch — no re-login
required. An explicit `CODEX_CLI_PATH` already in the environment still wins. If
you enable `remoteControl` but leave `cliPackage` unset, the module reuses
`remoteControl.package` automatically.

For a NixOS module, use the same package in `environment.systemPackages`
instead of `home.packages`.

If you enable the remote-control service, point it at the same CLI package:

```nix
{ inputs, pkgs, ... }:
let
  codexCli = inputs.codex-cli-nix.packages.${pkgs.stdenv.hostPlatform.system}.default;
in
{
  programs.codexDesktopLinux = {
    enable = true;
    remoteControl = {
      enable = true;
      package = codexCli;
    };
  };
}
```

Set `remoteControl.environmentFile` to a quoted absolute runtime path such as
`"/run/secrets/codex-remote-control.env"`. Prefix it with `-` only when systemd
should ignore a missing file. Empty, relative, non-canonical, Nix-context, and
store-backed paths are rejected. Do not interpolate a path containing secrets:
Nix can copy it into the store before module validation rejects the
configuration. The referenced runtime file must be readable by the user service
and should remain owner-only.

Pinning `github:sadjow/codex-cli-nix` to a release tag or commit is
recommended for fully reproducible configurations.

If your graphical session does not put the selected profile on `PATH`, set
`cliPackage` so the launcher is wrapped with `CODEX_CLI_PATH`:

```nix
{
  # Preferred: wrap the launcher so CODEX_CLI_PATH is always set.
  programs.codexDesktopLinux.cliPackage = codexCli;

  # Manual fallback if you are not using the module (needs a re-login to apply):
  # home.sessionVariables.CODEX_CLI_PATH = "${codexCli}/bin/codex";
}
```

If `nix run` appears to do nothing, check the launcher log first:

```bash
sed -n '1,220p' ~/.cache/codex-desktop/launcher.log
```

## Feature Outputs

Flakes do not include the git-ignored `linux-features/features.json` opt-in
file. Nix therefore keeps the existing cache-friendly feature outputs and also
lets module users select Linux features that have been verified to build
hermetically.

Remote mobile control:

```bash
nix run github:ilysenko/codex-desktop-linux#remote-mobile-control
```

Computer Use UI plus remote mobile control:

```bash
nix run github:ilysenko/codex-desktop-linux#computer-use-ui-remote-mobile-control
```

Computer Use UI only:

```bash
nix run github:ilysenko/codex-desktop-linux#codex-desktop-computer-use-ui
```

The Home Manager and NixOS modules accept these feature IDs through
`programs.codexDesktopLinux.linuxFeatures`:

| Feature ID | Purpose |
| --- | --- |
| `appshots` | Linux AppShots capture integration |
| `directory-only-working-tree-watch` | Bounded directory-only working-tree watches |
| `frameless-titlebar` | Hide app-provided titlebar controls for compositor-managed decorations |
| `mcp-helper-reaper` | Cleanup for stale configured MCP helper processes |
| `node-repl-reaper` | Cleanup for leaked Browser Use `node_repl` helpers |
| `open-target-discovery` | Linux terminal, editor, and file-manager discovery |
| `persistent-status-panel` | Persistent `/status` panel state |
| `remote-mobile-control` | Experimental Linux Remote host and outbound-control adaptation |

The list is validated during module evaluation, then deduplicated and sorted so
equivalent configurations produce the same derivation. Features that are not in
this Nix allowlist remain available through the regular opt-in feature flow but
cannot be selected from a pure flake configuration.

## Home Manager / NixOS Module

For a declarative install with the mobile remote-control app-server managed by
systemd instead of the Desktop launcher:

```nix
{
  imports = [
    inputs.codex-desktop-linux.homeManagerModules.default
  ];

  programs.codexDesktopLinux = {
    enable = true;
    computerUseUi.enable = true;
    remoteMobileControl.enable = true;
    linuxFeatures = [
      "appshots"
      "open-target-discovery"
    ];
    remoteControl.enable = true;
  };
}
```

`remoteMobileControl.enable` remains a compatibility shorthand for adding
`remote-mobile-control` to the normalized feature list. `computerUseUi.enable`
remains a dedicated option because it selects the Computer Use UI package path.
The existing named package outputs use the same package builder with fixed
arguments. Setting `programs.codexDesktopLinux.package` still selects that
package directly and takes precedence over module-driven feature selection.

This installs the selected ChatGPT Desktop package variant and starts a user
`codex-remote-control.service` with:

```text
codex app-server --remote-control --listen unix://
```

A `nixosModules.default` export is also available for system-level
configurations that prefer a global user unit.

## Development Shell

```bash
nix develop github:ilysenko/codex-desktop-linux
```

## Cachix

CI can populate a Cachix cache named `codex-desktop-linux` for flake package
outputs. To push to the cache, create it in Cachix and add a repository secret
named `CACHIX_AUTH_TOKEN` with write access.

Users can opt in locally with:

```bash
cachix use codex-desktop-linux
```

When a merge to `main` changes the pinned `Codex.dmg` hash, the `Populate
Cachix` workflow builds the default package, feature-specific package variants,
the watchdog feature check, and `.#installer`. It uploads and garbage-collects
each output before starting the next one so the hosted runner does not retain
every large app variant at once. Maintainers can dispatch the workflow manually
to backfill the current `main` pin after a skipped or interrupted run.

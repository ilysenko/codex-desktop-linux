# Nix

The flake downloads the official architecture-specific Linux package pinned in
`nix/upstream-linux-packages.json`, verifies its hash through Nix, extracts the
ELF payload, and wraps it with the required Nix libraries.

These inputs are official Linux `.deb` files. Nix wraps the official runtime
directly instead of replacing Electron or rebuilding upstream native modules.
The derivation audits every ELF in that payload. Target-architecture glibc
executables and native modules receive the Nix dynamic linker and runtime
RUNPATH; foreign, musl, Android, and static payloads are classified and left
alone. Electron needs one additional fix: `patchelf` normally moves its
interpreter metadata beyond the first 2 KiB, where the bundled libc detector
can no longer see it. The derivation relocates that metadata into verified
`patchelf` padding so the detector selects glibc without using Electron's
unsafe report fallback. These checks run against both official architectures
and keep `resources/app.asar` byte-for-byte identical to upstream.

```bash
nix run github:ilysenko/codex-desktop-linux
nix build .#codex-desktop
```

Supported systems are `x86_64-linux` and `aarch64-linux`. The flake maps these
to upstream `amd64` and `arm64` packages. It does not replace Electron or build
upstream native modules.

## Flake outputs

The main package outputs are:

```text
codex-desktop
codex-desktop-computer-use-ui
codex-desktop-remote-mobile-control
codex-desktop-computer-use-ui-remote-mobile-control
```

The default app runs `codex-desktop`. Normal users should prefer the immutable
package output. `.#installer` is an audited source-staging tool for development
and packaging workflows; it is not a mutable updater for a Nix store package.

```bash
nix run github:ilysenko/codex-desktop-linux#codex-desktop
nix build .#codex-desktop-computer-use-ui
```

## Features

Use the NixOS or Home Manager module and pass explicit feature IDs. Defaults are
empty. Feature resources and required retained helper crates are staged by the
Nix derivation; helpers are release-built as Nix inputs, not during an update.

```nix
programs.codexDesktopLinux = {
  enable = true;
  linuxFeatures = [ "read-aloud" ];
};
```

Feature IDs are validated against `nix/linux-features.nix`. The two convenience
booleans remain available for existing configurations:

```nix
programs.codexDesktopLinux = {
  enable = true;
  computerUseUi.enable = true;
  remoteMobileControl.enable = false;
};
```

## Home Manager

Add the flake input and import its module:

```nix
{
  inputs.codex-desktop-linux.url =
    "github:ilysenko/codex-desktop-linux";

  outputs = { self, nixpkgs, home-manager, codex-desktop-linux, ... }: {
    homeConfigurations.igor = home-manager.lib.homeManagerConfiguration {
      pkgs = nixpkgs.legacyPackages.x86_64-linux;
      modules = [
        codex-desktop-linux.homeManagerModules.default
        {
          programs.codexDesktopLinux = {
            enable = true;
            linuxFeatures = [ "read-aloud" "ui-tweaks" ];
          };
        }
      ];
    };
  };
}
```

## NixOS module

The NixOS module uses the same option namespace:

```nix
{
  imports = [ inputs.codex-desktop-linux.nixosModules.default ];

  programs.codexDesktopLinux = {
    enable = true;
    linuxFeatures = [ "codex-micro" ];
  };
}
```

The Nix package follows the standard `NIXOS_OZONE_WL` convention. When both
`NIXOS_OZONE_WL` and `WAYLAND_DISPLAY` are set, its wrapper starts Electron with
native Wayland rendering and text-input-v3 IME support.

The wrapper uses the NixOS OpenGL driver path when it is present and retains
Mesa as a fallback. Proprietary drivers on non-NixOS distributions may still
need that distribution's usual Nix/OpenGL integration; the flake deliberately
does not add a separate `nixGL` input or replace the host driver with Mesa.

When `codex-micro` is selected, the module also exposes its packaged udev
rules. Optional declarative remote-control service options live under
`programs.codexDesktopLinux.remoteControl` and are independent of the desktop
feature flag.

The official package's bundled `resources/codex` CLI is used by default. Set
`programs.codexDesktopLinux.cliPackage` only to select a different Nix CLI;
the module wraps both the command and desktop entry with a default
`CODEX_CLI_PATH`, while preserving an explicit value from the launch
environment.

When `remoteControl.enable` is set, both modules install a user service and
route Desktop requests to its Unix socket. The service gets a normal user or
system profile `PATH`; `remoteControl.environment` accepts strings, integers,
booleans, and null values (null entries are omitted). Secrets belong in
`remoteControl.environmentFile`, which must be an absolute canonical runtime
path outside `/nix/store` and may start with `-` for systemd's optional-file
semantics. The launcher daemon is suppressed by default to avoid creating a
second owner; set `remoteControl.disableLauncherAutostart = false` only when
that behavior is intentional.

## Development shell

Enter the flake development environment with:

```bash
nix develop
```

It provides the baseline source-verification tools. Rust helper development
still uses the repository Cargo workspaces. Before sending a Nix change, test
evaluation and the audited host-architecture runtime:

```bash
nix flake check
nix build .#checks.$(nix eval --impure --raw --expr builtins.currentSystem).nix-runtime
```

## Updating pins

Pins are updated from signed OpenAI APT metadata:

```bash
scripts/ci/update-official-linux-pins.sh
```

The automation checks both architectures. Do not hand-invent or bypass hashes.
The production pin workflow is dispatched by the standalone signed-package
watchdog only after the matching source revision has passed acceptance and any
required source repair has merged. It is not an independent timer: the
workflow binds its checkout, both package records, branch, pull request, and
explicit exact-head CI runs to one release campaign. The watchdog reviews and
merges that pull request only after the repository's required checks pass.

Validate changes with:

```bash
nix flake check
nix build .#checks.$(nix eval --impure --raw --expr builtins.currentSystem).nix-runtime
```

Nix outputs keep the **ChatGPT Community** desktop identity and shared upstream
`Codex` user profile. Do not run the Nix and official applications
concurrently.

Nix store packages do not use the mutable native-package updater. Update the
flake input or lock file and rebuild through your normal Nix/Home Manager/NixOS
workflow, for example:

```bash
nix flake update codex-desktop-linux
sudo nixos-rebuild switch --flake .#your-host
# or: home-manager switch --flake .#your-user
```

An unlocked `nix run github:ilysenko/codex-desktop-linux` follows the current
repository revision. A configuration with a lock file continues to use its
pinned revision until that input is updated.

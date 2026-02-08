{
  description = "Codex Desktop for Linux installer";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        codexDmg = pkgs.fetchurl {
          url = "https://persistent.oaistatic.com/codex-app-prod/Codex.dmg";
          hash = "sha256-dGgr8Av/1MArxkpIxT8c/Ui2fexgpnWHywJPuSq82PY=";
        };

        electronLibs = with pkgs; [
          glib
          gtk3
          pango
          cairo
          gdk-pixbuf
          atk
          at-spi2-atk
          at-spi2-core
          nss
          nspr
          dbus
          cups
          expat
          libdrm
          mesa
          libgbm
          alsa-lib
          libX11
          libXcomposite
          libXdamage
          libXext
          libXfixes
          libXrandr
          libxcb
          libxkbcommon
          xorg.libXcursor
          xorg.libXi
          xorg.libXtst
          xorg.libXScrnSaver
          libglvnd
          systemd
          wayland
        ];

        electronLibPath = pkgs.lib.makeLibraryPath electronLibs;

        installer = pkgs.writeShellApplication {
          name = "codex-desktop-installer";
          runtimeInputs = [
            pkgs.nodejs_20
            pkgs.python3
            pkgs.p7zip
            pkgs.curl
            pkgs.unzip
            pkgs.gnumake
            pkgs.gcc
            pkgs.patchelf
          ];
          text = ''
            set -euo pipefail

            root_dir="$(pwd)"
            workdir="$(mktemp -d)"
            cleanup() {
              rm -rf "$workdir"
            }
            trap cleanup EXIT

            cp ${./install.sh} "$workdir/install.sh"
            cp ${codexDmg} "$workdir/Codex.dmg"
            chmod +x "$workdir/install.sh"

            cd "$workdir"
            export CODEX_INSTALL_DIR="''${CODEX_INSTALL_DIR:-$root_dir/codex-app}"
            "$workdir/install.sh" "$workdir/Codex.dmg" "$@"

            install_dir="''${CODEX_INSTALL_DIR:-$root_dir/codex-app}"

            # Patch the Electron binary for NixOS
            if [ -f "$install_dir/electron" ]; then
              echo "[NIX] Patching Electron binary for NixOS..."
              patchelf --set-interpreter "$(cat ${pkgs.stdenv.cc}/nix-support/dynamic-linker)" \
                       --set-rpath "$install_dir:${electronLibPath}" \
                       "$install_dir/electron"

              # Also patch chrome_crashpad_handler if present
              if [ -f "$install_dir/chrome_crashpad_handler" ]; then
                patchelf --set-interpreter "$(cat ${pkgs.stdenv.cc}/nix-support/dynamic-linker)" \
                         "$install_dir/chrome_crashpad_handler" || true
              fi

              # Also patch chrome-sandbox if present
              if [ -f "$install_dir/chrome-sandbox" ]; then
                patchelf --set-interpreter "$(cat ${pkgs.stdenv.cc}/nix-support/dynamic-linker)" \
                         "$install_dir/chrome-sandbox" || true
              fi

              # Patch all .so files in the install dir
              find "$install_dir" -maxdepth 1 -name "*.so*" -type f | while read -r so; do
                patchelf --set-rpath "${electronLibPath}" "$so" 2>/dev/null || true
              done

              echo "[NIX] Electron patched successfully"
            fi
          '';
        };
      in
      {
        packages = {
          default = installer;
          installer = installer;
        };

        apps.default = {
          type = "app";
          program = "${installer}/bin/codex-desktop-installer";
        };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_20
            pkgs.python3
            pkgs.p7zip
            pkgs.curl
            pkgs.unzip
            pkgs.gnumake
            pkgs.gcc
          ];
        };
      }
    );
}

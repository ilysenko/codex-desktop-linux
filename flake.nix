{
  description = "codex-desktop built from OpenAI's official Linux package";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachSystem [ "x86_64-linux" "aarch64-linux" ] (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };
        lib = pkgs.lib;
        nixLinuxFeatures = import ./nix/linux-features.nix { inherit lib; };
        upstreamPins = builtins.fromJSON (builtins.readFile ./nix/upstream-linux-packages.json);
        codexVersion = upstreamPins.version;
        officialPackage = {
          x86_64-linux = {
            architecture = "amd64";
            url = "https://persistent.oaistatic.com/codex-app-prod/linux/deb/${upstreamPins.amd64.repositoryPath}";
            hash = upstreamPins.amd64.sri;
          };
          aarch64-linux = {
            architecture = "arm64";
            url = "https://persistent.oaistatic.com/codex-app-prod/linux/deb/${upstreamPins.arm64.repositoryPath}";
            hash = upstreamPins.arm64.sri;
          };
        }.${system};
        upstreamDeb = pkgs.fetchurl {
          inherit (officialPackage) url hash;
          name = "chatgpt_${codexVersion}_${officialPackage.architecture}.deb";
        };
        sourceRoot = lib.cleanSourceWith {
          src = ./.;
          filter = path: type:
            lib.cleanSourceFilter path type
            && !(lib.hasInfix "/.git/" (toString path))
            && !(lib.hasInfix "/target/" (toString path));
        };
        runtimeLibraries = with pkgs; [
          alsa-lib atk at-spi2-atk at-spi2-core cairo cups dbus expat
          gdk-pixbuf glib graphite2 gtk3 libdrm libgbm libglvnd libnotify libusb1
          libxkbcommon mesa nspr nss openssl pango systemd stdenv.cc.cc.lib wayland xz
          libX11 libXcomposite libXdamage libXext libXfixes libXrandr
          libxcb libxcrypt-legacy zlib
        ];
        runtimeLibraryPath = lib.makeLibraryPath runtimeLibraries;
        runtimePath = lib.makeBinPath (with pkgs; [
          bash coreutils findutils gnugrep gnused nodejs python3 systemd xdg-utils
        ]);
        emptyFeaturesConfig = pkgs.writeText "empty-features.json" ''{"enabled":[]}'';

        workspaceHelpers = pkgs.rustPlatform.buildRustPackage {
          pname = "codex-desktop-feature-helpers";
          version = "0.1.0";
          src = sourceRoot;
          cargoLock.lockFile = ./Cargo.lock;
          cargoBuildFlags = [
            "-p" "codex-computer-use-linux"
            "-p" "codex-read-aloud-linux"
            "-p" "codex-record-replay-linux"
          ];
          doCheck = false;
          installPhase = ''
            runHook preInstall
            mkdir -p "$out/bin"
            release="target/''${CARGO_BUILD_TARGET:-${pkgs.stdenv.hostPlatform.rust.rustcTarget}}/release"
            test -d "$release" || release=target/release
            for binary in codex-computer-use-linux codex-computer-use-cosmic codex-read-aloud-linux codex-record-replay-linux; do
              test ! -x "$release/$binary" || install -m0755 "$release/$binary" "$out/bin/$binary"
            done
            runHook postInstall
          '';
        };
        globalDictationHelper = pkgs.rustPlatform.buildRustPackage {
          pname = "codex-global-dictation-linux";
          version = "0.1.0";
          src = ./global-dictation-linux;
          cargoLock.lockFile = ./global-dictation-linux/Cargo.lock;
          doCheck = false;
        };
        mcpReaperHelper = pkgs.rustPlatform.buildRustPackage {
          pname = "codex-mcp-helper-reaper";
          version = "0.1.0";
          src = ./linux-features/mcp-helper-reaper/reaper;
          cargoLock.lockFile = ./linux-features/mcp-helper-reaper/reaper/Cargo.lock;
          doCheck = false;
        };
        mkCodexDesktop = {
          linuxFeatureIds ? [ ],
          enableComputerUseUi ? false,
        }:
          let
            normalizedFeatureIds = nixLinuxFeatures.normalize (
              linuxFeatureIds ++ lib.optional enableComputerUseUi "computer-use-linux"
            );
            featuresConfig = pkgs.writeText "codex-linux-features.json" (builtins.toJSON {
              enabled = normalizedFeatureIds;
            });
            suffix = if normalizedFeatureIds == [ ] then "" else "-${lib.concatStringsSep "-" normalizedFeatureIds}";
          in
          pkgs.stdenv.mkDerivation {
            pname = "codex-desktop${suffix}";
            version = codexVersion;
            src = sourceRoot;
            nativeBuildInputs = [
              pkgs.asar pkgs.bash pkgs.coreutils pkgs.curl pkgs.dpkg pkgs.gnupg
              pkgs.makeWrapper pkgs.nodejs pkgs.patchelf pkgs.python3 pkgs.util-linux
            ];
            dontConfigure = true;
            dontBuild = true;
            installPhase = ''
              runHook preInstall
              export HOME="$TMPDIR/home"
              mkdir -p "$HOME"
              source_dir="$TMPDIR/source"
              cp -R "$src" "$source_dir"
              chmod -R u+w "$source_dir"
              substituteInPlace "$source_dir/scripts/lib/asar-patch.sh" \
                --replace-fail "npx --yes @electron/asar" "${pkgs.asar}/bin/asar"
              export CODEX_INSTALL_TRANSACTION_ACTIVE=1
              export CODEX_INSTALL_DIR="$out/opt/codex-desktop"
              export CODEX_LINUX_FEATURES_CONFIG="${featuresConfig}"
              export CODEX_COMPUTER_USE_BINARY_SOURCE="${workspaceHelpers}/bin/codex-computer-use-linux"
              export CODEX_COMPUTER_USE_COSMIC_BINARY_SOURCE="${workspaceHelpers}/bin/codex-computer-use-cosmic"
              export CODEX_LINUX_READ_ALOUD_MCP_SOURCE="${workspaceHelpers}/bin/codex-read-aloud-linux"
              export CODEX_RECORD_REPLAY_LINUX_SOURCE="${workspaceHelpers}/bin/codex-record-replay-linux"
              export CODEX_GLOBAL_DICTATION_LINUX_SOURCE="${globalDictationHelper}/bin/codex-global-dictation-linux"
              export CODEX_MCP_HELPER_REAPER_SOURCE="${mcpReaperHelper}/bin/codex-mcp-helper-reaper"
              bash "$source_dir/install.sh" "${upstreamDeb}"

              app="$out/opt/codex-desktop"
              for executable in "$app/ChatGPT" "$app/chrome_crashpad_handler"; do
                test ! -f "$executable" || patchelf \
                  --set-interpreter "$(cat ${pkgs.stdenv.cc}/nix-support/dynamic-linker)" \
                  --add-rpath "${runtimeLibraryPath}" "$executable"
              done
              find "$app" -type f \( -name '*.so' -o -name '*.so.*' -o -name '*.node' \) -print0 | \
                while IFS= read -r -d "" library; do
                  patchelf --add-rpath "${runtimeLibraryPath}" "$library" 2>/dev/null || true
                done

              install -Dm0644 "$app/.codex-linux/codex-desktop.png" \
                "$out/share/icons/hicolor/256x256/apps/codex-desktop.png"
              install -Dm0644 "$source_dir/packaging/linux/codex-desktop.desktop" \
                "$out/share/applications/codex-desktop.desktop"
              substituteInPlace "$out/share/applications/codex-desktop.desktop" \
                --replace-fail "/usr/bin/codex-desktop" "$out/bin/codex-desktop" \
                --replace-fail "/usr/share/applications/codex-desktop.desktop" "$out/share/applications/codex-desktop.desktop"
              makeWrapper "$app/start.sh" "$out/bin/codex-desktop" \
                --prefix PATH : "${runtimePath}" \
                --prefix LD_LIBRARY_PATH : "${runtimeLibraryPath}" \
                --add-flags "\''${NIXOS_OZONE_WL:+\''${WAYLAND_DISPLAY:+--ozone-platform=wayland --enable-wayland-ime=true --wayland-text-input-version=3}}"
              runHook postInstall
            '';
            passthru = {
              inherit linuxFeatureIds upstreamDeb;
              upstreamVersion = codexVersion;
              upstreamArchitecture = officialPackage.architecture;
            };
            meta = {
              description = "Custom codex-desktop distribution based on OpenAI's official Linux package";
              homepage = "https://github.com/ilysenko/codex-desktop-linux";
              license = lib.licenses.unfree;
              platforms = [ "x86_64-linux" "aarch64-linux" ];
              mainProgram = "codex-desktop";
            };
          };

        codexDesktop = lib.makeOverridable mkCodexDesktop { };
        remoteMobile = codexDesktop.override { linuxFeatureIds = [ "remote-mobile-control" ]; };
        computerUse = codexDesktop.override { linuxFeatureIds = [ "computer-use-linux" ]; };
        installer = pkgs.writeShellApplication {
          name = "codex-desktop-installer";
          runtimeInputs = [ pkgs.bash pkgs.coreutils pkgs.curl pkgs.dpkg pkgs.gnupg pkgs.nodejs pkgs.python3 pkgs.util-linux ];
          text = ''
            export CODEX_LINUX_FEATURES_CONFIG="''${CODEX_LINUX_FEATURES_CONFIG:-${emptyFeaturesConfig}}"
            exec ${pkgs.bash}/bin/bash ${sourceRoot}/install.sh ${upstreamDeb} "$@"
          '';
        };
      in {
        packages = {
          default = codexDesktop;
          codex-desktop = codexDesktop;
          codex-desktop-computer-use-ui = computerUse;
          codex-desktop-remote-mobile-control = remoteMobile;
          codex-desktop-computer-use-ui-remote-mobile-control = codexDesktop.override {
            linuxFeatureIds = [ "computer-use-linux" "remote-mobile-control" ];
          };
          inherit installer;
        };
        apps.default = { type = "app"; program = "${codexDesktop}/bin/codex-desktop"; };
        apps.installer = { type = "app"; program = "${installer}/bin/codex-desktop-installer"; };
        checks.official-linux-package = pkgs.runCommand "official-linux-package-check" { nativeBuildInputs = [ pkgs.dpkg ]; } ''
          test "$(dpkg-deb -f ${upstreamDeb} Package)" = chatgpt
          test "$(dpkg-deb -f ${upstreamDeb} Architecture)" = ${officialPackage.architecture}
          touch "$out"
        '';
        devShells.default = pkgs.mkShell { packages = [ pkgs.nodejs pkgs.python3 pkgs.dpkg pkgs.gnupg ]; };
      }
    ) // {
      homeManagerModules = rec {
        default = import ./nix/home-manager-module.nix { inherit self; };
        codex-desktop-linux = default;
      };
      nixosModules = rec {
        default = import ./nix/nixos-module.nix { inherit self; };
        codex-desktop-linux = default;
      };
    };
}

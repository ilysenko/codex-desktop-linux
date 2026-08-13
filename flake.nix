{
  description = "codex-desktop built from OpenAI's official Linux package";

  nixConfig = {
    extra-substituters = [ "https://codex-desktop-linux.cachix.org" ];
    extra-trusted-public-keys = [
      "codex-desktop-linux.cachix.org-1:nX/xy6AdK9hQE24A8ALGjkCKj2ObFmcnemiL5Cid4nk="
    ];
  };

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
        officialRuntimePaths = {
          x86_64-linux = {
            sky = "resources/cua_node/lib/node_modules/@oai/sky/bin/linux/sky_linux_x64";
            extensionHost = "resources/plugins/openai-bundled/plugins/chrome/extension-host/linux/x64/extension-host";
          };
          aarch64-linux = {
            sky = "resources/cua_node/lib/node_modules/@oai/sky/bin/linux/sky_linux_arm64";
            extensionHost = "resources/plugins/openai-bundled/plugins/chrome/extension-host/linux/arm64/extension-host";
          };
        }.${system};
        upstreamDeb = pkgs.fetchurl {
          inherit (officialPackage) url hash;
          name = "chatgpt_${codexVersion}_${officialPackage.architecture}.deb";
        };
        flakeSourceCommit = self.rev or (self.dirtyRev or "");
        flakeSourceRemote = "https://github.com/ilysenko/codex-desktop-linux.git";
        flakeSourceDateEpoch = toString (self.lastModified or 1);
        sourceRoot = lib.cleanSourceWith {
          src = ./.;
          filter = path: type:
            lib.cleanSourceFilter path type
            && (let
              value = toString path;
              name = baseNameOf value;
            in
              !(lib.elem name [ ".codex" "target" ])
              && builtins.match "^codex-app($|[-.].*)" name == null
              && builtins.match "^dist($|[-.].*)" name == null
              && !(lib.hasInfix "/.git/" value)
              && !(lib.hasSuffix "/linux-features/features.json" value)
              && !(lib.hasInfix "/linux-features/local/" value)
              && !(lib.hasInfix "/codex-app.backup-" value)
              && !(lib.hasInfix "/.codex-app.candidate-" value)
              && !(lib.hasInfix "/.codex-app.nix-candidate-" value));
        };
        runtimeLibraries = with pkgs; [
          alsa-lib atk at-spi2-atk at-spi2-core cairo cups dbus expat
          gdk-pixbuf glib graphite2 gtk3 libdrm libgbm libglvnd libnotify libusb1
          libxkbcommon mesa nspr nss openssl pango pipewire systemd stdenv.cc.cc.lib
          wayland xz zstd libX11 libXcomposite libXcursor libXdamage libXext
          libXfixes libXi libXrandr libXScrnSaver libXtst libxcb libxcrypt-legacy zlib
        ];
        runtimeLibraryPath = lib.concatStringsSep ":" [
          "${pkgs.addDriverRunpath.driverLink}/lib"
          (lib.makeLibraryPath runtimeLibraries)
        ];
        baseRuntimePackages = with pkgs; [
          bash coreutils curl findutils gawk gnugrep gnused libnotify nodejs procps
          python3 systemd util-linux xdg-utils
        ];
        featureRuntimePackages = featureIds:
          lib.optionals (lib.elem "appshots" featureIds) [ pkgs.xinput pkgs.xmodmap ]
          ++ lib.optionals (lib.elem "global-dictation" featureIds) [
            pkgs.xdotool pkgs.xinput pkgs.xmodmap
          ]
          ++ lib.optionals (
            lib.elem "read-aloud" featureIds || lib.elem "read-aloud-mcp" featureIds
          ) [ pkgs.alsa-utils ]
          ++ lib.optionals (lib.elem "computer-use-linux" featureIds) [ pkgs.glib ];
        runtimePathFor = featureIds:
          lib.makeBinPath (lib.unique (
            baseRuntimePackages ++ featureRuntimePackages featureIds
          ));
        gsettingsSchemaPackages = with pkgs; [ gsettings-desktop-schemas gtk3 ];
        gsettingsSchemaRoot = package:
          lib.removeSuffix "/glib-2.0/schemas" (pkgs.glib.getSchemaPath package);
        gsettingsSchemaDataDirs =
          lib.concatMapStringsSep ":" gsettingsSchemaRoot gsettingsSchemaPackages;
        xdgDefaultDataDirs = "/usr/local/share:/usr/share";
        emptyFeaturesConfig = pkgs.writeText "empty-features.json" ''{"enabled":[]}'';
        helperWorkspaceSource = lib.cleanSourceWith {
          src = sourceRoot;
          filter = path: type:
            let
              relative = lib.removePrefix "${toString sourceRoot}/" (toString path);
              workspacePaths = [
                "computer-use-linux"
                "read-aloud-linux"
                "record-replay-linux"
                "updater"
              ];
            in
            relative == "Cargo.toml"
            || relative == "Cargo.lock"
            || lib.any (workspace: relative == workspace || lib.hasPrefix "${workspace}/" relative) workspacePaths;
        };

        mkWorkspaceHelpers = featureIds:
          let
            computerUseEnabled = lib.elem "computer-use-linux" featureIds;
            readAloudEnabled = lib.elem "read-aloud-mcp" featureIds;
            recordReplayEnabled = lib.elem "record-and-replay" featureIds;
            cargoPackages =
              lib.optionals computerUseEnabled [ "codex-computer-use-linux" ]
              ++ lib.optionals readAloudEnabled [ "codex-read-aloud-linux" ]
              ++ lib.optionals recordReplayEnabled [ "codex-record-replay-linux" ];
            expectedBinaries =
              lib.optionals computerUseEnabled [ "codex-computer-use-linux" "codex-computer-use-cosmic" ]
              ++ lib.optionals readAloudEnabled [ "codex-read-aloud-linux" ]
              ++ lib.optionals recordReplayEnabled [ "codex-record-replay-linux" ];
          in
          if cargoPackages == [ ] then null else pkgs.rustPlatform.buildRustPackage {
            pname = "codex-desktop-feature-helpers";
            version = "0.1.0";
            src = helperWorkspaceSource;
            cargoLock.lockFile = ./Cargo.lock;
            cargoBuildFlags = lib.concatMap (package: [ "-p" package ]) cargoPackages;
            doCheck = false;
            installPhase = ''
              runHook preInstall
              mkdir -p "$out/bin"
              release="target/''${CARGO_BUILD_TARGET:-${pkgs.stdenv.hostPlatform.rust.rustcTarget}}/release"
              test -d "$release" || release=target/release
              ${lib.concatMapStringsSep "\n" (binary: ''
                test -x "$release/${binary}"
                install -m0755 "$release/${binary}" "$out/bin/${binary}"
              '') expectedBinaries}
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
        watchboundArtifacts = builtins.fromJSON (
          builtins.readFile ./linux-features/directory-only-working-tree-watch/watchbound-artifacts.json
        );
        watchboundVersion = watchboundArtifacts.version;
        watchboundSourceArchive = pkgs.fetchurl {
          name = "watchbound-${watchboundArtifacts.source.revision}.tar.gz";
          inherit (watchboundArtifacts.source) url sha256;
        };
        watchboundWrapperArchive = pkgs.fetchurl {
          name = "watchbound-${watchboundVersion}.tgz";
          inherit (watchboundArtifacts.packages.wrapper) url sha256;
        };
        watchboundLoaderArchive = pkgs.fetchurl {
          name = "watchbound-node-${watchboundVersion}.tgz";
          inherit (watchboundArtifacts.packages.loader) url sha256;
        };
        watchboundSource = pkgs.runCommandLocal "watchbound-${watchboundVersion}-source" {
          nativeBuildInputs = [ pkgs.gnutar pkgs.gzip ];
        } ''
          mkdir -p "$out"
          tar -xzf ${watchboundSourceArchive} -C "$out" --strip-components=1
          chmod -R u+w "$out"
          for manifest in "$out/package.json" "$out/js/package.json" "$out/node/package.json"; do
            substituteInPlace "$manifest" \
              --replace-fail '"version": "0.0.0-development"' '"version": "${watchboundVersion}"'
          done
          substituteInPlace "$out/js/package.json" \
            --replace-fail '"@gadicc/watchbound-node": "workspace:0.0.0-development"' \
              '"@gadicc/watchbound-node": "workspace:${watchboundVersion}"'
          substituteInPlace "$out/Cargo.toml" \
            --replace-fail 'version = "0.0.0-development"' 'version = "${watchboundVersion}"'
          substituteInPlace "$out/Cargo.lock" \
            --replace-fail 'version = "0.0.0-development"' 'version = "${watchboundVersion}"'
          substituteInPlace "$out/pnpm-lock.yaml" \
            --replace-fail 'specifier: workspace:0.0.0-development' \
              'specifier: workspace:${watchboundVersion}'
        '';
        watchboundTarget = {
          x86_64-linux = {
            id = "linux-x64-gnu";
            rustTarget = "x86_64-unknown-linux-gnu";
            binary = "watchbound.linux-x64-gnu.node";
            electronArch = "x64";
          };
          aarch64-linux = {
            id = "linux-arm64-gnu";
            rustTarget = "aarch64-unknown-linux-gnu";
            binary = "watchbound.linux-arm64-gnu.node";
            electronArch = "arm64";
          };
        }.${system};
        watchboundNative = pkgs.rustPlatform.buildRustPackage {
          pname = "watchbound-native-${watchboundTarget.id}";
          version = watchboundVersion;
          src = watchboundSource;
          cargoLock.lockFile = ./nix/watchbound-Cargo.lock;
          cargoBuildFlags = [ "-p" "watchbound-node" ];
          doCheck = false;
          installPhase = ''
            runHook preInstall
            release="target/''${CARGO_BUILD_TARGET:-${watchboundTarget.rustTarget}}/release"
            test -f "$release/libwatchbound_node.so" || release=target/release
            test -f "$release/libwatchbound_node.so"
            install -Dm0555 "$release/libwatchbound_node.so" \
              "$out/lib/${watchboundTarget.binary}"
            runHook postInstall
          '';
        };
        watchboundPackage = pkgs.stdenv.mkDerivation {
          pname = "watchbound-node-package-${watchboundTarget.id}";
          version = watchboundVersion;
          src = watchboundSource;
          nativeBuildInputs = [ pkgs.gnutar pkgs.gzip pkgs.nodejs_24 ];
          dontConfigure = true;
          dontBuild = true;
          installPhase = ''
            runHook preInstall
            node scripts/generate-nix-package.mjs \
              --target ${watchboundTarget.id} \
              --artifact ${watchboundNative}/lib/${watchboundTarget.binary} \
              --output "$out"
            rm -rf \
              "$out/lib/node_modules/watchbound" \
              "$out/lib/node_modules/@gadicc/watchbound-node"
            mkdir -p \
              "$out/lib/node_modules/watchbound" \
              "$out/lib/node_modules/@gadicc/watchbound-node"
            tar -xzf ${watchboundWrapperArchive} \
              -C "$out/lib/node_modules/watchbound" --strip-components=1
            tar -xzf ${watchboundLoaderArchive} \
              -C "$out/lib/node_modules/@gadicc/watchbound-node" --strip-components=1
            # Apply the one explicit downstream compatibility delta for the
            # signed app's Node 24.14. The package verifier pins the adjusted
            # loader hash separately from the upstream artifact manifest, and
            # the maximal check exercises its lifecycle with that CUA runtime.
            substituteInPlace \
              "$out/lib/node_modules/@gadicc/watchbound-node/native-matrix.json" \
              --replace-fail '"nodeRange": ">=24.15.0 <25"' '"nodeRange": ">=24.14.0 <25"' \
              --replace-fail '"nodeMinimum": "24.15.0"' '"nodeMinimum": "24.14.0"'
            grep -q '"nodeMinimum": "24.14.0"' \
              "$out/lib/node_modules/@gadicc/watchbound-node/native-matrix.json"
            CODEX_WATCHBOUND_NIX_NODE_24_14=1 \
              node ${sourceRoot}/linux-features/directory-only-working-tree-watch/watchbound-package.js \
              --verify-controlled-package-root "$out/lib/node_modules" ${watchboundTarget.electronArch}
            runHook postInstall
          '';
        };
        mkCodexDesktop = {
          linuxFeatureIds ? [ ],
          enableComputerUseUi ? false,
        }:
          let
            normalizedFeatureIds = nixLinuxFeatures.normalize (
              linuxFeatureIds ++ lib.optional enableComputerUseUi "computer-use-linux"
            );
            workspaceHelpers = mkWorkspaceHelpers normalizedFeatureIds;
            watchboundEnabled = lib.elem "directory-only-working-tree-watch" normalizedFeatureIds;
            codexMicroEnabled = lib.elem "codex-micro" normalizedFeatureIds;
            featuresConfig = pkgs.writeText "codex-linux-features.json" (builtins.toJSON {
              enabled = normalizedFeatureIds;
            });
            suffix = if normalizedFeatureIds == [ ] then "" else "-${lib.concatStringsSep "-" normalizedFeatureIds}";
          in
          pkgs.stdenv.mkDerivation {
            pname = "codex-desktop${suffix}";
            version = codexVersion;
            src = sourceRoot;
            # This derivation's fail-closed audit owns ELF interpreters and
            # RUNPATHs. Generic fixups would shrink them again and cannot
            # safely strip the current amd64 Tectonic payload.
            dontPatchELF = true;
            dontStrip = true;
            dontFixup = true;
            nativeBuildInputs = [
              pkgs.asar pkgs.bash pkgs.coreutils pkgs.curl pkgs.dpkg pkgs.gnupg
              pkgs.makeWrapper pkgs.nodejs pkgs.patchelf pkgs.python3 pkgs.util-linux
            ];
            dontConfigure = true;
            dontBuild = true;
            installPhase = ''
              runHook preInstall
              export HOME="$TMPDIR/home"
              export SOURCE_DATE_EPOCH="${flakeSourceDateEpoch}"
              mkdir -p "$HOME"
              source_dir="$TMPDIR/source"
              cp -R "$src" "$source_dir"
              chmod -R u+w "$source_dir"
              upstream_contract_root="$TMPDIR/upstream-contract"
              mkdir -p "$upstream_contract_root"
              dpkg-deb -x ${upstreamDeb} "$upstream_contract_root"
              node "$source_dir/nix/elf-runtime.cjs" validate-upstream \
                --root "$upstream_contract_root/usr/lib/chatgpt" \
                --arch ${officialPackage.architecture}
              substituteInPlace "$source_dir/scripts/lib/asar-patch.sh" \
                --replace-fail "npx --yes @electron/asar" "${pkgs.asar}/bin/asar"
              export CODEX_INSTALL_TRANSACTION_ACTIVE=1
              export CODEX_INSTALL_DIR="$out/opt/codex-desktop"
              export CODEX_LINUX_FEATURES_CONFIG="${featuresConfig}"
              ${lib.optionalString (flakeSourceCommit != "") ''
              export CODEX_LINUX_SOURCE_COMMIT="${flakeSourceCommit}"
              export CODEX_LINUX_SOURCE_REMOTE="${flakeSourceRemote}"
              ''}
              ${lib.optionalString (lib.elem "computer-use-linux" normalizedFeatureIds) ''
              export CODEX_COMPUTER_USE_BINARY_SOURCE="${workspaceHelpers}/bin/codex-computer-use-linux"
              export CODEX_COMPUTER_USE_COSMIC_BINARY_SOURCE="${workspaceHelpers}/bin/codex-computer-use-cosmic"
              ''}
              ${lib.optionalString (lib.elem "read-aloud-mcp" normalizedFeatureIds) ''
              export CODEX_LINUX_READ_ALOUD_MCP_SOURCE="${workspaceHelpers}/bin/codex-read-aloud-linux"
              ''}
              ${lib.optionalString (lib.elem "record-and-replay" normalizedFeatureIds) ''
              export CODEX_RECORD_REPLAY_LINUX_SOURCE="${workspaceHelpers}/bin/codex-record-replay-linux"
              ''}
              ${lib.optionalString (lib.elem "global-dictation" normalizedFeatureIds) ''
              export CODEX_GLOBAL_DICTATION_LINUX_SOURCE="${globalDictationHelper}/bin/codex-global-dictation-linux"
              ''}
              ${lib.optionalString (lib.elem "mcp-helper-reaper" normalizedFeatureIds) ''
              export CODEX_MCP_HELPER_REAPER_SOURCE="${mcpReaperHelper}/bin/codex-mcp-helper-reaper"
              ''}
              ${lib.optionalString watchboundEnabled ''
              export CODEX_WATCHBOUND_PACKAGE_ROOT="${watchboundPackage}/lib/node_modules"
              export CODEX_WATCHBOUND_NIX_NODE_24_14=1
              ''}
              bash "$source_dir/install.sh" "${upstreamDeb}"

              app="$out/opt/codex-desktop"
              dynamic_linker="$(cat ${pkgs.stdenv.cc}/nix-support/dynamic-linker)"
              node "$source_dir/nix/elf-runtime.cjs" fix \
                --root "$app" \
                --arch ${officialPackage.architecture} \
                --dynamic-linker "$dynamic_linker" \
                --runtime-library-path "${runtimeLibraryPath}" \
                --patchelf "${pkgs.patchelf}/bin/patchelf" \
                --chatgpt-relocator "$source_dir/nix/relocate-elf-interpreter.cjs" \
                --shell "${pkgs.bash}/bin/bash"
              patchShebangs --build "$app"

              install -Dm0644 "$app/.codex-linux/codex-desktop.png" \
                "$out/share/icons/hicolor/256x256/apps/codex-desktop.png"
              ${lib.optionalString codexMicroEnabled ''
              install -Dm0644 \
                "$source_dir/linux-features/codex-micro/resources/70-codex-micro.rules" \
                "$out/lib/udev/rules.d/70-codex-micro.rules"
              ''}
              mkdir -p "$out/share/applications"
              awk '
                /^\[Desktop Action CheckForUpdates\]$/ { skip = 1; next }
                /^\[Desktop Action InstallReadyUpdate\]$/ { skip = 1; next }
                /^\[/ { skip = 0 }
                skip { next }
                /^Actions=/ { print "Actions=new-window;"; next }
                { print }
              ' "$source_dir/packaging/linux/codex-desktop.desktop" \
                > "$out/share/applications/codex-desktop.desktop"
              substituteInPlace "$out/share/applications/codex-desktop.desktop" \
                --replace-fail "/usr/bin/codex-desktop" "$out/bin/codex-desktop" \
                --replace-fail "/usr/share/applications/codex-desktop.desktop" "$out/share/applications/codex-desktop.desktop"
              makeWrapper "$app/start.sh" "$out/bin/codex-desktop" \
                --prefix PATH : "${runtimePathFor normalizedFeatureIds}" \
                --set-default ALSA_PLUGIN_DIR "${pkgs.pipewire}/lib/alsa-lib" \
                --run 'export XDG_DATA_DIRS="''${XDG_DATA_DIRS:-${xdgDefaultDataDirs}}"' \
                --prefix XDG_DATA_DIRS : "${gsettingsSchemaDataDirs}" \
                --set-default BAMF_DESKTOP_FILE_HINT "$out/share/applications/codex-desktop.desktop" \
                --set-default CODEX_CLI_PATH "$app/resources/codex" \
                --add-flags "\''${NIXOS_OZONE_WL:+\''${WAYLAND_DISPLAY:+--ozone-platform=wayland --enable-wayland-ime=true --wayland-text-input-version=3}}"
              node "$source_dir/nix/elf-runtime.cjs" audit \
                --root "$app" \
                --arch ${officialPackage.architecture} \
                --dynamic-linker "$dynamic_linker" \
                --runtime-library-path "${runtimeLibraryPath}" \
                --patchelf "${pkgs.patchelf}/bin/patchelf"
              node "$source_dir/nix/relocate-elf-interpreter.cjs" check \
                "$app/ChatGPT" "$dynamic_linker"
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
        maximalDirectoryFeatureIds = lib.filter (
          featureId: featureId != "shallow-repository-watches"
        ) nixLinuxFeatures.supportedFeatureIds;
        maximalShallowFeatureIds = lib.filter (
          featureId: featureId != "directory-only-working-tree-watch"
        ) nixLinuxFeatures.supportedFeatureIds;
        maximalDirectory = codexDesktop.override {
          linuxFeatureIds = maximalDirectoryFeatureIds;
        };
        maximalShallow = codexDesktop.override {
          linuxFeatureIds = maximalShallowFeatureIds;
        };
        installedLauncher = pkgs.writeShellScript "codex-desktop-installed-launcher" ''
          set -euo pipefail
          app_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
          export PATH="${runtimePathFor nixLinuxFeatures.supportedFeatureIds}''${PATH:+:$PATH}"
          if [[ ! -v ALSA_PLUGIN_DIR ]]; then
            export ALSA_PLUGIN_DIR="${pkgs.pipewire}/lib/alsa-lib"
          fi
          export XDG_DATA_DIRS="${gsettingsSchemaDataDirs}:''${XDG_DATA_DIRS:-${xdgDefaultDataDirs}}"
          export CODEX_CLI_PATH="''${CODEX_CLI_PATH:-$app_dir/resources/codex}"
          export BAMF_DESKTOP_FILE_HINT="''${BAMF_DESKTOP_FILE_HINT:-$app_dir/.codex-linux/codex-desktop.desktop}"
          extra_flags=()
          if [[ -n "''${NIXOS_OZONE_WL-}" && -n "''${WAYLAND_DISPLAY-}" ]]; then
            extra_flags+=(
              --ozone-platform=wayland
              --enable-wayland-ime=true
              --wayland-text-input-version=3
            )
          fi
          exec "$app_dir/.start.sh-nix" "$@" "''${extra_flags[@]}"
        '';
        installerWorkspaceHelpers = mkWorkspaceHelpers maximalDirectoryFeatureIds;
        installerRuntimeClosure = pkgs.writeText "codex-desktop-installer-runtime-closure" (
          lib.concatMapStringsSep "\n" toString (
            [
              sourceRoot upstreamDeb installedLauncher installerWorkspaceHelpers
              globalDictationHelper mcpReaperHelper watchboundPackage
              pkgs.stdenv pkgs.stdenv.cc pkgs.bash pkgs.nodejs pkgs.patchelf
            ]
            ++ runtimeLibraries
            ++ baseRuntimePackages
            ++ featureRuntimePackages nixLinuxFeatures.supportedFeatureIds
          )
        );
        installer = pkgs.writeShellApplication {
          name = "codex-desktop-installer";
          runtimeInputs = baseRuntimePackages ++ [
            pkgs.dpkg pkgs.gnupg pkgs.makeWrapper pkgs.nix pkgs.patchelf
          ] ++ featureRuntimePackages nixLinuxFeatures.supportedFeatureIds;
          text = ''
            set -euo pipefail
            info() { printf '[INFO] %s\n' "$*" >&2; }
            warn() { printf '[WARN] %s\n' "$*" >&2; }
            error() { printf '[ERROR] %s\n' "$*" >&2; exit 1; }
            # shellcheck disable=SC1091
            source ${sourceRoot}/scripts/lib/process-detection.sh
            # shellcheck disable=SC1091
            source ${sourceRoot}/scripts/lib/candidate-install.sh
            export CODEX_LINUX_FEATURES_CONFIG="''${CODEX_LINUX_FEATURES_CONFIG:-${emptyFeaturesConfig}}"
            final_dir="''${CODEX_INSTALL_DIR:-$PWD/codex-app}"
            parent="$(dirname "$final_dir")"
            name="$(basename "$final_dir")"
            candidate="$parent/.$name.nix-candidate-$$"
            runtime_root="$parent/.$name.nix-runtime"
            cleanup() {
              if [ -d "$candidate" ] && [ ! -L "$candidate" ]; then
                chmod -R u+w "$candidate" 2>/dev/null || true
                rm -rf -- "$candidate"
              fi
            }
            trap cleanup EXIT
            test "$candidate" != "$final_dir"
            mkdir -p "$parent"
            recover_pending_candidate_promotion "$final_dir"

            export CODEX_INSTALL_TRANSACTION_ACTIVE=1
            export CODEX_INSTALL_DIR="$candidate"
            export SOURCE_DATE_EPOCH="${flakeSourceDateEpoch}"
            ${lib.optionalString (flakeSourceCommit != "") ''
            export CODEX_LINUX_SOURCE_COMMIT="${flakeSourceCommit}"
            export CODEX_LINUX_SOURCE_REMOTE="${flakeSourceRemote}"
            ''}
            all_helpers=${installerWorkspaceHelpers}
            export CODEX_COMPUTER_USE_BINARY_SOURCE="$all_helpers/bin/codex-computer-use-linux"
            export CODEX_COMPUTER_USE_COSMIC_BINARY_SOURCE="$all_helpers/bin/codex-computer-use-cosmic"
            export CODEX_LINUX_READ_ALOUD_MCP_SOURCE="$all_helpers/bin/codex-read-aloud-linux"
            export CODEX_RECORD_REPLAY_LINUX_SOURCE="$all_helpers/bin/codex-record-replay-linux"
            export CODEX_GLOBAL_DICTATION_LINUX_SOURCE="${globalDictationHelper}/bin/codex-global-dictation-linux"
            export CODEX_MCP_HELPER_REAPER_SOURCE="${mcpReaperHelper}/bin/codex-mcp-helper-reaper"
            export CODEX_WATCHBOUND_PACKAGE_ROOT="${watchboundPackage}/lib/node_modules"
            export CODEX_WATCHBOUND_NIX_NODE_24_14=1
            upstream_contract_root="$(mktemp -d)"
            dpkg-deb -x ${upstreamDeb} "$upstream_contract_root"
            node ${sourceRoot}/nix/elf-runtime.cjs validate-upstream \
              --root "$upstream_contract_root/usr/lib/chatgpt" \
              --arch ${officialPackage.architecture}
            rm -rf -- "$upstream_contract_root"
            ${pkgs.bash}/bin/bash ${sourceRoot}/install.sh ${upstreamDeb} "$@"

            dynamic_linker="$(cat ${pkgs.stdenv.cc}/nix-support/dynamic-linker)"
            node ${sourceRoot}/nix/elf-runtime.cjs fix \
              --root "$candidate" \
              --arch ${officialPackage.architecture} \
              --dynamic-linker "$dynamic_linker" \
              --runtime-library-path "${runtimeLibraryPath}" \
              --patchelf "${pkgs.patchelf}/bin/patchelf" \
              --chatgpt-relocator ${sourceRoot}/nix/relocate-elf-interpreter.cjs \
              --shell "${pkgs.bash}/bin/bash"
            (
              # patchShebangs is a stdenv setup function, not a standalone
              # executable. Source it in an isolated subshell so the public
              # installer applies the same audited script fixup as the package.
              # shellcheck disable=SC1091
              source ${pkgs.stdenv}/setup
              patchShebangs --build "$candidate"
            )
            mv "$candidate/start.sh" "$candidate/.start.sh-nix"
            install -m0755 ${installedLauncher} "$candidate/start.sh"
            node ${sourceRoot}/nix/elf-runtime.cjs audit \
              --root "$candidate" \
              --arch ${officialPackage.architecture} \
              --dynamic-linker "$dynamic_linker" \
              --runtime-library-path "${runtimeLibraryPath}" \
              --patchelf "${pkgs.patchelf}/bin/patchelf"
            node ${sourceRoot}/nix/relocate-elf-interpreter.cjs check \
              "$candidate/ChatGPT" "$dynamic_linker"

            if [ "''${CODEX_NIX_SKIP_GC_ROOT:-0}" != 1 ]; then
              nix-store --add-root "$runtime_root" --indirect \
                -r ${installerRuntimeClosure} >/dev/null
              test "$(readlink -f "$runtime_root")" = "${installerRuntimeClosure}"
            fi
            promote_candidate_install "$candidate" "$final_dir"
            trap - EXIT
            printf 'Installed Nix-compatible app: %s\n' "$final_dir"
            if [ -n "''${PROMOTED_BACKUP_APP_DIR:-}" ]; then
              printf 'Previous app backup: %s\n' "$PROMOTED_BACKUP_APP_DIR"
            fi
          '';
        };
        wrapperEnvironmentProbe = pkgs.writeText "codex-nix-wrapper-environment-probe" ''
          case "$0" in
            */opt/codex-desktop/start.sh)
              {
                printf 'alsa=%s:%s\n' "''${ALSA_PLUGIN_DIR+x}" "''${ALSA_PLUGIN_DIR-}"
                printf 'xdg=%s:%s\n' "''${XDG_DATA_DIRS+x}" "''${XDG_DATA_DIRS-}"
                printf 'path=%s\n' "$PATH"
                printf 'ld=%s:%s\n' "''${LD_LIBRARY_PATH+x}" "''${LD_LIBRARY_PATH-}"
                printf 'bamf=%s\n' "''${BAMF_DESKTOP_FILE_HINT-}"
                printf 'args='
                printf '<%s>' "$@"
                printf '\n'
              } > "$CODEX_NIX_ENV_CAPTURE"
              exit 0
              ;;
          esac
        '';
        mkWrapperContractCheck = package: pkgs.writeShellScript "codex-nix-wrapper-contract" ''
          set -euo pipefail
          capture="$(${pkgs.coreutils}/bin/mktemp)"
          trap '${pkgs.coreutils}/bin/rm -f "$capture"' EXIT
          ${pkgs.coreutils}/bin/env -u ALSA_PLUGIN_DIR -u XDG_DATA_DIRS -u LD_LIBRARY_PATH \
            -u NIXOS_OZONE_WL -u WAYLAND_DISPLAY \
            BASH_ENV=${wrapperEnvironmentProbe} CODEX_NIX_ENV_CAPTURE="$capture" \
            ${package}/bin/codex-desktop --diagnose
          ${pkgs.gnugrep}/bin/grep -Fx 'alsa=x:${pkgs.pipewire}/lib/alsa-lib' "$capture"
          ${pkgs.gnugrep}/bin/grep -Fx 'xdg=x:${gsettingsSchemaDataDirs}:${xdgDefaultDataDirs}' "$capture"
          ${pkgs.gnugrep}/bin/grep -Fx 'ld=:' "$capture"
          ${pkgs.gnugrep}/bin/grep -Fx 'bamf=${package}/share/applications/codex-desktop.desktop' "$capture"
          ${pkgs.gnugrep}/bin/grep -Fx 'args=<--diagnose>' "$capture"
          ${pkgs.coreutils}/bin/env -u WAYLAND_DISPLAY NIXOS_OZONE_WL=1 \
            BASH_ENV=${wrapperEnvironmentProbe} CODEX_NIX_ENV_CAPTURE="$capture" \
            ${package}/bin/codex-desktop --diagnose
          ${pkgs.gnugrep}/bin/grep -Fx 'args=<--diagnose>' "$capture"
          ${pkgs.coreutils}/bin/env -u NIXOS_OZONE_WL WAYLAND_DISPLAY=wayland-1 \
            BASH_ENV=${wrapperEnvironmentProbe} CODEX_NIX_ENV_CAPTURE="$capture" \
            ${package}/bin/codex-desktop --diagnose
          ${pkgs.gnugrep}/bin/grep -Fx 'args=<--diagnose>' "$capture"
          ${pkgs.coreutils}/bin/env ALSA_PLUGIN_DIR= XDG_DATA_DIRS= LD_LIBRARY_PATH=/caller/lib \
            PATH=/caller/bin NIXOS_OZONE_WL=1 WAYLAND_DISPLAY=wayland-1 \
            BASH_ENV=${wrapperEnvironmentProbe} CODEX_NIX_ENV_CAPTURE="$capture" \
            ${package}/bin/codex-desktop --diagnose
          ${pkgs.gnugrep}/bin/grep -Fx 'alsa=x:' "$capture"
          ${pkgs.gnugrep}/bin/grep -Fx 'xdg=x:${gsettingsSchemaDataDirs}:${xdgDefaultDataDirs}' "$capture"
          ${pkgs.gnugrep}/bin/grep -Fx 'path=${runtimePathFor package.passthru.linuxFeatureIds}:/caller/bin' "$capture"
          ${pkgs.gnugrep}/bin/grep -Fx 'ld=x:/caller/lib' "$capture"
          ${pkgs.gnugrep}/bin/grep -Fx \
            'args=<--ozone-platform=wayland><--enable-wayland-ime=true><--wayland-text-input-version=3><--diagnose>' \
            "$capture"
          ${pkgs.coreutils}/bin/env ALSA_PLUGIN_DIR=/caller/alsa XDG_DATA_DIRS=/caller/share \
            BAMF_DESKTOP_FILE_HINT=/caller/desktop LD_LIBRARY_PATH= \
            BASH_ENV=${wrapperEnvironmentProbe} CODEX_NIX_ENV_CAPTURE="$capture" \
            ${package}/bin/codex-desktop --diagnose
          ${pkgs.gnugrep}/bin/grep -Fx 'alsa=x:/caller/alsa' "$capture"
          ${pkgs.gnugrep}/bin/grep -Fx 'xdg=x:${gsettingsSchemaDataDirs}:/caller/share' "$capture"
          ${pkgs.gnugrep}/bin/grep -Fx 'ld=x:' "$capture"
          ${pkgs.gnugrep}/bin/grep -Fx 'bamf=/caller/desktop' "$capture"
        '';
        mkRuntimeCheck = name: package: verifyCleanAsar: verifyWatchbound:
          pkgs.runCommand name {
            nativeBuildInputs = [ pkgs.coreutils pkgs.dpkg pkgs.nodejs pkgs.patchelf ];
          } ''
            set -euo pipefail
            app=${package}/opt/codex-desktop
            dynamic_linker="$(cat ${pkgs.stdenv.cc}/nix-support/dynamic-linker)"
            node ${sourceRoot}/nix/elf-runtime.cjs audit \
              --root "$app" \
              --arch ${officialPackage.architecture} \
              --dynamic-linker "$dynamic_linker" \
              --runtime-library-path "${runtimeLibraryPath}" \
              --patchelf ${pkgs.patchelf}/bin/patchelf
            ${mkWrapperContractCheck package}
            "$app/start.sh" --diagnose
            timeout 10 "$app/browser_crashpad_handler" --version
            "$app/resources/cua_node/bin/node" --version
            NODE_PATH="$app/resources/cua_node/lib/node_modules" \
              timeout 20 "$app/resources/cua_node/bin/node" -e \
                "require('sharp'); require('@napi-rs/canvas')"
            timeout 10 "$app/${officialRuntimePaths.sky}" --help >/dev/null
            timeout 10 "$app/${officialRuntimePaths.extensionHost}" --help >/dev/null
            "$app/resources/rg" --version
            ${lib.optionalString (system == "x86_64-linux") ''
            set +e
            timeout 2 "$app/resources/plugins/openai-bundled/plugins/latex/bin/tectonic" \
              --version >/dev/null 2>&1
            tectonic_status=$?
            set -e
            test "$tectonic_status" = 124
            ''}
            ${lib.optionalString verifyWatchbound ''
            WATCHBOUND_ROOT=${watchboundPackage}/lib/node_modules \
              timeout 20 "$app/resources/cua_node/bin/node" --input-type=module <<'NODE'
            import fs from "node:fs";
            import os from "node:os";
            import path from "node:path";
            import { pathToFileURL } from "node:url";
            const root = fs.mkdtempSync(path.join(os.tmpdir(), "watchbound-smoke-"));
            const module = await import(pathToFileURL(`''${process.env.WATCHBOUND_ROOT}/watchbound/index.js`));
            const qualification = module.qualifyRoot(root);
            if (qualification.target?.state !== "qualified") {
              throw new Error(JSON.stringify(qualification));
            }
            let changed;
            const observed = new Promise((resolve) => { changed = resolve; });
            const subscription = await module.subscribe(root, (batch) => changed(batch));
            fs.writeFileSync(path.join(root, "changed"), "ok");
            await Promise.race([
              observed,
              new Promise((_, reject) => setTimeout(() => reject(new Error("watch timeout")), 5000)),
            ]);
            await subscription.dispose();
            fs.rmSync(root, { recursive: true, force: true });
            NODE
            ''}
            ${lib.optionalString verifyCleanAsar ''
            upstream_root="$(mktemp -d)"
            dpkg-deb -x ${upstreamDeb} "$upstream_root"
            cmp "$upstream_root/usr/lib/chatgpt/resources/app.asar" "$app/resources/app.asar"
            ''}
            test -x ${pkgs.pipewire}/lib/alsa-lib/libasound_module_pcm_pipewire.so
            ! grep -q 'LD_LIBRARY_PATH=' ${package}/bin/codex-desktop
            ! grep -q '/usr/bin/' ${package}/share/applications/codex-desktop.desktop
            ! grep -q 'CheckForUpdates\|InstallReadyUpdate' \
              ${package}/share/applications/codex-desktop.desktop
            mkdir -p "$out"
            ln -s ${package} "$out/package"
          '';
        vmSmokeScript = pkgs.writeShellScript "codex-desktop-vm-smoke" ''
          set -euo pipefail
          export HOME="$(mktemp -d)"
          export XDG_CONFIG_HOME="$HOME/.config"
          export XDG_STATE_HOME="$HOME/.local/state"
          export XDG_CACHE_HOME="$HOME/.cache"
          export DISPLAY=:99
          mkdir -p "$XDG_CONFIG_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"
          ${mkWrapperContractCheck codexDesktop}
          ${pkgs.xvfb}/bin/Xvfb "$DISPLAY" -screen 0 1280x800x24 >"$HOME/xvfb.log" 2>&1 &
          xvfb_pid=$!
          trap 'kill "$xvfb_pid" 2>/dev/null || true' EXIT
          for _ in $(seq 1 50); do
            [ -S /tmp/.X11-unix/X99 ] && break
            sleep 0.1
          done
          [ -S /tmp/.X11-unix/X99 ]
          ${pkgs.dbus}/bin/dbus-run-session -- ${pkgs.bash}/bin/bash -c '
            set -euo pipefail
            log="$HOME/electron.log"
            ${codexDesktop}/bin/codex-desktop --no-sandbox >"$log" 2>&1 &
            pid=$!
            sleep 10
            if ! kill -0 "$pid" 2>/dev/null; then
              cat "$log" >&2
              exit 1
            fi
            kill "$pid"
            wait "$pid" 2>/dev/null || true
            if grep -Eqi "stub-ld|Could not start dynamically linked executable|Trace/breakpoint trap|SIGILL|libGL[^ ]*:.*not found|error while loading shared libraries" "$log"; then
              cat "$log" >&2
              exit 1
            fi
          '
          timeout 10 ${codexDesktop}/opt/codex-desktop/browser_crashpad_handler --version
          # TCG can make the larger helpers miss this deadline. A timeout still
          # proves that the Nix loader started the process; loader/SIGILL exits
          # remain fatal.
          set +e
          timeout 10 ${codexDesktop}/opt/codex-desktop/${officialRuntimePaths.sky} --help >/dev/null
          sky_status=$?
          timeout 10 ${codexDesktop}/opt/codex-desktop/${officialRuntimePaths.extensionHost} --help >/dev/null
          extension_status=$?
          set -e
          test "$sky_status" = 0 -o "$sky_status" = 124
          test "$extension_status" = 0 -o "$extension_status" = 124
        '';
      in {
        packages = {
          default = codexDesktop;
          codex-desktop = codexDesktop;
          codex-desktop-computer-use-ui = computerUse;
          codex-desktop-remote-mobile-control = remoteMobile;
          codex-desktop-computer-use-ui-remote-mobile-control = codexDesktop.override {
            linuxFeatureIds = [ "computer-use-linux" "remote-mobile-control" ];
          };
          codex-desktop-maximal-directory-watch = maximalDirectory;
          codex-desktop-maximal-shallow-watch = maximalShallow;
          inherit installer;
        };
        apps = {
          default = { type = "app"; program = "${codexDesktop}/bin/codex-desktop"; };
          codex-desktop = { type = "app"; program = "${codexDesktop}/bin/codex-desktop"; };
          codex-desktop-computer-use-ui = { type = "app"; program = "${computerUse}/bin/codex-desktop"; };
          codex-desktop-remote-mobile-control = { type = "app"; program = "${remoteMobile}/bin/codex-desktop"; };
          codex-desktop-computer-use-ui-remote-mobile-control = {
            type = "app";
            program = "${codexDesktop.override {
              linuxFeatureIds = [ "computer-use-linux" "remote-mobile-control" ];
            }}/bin/codex-desktop";
          };
          installer = { type = "app"; program = "${installer}/bin/codex-desktop-installer"; };
        };
        checks.official-linux-package = pkgs.runCommand "official-linux-package-check" { nativeBuildInputs = [ pkgs.dpkg ]; } ''
          test "$(dpkg-deb -f ${upstreamDeb} Package)" = chatgpt
          test "$(dpkg-deb -f ${upstreamDeb} Architecture)" = ${officialPackage.architecture}
          touch "$out"
        '';
        checks.modules = import ./nix/modules-test.nix { inherit pkgs self system; };
        checks.nix-runtime = mkRuntimeCheck "nix-runtime-check" codexDesktop true false;
        checks.nix-runtime-maximal-directory-watch =
          mkRuntimeCheck "nix-runtime-maximal-directory-watch" maximalDirectory false true;
        checks.nix-runtime-maximal-shallow-watch =
          mkRuntimeCheck "nix-runtime-maximal-shallow-watch" maximalShallow false false;
        checks.nix-installer = pkgs.runCommand "nix-installer-check" {
          nativeBuildInputs = [ installer pkgs.nodejs pkgs.patchelf ];
        } ''
          set -euo pipefail
          export CODEX_INSTALL_DIR="$TMPDIR/installed"
          export CODEX_NIX_SKIP_GC_ROOT=1
          ${installer}/bin/codex-desktop-installer
          dynamic_linker="$(cat ${pkgs.stdenv.cc}/nix-support/dynamic-linker)"
          node ${sourceRoot}/nix/elf-runtime.cjs audit \
            --root "$CODEX_INSTALL_DIR" \
            --arch ${officialPackage.architecture} \
            --dynamic-linker "$dynamic_linker" \
            --runtime-library-path "${runtimeLibraryPath}" \
            --patchelf ${pkgs.patchelf}/bin/patchelf
          "$CODEX_INSTALL_DIR/start.sh" --diagnose
          if [ ${officialPackage.architecture} = amd64 ]; then
            set +e
            timeout 2 "$CODEX_INSTALL_DIR/resources/plugins/openai-bundled/plugins/latex/bin/tectonic" \
              --version >/dev/null 2>&1
            tectonic_status=$?
            set -e
            test "$tectonic_status" = 124
          fi
          first_chatgpt="$(stat -c %i "$CODEX_INSTALL_DIR/ChatGPT")"
          ${installer}/bin/codex-desktop-installer
          test "$(stat -c %i "$CODEX_INSTALL_DIR/ChatGPT")" != "$first_chatgpt"
          test -n "$(find "$TMPDIR" -maxdepth 1 -type d -name 'installed.backup-*' -print -quit)"
          grep -q 'nix-store --add-root' ${installer}/bin/codex-desktop-installer
          mkdir -p "$out"
        '';
        checks.nixos-vm = if system == "x86_64-linux" then
          pkgs.testers.runNixOSTest {
            name = "codex-desktop-nixos-smoke";
            nodes.machine = { pkgs, ... }: {
              imports = [ self.nixosModules.default ];
              programs.codexDesktopLinux = {
                enable = true;
                package = codexDesktop;
                remoteControl = {
                  enable = true;
                  target = "never.target";
                  environment = { CODEX_NIX_VM = true; NULL_VALUE = null; };
                };
              };
              users.users.tester = {
                isNormalUser = true;
                uid = 1000;
              };
              services.dbus.enable = true;
              environment.systemPackages = [ pkgs.xvfb pkgs.dbus ];
            };
            testScript = ''
              machine.wait_for_unit("multi-user.target")
              machine.succeed("codex-desktop --diagnose")
              machine.succeed("test -f /etc/systemd/user/codex-remote-control.service")
              machine.succeed("grep -q 'CODEX_NIX_VM=true' /etc/systemd/user/codex-remote-control.service")
              machine.succeed("grep -q 'After=network.target' /etc/systemd/user/codex-remote-control.service")
              machine.succeed("grep -q 'CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED' /etc/set-environment")
              machine.succeed("su - tester -c ${lib.escapeShellArg (toString vmSmokeScript)}")
              machine.succeed("! grep -R 'Could not start dynamically linked executable' /var/log")
            '';
          }
        else pkgs.runCommand "codex-desktop-nixos-smoke-not-supported" { } ''
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

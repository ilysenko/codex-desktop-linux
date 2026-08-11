{
  description = "ChatGPT Desktop for Linux installer";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachSystem [ "x86_64-linux" "aarch64-linux" ] (system:
      let
        rewriteCratesIoDownloadUrl = url:
          if ! builtins.isString url then
            url
          else
            let
              match = builtins.match
                "https://crates[.]io/api/v1/crates/([^/]+)/([^/]+)/download"
                url;
            in
            if match == null then
              url
            else
              let
                crateName = builtins.elemAt match 0;
                version = builtins.elemAt match 1;
              in
              "https://static.crates.io/crates/${crateName}/${crateName}-${version}.crate";

        rewriteCratesIoFetchurlArgs = lib: args:
          if ! builtins.isAttrs args then
            args
          else
            args
            // lib.optionalAttrs (args ? url) {
              url =
                if builtins.isList args.url then
                  map rewriteCratesIoDownloadUrl args.url
                else
                  rewriteCratesIoDownloadUrl args.url;
            }
            // lib.optionalAttrs (args ? urls) {
              urls = map rewriteCratesIoDownloadUrl args.urls;
            };

        pkgs = import nixpkgs {
          inherit system;
          overlays = [
            (_final: prev: {
              fetchurl = args:
                prev.fetchurl (rewriteCratesIoFetchurlArgs prev.lib args);
            })
          ];
        };
        flakeSourceCommit = self.rev or (self.dirtyRev or "");
        flakeSourceRemote = "https://github.com/ilysenko/codex-desktop-linux.git";
        flakeSourceDateEpoch = toString (self.lastModified or 1);
        sourceRoot = pkgs.lib.cleanSourceWith {
          src = ./.;
          filter = path: type:
            pkgs.lib.cleanSourceFilter path type
            && (let
              pathStr = toString path;
            in
              !(pkgs.lib.hasSuffix "/.codex" pathStr || pkgs.lib.hasInfix "/.codex/" pathStr));
        };
        nixLinuxFeatures = import ./nix/linux-features.nix { lib = pkgs.lib; };
        computerUseBuildSource = pkgs.runCommandLocal "codex-computer-use-linux-source" { } ''
          mkdir -p "$out"
          cp ${./Cargo.lock} "$out/Cargo.lock"
          cat > "$out/Cargo.toml" <<'EOF'
          [workspace]
          members = ["computer-use-linux"]
          resolver = "2"
          EOF
          cp -R ${./computer-use-linux} "$out/computer-use-linux"
          chmod -R u+w "$out"
        '';
        notificationActionsBuildSource = pkgs.runCommandLocal "codex-notification-actions-linux-source" { } ''
          mkdir -p "$out"
          cp ${./Cargo.lock} "$out/Cargo.lock"
          cat > "$out/Cargo.toml" <<'EOF'
          [workspace]
          members = ["notification-actions-linux"]
          resolver = "2"
          EOF
          cp -R ${./notification-actions-linux} "$out/notification-actions-linux"
          chmod -R u+w "$out"
        '';
        officialLinuxPackage = pkgs.fetchurl ({
          x86_64-linux = {
            url = "https://persistent.oaistatic.com/codex-app-prod/linux/deb/latest/chatgpt_amd64.deb";
            hash = "sha256-qb+Ro2j598Tuo4CCqfuPtGuNAFtxmm13FdLloZgsOOs=";
          };
          aarch64-linux = {
            url = "https://persistent.oaistatic.com/codex-app-prod/linux/deb/latest/chatgpt_arm64.deb";
            hash = "sha256-84/MGU7KmrAyfcEMkjQGgernfF11Fk33ADhM4q2sy8E=";
          };
        }.${system});

        codexVersion = "26.803.81509";
        electronVersion = "42.3.0";
        targetPlatform =
          {
            x86_64-linux = {
              arch = "x64";
            };
            aarch64-linux = {
              arch = "arm64";
            };
          }.${system} or (throw "codex-desktop-linux Nix package is not supported on ${system}");

        codexMicroNodeHidArchive = pkgs.fetchurl {
          name = "node-hid-3.3.0.tgz";
          url = "https://registry.npmjs.org/node-hid/-/node-hid-3.3.0.tgz";
          hash = "sha512-j+dFgJLRAE0nufQKXk3IfS6T6YuHhCgMvz4TrG0sgtb6DSCdYpfJ1etcdmeCmPQjUgO+yo32ktVrRliNs/+fmg==";
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
          };
          aarch64-linux = {
            id = "linux-arm64-gnu";
            rustTarget = "aarch64-unknown-linux-gnu";
            binary = "watchbound.linux-arm64-gnu.node";
          };
        }.${system};
        watchboundNative = pkgs.rustPlatform.buildRustPackage {
          pname = "watchbound-native-${watchboundTarget.id}";
          version = watchboundVersion;
          src = watchboundSource;
          # Materialized from the source revision pinned in the artifact manifest.
          cargoLock.lockFile = ./nix/watchbound-Cargo.lock;
          cargoBuildFlags = [ "-p" "watchbound-node" ];
          doCheck = false;
          installPhase = ''
            runHook preInstall
            release_dir="target/''${CARGO_BUILD_TARGET:-${watchboundTarget.rustTarget}}/release"
            if [ ! -f "$release_dir/libwatchbound_node.so" ]; then
              release_dir="target/release"
            fi
            install -Dm0555 "$release_dir/libwatchbound_node.so" \
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
            node ${sourceRoot}/linux-features/directory-only-working-tree-watch/watchbound-package.js \
              --verify-controlled-package-root \
              "$out/lib/node_modules" \
              ${targetPlatform.arch}
            runHook postInstall
          '';
        };

        browserUseNodeReplRuntime = pkgs.fetchurl {
          url = "https://persistent.oaistatic.com/codex-primary-runtime/26.426.12240/codex-primary-runtime-linux-x64-26.426.12240.tar.xz";
          hash = "sha256-21Yk6276NrZuxvbdBIjO+5ZuSWNoYqq2IJpDNsHKkMQ=";
        };

        browserUseNodeRepl = if system == "x86_64-linux" then pkgs.stdenv.mkDerivation {
          pname = "codex-browser-use-node-repl";
          version = "26.426.12240";
          src = browserUseNodeReplRuntime;

          dontConfigure = true;
          dontBuild = true;

          installPhase = ''
            runHook preInstall
            mkdir -p "$out/bin"
            tar -xJf "$src" -C "$TMPDIR" codex-primary-runtime/dependencies/bin/node_repl
            install -m 0755 "$TMPDIR/codex-primary-runtime/dependencies/bin/node_repl" "$out/bin/node_repl"
            runHook postInstall
          '';
        } else null;

        codexComputerUseBinaries = pkgs.rustPlatform.buildRustPackage {
          pname = "codex-computer-use-linux-binaries";
          version = "0.1.2-linux-alpha1";
          src = computerUseBuildSource;

          cargoLock = {
            lockFile = ./Cargo.lock;
          };

          buildAndTestSubdir = "computer-use-linux";
          cargoBuildFlags = [
            "-p"
            "codex-computer-use-linux"
            "--bins"
          ];
          doCheck = false;

          installPhase = ''
            runHook preInstall
            release_dir="target/''${CARGO_BUILD_TARGET:-${pkgs.stdenv.hostPlatform.rust.rustcTarget}}/release"
            if [ ! -d "$release_dir" ]; then
              release_dir="target/release"
            fi
            install -Dm0755 "$release_dir/codex-computer-use-linux" "$out/bin/codex-computer-use-linux"
            install -Dm0755 "$release_dir/codex-computer-use-cosmic" "$out/bin/codex-computer-use-cosmic"
            install -Dm0755 "$release_dir/codex-chrome-extension-host" "$out/bin/codex-chrome-extension-host"
            runHook postInstall
          '';
        };

        codexNotificationActionsBinary = pkgs.rustPlatform.buildRustPackage {
          pname = "codex-notification-actions-linux";
          version = "0.1.0";
          src = notificationActionsBuildSource;

          cargoLock = {
            lockFile = ./Cargo.lock;
          };

          cargoBuildFlags = [
            "-p"
            "codex-notification-actions-linux"
          ];

          doCheck = true;

          installPhase = ''
            runHook preInstall
            release_dir="target/''${CARGO_BUILD_TARGET:-${pkgs.stdenv.hostPlatform.rust.rustcTarget}}/release"
            if [ ! -d "$release_dir" ]; then
              release_dir="target/release"
            fi
            install -Dm0755 "$release_dir/codex-notification-actions-linux" "$out/bin/codex-notification-actions-linux"
            runHook postInstall
          '';
        };

        codexMcpHelperReaper = pkgs.rustPlatform.buildRustPackage {
          pname = "codex-mcp-helper-reaper";
          version = "0.1.0";
          src = ./linux-features/mcp-helper-reaper/reaper;

          cargoLock = {
            lockFile = ./linux-features/mcp-helper-reaper/reaper/Cargo.lock;
          };
        };

        codexGlobalDictationBinary = pkgs.rustPlatform.buildRustPackage {
          pname = "codex-global-dictation-linux";
          version = "0.1.0";
          src = ./global-dictation-linux;

          cargoLock = {
            lockFile = ./global-dictation-linux/Cargo.lock;
          };

          doCheck = false;

          installPhase = ''
            runHook preInstall
            release_dir="target/''${CARGO_BUILD_TARGET:-${pkgs.stdenv.hostPlatform.rust.rustcTarget}}/release"
            if [ ! -d "$release_dir" ]; then
              release_dir="target/release"
            fi
            install -Dm0755 "$release_dir/codex-global-dictation-linux" "$out/bin/codex-global-dictation-linux"
            runHook postInstall
          '';
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
          pipewire
          libX11
          libXcomposite
          libXdamage
          libXext
          libXfixes
          libXrandr
          libxcb
          libxkbcommon
          libxcursor
          libxi
          libxtst
          libxscrnsaver
          libnotify
          libglvnd
          systemd
          wayland
        ];

        electronLibPath = pkgs.lib.makeLibraryPath electronLibs;
        runtimeLibPath = pkgs.lib.makeLibraryPath (with pkgs; [
          libxcrypt-legacy
          stdenv.cc.cc.lib
          zlib
        ]);
        codexMicroRuntimeLibPath = pkgs.lib.makeLibraryPath (with pkgs; [
          systemd
          libusb1
          stdenv.cc.cc.lib
          glibc
        ]);
        gsettingsSchemaPackages = with pkgs; [
          gsettings-desktop-schemas
          gtk3
        ];
        gsettingsSchemaRoot = pkg:
          pkgs.lib.removeSuffix "/glib-2.0/schemas" (pkgs.glib.getSchemaPath pkg);
        gsettingsSchemaDataDirs =
          pkgs.lib.concatMapStringsSep ":" gsettingsSchemaRoot gsettingsSchemaPackages;
        xdgDefaultDataDirs = "/usr/local/share:/usr/share";
        launcherPath = pkgs.lib.makeBinPath (with pkgs; [
          bash
          coreutils
          curl
          findutils
          gawk
          gnugrep
          gnused
          nodejs
          procps
          python3
          systemd
          xdg-utils
        ]);
        globalDictationRuntimePath = pkgs.lib.makeBinPath (with pkgs; [
          xdotool
          xinput
          xmodmap
        ]);

        patchNixInstalledApp = installDir: ''
          # Patch generated scripts for NixOS systems without /bin/bash.
          if [ -f "${installDir}/start.sh" ]; then
            ${pkgs.gnused}/bin/sed -i '1s|^#!/bin/bash$|#!${pkgs.bash}/bin/bash|' "${installDir}/start.sh"
            if ! grep -q "NixOS Electron library path" "${installDir}/start.sh"; then
              # shellcheck disable=SC2016
              ${pkgs.gnused}/bin/sed -i '/^codex_capture_original_ld_library_path$/a\
# NixOS Electron library path for dlopen()ed GL/EGL libraries.\
export LD_LIBRARY_PATH="${electronLibPath}:${runtimeLibPath}''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"\
codex_nixos_add_runtime_library_dirs' "${installDir}/start.sh"
            fi
            if ! grep -q "codex_nixos_add_runtime_library_dirs()" "${installDir}/start.sh"; then
              # shellcheck disable=SC2016
              ${pkgs.gnused}/bin/sed -i '/^set -euo pipefail$/a\
\
codex_nixos_add_runtime_library_dirs() {\
    local cache_home="''${XDG_CACHE_HOME:-''${HOME:-}/.cache}"\
    local runtime_root="''${CODEX_PRIMARY_RUNTIME_ROOT:-''${CODEX_RUNTIME_ROOT:-$cache_home/codex-runtimes/codex-primary-runtime}}"\
    local dir\
\
    for dir in \\\
        "$runtime_root/dependencies/python/lib" \\\
        "$runtime_root/dependencies/python/lib/python3.12/site-packages/pillow.libs" \\\
        "$runtime_root/dependencies/python/lib/python3.12/site-packages/numpy.libs" \\\
        "$runtime_root/dependencies/node/node_modules/@img/sharp-libvips-linux-x64/lib" \\\
        "$runtime_root/dependencies/node/node_modules/@img/sharp-linux-x64/lib" \\\
        "$runtime_root/dependencies/node/node_modules/@napi-rs/canvas-linux-x64-gnu"; do\
        if [ -d "$dir" ]; then\
            LD_LIBRARY_PATH="$dir:''${LD_LIBRARY_PATH:-}"\
        fi\
    done\
\
    export LD_LIBRARY_PATH\
}' "${installDir}/start.sh"
            fi
            if ! grep -q "Browser Use bundled marketplace metadata" "${installDir}/start.sh"; then
              ${pkgs.python3}/bin/python3 - "${installDir}/start.sh" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
needle = '    [ -f "$source_client" ] || return 0\n\n'
insert = "\n".join([
    "    # Browser Use bundled marketplace metadata for app-server plugin discovery.",
    "    local source_marketplace=\"$SCRIPT_DIR/resources/plugins/openai-bundled/.agents/plugins/marketplace.json\"",
    "    local marketplace_root=\"$codex_home/.tmp/bundled-marketplaces/openai-bundled\"",
    "    local marketplace_plugins_dir=\"$marketplace_root/.agents/plugins\"",
    "    if [ -f \"$source_marketplace\" ]; then",
    "        mkdir -p \"$marketplace_plugins_dir\"",
    "        rm -f \"$marketplace_plugins_dir/marketplace.json\"",
    "        cp \"$source_marketplace\" \"$marketplace_plugins_dir/marketplace.json\" && \\",
    "            chmod u+w \"$marketplace_plugins_dir/marketplace.json\" || \\",
    "            echo \"Browser Use bundled marketplace sync failed; continuing with existing marketplace cache.\"",
    "    fi",
    "",
    "",
])
if insert not in text:
    if needle not in text:
        raise SystemExit("Browser Use plugin cache insertion point not found")
    text = text.replace(needle, needle + insert, 1)
    path.write_text(text)
PY
            fi
          fi

          # Patch the Electron binary for NixOS.
          if [ -f "${installDir}/electron" ]; then
            echo "[NIX] Patching Electron binary for NixOS..."
            patchelf --set-interpreter "$(cat ${pkgs.stdenv.cc}/nix-support/dynamic-linker)" \
                     --set-rpath "${installDir}:${electronLibPath}" \
                     "${installDir}/electron"

            if [ -f "${installDir}/chrome_crashpad_handler" ]; then
              patchelf --set-interpreter "$(cat ${pkgs.stdenv.cc}/nix-support/dynamic-linker)" \
                       "${installDir}/chrome_crashpad_handler" || true
            fi

            if [ -f "${installDir}/chrome-sandbox" ]; then
              patchelf --set-interpreter "$(cat ${pkgs.stdenv.cc}/nix-support/dynamic-linker)" \
                       "${installDir}/chrome-sandbox" || true
            fi

            find "${installDir}" -maxdepth 1 -name "*.so*" -type f | while read -r so; do
              patchelf --set-rpath "${electronLibPath}" "$so" 2>/dev/null || true
            done

            echo "[NIX] Electron patched successfully"
          fi
        '';

        patchNixGeneratedScripts = installDir: ''
          # Patch generated scripts for NixOS systems without /bin/bash.
          if [ -f "${installDir}/start.sh" ]; then
            ${pkgs.gnused}/bin/sed -i '1s|^#!/bin/bash$|#!${pkgs.bash}/bin/bash|' "${installDir}/start.sh"
          fi
        '';

        linuxFeaturesConfigFile = config:
          pkgs.writeText "codex-linux-features.json" (builtins.toJSON config);

        linuxFeaturesConfig = linuxFeatureIds:
          linuxFeaturesConfigFile {
            enabled = linuxFeatureIds;
          };

        normalizeLinuxFeaturesConfig = config:
          let
            enabled = nixLinuxFeatures.normalize (config.enabled or [ ]);
          in
          config // {
            inherit enabled;
          };

        watchdogLinuxFeaturesConfig = normalizeLinuxFeaturesConfig (
          builtins.fromJSON (builtins.readFile ./scripts/ci/watchdog-linux-features.json)
        );

        enabledFeatureIds = { enableComputerUseUi ? false, linuxFeatureIds ? [ ] }:
          pkgs.lib.optionals enableComputerUseUi [ "computer-use-ui" ]
          ++ nixLinuxFeatures.normalize linuxFeatureIds;

        packageSuffix = args:
          let
            featureIds = enabledFeatureIds args;
          in
          if featureIds == [ ] then "" else "-${pkgs.lib.concatStringsSep "-" featureIds}";

        mkCodexDesktopPayload = { enableComputerUseUi ? false, linuxFeatureIds ? [ ], linuxFeaturesConfigOverride ? null }:
        let
          effectiveLinuxFeaturesConfig =
            if linuxFeaturesConfigOverride == null then
              normalizeLinuxFeaturesConfig { enabled = linuxFeatureIds; }
            else
              normalizeLinuxFeaturesConfig linuxFeaturesConfigOverride;
          effectiveLinuxFeatureIds = effectiveLinuxFeaturesConfig.enabled;
          codexMicroEnabled = builtins.elem "codex-micro" effectiveLinuxFeatureIds;
          watchboundEnabled = builtins.elem
            "directory-only-working-tree-watch"
            effectiveLinuxFeatureIds;
        in
        pkgs.stdenv.mkDerivation {
          pname = "codex-desktop${packageSuffix { inherit enableComputerUseUi; linuxFeatureIds = effectiveLinuxFeatureIds; }}-payload";
          version = codexVersion;
          src = sourceRoot;
          __structuredAttrs = true;

          nativeBuildInputs = [
            pkgs.bash
            pkgs.cargo
            pkgs.curl
            pkgs.gcc
            pkgs.gnumake
            pkgs.gnused
            pkgs.makeWrapper
            pkgs.nodejs
            pkgs.asar
            pkgs.binutils
            pkgs.patchelf
            pkgs.python3
            pkgs.unzip
            pkgs.util-linux
          ];

          dontConfigure = true;
          dontBuild = true;

          installPhase = ''
            runHook preInstall

            export HOME="$TMPDIR/home"
            export npm_config_cache="$TMPDIR/npm-cache"
            export SSL_CERT_FILE="${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
            export NIX_SSL_CERT_FILE="$SSL_CERT_FILE"
            export npm_config_cafile="$SSL_CERT_FILE"
            export CARGO_HOME="$TMPDIR/cargo-home"
            export CARGO_BUILD_JOBS=1
            export SOURCE_DATE_EPOCH="${flakeSourceDateEpoch}"
            ${pkgs.lib.optionalString (flakeSourceCommit != "") ''
            export CODEX_LINUX_SOURCE_COMMIT="${flakeSourceCommit}"
            export CODEX_LINUX_SOURCE_REMOTE="${flakeSourceRemote}"
            ''}
            ${pkgs.lib.optionalString enableComputerUseUi ''
            export CODEX_LINUX_ENABLE_COMPUTER_USE_UI=1
            ''}
            export CFLAGS="''${CFLAGS:-} -ffile-prefix-map=$TMPDIR=/build -fdebug-prefix-map=$TMPDIR=/build -fmacro-prefix-map=$TMPDIR=/build"
            export CXXFLAGS="''${CXXFLAGS:-} -ffile-prefix-map=$TMPDIR=/build -fdebug-prefix-map=$TMPDIR=/build -fmacro-prefix-map=$TMPDIR=/build"
            export RUSTFLAGS="''${RUSTFLAGS:-} --remap-path-prefix=$TMPDIR=/build -C link-arg=-Wl,--build-id=none"
            export CODEX_MANAGED_NODE_SOURCE="${pkgs.nodejs}"
            export CODEX_LINUX_FEATURES_CONFIG="${linuxFeaturesConfigFile effectiveLinuxFeaturesConfig}"
            ${pkgs.lib.optionalString codexMicroEnabled ''
            export CODEX_MICRO_NODE_HID_ARCHIVE="${codexMicroNodeHidArchive}"
            ''}
            ${pkgs.lib.optionalString watchboundEnabled ''
            export CODEX_WATCHBOUND_PACKAGE_ROOT="${watchboundPackage}/lib/node_modules"
            ''}
            ${pkgs.lib.optionalString (browserUseNodeRepl != null) ''
            export CODEX_LINUX_NODE_REPL_SOURCE="${browserUseNodeRepl}/bin/node_repl"
            ''}
            export CODEX_LINUX_COMPUTER_USE_BACKEND_SOURCE="${codexComputerUseBinaries}/bin/codex-computer-use-linux"
            export CODEX_LINUX_COMPUTER_USE_COSMIC_SOURCE="${codexComputerUseBinaries}/bin/codex-computer-use-cosmic"
            export CODEX_CHROME_EXTENSION_HOST_SOURCE="${codexComputerUseBinaries}/bin/codex-chrome-extension-host"
            export CODEX_NOTIFICATION_ACTIONS_SOURCE="${codexNotificationActionsBinary}/bin/codex-notification-actions-linux"
            ${pkgs.lib.optionalString (builtins.elem "mcp-helper-reaper" effectiveLinuxFeatureIds) ''
            export CODEX_MCP_HELPER_REAPER_SOURCE="${codexMcpHelperReaper}/bin/codex-mcp-helper-reaper"
            ''}
            ${pkgs.lib.optionalString (builtins.elem "global-dictation" effectiveLinuxFeatureIds) ''
            export CODEX_GLOBAL_DICTATION_LINUX_SOURCE="${codexGlobalDictationBinary}/bin/codex-global-dictation-linux"
            ''}
            mkdir -p "$HOME" "$npm_config_cache" "$CARGO_HOME"

            source_dir="$TMPDIR/codex-source"
            mkdir -p "$source_dir"
            cp -R ./. "$source_dir/"
            chmod -R u+w "$source_dir"
            cp ${officialLinuxPackage} "$source_dir/ChatGPT.deb"

            substituteInPlace "$source_dir/scripts/lib/asar-patch.sh" \
              --replace-fail "npx --yes asar" "asar" \
              --replace-fail "npx asar" "asar"
            substituteInPlace "$source_dir/scripts/lib/official-linux-package.sh" \
              --replace-fail "npx --yes asar" "asar"
            export CODEX_INSTALL_DIR="$out/opt/codex-desktop"
            ${pkgs.bash}/bin/bash "$source_dir/install.sh" "$source_dir/ChatGPT.deb"

            asar extract "$CODEX_INSTALL_DIR/resources/app.asar" "$CODEX_INSTALL_DIR/resources/app-extracted"
            rm -f "$CODEX_INSTALL_DIR/resources/app.asar"
            rm -rf "$CODEX_INSTALL_DIR/resources/app.asar.unpacked"

            ${patchNixGeneratedScripts "$out/opt/codex-desktop"}

            runHook postInstall
          '';
        };

        buildCodexDesktop = { enableComputerUseUi ? false, linuxFeatureIds ? [ ], linuxFeaturesConfigOverride ? null }:
        let
          effectiveLinuxFeaturesConfig =
            if linuxFeaturesConfigOverride == null then
              normalizeLinuxFeaturesConfig { enabled = linuxFeatureIds; }
            else
              normalizeLinuxFeaturesConfig linuxFeaturesConfigOverride;
          normalizedLinuxFeatureIds = effectiveLinuxFeaturesConfig.enabled;
          codexMicroEnabled = builtins.elem "codex-micro" normalizedLinuxFeatureIds;
          featureArgs = {
            inherit enableComputerUseUi;
            linuxFeatureIds = normalizedLinuxFeatureIds;
          };
          payload = mkCodexDesktopPayload {
            inherit enableComputerUseUi;
            linuxFeatureIds = normalizedLinuxFeatureIds;
            linuxFeaturesConfigOverride = effectiveLinuxFeaturesConfig;
          };
          payloadLauncherPath = launcherPath + pkgs.lib.optionalString
            (builtins.elem "global-dictation" normalizedLinuxFeatureIds)
            ":${globalDictationRuntimePath}";
        in
        pkgs.stdenv.mkDerivation {
          pname = "codex-desktop${packageSuffix featureArgs}";
          version = codexVersion;
          src = payload;

          nativeBuildInputs = [
            pkgs.asar
            pkgs.makeWrapper
            pkgs.patchelf
          ];

          dontConfigure = true;
          dontBuild = true;

          installPhase = ''
            runHook preInstall

            mkdir -p "$out/opt"
            cp -aT "$src/opt/codex-desktop" "$out/opt/codex-desktop"
            chmod -R u+w "$out/opt/codex-desktop"
            rm -rf "$out/opt/codex-desktop/resources/node-runtime"
            ln -s ${pkgs.nodejs} "$out/opt/codex-desktop/resources/node-runtime"
            if [ -e "$out/opt/codex-desktop/update-builder/node-runtime" ]; then
              rm -rf "$out/opt/codex-desktop/update-builder/node-runtime"
              ln -s ${pkgs.nodejs} "$out/opt/codex-desktop/update-builder/node-runtime"
            fi

            resources_dir="$out/opt/codex-desktop/resources"
            (cd "$resources_dir/app-extracted" && find . -type f | LC_ALL=C sort | sed 's#^\./##') > "$TMPDIR/app.asar.ordering"
            asar pack "$resources_dir/app-extracted" "$resources_dir/app.asar" \
              --ordering "$TMPDIR/app.asar.ordering" \
              --unpack "{*.node,*.so,*.dylib}"
            rm -rf "$resources_dir/app-extracted"

            ${pkgs.lib.optionalString codexMicroEnabled ''
            codex_micro_node_count=0
            while IFS= read -r codex_micro_node; do
              codex_micro_node_count=$((codex_micro_node_count + 1))
              patchelf --set-rpath "${codexMicroRuntimeLibPath}" "$codex_micro_node"
              actual_rpath="$(patchelf --print-rpath "$codex_micro_node")"
              if [ "$actual_rpath" != "${codexMicroRuntimeLibPath}" ]; then
                echo "codex-micro node-hid RPATH verification failed: $actual_rpath" >&2
                exit 1
              fi
            done < <(
              find "$resources_dir/app.asar.unpacked" -type f \
                -path '*/node-hid/prebuilds/HID_hidraw-linux-*/node-napi-v4.node' \
                -print
            )
            if [ "$codex_micro_node_count" -ne 1 ]; then
              echo "expected exactly one codex-micro node-hid Linux binding, found $codex_micro_node_count" >&2
              exit 1
            fi

            install -Dm0644 \
              "$out/opt/codex-desktop/.codex-linux/features/codex-micro/70-codex-micro.rules" \
              "$out/lib/udev/rules.d/70-codex-micro.rules"
            ''}

            for node_repl_binary in \
              "$resources_dir/node_repl" \
              "$resources_dir/node_repl.codex-linux-original"; do
              if [ -f "$node_repl_binary" ] \
                  && [ "$(dd if="$node_repl_binary" bs=1 count=4 2>/dev/null | od -An -tx1 | tr -d ' \n')" = "7f454c46" ]; then
                patchelf --set-interpreter "$(cat ${pkgs.stdenv.cc}/nix-support/dynamic-linker)" \
                  --set-rpath "${pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib pkgs.glibc ]}" \
                  "$node_repl_binary"
              fi
            done

            if [ -f "$resources_dir/node_repl.codex-linux-original" ]; then
              node_repl_interpreter="$(patchelf --print-interpreter \
                "$resources_dir/node_repl.codex-linux-original")"
              node_repl_rpath="$(patchelf --print-rpath \
                "$resources_dir/node_repl.codex-linux-original")"
              case "$node_repl_interpreter" in
                /nix/store/*) ;;
                *) echo "node_repl backup has non-Nix interpreter: $node_repl_interpreter" >&2; exit 1 ;;
              esac
              case "$node_repl_rpath" in
                *"/nix/store/"*) ;;
                *) echo "node_repl backup has non-Nix RPATH: $node_repl_rpath" >&2; exit 1 ;;
              esac
            fi

            ${patchNixInstalledApp "$out/opt/codex-desktop"}

            install -Dm0644 "$out/opt/codex-desktop/.codex-linux/codex-desktop.png" \
              "$out/share/icons/hicolor/256x256/apps/codex-desktop.png"

            install -Dm0644 ${sourceRoot}/packaging/linux/codex-desktop.desktop \
              "$out/share/applications/codex-desktop.desktop"
            substituteInPlace "$out/share/applications/codex-desktop.desktop" \
              --replace-fail "/usr/bin/codex-desktop" "$out/bin/codex-desktop" \
              --replace-fail "/usr/share/applications/codex-desktop.desktop" "$out/share/applications/codex-desktop.desktop"

            makeWrapper "$out/opt/codex-desktop/start.sh" "$out/bin/codex-desktop" \
              --prefix PATH : "${payloadLauncherPath}" \
              --set-default ALSA_PLUGIN_DIR "${pkgs.pipewire}/lib/alsa-lib" \
              --run 'export XDG_DATA_DIRS="''${XDG_DATA_DIRS:-${xdgDefaultDataDirs}}"' \
              --prefix XDG_DATA_DIRS : "${gsettingsSchemaDataDirs}" \
              --prefix PATH : "/run/current-system/sw/bin" \
              --prefix PATH : "/etc/profiles/per-user/$(whoami)/bin"

            runHook postInstall
          '';

          meta = {
            description =
              let
                featureIds = enabledFeatureIds featureArgs;
              in
              if featureIds == [ ] then
                "ChatGPT Desktop for Linux"
              else
                "ChatGPT Desktop for Linux with ${pkgs.lib.concatStringsSep ", " featureIds} enabled";
            homepage = "https://github.com/ilysenko/codex-desktop-linux";
            license = pkgs.lib.licenses.mit;
            platforms = pkgs.lib.platforms.linux;
            mainProgram = "codex-desktop";
          };
        };

        codexDesktop = pkgs.lib.makeOverridable buildCodexDesktop { };

        codexDesktopComputerUseUi = codexDesktop.override {
          enableComputerUseUi = true;
        };

        codexDesktopRemoteMobileControl = codexDesktop.override {
          linuxFeatureIds = [ "remote-mobile-control" ];
        };

        codexDesktopComputerUseUiRemoteMobileControl = codexDesktop.override {
          enableComputerUseUi = true;
          linuxFeatureIds = [ "remote-mobile-control" ];
        };

        codexDesktopWatchdogFeatureCheck = codexDesktop.override {
          linuxFeaturesConfigOverride = watchdogLinuxFeaturesConfig;
        };

        installer = pkgs.writeShellApplication {
          name = "codex-desktop-installer";
          runtimeInputs = [
            pkgs.bash
            pkgs.nodejs
            pkgs.python3
            pkgs.binutils
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
            source_dir="$workdir/source"
            cleanup() {
              rm -rf "$workdir"
            }
            trap cleanup EXIT

            mkdir -p "$source_dir"
            cp -R ${sourceRoot}/. "$source_dir"
            chmod -R u+w "$source_dir"
            cp ${officialLinuxPackage} "$source_dir/ChatGPT.deb"
            chmod +x "$source_dir/install.sh"

            cd "$source_dir"
            export CODEX_INSTALL_DIR="''${CODEX_INSTALL_DIR:-$root_dir/codex-app}"
            export CODEX_MANAGED_NODE_SOURCE="${pkgs.nodejs}"
            export CODEX_NOTIFICATION_ACTIONS_SOURCE="${codexNotificationActionsBinary}/bin/codex-notification-actions-linux"
            ${pkgs.bash}/bin/bash "$source_dir/install.sh" "$source_dir/ChatGPT.deb" "$@"

            install_dir="''${CODEX_INSTALL_DIR:-$root_dir/codex-app}"

            ${patchNixInstalledApp "$install_dir"}
          '';
        };
      in
      {
        packages = {
          default = codexDesktop;
          codex-desktop = codexDesktop;
          codex-desktop-computer-use-ui = codexDesktopComputerUseUi;
          codex-desktop-remote-mobile-control = codexDesktopRemoteMobileControl;
          codex-desktop-computer-use-ui-remote-mobile-control = codexDesktopComputerUseUiRemoteMobileControl;
          installer = installer;
        };

        checks = {
          notification-actions-linux = codexNotificationActionsBinary;
          official-linux-runtime = pkgs.runCommand "codex-official-linux-runtime-check" {
            nativeBuildInputs = [ pkgs.binutils pkgs.gnutar ];
          } ''
            data_member="$(ar t ${officialLinuxPackage} | awk '/^data[.]tar([.].+)?$/ { print; exit }')"
            test -n "$data_member"
            mkdir extracted
            ar p ${officialLinuxPackage} "$data_member" | tar -xJ -C extracted
            test -x extracted/usr/lib/chatgpt/ChatGPT
            test -f extracted/usr/lib/chatgpt/resources/app.asar
            touch "$out"
          '';
          notification-actions-installer = pkgs.runCommand "codex-notification-actions-installer-check" { } ''
            grep -F 'CODEX_NOTIFICATION_ACTIONS_SOURCE=' ${installer}/bin/codex-desktop-installer >/dev/null
            touch "$out"
          '';
          nix-pipewire-alsa-wrapper = pkgs.runCommand "codex-desktop-nix-pipewire-alsa-wrapper-check" { } ''
            plugin="${pkgs.pipewire}/lib/alsa-lib/libasound_module_pcm_pipewire.so"
            expected_plugin_dir="${pkgs.pipewire}/lib/alsa-lib"
            test -f "$plugin"

            run_wrapper() {
              case "$1" in
                unset) unset ALSA_PLUGIN_DIR ;;
                custom) export ALSA_PLUGIN_DIR=/custom/lib/alsa-lib ;;
                *) echo "unknown test case: $1" >&2; return 1 ;;
              esac

              actual_plugin_dir="$({
                exec() {
                  printf '%s\n' "$ALSA_PLUGIN_DIR"
                }

                source ${codexDesktop}/bin/codex-desktop
              })"
              if [ "$actual_plugin_dir" != "$2" ]; then
                printf 'expected ALSA_PLUGIN_DIR <%s>, got <%s>\n' \\
                  "$2" "$actual_plugin_dir" >&2
                return 1
              fi
            }

            run_wrapper unset "$expected_plugin_dir"
            run_wrapper custom /custom/lib/alsa-lib
            touch "$out"
          '';
          nix-gsettings-schema-wrapper = pkgs.runCommand "codex-desktop-nix-gsettings-schema-wrapper-check" { } ''
            schema_data_dirs=${pkgs.lib.escapeShellArg gsettingsSchemaDataDirs}
            default_data_dirs=${pkgs.lib.escapeShellArg xdgDefaultDataDirs}
            explicit_data_dirs=/custom/share:/other/share

            run_wrapper() {
              case "$1" in
                unset) unset XDG_DATA_DIRS ;;
                empty) export XDG_DATA_DIRS= ;;
                populated) export XDG_DATA_DIRS="$explicit_data_dirs" ;;
                *) echo "unknown test case: $1" >&2; return 1 ;;
              esac

              exec() {
                printf '%s\n' "$XDG_DATA_DIRS"
              }

              source ${codexDesktop}/bin/codex-desktop
            }

            assert_data_dirs() {
              test_case="$1"
              expected="$2"
              actual="$(run_wrapper "$test_case")"
              if [ "$actual" != "$expected" ]; then
                printf '%s: expected <%s>, got <%s>\n' \
                  "$test_case" "$expected" "$actual" >&2
                return 1
              fi
            }

            expected_defaults="$schema_data_dirs:$default_data_dirs"
            assert_data_dirs unset "$expected_defaults"
            assert_data_dirs empty "$expected_defaults"
            assert_data_dirs populated "$schema_data_dirs:$explicit_data_dirs"
            touch "$out"
          '';
          nix-linux-features-evaluation = import ./nix/linux-features-test.nix {
            inherit pkgs self system;
          };
          watchdog-linux-features = codexDesktopWatchdogFeatureCheck;
          nix-linux-features-multi-feature = codexDesktopWatchdogFeatureCheck;
        };

        apps.default = {
          type = "app";
          program = "${codexDesktop}/bin/codex-desktop";
        };

        apps.remote-mobile-control = {
          type = "app";
          program = "${codexDesktopRemoteMobileControl}/bin/codex-desktop";
        };

        apps.computer-use-ui-remote-mobile-control = {
          type = "app";
          program = "${codexDesktopComputerUseUiRemoteMobileControl}/bin/codex-desktop";
        };

        apps.installer = {
          type = "app";
          program = "${installer}/bin/codex-desktop-installer";
        };

        apps.codex-desktop-computer-use-ui = {
          type = "app";
          program = "${codexDesktopComputerUseUi}/bin/codex-desktop";
        };

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.nodejs
            pkgs.python3
            pkgs.binutils
            pkgs.curl
            pkgs.unzip
            pkgs.gnumake
            pkgs.gcc
          ];
        };
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

{ pkgs, self, system }:
let
  inherit (pkgs) lib;
  packages = self.packages.${system};
  features = import ./linux-features.nix { inherit lib; };
  homeManagerModule = import ./home-manager-module.nix { inherit self; };
  nixosModule = import ./nixos-module.nix { inherit self; };

  evalHome = moduleConfig: lib.evalModules {
    specialArgs = { inherit pkgs; };
    modules = [
      homeManagerModule
      ({ lib, ... }: {
        options = {
          assertions = lib.mkOption { type = lib.types.listOf lib.types.anything; default = [ ]; };
          home.homeDirectory = lib.mkOption { type = lib.types.str; };
          home.profileDirectory = lib.mkOption { type = lib.types.str; };
          home.packages = lib.mkOption { type = lib.types.listOf lib.types.package; default = [ ]; };
          home.sessionVariables = lib.mkOption { type = lib.types.attrsOf lib.types.anything; default = { }; };
          systemd.user.sessionVariables = lib.mkOption { type = lib.types.attrsOf lib.types.anything; default = { }; };
          systemd.user.services = lib.mkOption { type = lib.types.attrsOf lib.types.anything; default = { }; };
        };
        config = {
          home.homeDirectory = "/home/tester";
          home.profileDirectory = "/home/tester/.nix-profile";
          programs.codexDesktopLinux = moduleConfig;
        };
      })
    ];
  };

  evalNixOS = moduleConfig: lib.evalModules {
    specialArgs = { inherit pkgs; };
    modules = [
      nixosModule
      ({ lib, ... }: {
        options = {
          assertions = lib.mkOption { type = lib.types.listOf lib.types.anything; default = [ ]; };
          environment.systemPackages = lib.mkOption { type = lib.types.listOf lib.types.package; default = [ ]; };
          environment.sessionVariables = lib.mkOption { type = lib.types.attrsOf lib.types.anything; default = { }; };
          services.udev.packages = lib.mkOption { type = lib.types.listOf lib.types.package; default = [ ]; };
          systemd.user.services = lib.mkOption { type = lib.types.attrsOf lib.types.anything; default = { }; };
        };
        config.programs.codexDesktopLinux = moduleConfig;
      })
    ];
  };

  fakeDesktop = pkgs.runCommand "codex-desktop-module-test" { } ''
    mkdir -p "$out/bin" "$out/share/applications" "$out/opt/codex-desktop/resources"
    printf '#!/bin/sh\nprintf "%%s\\n" "''${CODEX_CLI_PATH-}"\n' > "$out/bin/codex-desktop"
    chmod +x "$out/bin/codex-desktop"
    printf '#!/bin/sh\nexit 0\n' > "$out/opt/codex-desktop/resources/codex"
    chmod +x "$out/opt/codex-desktop/resources/codex"
    printf '[Desktop Entry]\nExec=%s/bin/codex-desktop\n' "$out" > "$out/share/applications/codex-desktop.desktop"
  '';
  fakeBundledCli = import ./bundled-codex-cli.nix {
    inherit pkgs;
    desktopPackage = fakeDesktop;
  };
  fakeCli = pkgs.writeShellScriptBin "codex" "exit 0";
  baseConfig = { enable = true; package = fakeDesktop; };
  bundledRemoteConfig = baseConfig // { remoteControl.enable = true; };
  remoteConfig = baseConfig // {
    remoteControl = {
      enable = true;
      package = fakeCli;
      environmentFile = "/run/secrets/codex.env";
      environment = {
        BOOL = true;
        COUNT = 7;
        OMIT = null;
      };
    };
  };
  remoteAutostartConfig = remoteConfig // {
    remoteControl = remoteConfig.remoteControl // { disableLauncherAutostart = false; };
  };
  optionalEnvironmentFileConfig = remoteConfig // {
    remoteControl = remoteConfig.remoteControl // { environmentFile = "-/run/secrets/codex.env"; };
  };
  invalidEnvironmentFileConfigs = map
    (environmentFile: remoteConfig // {
      remoteControl = remoteConfig.remoteControl // { inherit environmentFile; };
    })
    [ "" "relative.env" "-relative.env" "//run/secrets/x" "/run/../secrets/x" "/run/secrets/./x" "/nix/store/x" ];
  contextEnvironmentFileConfig = remoteConfig // {
    remoteControl = remoteConfig.remoteControl // { environmentFile = "/run/secrets/${./modules-test.nix}"; };
  };
  home = (evalHome remoteConfig).config;
  nixos = (evalNixOS remoteConfig).config;
  bundledHome = (evalHome bundledRemoteConfig).config;
  bundledNixOS = (evalNixOS bundledRemoteConfig).config;
  homeService = home.systemd.user.services.codex-remote-control;
  nixosService = nixos.systemd.user.services.codex-remote-control;
  bundledHomeService = bundledHome.systemd.user.services.codex-remote-control;
  bundledNixOSService = bundledNixOS.systemd.user.services.codex-remote-control;
  homeDefaultPackage = builtins.head (evalHome baseConfig).config.home.packages;
  nixosDefaultPackage = builtins.head (evalNixOS baseConfig).config.environment.systemPackages;
  homeCliPackage = builtins.head (evalHome (baseConfig // { cliPackage = fakeCli; })).config.home.packages;
  nixosCliPackage = builtins.head (evalNixOS (baseConfig // { cliPackage = fakeCli; })).config.environment.systemPackages;
  assertionsFail = evaluated: lib.any (item: !item.assertion) evaluated.config.assertions;
  invalidHomeFiles = map (cfg: assertionsFail (evalHome cfg)) invalidEnvironmentFileConfigs;
  invalidNixOSFiles = map (cfg: assertionsFail (evalNixOS cfg)) invalidEnvironmentFileConfigs;
in
assert lib.assertMsg
  (features.normalize [ "ui-tweaks" "ui-tweaks" "agent-workspace" ] == [ "agent-workspace" "ui-tweaks" ])
  "Nix feature IDs are not sorted and deduplicated";
assert lib.assertMsg
  (features.normalize [ "codex-wrapper-updater" "zed-opener" ] == [ ])
  "known retired and aliased-retired feature IDs were not ignored";
assert lib.assertMsg
  (!(builtins.tryEval (features.normalize [ "not-a-feature" ])).success)
  "an arbitrary unknown feature ID was accepted";
assert lib.assertMsg
  (!(builtins.tryEval (features.normalize [ "directory-only-working-tree-watch" "shallow-repository-watches" ])).success)
  "conflicting watcher features were accepted";
assert lib.assertMsg
  (!features.optionType.check [ "not-a-feature" ]
    && features.optionType.check [ "codex-wrapper-updater" ])
  "module option checking did not distinguish unknown and explicitly retired feature IDs";
assert lib.assertMsg
  (homeDefaultPackage.drvPath == fakeDesktop.drvPath && nixosDefaultPackage.drvPath == fakeDesktop.drvPath)
  "the bundled CLI default unexpectedly wrapped a custom Desktop package";
assert lib.assertMsg
  (!((evalHome baseConfig).config.systemd.user.services ? codex-remote-control)
    && !((evalNixOS baseConfig).config.systemd.user.services ? codex-remote-control))
  "remote control was enabled without explicit user configuration";
assert lib.assertMsg
  (homeCliPackage.drvPath != fakeDesktop.drvPath && nixosCliPackage.drvPath != fakeDesktop.drvPath)
  "cliPackage did not wrap the Desktop launcher";
assert lib.assertMsg
  ((builtins.head (evalHome remoteConfig).config.home.packages).drvPath != fakeDesktop.drvPath)
  "Home Manager did not use the remote-control CLI fallback";
assert lib.assertMsg
  ((builtins.head (evalNixOS remoteConfig).config.environment.systemPackages).drvPath != fakeDesktop.drvPath)
  "NixOS did not use the remote-control CLI fallback";
assert lib.assertMsg
  (lib.hasPrefix "${fakeBundledCli}/bin/codex " bundledHomeService.Service.ExecStart
    && lib.hasPrefix "${fakeBundledCli}/bin/codex " bundledNixOSService.serviceConfig.ExecStart)
  "the default remote-control service did not use the Desktop package's bundled CLI";
assert lib.assertMsg
  ((builtins.head bundledHome.home.packages).drvPath != fakeDesktop.drvPath
    && (builtins.head bundledNixOS.environment.systemPackages).drvPath != fakeDesktop.drvPath)
  "the bundled remote-control CLI was not shared with the Desktop launcher";
assert lib.assertMsg
  ((evalNixOS (baseConfig // { linuxFeatures = [ "codex-micro" ]; })).config.services.udev.packages == [ ])
  "a custom Desktop package unexpectedly inherited codex-micro udev policy";
assert lib.assertMsg
  (builtins.length (evalNixOS { enable = true; linuxFeatures = [ "codex-micro" ]; }).config.services.udev.packages == 1)
  "the module-managed codex-micro package was not registered with udev";
assert lib.assertMsg
  (home.home.sessionVariables == home.systemd.user.sessionVariables)
  "Home Manager session and systemd user variables diverged";
assert lib.assertMsg
  (home.home.sessionVariables.CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED == "1"
    && nixos.environment.sessionVariables.CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED == "1")
  "launcher daemon suppression was not enabled by default";
assert lib.assertMsg
  (nixos.environment.sessionVariables.CODEX_REMOTE_CONTROL_APP_SERVER_PROXY_SOCKET
    == "$HOME/.codex/app-server-control/app-server-control.sock")
  "the NixOS session proxy socket did not use a per-user home path";
assert lib.assertMsg
  (!((evalHome remoteAutostartConfig).config.home.sessionVariables ? CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED)
    && !((evalNixOS remoteAutostartConfig).config.environment.sessionVariables ? CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED))
  "launcher daemon suppression ignored its option";
assert lib.assertMsg
  (homeService.Unit.After == [ "network.target" ] && homeService.Service.RestartSec == 5
    && nixosService.after == [ "network.target" ] && nixosService.serviceConfig.RestartSec == 5)
  "remote-control service ordering or restart timing regressed";
assert lib.assertMsg
  (lib.hasSuffix "mkdir -p /home/tester/.codex" bundledHomeService.Service.ExecStartPre
    && lib.hasSuffix "mkdir -p %h/.codex" bundledNixOSService.serviceConfig.ExecStartPre)
  "remote-control service did not prepare the default CODEX_HOME";
assert lib.assertMsg
  (lib.elem "BOOL=true" homeService.Service.Environment
    && lib.elem "COUNT=7" homeService.Service.Environment
    && !(lib.any (value: lib.hasPrefix "OMIT=" value) homeService.Service.Environment))
  "Home Manager did not serialize bool/int/null environment values correctly";
assert lib.assertMsg
  (lib.elem "BOOL=true" nixosService.serviceConfig.Environment
    && lib.elem "COUNT=7" nixosService.serviceConfig.Environment
    && !(lib.any (value: lib.hasPrefix "OMIT=" value) nixosService.serviceConfig.Environment))
  "NixOS did not serialize bool/int/null environment values correctly";
assert lib.assertMsg
  (lib.any (value: lib.hasPrefix "PATH=/home/tester/.nix-profile/bin:" value) homeService.Service.Environment
    && lib.any (value: lib.hasPrefix "PATH=/run/current-system/sw/bin:" value) nixosService.serviceConfig.Environment)
  "remote-control service PATH omitted the user or system profile";
assert lib.assertMsg
  ((evalHome optionalEnvironmentFileConfig).config.systemd.user.services.codex-remote-control.Service.EnvironmentFile == "-/run/secrets/codex.env"
    && (evalNixOS optionalEnvironmentFileConfig).config.systemd.user.services.codex-remote-control.serviceConfig.EnvironmentFile == "-/run/secrets/codex.env")
  "optional runtime environmentFile changed";
assert lib.assertMsg
  (lib.all (value: value) invalidHomeFiles && lib.all (value: value) invalidNixOSFiles)
  "an empty, relative, non-canonical, or store environmentFile was accepted";
assert lib.assertMsg
  (assertionsFail (evalHome contextEnvironmentFileConfig) && assertionsFail (evalNixOS contextEnvironmentFileConfig))
  "a context-bearing environmentFile was accepted";
pkgs.runCommand "codex-desktop-module-evaluation" { } ''
  test -x ${fakeBundledCli}/bin/codex
  test "$(${builtins.head bundledHome.home.packages}/bin/codex-desktop)" = "${fakeBundledCli}/bin/codex"
  test "$(${builtins.head bundledNixOS.environment.systemPackages}/bin/codex-desktop)" = "${fakeBundledCli}/bin/codex"
  test "$(${homeCliPackage}/bin/codex-desktop)" = "${fakeCli}/bin/codex"
  test "$(CODEX_CLI_PATH=/explicit/codex ${homeCliPackage}/bin/codex-desktop)" = "/explicit/codex"
  grep -F "Exec=${homeCliPackage}/bin/codex-desktop" \
    ${homeCliPackage}/share/applications/codex-desktop.desktop
  touch "$out"
''

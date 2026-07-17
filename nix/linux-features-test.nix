{
  pkgs,
  self,
  system,
}:
let
  inherit (pkgs) lib;
  packages = self.packages.${system};
  linuxFeatures = import ./linux-features.nix { inherit lib; };
  homeManagerModule = import ./home-manager-module.nix { inherit self; };
  nixosModule = import ./nixos-module.nix { inherit self; };

  testFeatureIds = [
    "persistent-status-panel"
    "appshots"
    "codex-wrapper-updater"
    "directory-only-working-tree-watch"
    "frameless-titlebar"
    "global-dictation"
    "mcp-helper-reaper"
    "remote-mobile-control"
    "pet-overlay"
    "open-target-discovery"
    "remote-control-ui"
    "ui-tweaks"
    "appshots"
  ];
  normalizedTestFeatureIds = [
    "appshots"
    "codex-wrapper-updater"
    "directory-only-working-tree-watch"
    "frameless-titlebar"
    "global-dictation"
    "mcp-helper-reaper"
    "open-target-discovery"
    "persistent-status-panel"
    "pet-overlay"
    "remote-control-ui"
    "remote-mobile-control"
    "ui-tweaks"
  ];
  watchdogFeatureIds = (builtins.fromJSON (builtins.readFile ../scripts/ci/watchdog-linux-features.json)).enabled;
  normalizedWatchdogFeatureIds = [
    "appshots"
    "codex-wrapper-updater"
    "directory-only-working-tree-watch"
    "frameless-titlebar"
    "global-dictation"
    "mcp-helper-reaper"
    "node-repl-reaper"
    "open-target-discovery"
    "persistent-status-panel"
    "remote-control-ui"
    "remote-mobile-control"
    "ui-tweaks"
  ];

  evalHomeManager = moduleConfig:
    lib.evalModules {
      specialArgs = { inherit pkgs; };
      modules = [
        homeManagerModule
        ({ lib, ... }: {
          options = {
            assertions = lib.mkOption {
              type = lib.types.listOf lib.types.anything;
              default = [ ];
            };
            home.homeDirectory = lib.mkOption { type = lib.types.str; };
            home.profileDirectory = lib.mkOption { type = lib.types.str; };
            home.packages = lib.mkOption {
              type = lib.types.listOf lib.types.package;
              default = [ ];
            };
            home.sessionVariables = lib.mkOption {
              type = lib.types.attrsOf lib.types.anything;
              default = { };
            };
            systemd.user.sessionVariables = lib.mkOption {
              type = lib.types.attrsOf lib.types.anything;
              default = { };
            };
            systemd.user.services = lib.mkOption {
              type = lib.types.attrsOf lib.types.anything;
              default = { };
            };
          };
          config = {
            home.homeDirectory = "/home/tester";
            home.profileDirectory = "/home/tester/.nix-profile";
            programs.codexDesktopLinux = moduleConfig;
          };
        })
      ];
    };

  evalNixOS = moduleConfig:
    lib.evalModules {
      specialArgs = { inherit pkgs; };
      modules = [
        nixosModule
        ({ lib, ... }: {
          options = {
            assertions = lib.mkOption {
              type = lib.types.listOf lib.types.anything;
              default = [ ];
            };
            environment.systemPackages = lib.mkOption {
              type = lib.types.listOf lib.types.package;
              default = [ ];
            };
            environment.sessionVariables = lib.mkOption {
              type = lib.types.attrsOf lib.types.anything;
              default = { };
            };
            systemd.user.services = lib.mkOption {
              type = lib.types.attrsOf lib.types.anything;
              default = { };
            };
          };
          config.programs.codexDesktopLinux = moduleConfig;
        })
      ];
    };

  homePackage = moduleConfig:
    builtins.head (evalHomeManager moduleConfig).config.home.packages;
  nixosPackage = moduleConfig:
    builtins.head (evalNixOS moduleConfig).config.environment.systemPackages;

  defaultConfig = { enable = true; };
  legacyRemoteConfig = {
    enable = true;
    remoteMobileControl.enable = true;
  };
  combinedConfig = {
    enable = true;
    computerUseUi.enable = true;
    remoteMobileControl.enable = true;
    linuxFeatures = testFeatureIds;
  };

  expectedCombined = packages.codex-desktop.override {
    enableComputerUseUi = true;
    linuxFeatureIds = normalizedTestFeatureIds;
  };
  reorderedCombined = packages.codex-desktop.override {
    enableComputerUseUi = true;
    linuxFeatureIds = [
      "remote-mobile-control"
      "frameless-titlebar"
      "codex-wrapper-updater"
      "directory-only-working-tree-watch"
      "global-dictation"
      "persistent-status-panel"
      "mcp-helper-reaper"
      "pet-overlay"
      "open-target-discovery"
      "remote-control-ui"
      "ui-tweaks"
      "appshots"
      "appshots"
    ];
  };

  customPackage = pkgs.runCommand "codex-desktop-custom-test-package" { } ''
    mkdir -p "$out"
  '';
  customConfig = combinedConfig // { package = customPackage; };
  remoteControlConfig = {
    enable = true;
    package = customPackage;
    remoteControl = {
      enable = true;
      package = pkgs.writeShellScriptBin "codex" "exit 0";
      environmentFile = "/run/secrets/codex-remote-control.env";
    };
  };
  remoteControlConfigWithEnvironmentFile = environmentFile:
    remoteControlConfig
    // {
      remoteControl = remoteControlConfig.remoteControl // { inherit environmentFile; };
    };
  homeRemoteService =
    (evalHomeManager remoteControlConfig).config.systemd.user.services.codex-remote-control;
  nixosRemoteService =
    (evalNixOS remoteControlConfig).config.systemd.user.services.codex-remote-control;
  optionalHomeRemoteService =
    (evalHomeManager (
      remoteControlConfigWithEnvironmentFile "-/run/secrets/codex-remote-control.env"
    )).config.systemd.user.services.codex-remote-control;
  optionalNixOSRemoteService =
    (evalNixOS (
      remoteControlConfigWithEnvironmentFile "-/run/secrets/codex-remote-control.env"
    )).config.systemd.user.services.codex-remote-control;

  invalidBuilder = builtins.tryEval (
    (packages.codex-desktop.override {
      linuxFeatureIds = [ "not-nix-compatible" ];
    }).drvPath
  );
  invalidHomeManager = builtins.tryEval (
    builtins.deepSeq
      (evalHomeManager {
        enable = true;
        linuxFeatures = [ "not-nix-compatible" ];
      }).config.home.packages
      true
  );
  invalidNixOS = builtins.tryEval (
    builtins.deepSeq
      (evalNixOS {
        enable = true;
        linuxFeatures = [ "not-nix-compatible" ];
      }).config.environment.systemPackages
      true
  );
  invalidHomeManagerEnvironmentFile = builtins.tryEval (
    builtins.deepSeq
      (evalHomeManager (
        remoteControlConfigWithEnvironmentFile ./linux-features-test.nix
      )).config.systemd.user.services.codex-remote-control
      true
  );
  invalidNixOSEnvironmentFile = builtins.tryEval (
    builtins.deepSeq
      (evalNixOS (
        remoteControlConfigWithEnvironmentFile ./linux-features-test.nix
      )).config.systemd.user.services.codex-remote-control
      true
  );
  storeEnvironmentFiles = [
    "${./linux-features-test.nix}"
    "-${./linux-features-test.nix}"
  ];
  invalidRuntimeEnvironmentFiles = [
    ""
    "secrets.env"
    "-secrets.env"
    "//nix/store/example-secret"
    "/run/../nix/store/example-secret"
    "/nix//store/example-secret"
    "/run/secrets/./codex-remote-control.env"
    "/run/secrets/"
  ];
  contextEnvironmentFiles = [
    "/run/secrets/${./linux-features-test.nix}"
    "-/run/secrets/${./linux-features-test.nix}"
  ];
  homeManagerStoreEnvironmentFileAssertions = map (
    environmentFile:
    (evalHomeManager (
      remoteControlConfigWithEnvironmentFile environmentFile
    )).config.assertions
  ) storeEnvironmentFiles;
  nixosStoreEnvironmentFileAssertions = map (
    environmentFile:
    (evalNixOS (
      remoteControlConfigWithEnvironmentFile environmentFile
    )).config.assertions
  ) storeEnvironmentFiles;
  homeManagerRuntimeEnvironmentFileAssertions = map (
    environmentFile:
    (evalHomeManager (
      remoteControlConfigWithEnvironmentFile environmentFile
    )).config.assertions
  ) invalidRuntimeEnvironmentFiles;
  nixosRuntimeEnvironmentFileAssertions = map (
    environmentFile:
    (evalNixOS (
      remoteControlConfigWithEnvironmentFile environmentFile
    )).config.assertions
  ) invalidRuntimeEnvironmentFiles;
  homeManagerContextEnvironmentFileAssertions = map (
    environmentFile:
    (evalHomeManager (
      remoteControlConfigWithEnvironmentFile environmentFile
    )).config.assertions
  ) contextEnvironmentFiles;
  nixosContextEnvironmentFileAssertions = map (
    environmentFile:
    (evalNixOS (
      remoteControlConfigWithEnvironmentFile environmentFile
    )).config.assertions
  ) contextEnvironmentFiles;
in
assert lib.assertMsg
  (linuxFeatures.normalize testFeatureIds == normalizedTestFeatureIds)
  "Nix Linux feature IDs must be sorted and deduplicated";
assert lib.assertMsg
  (linuxFeatures.normalize watchdogFeatureIds == normalizedWatchdogFeatureIds)
  "the committed watchdog Linux feature profile drifted from the Nix-supported profile";
assert lib.assertMsg
  ((homePackage defaultConfig).drvPath == packages.codex-desktop.drvPath)
  "the Home Manager default package changed";
assert lib.assertMsg
  ((nixosPackage defaultConfig).drvPath == packages.codex-desktop.drvPath)
  "the NixOS default package changed";
assert lib.assertMsg
  ((homePackage legacyRemoteConfig).drvPath == packages.codex-desktop-remote-mobile-control.drvPath)
  "the Home Manager remoteMobileControl shorthand changed";
assert lib.assertMsg
  ((nixosPackage legacyRemoteConfig).drvPath == packages.codex-desktop-remote-mobile-control.drvPath)
  "the NixOS remoteMobileControl shorthand changed";
assert lib.assertMsg
  ((homePackage combinedConfig).drvPath == expectedCombined.drvPath)
  "Home Manager did not select the normalized combined package";
assert lib.assertMsg
  ((nixosPackage combinedConfig).drvPath == expectedCombined.drvPath)
  "NixOS did not select the normalized combined package";
assert lib.assertMsg
  (expectedCombined.drvPath == reorderedCombined.drvPath)
  "equivalent feature lists produced different derivations";
assert lib.assertMsg
  ((homePackage customConfig).drvPath == customPackage.drvPath)
  "the Home Manager custom package override lost precedence";
assert lib.assertMsg
  ((nixosPackage customConfig).drvPath == customPackage.drvPath)
  "the NixOS custom package override lost precedence";
assert lib.assertMsg (!invalidBuilder.success) "the package builder accepted an unsupported feature";
assert lib.assertMsg (!invalidHomeManager.success) "Home Manager accepted an unsupported feature";
assert lib.assertMsg (!invalidNixOS.success) "NixOS accepted an unsupported feature";
assert lib.assertMsg
  (homeRemoteService.Service.EnvironmentFile == "/run/secrets/codex-remote-control.env")
  "Home Manager changed the runtime remote-control environment-file path";
assert lib.assertMsg
  (nixosRemoteService.serviceConfig.EnvironmentFile == "/run/secrets/codex-remote-control.env")
  "NixOS changed the runtime remote-control environment-file path";
assert lib.assertMsg
  (optionalHomeRemoteService.Service.EnvironmentFile == "-/run/secrets/codex-remote-control.env")
  "Home Manager rejected or changed an optional absolute environment-file path";
assert lib.assertMsg
  (optionalNixOSRemoteService.serviceConfig.EnvironmentFile == "-/run/secrets/codex-remote-control.env")
  "NixOS rejected or changed an optional absolute environment-file path";
assert lib.assertMsg
  (!invalidHomeManagerEnvironmentFile.success)
  "Home Manager accepted a Nix path that can copy remote-control secrets into the store";
assert lib.assertMsg
  (!invalidNixOSEnvironmentFile.success)
  "NixOS accepted a Nix path that can copy remote-control secrets into the store";
assert lib.assertMsg
  (lib.all (assertions: !lib.all (item: item.assertion) assertions) homeManagerStoreEnvironmentFileAssertions)
  "Home Manager accepted a store path for the remote-control environment file";
assert lib.assertMsg
  (lib.all (assertions: !lib.all (item: item.assertion) assertions) nixosStoreEnvironmentFileAssertions)
  "NixOS accepted a store path for the remote-control environment file";
assert lib.assertMsg
  (lib.all (assertions: !lib.all (item: item.assertion) assertions) homeManagerRuntimeEnvironmentFileAssertions)
  "Home Manager accepted an empty, relative, or non-canonical remote-control environment-file path";
assert lib.assertMsg
  (lib.all (assertions: !lib.all (item: item.assertion) assertions) nixosRuntimeEnvironmentFileAssertions)
  "NixOS accepted an empty, relative, or non-canonical remote-control environment-file path";
assert lib.assertMsg
  (lib.all (assertions: !lib.all (item: item.assertion) assertions) homeManagerContextEnvironmentFileAssertions)
  "Home Manager accepted a context-bearing remote-control environment-file path";
assert lib.assertMsg
  (lib.all (assertions: !lib.all (item: item.assertion) assertions) nixosContextEnvironmentFileAssertions)
  "NixOS accepted a context-bearing remote-control environment-file path";
pkgs.runCommand "nix-linux-features-evaluation" { } ''
  touch "$out"
''

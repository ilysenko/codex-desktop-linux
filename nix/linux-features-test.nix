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
    "frameless-titlebar"
    "global-dictation"
    "mcp-helper-reaper"
    "remote-mobile-control"
    "pet-overlay"
    "open-target-discovery"
    "appshots"
  ];
  normalizedTestFeatureIds = [
    "appshots"
    "frameless-titlebar"
    "global-dictation"
    "mcp-helper-reaper"
    "open-target-discovery"
    "persistent-status-panel"
    "pet-overlay"
    "remote-mobile-control"
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
      "global-dictation"
      "persistent-status-panel"
      "mcp-helper-reaper"
      "pet-overlay"
      "open-target-discovery"
      "appshots"
      "appshots"
    ];
  };

  customPackage = pkgs.runCommand "codex-desktop-custom-test-package" { } ''
    mkdir -p "$out"
  '';
  customConfig = combinedConfig // { package = customPackage; };

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
in
assert lib.assertMsg
  (linuxFeatures.normalize testFeatureIds == normalizedTestFeatureIds)
  "Nix Linux feature IDs must be sorted and deduplicated";
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
pkgs.runCommand "nix-linux-features-evaluation" { } ''
  touch "$out"
''

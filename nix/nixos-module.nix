{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.codexDesktopLinux;
  remoteCfg = cfg.remoteControl;
  remoteEnvironmentFilePath =
    if remoteCfg.environmentFile == null then null else lib.removePrefix "-" remoteCfg.environmentFile;
  remoteEnvironmentFileSegments =
    if remoteEnvironmentFilePath == null then [ ] else lib.drop 1 (lib.splitString "/" remoteEnvironmentFilePath);
  remoteEnvironmentFileIsCanonical =
    remoteEnvironmentFilePath != null
    && lib.hasPrefix "/" remoteEnvironmentFilePath
    && lib.all (segment: segment != "" && segment != "." && segment != "..") remoteEnvironmentFileSegments;
  system = pkgs.stdenv.hostPlatform.system;
  flakePackages = self.packages.${system};
  linuxFeatures = import ./linux-features.nix { inherit lib; };
  packageSelection = import ./package-selection.nix {
    inherit cfg flakePackages lib;
  };
  basePackage = packageSelection.package;
  codexMicroEnabled =
    cfg.package == null
    && lib.elem "codex-micro" packageSelection.normalizedFeatureIds;
  codexMicroUdevRules = flakePackages.codex-micro-udev-rules;
  codexCliPackage =
    if cfg.cliPackage != null then
      cfg.cliPackage
    else if remoteCfg.enable then
      remoteCfg.package
    else
      null;
  codexCliPath = if codexCliPackage != null then lib.getExe' codexCliPackage "codex" else null;
  # Thin wrapper that bakes CODEX_CLI_PATH into the launcher. The `.desktop`
  # entry shipped by the package launches `<pkg>/bin/codex-desktop` by absolute
  # path, so wrapping that binary (and repointing the desktop entry at the
  # wrapper) makes ChatGPT Desktop locate the CLI no matter how it is started --
  # graphical autostart, application launcher, terminal, or a warm-start handoff
  # to an already-running instance -- without depending on the session/login
  # `PATH` and without requiring a re-login for a config change to take effect.
  # `--set-default` leaves an explicit `CODEX_CLI_PATH` in the environment in
  # control, so users can still override the launched CLI.
  withCodexCliPath =
    base:
    pkgs.symlinkJoin {
      name = "${base.name}-codex-cli-path";
      paths = [ base ];
      nativeBuildInputs = [ pkgs.makeWrapper ];
      postBuild = ''
        if [ -e "$out/bin/codex-desktop" ]; then
          rm -f "$out/bin/codex-desktop"
          makeWrapper "${base}/bin/codex-desktop" "$out/bin/codex-desktop" \
            --set-default CODEX_CLI_PATH "${codexCliPath}"
        fi
        desktopFile="$out/share/applications/codex-desktop.desktop"
        if [ -e "$desktopFile" ]; then
          target="$(readlink -f "$desktopFile")"
          rm -f "$desktopFile"
          substitute "$target" "$desktopFile" \
            --replace-fail "${base}/bin/codex-desktop" "$out/bin/codex-desktop"
        fi
      '';
      meta = base.meta or { };
    };
  desktopPackage = if codexCliPath != null then withCodexCliPath basePackage else basePackage;
  remoteControlPath = lib.makeSearchPath "bin" (
    [
      "/run/current-system/sw"
    ]
    ++ remoteCfg.extraPackages
  );
  remoteControlEnvironment = {
    CODEX_HOME = if remoteCfg.codexHome != null then remoteCfg.codexHome else "%h/.codex";
    PATH = remoteControlPath;
  }
  // remoteCfg.environment;
  remoteControlEnvironmentList = lib.mapAttrsToList (
    name: value: "${name}=${if lib.isBool value then lib.boolToString value else toString value}"
  ) (lib.filterAttrs (_name: value: value != null) remoteControlEnvironment);
in
{
  options.programs.codexDesktopLinux = {
    enable = lib.mkEnableOption "ChatGPT Desktop for Linux";

    package = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = null;
      defaultText = lib.literalExpression ''
        inputs.codex-desktop-linux.packages.''${pkgs.stdenv.hostPlatform.system}.codex-desktop
      '';
      description = ''
        ChatGPT Desktop package to install. When unset, the module builds the
        selected configuration from
        {option}`programs.codexDesktopLinux.computerUseUi.enable` and
        {option}`programs.codexDesktopLinux.linuxFeatures`. The
        {option}`programs.codexDesktopLinux.remoteMobileControl.enable` option
        remains a compatibility shorthand for the `remote-mobile-control`
        feature.
      '';
    };

    cliPackage = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = null;
      defaultText = lib.literalExpression "pkgs.codex";
      example = lib.literalExpression "pkgs.codex";
      description = ''
        Codex CLI package that ChatGPT Desktop should launch. When set, the
        installed ChatGPT Desktop launcher (and its `.desktop` entry) is wrapped so
        it always starts with {env}`CODEX_CLI_PATH` pointing at this package's
        `codex` binary. This lets ChatGPT Desktop locate the CLI regardless of how
        it is started — graphical autostart, application launcher, terminal, or a
        warm-start handoff to an already-running instance — without depending on
        the session/login {env}`PATH` and without requiring a re-login for the
        setting to take effect. An explicit {env}`CODEX_CLI_PATH` already in the
        environment still wins.

        When unset, the module falls back to
        {option}`programs.codexDesktopLinux.remoteControl.package` if
        {option}`programs.codexDesktopLinux.remoteControl.enable` is set;
        otherwise the launcher is left unwrapped and ChatGPT Desktop relies on
        discovering `codex` on {env}`PATH`.
      '';
    };

    computerUseUi.enable = lib.mkEnableOption "the Linux Computer Use UI package variant";

    remoteMobileControl.enable = lib.mkEnableOption "the experimental Linux mobile remote-control package variant";

    linuxFeatures = lib.mkOption {
      type = linuxFeatures.optionType;
      default = [ ];
      example = [
        "appshots"
        "open-target-discovery"
      ];
      description = ''
        Nix-compatible optional Linux features to include in the package. IDs
        are deduplicated and sorted before the package derivation is created.
        Features not supported by the Nix packaging layer fail module
        evaluation. This option does not affect an explicitly configured
        {option}`programs.codexDesktopLinux.package`.
      '';
    };

    remoteControl = {
      enable = lib.mkEnableOption "a system-wide user app-server unit with remote control enabled";

      package = lib.mkOption {
        type = lib.types.package;
        default = pkgs.codex;
        defaultText = lib.literalExpression "pkgs.codex";
        description = "Codex CLI package used by the remote-control app-server service.";
      };

      codexHome = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "%h/.codex";
        description = ''
          Value for {env}`CODEX_HOME` in the remote-control service. If unset,
          the global user unit uses {file}`%h/.codex`.
        '';
      };

      listen = lib.mkOption {
        type = lib.types.str;
        default = "unix://";
        description = ''
          Local app-server transport endpoint passed to
          {command}`codex app-server --listen`.
        '';
      };

      target = lib.mkOption {
        type = lib.types.str;
        default = "default.target";
        description = "Systemd user target that starts the remote-control service.";
      };

      environment = lib.mkOption {
        type = lib.types.attrsOf (
          lib.types.nullOr (
            lib.types.oneOf [
              lib.types.bool
              lib.types.int
              lib.types.str
            ]
          )
        );
        default = { };
        description = "Environment variables to set for the remote-control service.";
      };

      environmentFile = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "/run/secrets/codex-remote-control.env";
        description = ''
          Runtime path to an additional environment file as defined in
          {manpage}`systemd.exec(5)`. Use a quoted runtime string. Nix path
          literals or interpolations can copy contents into the Nix store
          before module validation; store-backed values are rejected.
        '';
      };

      extraPackages = lib.mkOption {
        type = lib.types.listOf lib.types.package;
        default = with pkgs; [
          bash
          coreutils
          findutils
          git
          gnugrep
          gnused
          openssh
        ];
        description = "Extra packages to add to {env}`PATH` for commands launched by Codex.";
      };

      extraArgs = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [
          "--analytics-default-enabled"
        ];
        description = "Additional arguments passed to {command}`codex app-server`.";
      };

      disableLauncherAutostart = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Set {env}`CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED=1` for
          graphical sessions when this declarative service is enabled, so the
          Desktop launcher does not also start the mutable standalone daemon
          hook.
        '';
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = !remoteCfg.enable || pkgs.stdenv.hostPlatform.isLinux;
        message = "`programs.codexDesktopLinux.remoteControl.enable` is only supported on Linux";
      }
      {
        assertion =
          remoteCfg.environmentFile == null
          || (!builtins.hasContext remoteCfg.environmentFile && remoteEnvironmentFileIsCanonical);
        message = ''
          `programs.codexDesktopLinux.remoteControl.environmentFile` must be an
          absolute canonical runtime path without Nix store context, optionally
          prefixed with `-`
        '';
      }
      {
        assertion =
          remoteCfg.environmentFile == null
          || (
            remoteEnvironmentFilePath != builtins.storeDir
            && !lib.hasPrefix "${builtins.storeDir}/" remoteEnvironmentFilePath
          );
        message = ''
          `programs.codexDesktopLinux.remoteControl.environmentFile` must be a
          runtime path outside the Nix store
        '';
      }
    ];

    environment.systemPackages = [
      desktopPackage
    ];

    services.udev.packages = lib.optionals codexMicroEnabled [
      codexMicroUdevRules
    ];

    environment.sessionVariables = lib.mkIf (remoteCfg.enable && remoteCfg.disableLauncherAutostart) {
      CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED = "1";
    };

    systemd.user.services.codex-remote-control = lib.mkIf remoteCfg.enable {
      description = "Codex remote-control app-server";
      after = [ "network.target" ];
      wantedBy = [
        remoteCfg.target
      ];
      serviceConfig = {
        Environment = remoteControlEnvironmentList;
        ExecStart = lib.escapeShellArgs (
          [
            (lib.getExe remoteCfg.package)
            "app-server"
            "--remote-control"
            "--listen"
            remoteCfg.listen
          ]
          ++ remoteCfg.extraArgs
        );
        Restart = "on-failure";
        RestartSec = 5;
      }
      // lib.optionalAttrs (remoteCfg.environmentFile != null) {
        EnvironmentFile = remoteCfg.environmentFile;
      };
    };
  };
}

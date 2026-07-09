{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.chatgptDesktopLinux;
  remoteCfg = cfg.remoteControl;
  system = pkgs.stdenv.hostPlatform.system;
  flakePackages = self.packages.${system};
  packageName =
    if cfg.remoteMobileControl.enable && cfg.computerUseUi.enable then
      "chatgpt-desktop-computer-use-ui-remote-mobile-control"
    else if cfg.remoteMobileControl.enable then
      "chatgpt-desktop-remote-mobile-control"
    else if cfg.computerUseUi.enable then
      "chatgpt-desktop-computer-use-ui"
    else
      "chatgpt-desktop";
  basePackage = if cfg.package != null then cfg.package else flakePackages.${packageName};
  codexCliPackage =
    if cfg.cliPackage != null then
      cfg.cliPackage
    else if remoteCfg.enable then
      remoteCfg.package
    else
      null;
  codexCliPath = if codexCliPackage != null then lib.getExe' codexCliPackage "codex" else null;
  # Thin wrapper that bakes CODEX_CLI_PATH into the launcher. The `.desktop`
  # entry shipped by the package launches `<pkg>/bin/chatgpt-desktop` by absolute
  # path, so wrapping that binary (and repointing the desktop entry at the
  # wrapper) makes ChatGPT Desktop locate the Codex CLI no matter how it is started --
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
        if [ -e "$out/bin/chatgpt-desktop" ]; then
          rm -f "$out/bin/chatgpt-desktop"
          makeWrapper "${base}/bin/chatgpt-desktop" "$out/bin/chatgpt-desktop" \
            --set-default CODEX_CLI_PATH "${codexCliPath}"
        fi
        desktopFile="$out/share/applications/chatgpt-desktop.desktop"
        if [ -e "$desktopFile" ]; then
          target="$(readlink -f "$desktopFile")"
          rm -f "$desktopFile"
          substitute "$target" "$desktopFile" \
            --replace-fail "${base}/bin/chatgpt-desktop" "$out/bin/chatgpt-desktop"
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
  options.programs.chatgptDesktopLinux = {
    enable = lib.mkEnableOption "ChatGPT Desktop for Linux";

    package = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = null;
      defaultText = lib.literalExpression ''
        inputs.chatgpt-desktop-linux.packages.''${pkgs.stdenv.hostPlatform.system}.chatgpt-desktop
      '';
      description = ''
        ChatGPT Desktop package to install. When unset, the module selects one of
        this flake's package variants from
        {option}`programs.chatgptDesktopLinux.computerUseUi.enable` and
        {option}`programs.chatgptDesktopLinux.remoteMobileControl.enable`.
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
        `codex` binary. This lets ChatGPT Desktop locate the Codex CLI regardless of how
        it is started — graphical autostart, application launcher, terminal, or a
        warm-start handoff to an already-running instance — without depending on
        the session/login {env}`PATH` and without requiring a re-login for the
        setting to take effect. An explicit {env}`CODEX_CLI_PATH` already in the
        environment still wins.

        When unset, the module falls back to
        {option}`programs.chatgptDesktopLinux.remoteControl.package` if
        {option}`programs.chatgptDesktopLinux.remoteControl.enable` is set;
        otherwise the launcher is left unwrapped and ChatGPT Desktop relies on
        discovering `codex` on {env}`PATH`.
      '';
    };

    computerUseUi.enable = lib.mkEnableOption "the Linux Computer Use UI package variant";

    remoteMobileControl.enable = lib.mkEnableOption "the experimental Linux mobile remote-control package variant";

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
        type = lib.types.nullOr lib.types.path;
        default = null;
        example = "/run/secrets/codex-remote-control.env";
        description = ''
          Additional environment file as defined in {manpage}`systemd.exec(5)`.
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
        message = "`programs.chatgptDesktopLinux.remoteControl.enable` is only supported on Linux";
      }
    ];

    environment.systemPackages = [
      desktopPackage
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

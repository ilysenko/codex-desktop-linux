{ self }:
{ config, lib, pkgs, ... }:
let
  cfg = config.programs.codexDesktopLinux;
  remote = cfg.remoteControl;
  remoteEnvironmentFilePath =
    if remote.environmentFile == null then null else lib.removePrefix "-" remote.environmentFile;
  remoteEnvironmentFileSegments =
    if remoteEnvironmentFilePath == null then [ ] else lib.drop 1 (lib.splitString "/" remoteEnvironmentFilePath);
  remoteEnvironmentFileIsCanonical =
    remoteEnvironmentFilePath != null
    && lib.hasPrefix "/" remoteEnvironmentFilePath
    && lib.all (segment: segment != "" && segment != "." && segment != "..") remoteEnvironmentFileSegments;
  system = pkgs.stdenv.hostPlatform.system;
  selection = import ./package-selection.nix {
    inherit cfg lib;
    flakePackages = self.packages.${system};
  };
  basePackage = selection.package;
  bundledCodexCliPackage = import ./bundled-codex-cli.nix {
    inherit pkgs;
    desktopPackage = basePackage;
  };
  remoteCodexCliPackage =
    if remote.package == null then bundledCodexCliPackage else remote.package;
  codexMicroEnabled =
    cfg.package == null
    && lib.elem "codex-micro" selection.normalizedFeatureIds;
  codexCliPackage =
    if cfg.cliPackage != null then cfg.cliPackage
    else if remote.enable then remoteCodexCliPackage
    else null;
  codexCliPath = if codexCliPackage == null then null else lib.getExe' codexCliPackage "codex";
  withCodexCliPath = base:
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
  desktopPackage = if codexCliPath == null then basePackage else withCodexCliPath basePackage;
  serviceCodexHome = if remote.codexHome == null then "%h/.codex" else remote.codexHome;
  sessionCodexHome = if remote.codexHome == null then "$HOME/.codex" else remote.codexHome;
  prepareCodexHome = lib.escapeShellArgs [ "${pkgs.coreutils}/bin/mkdir" "-p" serviceCodexHome ];
  listenIsUnixSocket =
    remote.listen == "unix://"
    || builtins.match "unix:///[^/].*" remote.listen != null;
  serviceSocket = if remote.listen == "unix://" then "${serviceCodexHome}/app-server-control/app-server-control.sock"
    else lib.removePrefix "unix://" remote.listen;
  sessionSocket = if remote.listen == "unix://" then "${sessionCodexHome}/app-server-control/app-server-control.sock"
    else lib.removePrefix "unix://" remote.listen;
  remotePath = lib.makeSearchPath "bin" ([ "/run/current-system/sw" ] ++ remote.extraPackages);
  remoteEnvironment = {
    CODEX_HOME = serviceCodexHome;
    PATH = remotePath;
  } // remote.environment;
  remoteEnvironmentList = lib.mapAttrsToList
    (name: value: "${name}=${if lib.isBool value then lib.boolToString value else toString value}")
    (lib.filterAttrs (_name: value: value != null) remoteEnvironment);
in {
  options.programs.codexDesktopLinux = {
    enable = lib.mkEnableOption "codex-desktop based on OpenAI's official Linux package";
    package = lib.mkOption { type = lib.types.nullOr lib.types.package; default = null; };
    cliPackage = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = null;
      example = lib.literalExpression "pkgs.codex";
      description = ''
        Optional Codex CLI package baked into the Desktop launcher as the
        default CODEX_CLI_PATH. An explicit environment value still wins.
        When unset, Desktop uses the CLI bundled in the official package,
        except that an enabled remote-control service supplies its package.
      '';
    };
    computerUseUi.enable = lib.mkEnableOption "the computer-use-linux feature";
    remoteMobileControl.enable = lib.mkEnableOption "the remote-mobile-control feature";
    linuxFeatures = lib.mkOption {
      type = (import ./linux-features.nix { inherit lib; }).optionType;
      default = [ ];
    };
    remoteControl = {
      enable = lib.mkEnableOption "a system-wide user remote-control app-server unit";
      package = lib.mkOption {
        type = lib.types.nullOr lib.types.package;
        default = null;
        example = lib.literalExpression "pkgs.codex";
        description = ''
          Optional Codex CLI package for the remote-control app-server.
          When unset, the compatible CLI bundled in the selected official
          Desktop package is used. An override must support the app-server
          --remote-control and --listen arguments.
        '';
      };
      codexHome = lib.mkOption { type = lib.types.nullOr lib.types.str; default = null; };
      listen = lib.mkOption { type = lib.types.str; default = "unix://"; };
      target = lib.mkOption { type = lib.types.str; default = "default.target"; };
      environment = lib.mkOption {
        type = lib.types.attrsOf (lib.types.nullOr (lib.types.oneOf [ lib.types.bool lib.types.int lib.types.str ]));
        default = { };
      };
      environmentFile = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "/run/secrets/codex-remote-control.env";
        description = "Absolute canonical runtime path outside the Nix store, optionally prefixed with `-`.";
      };
      extraPackages = lib.mkOption {
        type = lib.types.listOf lib.types.package;
        default = with pkgs; [ bash coreutils findutils git gnugrep gnused openssh ];
      };
      extraArgs = lib.mkOption { type = lib.types.listOf lib.types.str; default = [ ]; };
      disableLauncherAutostart = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Prevent the mutable launcher hook from starting a second remote-control daemon.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = !remote.enable || pkgs.stdenv.hostPlatform.isLinux;
        message = "programs.codexDesktopLinux.remoteControl.enable is only supported on Linux";
      }
      {
        assertion = !remote.enable || listenIsUnixSocket;
        message = "remoteControl.listen must be unix:// or an absolute unix:///path";
      }
      {
        assertion = remote.environmentFile == null
          || (!builtins.hasContext remote.environmentFile && remoteEnvironmentFileIsCanonical);
        message = "remoteControl.environmentFile must be an absolute canonical runtime path without Nix store context, optionally prefixed with -";
      }
      {
        assertion = remote.environmentFile == null
          || (remoteEnvironmentFilePath != builtins.storeDir
            && !lib.hasPrefix "${builtins.storeDir}/" remoteEnvironmentFilePath);
        message = "remoteControl.environmentFile must be a runtime path outside the Nix store";
      }
    ];
    environment.systemPackages = [ desktopPackage ];
    services.udev.packages = lib.optionals codexMicroEnabled [ basePackage ];
    environment.sessionVariables = lib.mkIf remote.enable ({
      CODEX_REMOTE_CONTROL_APP_SERVER_MODE = "proxy";
      CODEX_REMOTE_CONTROL_APP_SERVER_PROXY_SOCKET = sessionSocket;
    } // lib.optionalAttrs remote.disableLauncherAutostart {
      CODEX_REMOTE_CONTROL_DAEMON_AUTOSTART_DISABLED = "1";
    });
    systemd.user.services.codex-remote-control = lib.mkIf remote.enable {
      description = "Codex remote-control app-server";
      after = [ "network.target" ];
      wantedBy = [ remote.target ];
      serviceConfig = {
        ExecStartPre = prepareCodexHome;
        ExecStart = lib.escapeShellArgs ([
          (lib.getExe' remoteCodexCliPackage "codex")
          "app-server"
          "--remote-control"
          "--listen"
          remote.listen
        ] ++ remote.extraArgs);
        Restart = "on-failure";
        RestartSec = 5;
        Environment = remoteEnvironmentList;
      } // lib.optionalAttrs (remote.environmentFile != null) {
        EnvironmentFile = remote.environmentFile;
      };
    };
  };
}

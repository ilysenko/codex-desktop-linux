{ pkgs, desktopPackage }:
pkgs.runCommand "codex-desktop-bundled-cli" { } ''
  bundled_cli=${desktopPackage}/opt/codex-desktop/resources/codex
  if [ ! -x "$bundled_cli" ]; then
    echo "The selected codex-desktop package does not provide an executable bundled Codex CLI at $bundled_cli" >&2
    exit 1
  fi
  mkdir -p "$out/bin"
  ln -s "$bundled_cli" "$out/bin/codex"
''

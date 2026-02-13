{
  lib,
  stdenv,
  fetchurl,
  p7zip,
  asar,
  nodejs_20,
  python3,
  makeWrapper,
  electron_40,
}:
stdenv.mkDerivation {
  pname = "codex-desktop";
  version = "0.1.0";

  src = fetchurl {
    url = "https://persistent.oaistatic.com/codex-app-prod/Codex.dmg";
    hash = "sha256-CF/xZoxAvX6nwc1poNGUZAKf9bKXNO70snlmhgZ8RnE=";
  };

  nativeBuildInputs = [
    p7zip
    asar
    nodejs_20
    python3
    makeWrapper
    electron_40
  ];

  unpackPhase = ''
    # src is the Codex.dmg file - extract it
    mkdir -p dmg-extract
    echo "Extracting DMG from: $src"
    echo "Source file size: $(du -h "$src" | cut -f1)"

    # Try to extract DMG
    if 7z x -y "$src" -o"dmg-extract" 2>&1; then
      echo "7z extraction succeeded"
    else
      echo "7z extraction failed or produced errors"
      # Continue anyway, files might have been extracted
    fi

    # Find the .app bundle (it's usually in Codex Installer/)
    APP_PATH=$(find dmg-extract -name "Codex.app" -type d | head -1)

    if [ -z "$APP_PATH" ]; then
      echo "Error: Could not find .app bundle in DMG"
      echo "All directories in dmg-extract:"
      find dmg-extract -type d
      exit 1
    fi

    echo "Found app at: $APP_PATH"

    # Copy app to current directory for processing
    cp -r "$APP_PATH" ./Codex.app
    rm -rf dmg-extract
  '';

  patchPhase = ''
    # Extract app.asar from the Resources directory
    RESOURCES_DIR="./Codex.app/Contents/Resources"

    if [ ! -f "$RESOURCES_DIR/app.asar" ]; then
      echo "Error: app.asar not found at $RESOURCES_DIR/app.asar"
      exit 1
    fi

    # Extract asar
    ${asar}/bin/asar extract "$RESOURCES_DIR/app.asar" app-extracted

    # Copy any unpacked resources
    if [ -d "$RESOURCES_DIR/app.asar.unpacked" ]; then
      cp -r "$RESOURCES_DIR/app.asar.unpacked/"* app-extracted/ 2>/dev/null || true
    fi

    # Remove macOS-only modules
    rm -rf app-extracted/node_modules/sparkle-darwin 2>/dev/null || true
    find app-extracted -name "sparkle.node" -delete 2>/dev/null || true
  '';

  configurePhase = ''
    # Note: We skip native module rebuilding due to sandbox restrictions
    # The app contains pre-compiled macOS modules which won't work on Linux anyway
    # For production use, you'll need to rebuild these outside the Nix sandbox
    # or use @electron/rebuild with proper electron headers
    echo "Configuring build (native module rebuild skipped for sandbox compatibility)"
  '';

  buildPhase = ''
    echo "Repacking app.asar..."
    ${asar}/bin/asar pack \
      app-extracted \
      repacked.asar \
      --unpack "{*.node,*.so,*.dylib}" 2>/dev/null || \
    ${asar}/bin/asar pack app-extracted repacked.asar
  '';

  installPhase = ''
        mkdir -p $out/lib/codex-desktop
        mkdir -p $out/bin
        mkdir -p $out/share/applications

        # Copy Electron binary and resources from electron_40
        echo "Setting up Electron 40..."
        cp ${electron_40}/libexec/electron/electron $out/lib/codex-desktop/

        # Copy all Electron resources and supporting files
        mkdir -p $out/lib/codex-desktop/resources

        # Copy pak files and other resources
        for f in ${electron_40}/libexec/electron/*.pak; do
          [ -e "$f" ] && cp "$f" $out/lib/codex-desktop/resources/
        done

        # Copy data files
        for f in ${electron_40}/libexec/electron/*.dat; do
          [ -e "$f" ] && cp "$f" $out/lib/codex-desktop/
        done

        # Copy v8 snapshot
        for f in ${electron_40}/libexec/electron/v8_context_snapshot*.bin; do
          [ -e "$f" ] && cp "$f" $out/lib/codex-desktop/
        done

        # Copy crashpad handler
        if [ -f "${electron_40}/libexec/electron/chrome_crashpad_handler" ]; then
          cp "${electron_40}/libexec/electron/chrome_crashpad_handler" $out/lib/codex-desktop/
        fi

        # Copy any other necessary binaries
        for bin in ${electron_40}/libexec/electron/chrome_*.so ${electron_40}/libexec/electron/libEGL*.so* ${electron_40}/libexec/electron/libGLES*.so*; do
          [ -e "$bin" ] && cp "$bin" $out/lib/codex-desktop/ 2>/dev/null || true
        done

        # Copy patched app.asar
        if [ -f repacked.asar ]; then
          cp repacked.asar $out/lib/codex-desktop/resources/app.asar
        elif [ -f "Codex.app/Contents/Resources/app.asar" ]; then
          cp "Codex.app/Contents/Resources/app.asar" $out/lib/codex-desktop/resources/app.asar
        else
          echo "Error: No app.asar found"
          exit 1
        fi

        # Copy webview content
        if [ -d "app-extracted/webview" ]; then
          mkdir -p $out/lib/codex-desktop/content/webview
          cp -r app-extracted/webview/* $out/lib/codex-desktop/content/webview/
        fi

        # Create launcher script with proper library paths
        cat > $out/bin/codex-desktop << 'WRAPPER'
#!/bin/bash
export LD_LIBRARY_PATH="${electron_40}/lib:${electron_40}/libexec/electron:$LD_LIBRARY_PATH"
export NIXOS_OZONE_WL=1
export ELECTRON_OZONE_PLATFORM_HINT=wayland

APPDIR="$(dirname "$(dirname "$(readlink -f "$0")")")"
WEBVIEW_DIR="$APPDIR/lib/codex-desktop/content/webview"

if [ -d "$WEBVIEW_DIR" ] && [ -n "$(ls -A "$WEBVIEW_DIR" 2>/dev/null)" ]; then
  cd "$WEBVIEW_DIR"
  ${python3}/bin/python3 -m http.server 5175 > /dev/null 2>&1 &
  HTTP_PID=$!
  trap "kill $HTTP_PID 2>/dev/null" EXIT
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "Warning: Codex CLI not found. Install with: npm i -g @openai/codex" >&2
fi

cd "$APPDIR/lib/codex-desktop"
exec "$APPDIR/lib/codex-desktop/electron" \
  --no-sandbox \
  --ozone-platform=wayland \
  --enable-wayland-ime \
  resources/app.asar "$@"
WRAPPER
        chmod +x $out/bin/codex-desktop

        # Create .desktop file
        mkdir -p $out/share/applications
        cat > $out/share/applications/codex-desktop.desktop << 'EOF'
    [Desktop Entry]
    Name=Codex Desktop
    Exec=@out@/bin/codex-desktop
    Icon=text-editor
    Type=Application
    Categories=Development;IDE;
    StartupWMClass=Codex
    Comment=OpenAI Codex Desktop Application
    EOF
        sed -i "s|@out@|$out|g" $out/share/applications/codex-desktop.desktop
  '';

  dontStrip = true;
  dontPatchELF = true;

  meta = {
    description = "OpenAI Codex Desktop for Linux";
    homepage = "https://github.com/ilysenko/codex-desktop-linux";
    license = lib.licenses.mit;
    platforms = ["x86_64-linux" "aarch64-linux"];
    maintainers = with lib.maintainers; [];
  };
}

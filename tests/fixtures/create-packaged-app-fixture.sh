#!/usr/bin/env bash
set -Eeuo pipefail

app_dir="${1:-codex-app}"
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

mkdir -p "$app_dir/.codex-linux" "$app_dir/content/webview" "$app_dir/resources/node-runtime/bin"

enabled_linux_features_json="${CODEX_FIXTURE_LINUX_FEATURES_JSON:-[]}"
printf '{"schemaVersion":1,"linuxFeatures":{"enabled":%s}}\n' \
    "$enabled_linux_features_json" \
    > "$app_dir/.codex-linux/build-info.json"

printf '%s\n' '#!/usr/bin/env bash' 'echo "codex desktop fixture"' > "$app_dir/start.sh"
chmod +x "$app_dir/start.sh"
printf '%s\n' '<!doctype html><title>Codex fixture</title>' > "$app_dir/content/webview/index.html"
cp "$repo_dir/launcher/cli-launch-path.py" "$app_dir/.codex-linux/cli-launch-path.py"

for binary in node npm npx; do
    cat > "$app_dir/resources/node-runtime/bin/$binary" <<'SCRIPT'
#!/usr/bin/env bash
case "$(basename "$0")" in
    node) echo v22.22.2 ;;
    *) echo 10.9.7 ;;
esac
SCRIPT
    chmod +x "$app_dir/resources/node-runtime/bin/$binary"
done

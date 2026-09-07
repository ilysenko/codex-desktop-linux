#!/usr/bin/env bash
set -u

warn() {
    printf 'WARN: flatpak-chrome-native-messaging: %s\n' "$*" >&2
}

flatpak_root="${CODEX_FLATPAK_CHROME_ROOT:-${HOME:-}/.var/app/com.google.Chrome}"
chrome_config="$flatpak_root/config/google-chrome"
manifest_path="$chrome_config/NativeMessagingHosts/com.openai.codexextension.json"

flatpak_chrome_is_available() {
    if [ -n "${CODEX_FLATPAK_CHROME_ROOT:-}" ]; then
        [ -d "$flatpak_root" ]
        return
    fi
    command -v flatpak >/dev/null 2>&1 && flatpak info com.google.Chrome >/dev/null 2>&1
}

flatpak_chrome_is_available || exit 0

case "${CODEX_LINUX_FEATURE_HOOK_PHASE:-}" in
    launcher)
        printf 'env CODEX_CHROME_USER_DATA_DIR=%s\n' "$chrome_config"
        printf 'env CODEX_CHROME_NATIVE_HOST_MANIFEST_PATH=%s\n' "$manifest_path"
        ;;
    prelaunch|after-exit)
        app_dir="${CODEX_LINUX_APP_DIR:-}"
        state_root="${CODEX_LINUX_APP_STATE_DIR:-}"
        bridge="${CODEX_LINUX_FEATURES_DIR:-}/flatpak-chrome-native-messaging/bridge.mjs"
        node_bin="$app_dir/resources/cua_node/bin/node"
        owner_pid="$PPID"

        if [ -z "$app_dir" ] || [ -z "$state_root" ] || [ ! -f "$bridge" ] || [ ! -x "$node_bin" ]; then
            warn "the packaged Node runtime or bridge resource is unavailable"
            exit 0
        fi

        command=ensure
        [ "${CODEX_LINUX_FEATURE_HOOK_PHASE:-}" = after-exit ] && command=cleanup
        if ! "$node_bin" "$bridge" "$command" \
            --app-dir "$app_dir" \
            --codex-home "${CODEX_HOME:-${HOME:-}/.codex}" \
            --state-dir "$state_root/flatpak-chrome-native-messaging" \
            --flatpak-root "$flatpak_root" \
            --owner-pid "$owner_pid"; then
            warn "could not $command the Flatpak Chrome bridge; the desktop app will continue"
        fi
        ;;
esac

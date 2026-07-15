#!/usr/bin/env bash
set -Eeuo pipefail

package_name="codex-desktop"
app_dir="${CODEX_PACKAGED_APP_DIR:-/opt/$package_name}"
service_unit="${CODEX_PACKAGED_DESKTOP_SERVICE:-$package_name.service}"
runtime_root="${XDG_RUNTIME_DIR:-}"
runtime_dir="${runtime_root:+$runtime_root/$package_name}"

normalize_launch_args() {
    normalized_args=()
    local arg
    for arg in "$@"; do
        case "$arg" in
            --new-instance|--multi-instance|--multi-launch)
                normalized_args+=(--new-window)
                ;;
            *)
                normalized_args+=("$arg")
                ;;
        esac
    done
}

read_service_launch_args() {
    service_launch_args=()
    local pending_args="$runtime_dir/service-launch-args"
    if [ -f "$pending_args" ]; then
        mapfile -d '' -t service_launch_args < "$pending_args" || true
        rm -f "$pending_args"
    fi
}

write_service_launch_args() {
    local pending_args="$runtime_dir/service-launch-args"
    local temporary_args="$pending_args.$$"
    local arg

    : > "$temporary_args"
    chmod 0600 "$temporary_args"
    for arg in "$@"; do
        printf '%s\0' "$arg" >> "$temporary_args"
    done
    mv -f "$temporary_args" "$pending_args"
}

if [ "${1:-}" = "--systemd-service-owner" ]; then
    shift
    [ -n "$runtime_dir" ] || {
        echo "XDG_RUNTIME_DIR is required for $service_unit" >&2
        exit 1
    }
    mkdir -p "$runtime_dir"
    chmod 0700 "$runtime_dir"
    read_service_launch_args
    unset CODEX_MULTI_LAUNCH CODEX_LINUX_MULTI_LAUNCH
    exec "$app_dir/start.sh" "${service_launch_args[@]}" "$@"
fi

normalize_launch_args "$@"
unset CODEX_MULTI_LAUNCH CODEX_LINUX_MULTI_LAUNCH

systemd_user_available() {
    [ -n "$runtime_dir" ] || return 1
    command -v systemctl >/dev/null 2>&1 || return 1
    command -v flock >/dev/null 2>&1 || return 1
    systemctl --user show-environment >/dev/null 2>&1
}

import_graphical_environment() {
    local -a names=()
    local name
    for name in \
        PATH \
        DISPLAY \
        WAYLAND_DISPLAY \
        DBUS_SESSION_BUS_ADDRESS \
        XAUTHORITY \
        XDG_RUNTIME_DIR \
        XDG_SESSION_TYPE \
        XDG_CURRENT_DESKTOP \
        XDG_SESSION_DESKTOP \
        HYPRLAND_INSTANCE_SIGNATURE \
        CODEX_CLI_PATH \
        CODEX_HOME
    do
        [ -n "${!name+x}" ] && names+=("$name")
    done
    [ "${#names[@]}" -eq 0 ] || systemctl --user import-environment "${names[@]}" >/dev/null 2>&1 || true
}

if ! systemd_user_available; then
    exec "$app_dir/start.sh" "${normalized_args[@]}"
fi

mkdir -p "$runtime_dir"
chmod 0700 "$runtime_dir"
exec 9> "$runtime_dir/systemd-launch.lock"
if ! flock -w 20 9; then
    echo "Timed out waiting to start $service_unit" >&2
    exit 1
fi

import_graphical_environment
if systemctl --user is-active --quiet "$service_unit"; then
    CODEX_LINUX_SYSTEMD_HANDOFF_ONLY=1 exec "$app_dir/start.sh" "${normalized_args[@]}"
fi

write_service_launch_args "${normalized_args[@]}"
if ! systemctl --user start "$service_unit"; then
    rm -f "$runtime_dir/service-launch-args"
    echo "Failed to start $service_unit" >&2
    exit 1
fi
# The service owner consumes and removes service-launch-args. Type=exec may
# report startup before that shell has read the file, so the caller must not
# race it by deleting the handoff after a successful start.

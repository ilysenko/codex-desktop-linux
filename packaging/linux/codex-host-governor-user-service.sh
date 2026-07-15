#!/bin/sh

CODEX_HOST_GOVERNOR_SOCKET="${CODEX_HOST_GOVERNOR_SOCKET:-codex-host-governor.socket}"
CODEX_HOST_GOVERNOR_SERVICE="${CODEX_HOST_GOVERNOR_SERVICE:-codex-host-governor.service}"
CODEX_HOST_GOVERNOR_SOURCE="${CODEX_HOST_GOVERNOR_SOURCE:-/usr/libexec/codex-host-governor}"

codex_host_governor_foreach_user_manager() {
    if ! command -v runuser >/dev/null 2>&1 ||
        ! command -v systemctl >/dev/null 2>&1 ||
        ! command -v getent >/dev/null 2>&1; then
        return
    fi

    for runtime_dir in /run/user/*; do
        [ -d "$runtime_dir" ] || continue
        uid="$(basename "$runtime_dir")"
        case "$uid" in
            ''|*[!0-9]*|0) continue ;;
        esac
        bus="$runtime_dir/bus"
        [ -S "$bus" ] || continue
        passwd_entry="$(getent passwd "$uid" || true)"
        user_name="$(printf '%s\n' "$passwd_entry" | cut -d: -f1)"
        home_dir="$(printf '%s\n' "$passwd_entry" | cut -d: -f6)"
        [ -n "$user_name" ] || continue
        case "$home_dir" in
            /*) [ "$home_dir" != / ] || continue ;;
            *) continue ;;
        esac
        "$@" "$user_name" "$home_dir" "$runtime_dir" "$bus"
    done
}

codex_host_governor_systemctl_user() {
    user_name="$1"
    runtime_dir="$2"
    bus="$3"
    shift 3
    runuser -u "$user_name" -- env \
        XDG_RUNTIME_DIR="$runtime_dir" \
        DBUS_SESSION_BUS_ADDRESS="unix:path=$bus" \
        systemctl --user "$@" >/dev/null 2>&1
}

codex_host_governor_mirror_for_user() {
    user_name="$1"
    home_dir="$2"
    [ -x "$CODEX_HOST_GOVERNOR_SOURCE" ] || return 0
    # Variables expand inside the user-owned sh.
    # shellcheck disable=SC2016
    runuser -u "$user_name" -- sh -eu -c '
        home_dir="$1"
        source_path="$2"
        target_dir="$home_dir/.local/libexec"
        target="$target_dir/codex-host-governor"
        temporary="$target.tmp.$$"
        umask 077
        mkdir -p "$target_dir"
        trap '\''rm -f "$temporary"'\'' EXIT HUP INT TERM
        cp "$source_path" "$temporary"
        chmod 0755 "$temporary"
        mv -f "$temporary" "$target"
        trap - EXIT HUP INT TERM
    ' sh "$home_dir" "$CODEX_HOST_GOVERNOR_SOURCE"
}

codex_host_governor_ensure_one() {
    user_name="$1"
    home_dir="$2"
    runtime_dir="$3"
    bus="$4"

    codex_host_governor_mirror_for_user "$user_name" "$home_dir" || true
    codex_host_governor_systemctl_user "$user_name" "$runtime_dir" "$bus" daemon-reload || true
    codex_host_governor_systemctl_user "$user_name" "$runtime_dir" "$bus" \
        enable --now "$CODEX_HOST_GOVERNOR_SOCKET" || true
}

codex_host_governor_ensure_running() {
    codex_host_governor_foreach_user_manager codex_host_governor_ensure_one
}

codex_host_governor_cleanup_one() {
    user_name="$1"
    _home_dir="$2"
    runtime_dir="$3"
    bus="$4"

    codex_host_governor_systemctl_user "$user_name" "$runtime_dir" "$bus" \
        stop "$CODEX_HOST_GOVERNOR_SERVICE" "$CODEX_HOST_GOVERNOR_SOCKET" || true
    codex_host_governor_systemctl_user "$user_name" "$runtime_dir" "$bus" \
        disable "$CODEX_HOST_GOVERNOR_SOCKET" || true
    codex_host_governor_systemctl_user "$user_name" "$runtime_dir" "$bus" daemon-reload || true
}

codex_host_governor_cleanup() {
    codex_host_governor_foreach_user_manager codex_host_governor_cleanup_one
}

codex_host_governor_reload_one() {
    user_name="$1"
    _home_dir="$2"
    runtime_dir="$3"
    bus="$4"
    codex_host_governor_systemctl_user "$user_name" "$runtime_dir" "$bus" daemon-reload || true
}

codex_host_governor_reload_managers() {
    codex_host_governor_foreach_user_manager codex_host_governor_reload_one
}

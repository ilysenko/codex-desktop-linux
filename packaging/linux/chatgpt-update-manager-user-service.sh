#!/bin/sh

SERVICE_NAME="${SERVICE_NAME:-chatgpt-update-manager.service}"
LEGACY_SERVICE_NAME="${LEGACY_SERVICE_NAME:-codex-update-manager.service}"

codex_foreach_user_manager() {
    if ! command -v runuser >/dev/null 2>&1 || ! command -v systemctl >/dev/null 2>&1; then
        return
    fi

    for runtime_dir in /run/user/*; do
        [ -d "$runtime_dir" ] || continue

        uid="$(basename "$runtime_dir")"
        case "$uid" in
            ''|*[!0-9]*|0)
                continue
                ;;
        esac

        bus="$runtime_dir/bus"
        [ -S "$bus" ] || continue

        user_name="$(getent passwd "$uid" | cut -d: -f1 || true)"
        [ -n "$user_name" ] || continue

        "$@" "$user_name" "$runtime_dir" "$bus"
    done
}

codex_run_systemctl_user() {
    user_name="$1"
    runtime_dir="$2"
    bus="$3"
    shift 3

    runuser -u "$user_name" -- env \
        XDG_RUNTIME_DIR="$runtime_dir" \
        DBUS_SESSION_BUS_ADDRESS="unix:path=$bus" \
        systemctl --user "$@" >/dev/null 2>&1
}

codex_reload_user_managers() {
    codex_foreach_user_manager codex_reload_one_user_manager
}

codex_reload_one_user_manager() {
    codex_run_systemctl_user "$1" "$2" "$3" daemon-reload || true
}

codex_ensure_user_service_running() {
    codex_foreach_user_manager codex_ensure_one_user_service_running
}

codex_start_enabled_user_service() {
    codex_foreach_user_manager codex_start_one_enabled_user_service
}

codex_disable_legacy_user_service() {
    if [ -z "$LEGACY_SERVICE_NAME" ] || [ "$LEGACY_SERVICE_NAME" = "$SERVICE_NAME" ]; then
        return
    fi

    codex_foreach_user_manager codex_disable_one_legacy_user_service
}

codex_disable_one_legacy_user_service() {
    user_name="$1"
    runtime_dir="$2"
    bus="$3"

    if [ -z "$LEGACY_SERVICE_NAME" ] || [ "$LEGACY_SERVICE_NAME" = "$SERVICE_NAME" ]; then
        return
    fi

    codex_run_systemctl_user "$user_name" "$runtime_dir" "$bus" stop "$LEGACY_SERVICE_NAME" || true
    codex_run_systemctl_user "$user_name" "$runtime_dir" "$bus" disable "$LEGACY_SERVICE_NAME" || true
}

codex_ensure_one_user_service_running() {
    user_name="$1"
    runtime_dir="$2"
    bus="$3"

    codex_run_systemctl_user "$user_name" "$runtime_dir" "$bus" daemon-reload || true
    codex_disable_one_legacy_user_service "$user_name" "$runtime_dir" "$bus"

    if codex_run_systemctl_user "$user_name" "$runtime_dir" "$bus" is-active "$SERVICE_NAME"; then
        return
    fi

    if codex_run_systemctl_user "$user_name" "$runtime_dir" "$bus" is-enabled "$SERVICE_NAME"; then
        codex_run_systemctl_user "$user_name" "$runtime_dir" "$bus" start "$SERVICE_NAME" || true
    else
        codex_run_systemctl_user "$user_name" "$runtime_dir" "$bus" enable --now "$SERVICE_NAME" || true
    fi
}

codex_start_one_enabled_user_service() {
    user_name="$1"
    runtime_dir="$2"
    bus="$3"

    codex_run_systemctl_user "$user_name" "$runtime_dir" "$bus" daemon-reload || true
    codex_disable_one_legacy_user_service "$user_name" "$runtime_dir" "$bus"

    if codex_run_systemctl_user "$user_name" "$runtime_dir" "$bus" is-active "$SERVICE_NAME"; then
        return
    fi

    if codex_run_systemctl_user "$user_name" "$runtime_dir" "$bus" is-enabled "$SERVICE_NAME"; then
        codex_run_systemctl_user "$user_name" "$runtime_dir" "$bus" start "$SERVICE_NAME" || true
    fi
}

codex_cleanup_user_service() {
    action="$1"
    codex_foreach_user_manager codex_cleanup_one_user_service "$action"
}

codex_cleanup_one_user_service() {
    action="$1"
    user_name="$2"
    runtime_dir="$3"
    bus="$4"

    codex_run_systemctl_user "$user_name" "$runtime_dir" "$bus" "$action" "$SERVICE_NAME" || true
    if [ -n "$LEGACY_SERVICE_NAME" ] && [ "$LEGACY_SERVICE_NAME" != "$SERVICE_NAME" ]; then
        codex_run_systemctl_user "$user_name" "$runtime_dir" "$bus" "$action" "$LEGACY_SERVICE_NAME" || true
    fi
    codex_run_systemctl_user "$user_name" "$runtime_dir" "$bus" daemon-reload || true
}

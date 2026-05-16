#!/bin/bash

codex_packaged_runtime_prelaunch() {
    codex_packaged_runtime_prelaunch_background >/dev/null 2>&1 &
}

codex_packaged_runtime_prelaunch_background() {
    if ! command -v systemctl >/dev/null 2>&1; then
        return 0
    fi

    if [ -z "${XDG_RUNTIME_DIR:-}" ] || [ ! -d "$XDG_RUNTIME_DIR" ]; then
        return 0
    fi

    if ! systemctl --user show-environment >/dev/null 2>&1; then
        return 0
    fi

    systemctl --user import-environment \
        PATH \
        DISPLAY \
        WAYLAND_DISPLAY \
        DBUS_SESSION_BUS_ADDRESS \
        XAUTHORITY \
        XDG_RUNTIME_DIR \
        HYPRLAND_INSTANCE_SIGNATURE \
        YDOTOOL_SOCKET >/dev/null 2>&1 || true

    if command -v dbus-update-activation-environment >/dev/null 2>&1; then
        dbus-update-activation-environment --systemd \
            PATH \
            DISPLAY \
            WAYLAND_DISPLAY \
            DBUS_SESSION_BUS_ADDRESS \
            XAUTHORITY \
            XDG_RUNTIME_DIR \
            HYPRLAND_INSTANCE_SIGNATURE \
            YDOTOOL_SOCKET >/dev/null 2>&1 || true
    fi

    if systemctl --user is-enabled codex-update-manager.service >/dev/null 2>&1; then
        systemctl --user start codex-update-manager.service >/dev/null 2>&1 || true
    else
        systemctl --user enable --now codex-update-manager.service >/dev/null 2>&1 || true
    fi

    codex_packaged_runtime_trigger_update_check
}

codex_packaged_runtime_trigger_update_check() {
    if ! command -v codex-update-manager >/dev/null 2>&1; then
        return 0
    fi

    if command -v systemd-run >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
        systemd-run --user \
            --unit=codex-update-manager-launch-check \
            --collect \
            --quiet \
            /usr/bin/codex-update-manager check-now --if-stale >/dev/null 2>&1 || true
        return 0
    fi

    codex-update-manager check-now --if-stale >/dev/null 2>&1 || true
}

codex_packaged_runtime_export_env() {
    export CHROME_DESKTOP="codex-desktop.desktop"
    export BAMF_DESKTOP_FILE_HINT="/usr/share/applications/codex-desktop.desktop"
}

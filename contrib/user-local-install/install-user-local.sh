#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FILES_DIR="${SCRIPT_DIR}/files"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OPT_ROOT="${HOME}/.local/opt/codex-desktop-linux"
OPT_BIN_DIR="${OPT_ROOT}/bin"
OPT_LIB_DIR="${OPT_ROOT}/lib/codex-desktop-linux"
STATE_DIR="${XDG_STATE_HOME:-${HOME}/.local/state}/codex-desktop-linux"
FROM_UPDATE=0
ENABLE_TIMER=0
ENV_CODEX_RELEASE_TRACK="${CODEX_RELEASE_TRACK:-}"

if [ -f "${STATE_DIR}/install.env" ]; then
    # shellcheck disable=SC1090
    source "${STATE_DIR}/install.env"
fi
CODEX_RELEASE_TRACK="${ENV_CODEX_RELEASE_TRACK:-${CODEX_RELEASE_TRACK:-stable}}"

while [ $# -gt 0 ]; do
    case "$1" in
        --from-update)
            FROM_UPDATE=1
            ;;
        --enable-timer)
            ENABLE_TIMER=1
            ;;
        --track)
            shift
            [ $# -gt 0 ] || { echo "--track requires stable or preview" >&2; exit 2; }
            CODEX_RELEASE_TRACK="$1"
            ;;
        --track=*)
            CODEX_RELEASE_TRACK="${1#*=}"
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 2
            ;;
    esac
    shift
done

case "$CODEX_RELEASE_TRACK" in
    stable|preview) ;;
    *) echo "Unknown release track: $CODEX_RELEASE_TRACK (expected stable or preview)" >&2; exit 2 ;;
esac

copy_file() {
    local src="$1"
    local dst="$2"
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
}

install_manager_files() {
    local systemd_user_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
    local install_config_tmp
    mkdir -p "$OPT_BIN_DIR" "$OPT_LIB_DIR" "${HOME}/.local/share/applications" "${HOME}/.local/bin" "$STATE_DIR" "$systemd_user_dir"
    chmod 700 "$STATE_DIR"

    copy_file "${FILES_DIR}/.local/lib/codex-desktop-linux/common.sh" "${OPT_LIB_DIR}/common.sh"
    copy_file "${FILES_DIR}/.local/bin/codex-desktop" "${OPT_BIN_DIR}/codex-desktop"
    copy_file "${FILES_DIR}/.local/bin/codex-desktop-check-update" "${OPT_BIN_DIR}/codex-desktop-check-update"
    copy_file "${FILES_DIR}/.local/bin/codex-desktop-update" "${OPT_BIN_DIR}/codex-desktop-update"
    copy_file "${FILES_DIR}/.local/bin/codex-desktop-version" "${OPT_BIN_DIR}/codex-desktop-version"

    cat > "${HOME}/.local/bin/codex-desktop" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec "${HOME}/.local/opt/codex-desktop-linux/bin/codex-desktop" "$@"
EOF
    cat > "${HOME}/.local/bin/codex-desktop-check-update" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec "${HOME}/.local/opt/codex-desktop-linux/bin/codex-desktop-check-update" "$@"
EOF
    cat > "${HOME}/.local/bin/codex-desktop-update" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec "${HOME}/.local/opt/codex-desktop-linux/bin/codex-desktop-update" "$@"
EOF
    cat > "${HOME}/.local/bin/codex-desktop-version" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec "${HOME}/.local/opt/codex-desktop-linux/bin/codex-desktop-version" "$@"
EOF

    sed "s|@HOME@|${HOME}|g" "${FILES_DIR}/.local/share/applications/codex-desktop.desktop" > "${HOME}/.local/share/applications/codex-desktop.desktop"

    copy_file "${FILES_DIR}/.config/systemd/user/codex-desktop-update.service" "${systemd_user_dir}/codex-desktop-update.service"
    copy_file "${FILES_DIR}/.config/systemd/user/codex-desktop-update.timer" "${systemd_user_dir}/codex-desktop-update.timer"

    install_config_tmp="$(mktemp "${STATE_DIR}/install.env.tmp.XXXXXX")"
    chmod 600 "$install_config_tmp"
    cat > "$install_config_tmp" <<EOF
REPO_DIR=$(printf '%q' "$REPO_ROOT")
OPT_ROOT=$(printf '%q' "$OPT_ROOT")
CODEX_RELEASE_TRACK=$(printf '%q' "$CODEX_RELEASE_TRACK")
EOF
    mv "$install_config_tmp" "${STATE_DIR}/install.env"

    chmod +x \
        "${OPT_BIN_DIR}/codex-desktop" \
        "${OPT_BIN_DIR}/codex-desktop-check-update" \
        "${OPT_BIN_DIR}/codex-desktop-update" \
        "${OPT_BIN_DIR}/codex-desktop-version" \
        "${OPT_LIB_DIR}/common.sh" \
        "${HOME}/.local/bin/codex-desktop" \
        "${HOME}/.local/bin/codex-desktop-check-update" \
        "${HOME}/.local/bin/codex-desktop-update" \
        "${HOME}/.local/bin/codex-desktop-version"
}

install_manager_files

if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    if [ "$ENABLE_TIMER" -eq 1 ]; then
        systemctl --user enable --now codex-desktop-update.timer >/dev/null 2>&1 || true
    fi
fi

if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "${HOME}/.local/share/applications" >/dev/null 2>&1 || true
fi

if [ -x "${HOME}/.local/bin/codex-desktop-update" ]; then
    "${HOME}/.local/bin/codex-desktop-update" --record-only >/dev/null 2>&1 || true
fi

if [ "$FROM_UPDATE" -eq 0 ]; then
    echo "Installed user-local Codex desktop integration."
fi

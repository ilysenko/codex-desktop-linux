#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FILES_DIR="${SCRIPT_DIR}/files"
SCRIPT_REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SOURCE_REPO_ROOT="${CODEX_USER_LOCAL_SOURCE_REPO_DIR:-$SCRIPT_REPO_ROOT}"
DESKTOP_ENTRY_DOCTOR="${SOURCE_REPO_ROOT}/packaging/linux/chatgpt-desktop-entry-doctor.sh"
OPT_ROOT="${HOME}/.local/opt/chatgpt-desktop-linux"
OPT_BIN_DIR="${OPT_ROOT}/bin"
OPT_LIB_DIR="${OPT_ROOT}/lib/chatgpt-desktop-linux"
XDG_DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-${HOME}/.config}"
DATA_DIR="${XDG_DATA_HOME}/chatgpt-desktop-linux"
CONFIG_DIR="${XDG_CONFIG_HOME}/chatgpt-desktop-linux"
USER_LOCAL_ENV_FILE="${CONFIG_DIR}/user-local.env"
MANAGED_REPO_DIR="${DATA_DIR}/managed-repo"
STATE_DIR="${XDG_STATE_HOME:-${HOME}/.local/state}/chatgpt-desktop-linux"
FROM_UPDATE=0
ENABLE_TIMER=0
USER_LOCAL_OZONE_PLATFORM_SETTING=""

# shellcheck disable=SC1090
. "$DESKTOP_ENTRY_DOCTOR"

while [ $# -gt 0 ]; do
    case "$1" in
        --from-update)
            FROM_UPDATE=1
            ;;
        --enable-timer)
            ENABLE_TIMER=1
            ;;
        --force-x11|--x11-fallback)
            USER_LOCAL_OZONE_PLATFORM_SETTING="x11"
            ;;
        --no-force-x11|--no-x11-fallback)
            USER_LOCAL_OZONE_PLATFORM_SETTING="auto"
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 2
            ;;
    esac
    shift
done

copy_file() {
    local src="$1"
    local dst="$2"
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
}

write_user_local_preferences() {
    [ -n "$USER_LOCAL_OZONE_PLATFORM_SETTING" ] || return 0

    mkdir -p "$CONFIG_DIR"
    cat > "$USER_LOCAL_ENV_FILE" <<EOF
CODEX_USER_LOCAL_OZONE_PLATFORM=$(printf '%q' "$USER_LOCAL_OZONE_PLATFORM_SETTING")
EOF
}

repo_origin_url() {
    if [ -d "${SOURCE_REPO_ROOT}/.git" ]; then
        git -C "$SOURCE_REPO_ROOT" remote get-url origin 2>/dev/null || true
    fi
}

detected_repo_default_branch() {
    local branch=""
    if [ -d "${SOURCE_REPO_ROOT}/.git" ]; then
        branch="$(git -C "$SOURCE_REPO_ROOT" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
        branch="${branch#origin/}"
        if [ -z "$branch" ]; then
            branch="$(git -C "$SOURCE_REPO_ROOT" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
            if [ -n "$branch" ] && ! git -C "$SOURCE_REPO_ROOT" rev-parse --verify --quiet "refs/remotes/origin/$branch" >/dev/null; then
                branch=""
            fi
        fi
    fi
    printf '%s\n' "$branch"
}

install_manager_files() {
    local systemd_user_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
    mkdir -p "$OPT_BIN_DIR" "$OPT_LIB_DIR" "$DATA_DIR" "${HOME}/.local/share/applications" "${HOME}/.local/bin" "$STATE_DIR" "$systemd_user_dir"

    copy_file "${FILES_DIR}/.local/lib/chatgpt-desktop-linux/common.sh" "${OPT_LIB_DIR}/common.sh"
    copy_file "${FILES_DIR}/.local/bin/chatgpt-desktop" "${OPT_BIN_DIR}/chatgpt-desktop"
    copy_file "${FILES_DIR}/.local/bin/chatgpt-desktop-check-update" "${OPT_BIN_DIR}/chatgpt-desktop-check-update"
    copy_file "${FILES_DIR}/.local/bin/chatgpt-desktop-update" "${OPT_BIN_DIR}/chatgpt-desktop-update"
    copy_file "${FILES_DIR}/.local/bin/chatgpt-desktop-version" "${OPT_BIN_DIR}/chatgpt-desktop-version"

    cat > "${HOME}/.local/bin/chatgpt-desktop" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec "${HOME}/.local/opt/chatgpt-desktop-linux/bin/chatgpt-desktop" "$@"
EOF
    cat > "${HOME}/.local/bin/chatgpt-desktop-check-update" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec "${HOME}/.local/opt/chatgpt-desktop-linux/bin/chatgpt-desktop-check-update" "$@"
EOF
    cat > "${HOME}/.local/bin/chatgpt-desktop-update" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec "${HOME}/.local/opt/chatgpt-desktop-linux/bin/chatgpt-desktop-update" "$@"
EOF
    cat > "${HOME}/.local/bin/chatgpt-desktop-version" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec "${HOME}/.local/opt/chatgpt-desktop-linux/bin/chatgpt-desktop-version" "$@"
EOF

    codex_desktop_write_user_local_entry \
        "${FILES_DIR}/.local/share/applications/chatgpt-desktop.desktop" \
        "${HOME}/.local/share/applications/chatgpt-desktop.desktop" \
        "${HOME}"

    copy_file "${FILES_DIR}/.config/systemd/user/chatgpt-desktop-update.service" "${systemd_user_dir}/chatgpt-desktop-update.service"
    copy_file "${FILES_DIR}/.config/systemd/user/chatgpt-desktop-update.timer" "${systemd_user_dir}/chatgpt-desktop-update.timer"

    cat > "${STATE_DIR}/install.env" <<EOF
REPO_DIR=$(printf '%q' "$SOURCE_REPO_ROOT")
SOURCE_REPO_DIR=$(printf '%q' "$SOURCE_REPO_ROOT")
MANAGED_REPO_DIR=$(printf '%q' "$MANAGED_REPO_DIR")
REPO_ORIGIN_URL=$(printf '%q' "$(repo_origin_url)")
REPO_DEFAULT_BRANCH=$(printf '%q' "$(detected_repo_default_branch)")
OPT_ROOT=$(printf '%q' "$OPT_ROOT")
EOF

    chmod +x \
        "${OPT_BIN_DIR}/chatgpt-desktop" \
        "${OPT_BIN_DIR}/chatgpt-desktop-check-update" \
        "${OPT_BIN_DIR}/chatgpt-desktop-update" \
        "${OPT_BIN_DIR}/chatgpt-desktop-version" \
        "${OPT_LIB_DIR}/common.sh" \
        "${HOME}/.local/bin/chatgpt-desktop" \
        "${HOME}/.local/bin/chatgpt-desktop-check-update" \
        "${HOME}/.local/bin/chatgpt-desktop-update" \
        "${HOME}/.local/bin/chatgpt-desktop-version"
}

install_manager_files
write_user_local_preferences

if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    if [ "$ENABLE_TIMER" -eq 1 ]; then
        systemctl --user enable --now chatgpt-desktop-update.timer >/dev/null 2>&1 || true
    fi
fi

if [ "$FROM_UPDATE" -eq 0 ] && [ -x "${HOME}/.local/bin/chatgpt-desktop-update" ]; then
    "${HOME}/.local/bin/chatgpt-desktop-update" --record-only >/dev/null 2>&1 || true
fi

if [ "$FROM_UPDATE" -eq 0 ]; then
    echo "Installed user-local ChatGPT desktop integration."
fi

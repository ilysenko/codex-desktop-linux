#!/bin/bash
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source_repository="$(realpath "${1:?Usage: install-gentoo.sh /path/to/generated/repository}")"
if [ "$(id -u)" -ne 0 ]; then
    exec "$SCRIPT_DIR/sudo-with-alert.sh" bash "$0" "$source_repository"
fi
for exe in /proc/[0-9]*/exe; do
    if [ "$(readlink "$exe" 2>/dev/null || true)" = /opt/codex-desktop/ChatGPT ]; then
        echo 'Exit the native ChatGPT Community before installing' >&2
        exit 1
    fi
done
. "$SCRIPT_DIR/lib/gentoo-install.sh"
# Ignore inherited binary-only/selective modes for this verified local payload.
# Do not pass --usepkgonly=n: some Portage resolver paths test option presence,
# rather than its false value, and then incorrectly exclude every ebuild.
gentoo_install_transaction "$source_repository" \
    /var/db/repos/codex-desktop-local \
    /etc/portage/repos.conf/codex-desktop-local.conf \
    /etc/portage/package.accept_keywords/codex-desktop-local \
    /etc/portage/package.license/codex-desktop-local \
    "$(portageq envvar DISTDIR)" "$(portageq envvar ARCH)" \
    emerge --ignore-default-opts --usepkg=n --getbinpkg=n --select=y --selective=n

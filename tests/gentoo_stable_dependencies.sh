#!/bin/bash
# Stable-only dependency resolution in an empty VDB, including build-host deps.
set -Eeuo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/gentoo-audit.sh"
gentoo_chroot_profile() {
    local repository profile
    repository="$(realpath "$1")"
    profile="$(realpath "$2")"
    case "$profile" in
        "$repository"/profiles/*) printf '/var/db/repos/gentoo/%s\n' "${profile#"$repository"/}" ;;
        *) echo 'Stable audit requires a profile inside the Gentoo repository' >&2; return 1 ;;
    esac
}
if [ "${1:-}" = --map-profile ]; then
    gentoo_chroot_profile "$2" "$3"
    exit
fi
[ "$(id -u)" -eq 0 ] || { echo 'Run via scripts/sudo-with-alert.sh' >&2; exit 1; }

if [ "${1:-}" = --namespace ]; then
    root="$2"; gentoo="$3"; repository="$4"; version="$5"
    mount --make-rprivate /
    mkdir -p "$root/usr" "$root/proc" "$root/dev" \
        "$root/var/db/repos/gentoo" "$root/var/db/repos/codex-desktop-local" "$root/var/tmp"
    for pair in "/usr:$root/usr" "$gentoo:$root/var/db/repos/gentoo" \
        "$repository:$root/var/db/repos/codex-desktop-local" "/proc:$root/proc"; do
        source="${pair%%:*}"; target="${pair#*:}"
        mount --bind "$source" "$target"
        mount -o remount,bind,ro "$target"
    done
    gentoo_audit_usr_layout "$root"
    mknod -m 0666 "$root/dev/null" c 1 3
    mknod -m 0666 "$root/dev/zero" c 1 5
    mknod -m 0666 "$root/dev/random" c 1 8
    mknod -m 0666 "$root/dev/urandom" c 1 9
    ln -s /proc/self/fd "$root/dev/fd"
    ln -s /proc/self/fd/0 "$root/dev/stdin"
    ln -s /proc/self/fd/1 "$root/dev/stdout"
    ln -s /proc/self/fd/2 "$root/dev/stderr"
    for file in passwd group ld.so.cache sandbox.conf; do cp "/etc/$file" "$root/etc/$file"; done
    # Model a stable stage3 instead of bootstrapping Gentoo from zero. Every
    # provided version is selected from stable ::gentoo, never the host VDB.
    mkdir -p "$root/etc/portage/profile"
    chroot "$root" env -u ACCEPT_KEYWORDS -u PORTAGE_CONFIGROOT ROOT=/ \
        PATH=/usr/sbin:/usr/bin:/sbin:/bin python3 - <<'PY' > "$root/etc/portage/profile/package.provided"
import portage
db = portage.db['/']['porttree'].dbapi
atoms = {atom.lstrip('*') for atom in portage.settings.packages if atom.startswith('*')}
atoms.update(['dev-build/autoconf', 'dev-build/automake', 'dev-build/libtool',
              'app-portage/elt-patches', 'sys-apps/attr', 'sys-devel/gettext',
              'sys-libs/ncurses', 'sys-libs/readline', 'sys-libs/libcap', 'sys-libs/pam',
              'dev-lang/python', 'dev-lang/perl', 'sys-libs/libxcrypt'])
for atom in sorted(atoms):
    cpv = db.xmatch('bestmatch-visible', atom)
    if not cpv:
        raise RuntimeError('No stable stage3 package for ' + atom)
    print(cpv)
PY
    echo '[gentoo-stable] Stable stage3 baseline:'
    cat "$root/etc/portage/profile/package.provided"
    resolve() {
        chroot "$root" env -u ACCEPT_KEYWORDS -u ACCEPT_LICENSE -u EMERGE_DEFAULT_OPTS \
            -u USE -u LLVM_TARGETS -u PORTAGE_CONFIGROOT -u SYSROOT \
            PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root ROOT=/ TMPDIR=/var/tmp \
            emerge --pretend --emptytree --with-bdeps=y --usepkg=n --getbinpkg=n \
            --autounmask=n --color=n "$@"
    }
    echo '[gentoo-stable] Runtime and ebuild dependencies: empty VDB, only stable ::gentoo'
    resolve --onlydeps "=app-misc/codex-desktop-$version::codex-desktop-local"
    echo '[gentoo-stable] Bootstrap build dependencies'
    resolve app-shells/bash app-misc/ca-certificates net-misc/curl app-arch/dpkg \
        dev-vcs/git app-crypt/gnupg dev-build/make '>=net-libs/nodejs-22.12.0[npm]' \
        dev-lang/python sys-apps/util-linux app-arch/xz-utils
    echo '[gentoo-stable] Both stable ::gentoo dependency plans succeeded'
    exit 0
fi

repository="$(realpath "${1:?Usage: gentoo_stable_dependencies.sh /path/to/generated/repository}")"
arch="$(portageq envvar ARCH)"
chost="$(portageq envvar CHOST)"
gentoo="$(realpath "$(portageq get_repo_path / gentoo)")"
profile="$(gentoo_chroot_profile "$gentoo" /etc/portage/make.profile)"
export TMPDIR="${TMPDIR:-/var/tmp}"
scratch="$(mktemp -d "$TMPDIR/gentoo-stable-deps.XXXXXX")"
trap 'rm -rf -- "$scratch"' EXIT
root="$scratch/root"
config="$root/etc/portage"
mkdir -p "$config/repos.conf" "$config/package.accept_keywords" "$config/package.use"
# This is a source-bootstrap ordering option for documentation tooling, not
# an application runtime setting and not a keyword exception.
printf 'dev-python/pillow -truetype\n' > "$config/package.use/source-bootstrap"
ln -s "$profile" "$config/make.profile"
printf 'CHOST="%s"\nACCEPT_KEYWORDS="%s"\nACCEPT_LICENSE="*"\n' "$chost" "$arch" > "$config/make.conf"
if [ "$arch" = amd64 ]; then printf 'CPU_FLAGS_X86="mmx sse sse2"\n' >> "$config/make.conf"; fi
printf '[gentoo]\nlocation = /var/db/repos/gentoo\nauto-sync = no\n[codex-desktop-local]\nlocation = /var/db/repos/codex-desktop-local\nmasters = gentoo\nauto-sync = no\n' > "$config/repos.conf/repositories.conf"
printf 'app-misc/codex-desktop::codex-desktop-local ~%s\n' "$arch" > "$config/package.accept_keywords/community"
ebuilds=("$repository"/app-misc/codex-desktop/*.ebuild)
version="${ebuilds[0]##*/codex-desktop-}"
version="${version%.ebuild}"
# The namespace makes all bind mounts transient. No host VDB/config is mounted.
unshare --mount --fork bash "$0" --namespace "$root" "$gentoo" "$repository" "$version"

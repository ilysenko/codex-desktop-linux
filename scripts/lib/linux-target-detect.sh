#!/usr/bin/env bash

os_release_field() {
    local field="$1"
    local file line value
    local -a files

    if [ -n "${OS_RELEASE_FILE:-}" ]; then
        files=("$OS_RELEASE_FILE")
    else
        files=(/etc/os-release /usr/lib/os-release)
    fi

    for file in "${files[@]}"; do
        [ -n "$file" ] || continue
        [ -r "$file" ] || continue
        while IFS= read -r line; do
            case "$line" in
                "$field="*)
                    value="${line#*=}"
                    value="${value#\"}"
                    value="${value%\"}"
                    value="${value#\'}"
                    value="${value%\'}"
                    printf '%s\n' "${value,,}"
                    return 0
                    ;;
            esac
        done < "$file"
    done

    return 1
}

os_release_matches() {
    local expected token
    for expected in "$@"; do
        [ "${OS_RELEASE_ID:-}" = "$expected" ] && return 0
        for token in ${OS_RELEASE_ID_LIKE:-}; do
            [ "$token" = "$expected" ] && return 0
        done
    done
    return 1
}

os_release_version_major() {
    local version="${OS_RELEASE_VERSION_ID:-}"
    version="${version%%.*}"
    case "$version" in
        ''|*[!0-9]*) return 1 ;;
        *) printf '%s\n' "$version" ;;
    esac
}

linux_target_is_atomic() {
    local override="${CODEX_LINUX_TARGET_ATOMIC:-}"
    override="${override,,}"
    case "$override" in
        1|true|yes|on)
            return 0
            ;;
        0|false|no|off)
            return 1
            ;;
        "")
            ;;
        *)
            ;;
    esac

    local ostree_booted="${OSTREE_BOOTED_FILE:-/run/ostree-booted}"
    [ -n "$ostree_booted" ] && [ -e "$ostree_booted" ]
}

detect_package_manager() {
    if os_release_matches debian ubuntu linuxmint pop elementary zorin && command -v apt-get >/dev/null 2>&1; then
        echo "apt"
    elif os_release_matches arch archlinux manjaro endeavouros artix && command -v pacman >/dev/null 2>&1; then
        echo "pacman"
    elif os_release_matches opensuse suse sles && command -v zypper >/dev/null 2>&1; then
        echo "zypper"
    elif os_release_matches fedora rhel centos rocky almalinux ol; then
        local major
        major="$(os_release_version_major 2>/dev/null || true)"
        if linux_target_is_atomic && command -v rpm-ostree >/dev/null 2>&1; then
            echo "rpm-ostree"
        elif [ "${OS_RELEASE_ID:-}" = "fedora" ] && [ -n "$major" ] && [ "$major" -lt 41 ] && command -v dnf >/dev/null 2>&1; then
            echo "dnf"
        elif command -v dnf5 >/dev/null 2>&1; then
            echo "dnf5"
        elif command -v dnf >/dev/null 2>&1; then
            echo "dnf"
        else
            echo "unknown"
        fi
    elif command -v apt-get >/dev/null 2>&1; then
        echo "apt"
    elif command -v dnf5 >/dev/null 2>&1; then
        echo "dnf5"
    elif command -v dnf >/dev/null 2>&1; then
        echo "dnf"
    elif command -v pacman >/dev/null 2>&1; then
        echo "pacman"
    elif command -v zypper >/dev/null 2>&1; then
        echo "zypper"
    else
        echo "unknown"
    fi
}

detect_package_format() {
    if os_release_matches arch archlinux manjaro endeavouros artix; then
        echo "pacman"
    elif os_release_matches fedora rhel centos rocky almalinux ol sles suse opensuse; then
        echo "rpm"
    elif os_release_matches debian ubuntu linuxmint pop elementary zorin; then
        echo "deb"
    elif command -v pacman >/dev/null 2>&1 && ! command -v dpkg-deb >/dev/null 2>&1; then
        echo "pacman"
    elif command -v rpmbuild >/dev/null 2>&1 && ! command -v dpkg-deb >/dev/null 2>&1; then
        echo "rpm"
    elif command -v dpkg-deb >/dev/null 2>&1; then
        echo "deb"
    elif command -v rpmbuild >/dev/null 2>&1; then
        echo "rpm"
    elif command -v pacman >/dev/null 2>&1; then
        echo "pacman"
    else
        echo "unknown"
    fi
}

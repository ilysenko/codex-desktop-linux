#!/bin/bash
# Mirror the host's merged-usr or split-usr loader/command paths in a chroot.
# The callback is injectable for layout-only tests; production calls mount.
gentoo_audit_bind_readonly() {
    mount --bind "$1" "$2"
    mount -o remount,bind,ro "$2"
}

gentoo_audit_usr_layout() {
    local root="$1" host="${2:-/}" bind="${3:-gentoo_audit_bind_readonly}" name source
    for name in bin sbin lib lib64; do
        source="${host%/}/$name"
        if [ -L "$source" ]; then
            ln -s "$(readlink "$source")" "$root/$name"
        elif [ -d "$source" ]; then
            mkdir -p "$root/$name"
            "$bind" "$source" "$root/$name"
        fi
    done
}

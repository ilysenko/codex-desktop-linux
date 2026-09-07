#!/bin/bash

pacman_rust_bootstrap_package() {
    # Arch's rust and rustup packages conflict. Preserve whichever provider is
    # already installed (or available in the user's PATH) instead of forcing a
    # switch during the required full-system upgrade.
    if cargo --version >/dev/null 2>&1 || command -v rustup >/dev/null 2>&1; then
        return 0
    fi
    printf '%s\n' rustup
}

pacman_dependencies_installed() {
    pacman -T "$@" >/dev/null 2>&1
}

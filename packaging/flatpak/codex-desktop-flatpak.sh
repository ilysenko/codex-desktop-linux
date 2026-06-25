#!/bin/sh
set -eu

export XDG_CONFIG_HOME=/var/config
export XDG_DATA_HOME=/var/data
export XDG_CACHE_HOME=/var/cache
export XDG_STATE_HOME=/var/data/state
export HOME=/var/data/home
export CODEX_HOME=${CODEX_HOME:-$XDG_DATA_HOME/codex}
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=$XDG_CONFIG_HOME/git/config
export GIT_EXEC_PATH=/app/lib/codex-flatpak-tools/git/libexec/git-core
if [ -d /app/lib/codex-flatpak-tools/git/share/git-core/templates ]; then
    export GIT_TEMPLATE_DIR=/app/lib/codex-flatpak-tools/git/share/git-core/templates
fi
git_runtime_compat_dir="$XDG_CACHE_HOME/codex-desktop/git-runtime-compat"
git_runtime_libcurl_target=""
for git_runtime_candidate in \
    /usr/lib/x86_64-linux-gnu/libcurl.so.4 \
    /usr/lib/aarch64-linux-gnu/libcurl.so.4 \
    /usr/lib64/libcurl.so.4 \
    /usr/lib/libcurl.so.4
do
    if [ -e "$git_runtime_candidate" ]; then
        git_runtime_libcurl_target="$git_runtime_candidate"
        break
    fi
done
if [ -n "$git_runtime_libcurl_target" ]; then
    mkdir -p "$git_runtime_compat_dir"
    ln -svfnT "$git_runtime_libcurl_target" "$git_runtime_compat_dir/libcurl-gnutls.so.4"
    export LD_LIBRARY_PATH="$git_runtime_compat_dir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$CODEX_HOME" "$XDG_CONFIG_HOME/git"
export PATH=/app/lib/codex-flatpak/bin:/app/lib/codex-flatpak-tools/python/bin:$PATH
export CODEX_CLI_PATH=/app/lib/codex-flatpak/bin/codex
export CODEX_ELECTRON_WRAPPER_BIN=/app/bin/zypak-wrapper
export CODEX_SKIP_URL_SCHEME_REGISTRATION=1
export CHROME_DESKTOP=io.github.ilysenko.codex_desktop_linux.desktop
export BAMF_DESKTOP_FILE_HINT=/app/share/applications/io.github.ilysenko.codex_desktop_linux.desktop
exec /app/opt/codex-desktop/start.sh "$@"

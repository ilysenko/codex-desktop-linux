#!/usr/bin/env bash
set -Eeuo pipefail

: "${HOME:?HOME is required}"
: "${CODEX_LINUX_APP_DIR:?CODEX_LINUX_APP_DIR is required}"

expected_codex_home="$HOME/.codex-community"

if [[ "${CODEX_HOME:-}" != "$expected_codex_home" ]]; then
    printf 'ChatGPT Community CLI wrapper refuses CODEX_HOME=%s; expected %s\n' \
        "${CODEX_HOME:-<unset>}" "$expected_codex_home" >&2
    exit 64
fi

community_bin="$CODEX_LINUX_APP_DIR/resources"
real_codex="$community_bin/codex"

if [[ ! -x "$real_codex" ]]; then
    printf 'ChatGPT Community CLI wrapper cannot execute Community Codex: %s\n' \
        "$real_codex" >&2
    exit 69
fi

# Desktop/primary-runtime can reconstruct PATH after the launcher hook and put
# ~/.local/bin before Community resources. Reassert Community precedence using
# the actual dynamic PATH received by app-server.
case "${PATH:-}" in
    "$community_bin"|"$community_bin":*)
        ;;
    *)
        PATH="$community_bin${PATH:+:$PATH}"
        ;;
esac
export PATH

# Pin the same dynamic PATH for commands subsequently created by Codex.
exec "$real_codex" \
    -c "shell_environment_policy.set.PATH=$PATH" \
    "$@"

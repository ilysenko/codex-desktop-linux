#!/usr/bin/env bash
# browser-proxy-node-repl-wrapper
set -euo pipefail

bin_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
original="$bin_dir/node_repl.codex-linux-original"

if [ ! -x "$original" ]; then
    echo "browser-proxy: original node_repl is missing or not executable" >&2
    exit 126
fi

# Browser Use helpers are launched with a deliberately filtered environment.
# Recover only standard proxy variables from the immediate parent, or the
# bundled app-server behind the verified bundled CUA launcher.
# Upper- and lower-case spellings form one family, so
# either spelling in the helper environment blocks both parent spellings.
# Newer releases launch node_repl through @oai/cua-repl. That launcher can
# receive a filtered environment too. Only cross this one known intermediary;
# never search arbitrary ancestors or load shell configuration.
proxy_parent_pids=("$PPID")
parent_args=()
if [ -r "/proc/$PPID/cmdline" ]; then
    mapfile -d '' -t parent_args < "/proc/$PPID/cmdline" || true
fi
cua_launcher="$bin_dir/../lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs"
if [ "${parent_args[1]:-}" = "$(readlink -f -- "$cua_launcher")" ] &&
   [ "$(readlink -f -- "/proc/$PPID/exe")" = "$(readlink -f -- "$bin_dir/node")" ]; then
    app_server_pid=""
    while read -r key value rest; do
        if [ "$key" = "PPid:" ]; then app_server_pid="$value"; break; fi
    done < "/proc/$PPID/status"
    if [[ "$app_server_pid" =~ ^[1-9][0-9]*$ ]] &&
       [ "$(readlink -f -- "/proc/$app_server_pid/exe")" = "$(readlink -f -- "$bin_dir/../../codex")" ]; then
        proxy_parent_pids+=("$app_server_pid")
    fi
fi

for proxy_parent_pid in "${proxy_parent_pids[@]}"; do
    child_has_http_proxy_family=0
    child_has_https_proxy_family=0
    child_has_all_proxy_family=0
    child_has_no_proxy_family=0
    if [[ -v HTTP_PROXY || -v http_proxy ]]; then
        child_has_http_proxy_family=1
    fi
    if [[ -v HTTPS_PROXY || -v https_proxy ]]; then
        child_has_https_proxy_family=1
    fi
    if [[ -v ALL_PROXY || -v all_proxy ]]; then
        child_has_all_proxy_family=1
    fi
    if [[ -v NO_PROXY || -v no_proxy ]]; then
        child_has_no_proxy_family=1
    fi

    parent_environment="/proc/$proxy_parent_pid/environ"
    if [ -r "$parent_environment" ]; then
        while IFS= read -r -d '' entry; do
            name="${entry%%=*}"
            case "$name" in
                HTTP_PROXY|http_proxy)
                    if [ "$child_has_http_proxy_family" -eq 0 ]; then
                        export "$entry"
                    fi
                    ;;
                HTTPS_PROXY|https_proxy)
                    if [ "$child_has_https_proxy_family" -eq 0 ]; then
                        export "$entry"
                    fi
                    ;;
                ALL_PROXY|all_proxy)
                    if [ "$child_has_all_proxy_family" -eq 0 ]; then
                        export "$entry"
                    fi
                    ;;
                NO_PROXY|no_proxy)
                    if [ "$child_has_no_proxy_family" -eq 0 ]; then
                        export "$entry"
                    fi
                    ;;
                NODE_USE_ENV_PROXY)
                    if [[ ! -v NODE_USE_ENV_PROXY ]]; then
                        export "$entry"
                    fi
                    ;;
            esac
        done < "$parent_environment" 2>/dev/null || true
    fi
done

if [[ ! -v NODE_USE_ENV_PROXY ]]; then
    for name in HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; do
        if [[ -v $name && -n ${!name} ]]; then
            export NODE_USE_ENV_PROXY=1
            break
        fi
    done
fi

exec "$original" "$@"

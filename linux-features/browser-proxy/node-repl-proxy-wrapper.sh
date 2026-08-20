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
# Recover only the standard proxy variables that the immediate app-server
# parent already received. Upper- and lower-case spellings form one family, so
# either spelling in the helper environment blocks both parent spellings.
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

parent_environment="/proc/$PPID/environ"
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

if [[ ! -v NODE_USE_ENV_PROXY ]]; then
    for name in HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; do
        if [[ -v $name && -n ${!name} ]]; then
            export NODE_USE_ENV_PROXY=1
            break
        fi
    done
fi

exec "$original" "$@"

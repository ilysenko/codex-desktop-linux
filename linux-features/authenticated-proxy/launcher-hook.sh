#!/usr/bin/env bash
set -Eeo pipefail

diagnose() {
    printf '%s\n' "$*" >&2
}

emit_env() {
    printf 'env %s=%s\n' "$1" "$2"
}

emit_electron_arg() {
    printf 'electron-arg %s\n' "$1"
}

electron_proxy_server_arg_present() {
    local arg

    for arg in "$@"; do
        case "$arg" in
            --proxy-server|--proxy-server=*)
                return 0
                ;;
        esac
    done

    return 1
}

select_standard_proxy_env() {
    local name
    local value

    STANDARD_PROXY_ENV_NAME=""
    STANDARD_PROXY_ENV_VALUE=""
    for name in https_proxy HTTPS_PROXY http_proxy HTTP_PROXY all_proxy ALL_PROXY; do
        value="${!name-}"
        [ -n "$value" ] || continue
        STANDARD_PROXY_ENV_NAME="$name"
        STANDARD_PROXY_ENV_VALUE="$value"
        return 0
    done

    return 1
}

standard_no_proxy_env_value() {
    if [ -n "${no_proxy-}" ]; then
        printf '%s\n' "$no_proxy"
        return 0
    fi
    if [ -n "${NO_PROXY-}" ]; then
        printf '%s\n' "$NO_PROXY"
        return 0
    fi
    return 1
}

parse_standard_proxy_url() {
    python3 - "$1" <<'PY'
import sys
from urllib.parse import unquote, urlsplit, urlunsplit

raw = sys.argv[1].strip()
if not raw:
    raise SystemExit(1)

parse_target = raw if "://" in raw else f"//{raw}"
parts = urlsplit(parse_target)
netloc = parts.netloc
if not netloc:
    netloc = parts.path.split("/", 1)[0]
if not netloc:
    raise SystemExit(1)

userinfo = ""
hostport = netloc
if "@" in netloc:
    userinfo, hostport = netloc.rsplit("@", 1)

if parts.scheme:
    server = urlunsplit((parts.scheme, hostport, "", "", ""))
else:
    server = hostport

username = ""
password = ""
if userinfo:
    if ":" in userinfo:
        username, password = userinfo.split(":", 1)
    else:
        username = userinfo
    username = unquote(username)
    password = unquote(password)

print(f"{server}\t{username}\t{password}")
PY
}

populate_proxy_bypass_from_standard_env() {
    local no_proxy_value

    [ -z "${CODEX_LINUX_PROXY_BYPASS_LIST:-}" ] || return 0
    no_proxy_value="$(standard_no_proxy_env_value)" || return 0
    [ -n "$no_proxy_value" ] || return 0

    CODEX_LINUX_PROXY_BYPASS_LIST="${no_proxy_value//,/;}"
}

populate_codex_proxy_env_from_standard_env() {
    local parsed
    local server
    local username
    local password

    if [ -n "${CODEX_LINUX_PROXY_SERVER:-}" ]; then
        populate_proxy_bypass_from_standard_env
        return 0
    fi

    select_standard_proxy_env || return 0
    parsed="$(parse_standard_proxy_url "$STANDARD_PROXY_ENV_VALUE")" || {
        diagnose "Ignoring $STANDARD_PROXY_ENV_NAME: could not parse proxy URL."
        return 0
    }

    IFS=$'\t' read -r server username password <<< "$parsed"
    [ -n "$server" ] || return 0

    CODEX_LINUX_PROXY_SERVER="$server"
    if [ -z "${CODEX_LINUX_PROXY_USERNAME:-}" ] && [ -n "$username" ]; then
        CODEX_LINUX_PROXY_USERNAME="$username"
    fi
    if [ -z "${CODEX_LINUX_PROXY_PASSWORD:-}" ] && [ -n "$password" ]; then
        CODEX_LINUX_PROXY_PASSWORD="$password"
    fi
    populate_proxy_bypass_from_standard_env

    diagnose "Derived CODEX_LINUX_PROXY_SERVER from $STANDARD_PROXY_ENV_NAME."
}

extract_proxy_auth_endpoint() {
    local server="$1"
    local endpoint
    local rest

    PROXY_AUTH_HOST=""
    PROXY_AUTH_PORT=""

    endpoint="$server"
    case "$endpoint" in
        *";"*|*=*)
            diagnose "Ignoring proxy auth env: CODEX_LINUX_PROXY_SERVER must be a single proxy endpoint, not a proxy list."
            return 1
            ;;
    esac

    case "$endpoint" in
        *://*) endpoint="${endpoint#*://}" ;;
    esac
    endpoint="${endpoint%%/*}"
    endpoint="${endpoint%%\?*}"
    endpoint="${endpoint%%#*}"

    case "$endpoint" in
        *@*)
            diagnose "Ignoring credentials embedded in CODEX_LINUX_PROXY_SERVER; use CODEX_LINUX_PROXY_USERNAME and CODEX_LINUX_PROXY_PASSWORD instead."
            endpoint="${endpoint#*@}"
            ;;
    esac

    case "$endpoint" in
        \[*\]*)
            PROXY_AUTH_HOST="${endpoint%%]*}"
            PROXY_AUTH_HOST="${PROXY_AUTH_HOST#[}"
            rest="${endpoint#*]}"
            case "$rest" in
                :*) PROXY_AUTH_PORT="${rest#:}" ;;
            esac
            ;;
        *)
            PROXY_AUTH_HOST="${endpoint%%:*}"
            if [ "$PROXY_AUTH_HOST" != "$endpoint" ]; then
                PROXY_AUTH_PORT="${endpoint#*:}"
            fi
            ;;
    esac

    if [ -z "$PROXY_AUTH_HOST" ]; then
        diagnose "Ignoring proxy auth env: could not parse CODEX_LINUX_PROXY_SERVER host."
        return 1
    fi

    PROXY_AUTH_HOST="${PROXY_AUTH_HOST,,}"
    return 0
}

emit_proxy_configuration() {
    emit_env CODEX_LINUX_PROXY_AUTH_HOST ""
    emit_env CODEX_LINUX_PROXY_AUTH_PORT ""

    if electron_proxy_server_arg_present "$@"; then
        if [ -n "${CODEX_LINUX_PROXY_SERVER:-}" ] ||
            [ -n "${CODEX_LINUX_PROXY_USERNAME:-}" ] ||
            [ -n "${CODEX_LINUX_PROXY_PASSWORD:-}" ] ||
            [ -n "${CODEX_LINUX_PROXY_BYPASS_LIST:-}" ]; then
            diagnose "Ignoring CODEX_LINUX_PROXY_* env because --proxy-server was provided explicitly."
        fi
        return 0
    fi

    populate_codex_proxy_env_from_standard_env
    [ -n "${CODEX_LINUX_PROXY_SERVER:-}" ] || return 0

    emit_env CODEX_LINUX_PROXY_SERVER "$CODEX_LINUX_PROXY_SERVER"
    emit_electron_arg "--proxy-server=$CODEX_LINUX_PROXY_SERVER"

    if [ -n "${CODEX_LINUX_PROXY_BYPASS_LIST:-}" ]; then
        emit_env CODEX_LINUX_PROXY_BYPASS_LIST "$CODEX_LINUX_PROXY_BYPASS_LIST"
        emit_electron_arg "--proxy-bypass-list=$CODEX_LINUX_PROXY_BYPASS_LIST"
    fi

    if [ -n "${CODEX_LINUX_PROXY_USERNAME:-}" ]; then
        if extract_proxy_auth_endpoint "$CODEX_LINUX_PROXY_SERVER"; then
            emit_env CODEX_LINUX_PROXY_AUTH_HOST "$PROXY_AUTH_HOST"
            emit_env CODEX_LINUX_PROXY_AUTH_PORT "$PROXY_AUTH_PORT"
            emit_env CODEX_LINUX_PROXY_USERNAME "$CODEX_LINUX_PROXY_USERNAME"
            emit_env CODEX_LINUX_PROXY_PASSWORD "${CODEX_LINUX_PROXY_PASSWORD:-}"
            diagnose "Configured Electron proxy from CODEX_LINUX_PROXY_SERVER with proxy authentication."
        fi
    elif [ -n "${CODEX_LINUX_PROXY_PASSWORD:-}" ]; then
        diagnose "Ignoring CODEX_LINUX_PROXY_PASSWORD because CODEX_LINUX_PROXY_USERNAME is empty."
    else
        diagnose "Configured Electron proxy from CODEX_LINUX_PROXY_SERVER."
    fi
}

emit_proxy_configuration "$@"

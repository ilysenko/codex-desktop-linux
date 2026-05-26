#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
PACKAGE_NAME="${PACKAGE_NAME:-codex-desktop}"
CODEX_BIN="${CODEX_PARITY_CODEX_BIN:-codex}"
DOCTOR="${DOCTOR:-/usr/bin/${PACKAGE_NAME}-doctor}"
TMP_DIR="${CODEX_PARITY_FULL_TMPDIR:-$(mktemp -d)}"
CREATED_TMP_DIR=0
CODEX_PARITY_STRICT="${CODEX_PARITY_STRICT:-0}"
CODEX_PARITY_STRICT_REMOTE="${CODEX_PARITY_STRICT_REMOTE:-auto}"

if [ -z "${CODEX_PARITY_FULL_TMPDIR:-}" ]; then
    CREATED_TMP_DIR=1
fi

cleanup() {
    if [ "$CREATED_TMP_DIR" = "1" ]; then
        rm -rf "$TMP_DIR"
    fi
}
trap cleanup EXIT

pass_count=0
fail_count=0
skip_count=0

truthy() {
    case "${1:-}" in
        1|true|TRUE|yes|YES|on|ON)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

strict_enabled() {
    truthy "$CODEX_PARITY_STRICT"
}

pass() {
    pass_count=$((pass_count + 1))
    printf '[parity-full] PASS %s\n' "$*"
}

fail() {
    fail_count=$((fail_count + 1))
    printf '[parity-full] FAIL %s\n' "$*" >&2
}

skip() {
    if strict_enabled; then
        fail "$*: skipped while CODEX_PARITY_STRICT=1"
    else
        skip_count=$((skip_count + 1))
        printf '[parity-full] SKIP %s\n' "$*"
    fi
}

node_json_field() {
    local file="$1"
    local script="$2"
    node -e "const fs=require('fs');const data=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));${script}" "$file"
}

run_installed_doctor() {
    if [ "${CODEX_PARITY_SKIP_DOCTOR:-0}" = "1" ]; then
        skip "installed doctor: disabled by CODEX_PARITY_SKIP_DOCTOR=1"
        return
    fi
    if [ ! -x "$DOCTOR" ]; then
        fail "installed doctor: missing executable $DOCTOR"
        return
    fi

    local report="$TMP_DIR/doctor.json"
    if "$DOCTOR" --json >"$report"; then
        local summary
        summary="$(node_json_field "$report" 'const s=data.summary||{}; console.log(`pass=${s.pass??0} warn=${s.warn??0} info=${s.info??0} fail=${s.fail??0}`); if ((s.fail??0)>0) process.exit(1);')"
        pass "installed doctor: $summary"
    else
        fail "installed doctor: command failed"
    fi
}

run_service_check() {
    if [ "${CODEX_PARITY_SKIP_SERVICES:-0}" = "1" ]; then
        skip "user services: disabled by CODEX_PARITY_SKIP_SERVICES=1"
        return
    fi
    if ! command -v systemctl >/dev/null 2>&1; then
        skip "user services: systemctl missing"
        return
    fi

    local app_active updater_active app_enabled updater_enabled
    app_active="$(systemctl --user is-active "${PACKAGE_NAME}.service" 2>/dev/null || true)"
    updater_active="$(systemctl --user is-active codex-update-manager.service 2>/dev/null || true)"
    app_enabled="$(systemctl --user is-enabled "${PACKAGE_NAME}.service" 2>/dev/null || true)"
    updater_enabled="$(systemctl --user is-enabled codex-update-manager.service 2>/dev/null || true)"

    if [ "$app_active" = "active" ] && [ "$updater_active" = "active" ]; then
        pass "user services: app=$app_active/$app_enabled updater=$updater_active/$updater_enabled"
    else
        fail "user services: app=$app_active/$app_enabled updater=$updater_active/$updater_enabled"
    fi
}

run_schema_guard() {
    if [ "${CODEX_PARITY_SKIP_SCHEMA:-0}" = "1" ]; then
        skip "app-server schema guard: disabled by CODEX_PARITY_SKIP_SCHEMA=1"
        return
    fi

    local report="$TMP_DIR/schema.json"
    if node "$REPO_DIR/scripts/app-server-schema-guard.js" --codex-bin "$CODEX_BIN" --json >"$report"; then
        local summary
        summary="$(node_json_field "$report" 'const c=data.counts||{}; console.log(`clientMethods=${c.clientRequestMethods??0} serverNotifications=${c.serverNotifications??0} optional=${c.optionalClientMethodsPresent??0}/${c.optionalClientMethods??0}`);')"
        pass "app-server schema guard: $summary"
    else
        fail "app-server schema guard: command failed"
    fi
}

find_computer_use_bin() {
    if [ -n "${CODEX_COMPUTER_USE_BIN:-}" ]; then
        printf '%s\n' "$CODEX_COMPUTER_USE_BIN"
        return
    fi

    local candidates=(
        "/opt/${PACKAGE_NAME}/resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux"
        "$REPO_DIR/codex-app/resources/plugins/openai-bundled/plugins/computer-use/bin/codex-computer-use-linux"
    )
    local candidate
    for candidate in "${candidates[@]}"; do
        if [ -x "$candidate" ]; then
            printf '%s\n' "$candidate"
            return
        fi
    done
}

run_computer_use_doctor() {
    if [ "${CODEX_PARITY_SKIP_COMPUTER_USE:-0}" = "1" ]; then
        skip "Computer Use doctor: disabled by CODEX_PARITY_SKIP_COMPUTER_USE=1"
        return
    fi

    local computer_use_bin
    computer_use_bin="$(find_computer_use_bin || true)"
    if [ -z "$computer_use_bin" ]; then
        fail "Computer Use doctor: backend binary not found"
        return
    fi

    local report="$TMP_DIR/computer-use.json"
    if "$computer_use_bin" doctor >"$report"; then
        local summary
        if summary="$(node_json_field "$report" 'const r=data.readiness||{}; const blockers=Array.isArray(r.blockers)?r.blockers:[]; const c=data.capabilities||{}; const p=c.preferred||{}; console.log(`blockers=${blockers.length} input=${p.input||"unknown"} screenshot=${p.screenshot||"unknown"} window=${p.window_control||"unknown"}`); if (blockers.length>0 || r.can_build_accessibility_tree!==true || r.can_query_windows!==true || r.can_send_development_input!==true) process.exit(1);')"; then
            pass "Computer Use doctor: $summary"
        else
            fail "Computer Use doctor: readiness checks failed"
        fi
    else
        fail "Computer Use doctor: command failed"
    fi
}

remote_mobile_feature_enabled() {
    local marker
    for marker in \
        "/opt/${PACKAGE_NAME}/.codex-linux/remote-mobile-control-enabled" \
        "$REPO_DIR/codex-app/.codex-linux/remote-mobile-control-enabled"; do
        if [ -e "$marker" ]; then
            return 0
        fi
    done
    return 1
}

strict_remote_required() {
    if truthy "${CODEX_PARITY_REQUIRE_REMOTE_CONNECTED:-0}"; then
        return 0
    fi
    if ! strict_enabled; then
        return 1
    fi

    case "$CODEX_PARITY_STRICT_REMOTE" in
        1|true|TRUE|yes|YES|on|ON)
            return 0
            ;;
        0|false|FALSE|no|NO|off|OFF)
            return 1
            ;;
        auto|"")
            remote_mobile_feature_enabled
            return $?
            ;;
        *)
            fail "app-server parity smoke: invalid CODEX_PARITY_STRICT_REMOTE=$CODEX_PARITY_STRICT_REMOTE"
            return 1
            ;;
    esac
}

run_parity_smoke() {
    if [ "${CODEX_PARITY_SKIP_SMOKE:-0}" = "1" ]; then
        skip "app-server parity smoke: disabled by CODEX_PARITY_SKIP_SMOKE=1"
        return
    fi

    local args=("--codex-bin" "$CODEX_BIN")
    if strict_enabled; then
        args+=("--strict")
        if [ -z "${CODEX_DESKTOP_CDP_ORIGIN:-}" ]; then
            fail "app-server parity smoke: strict mode requires CODEX_DESKTOP_CDP_ORIGIN"
            return
        fi
    fi
    if strict_remote_required; then
        args+=("--require-remote-connected")
    fi
    if [ -n "${CODEX_DESKTOP_CDP_ORIGIN:-}" ]; then
        args+=("--cdp-origin" "$CODEX_DESKTOP_CDP_ORIGIN")
    fi

    if node "$REPO_DIR/scripts/desktop-parity-smoke.js" "${args[@]}"; then
        pass "app-server parity smoke"
    else
        fail "app-server parity smoke"
    fi
}

mkdir -p "$TMP_DIR"

run_installed_doctor
run_service_check
run_schema_guard
run_computer_use_doctor
run_parity_smoke

printf '[parity-full] result=%s pass=%s skip=%s fail=%s\n' \
    "$([ "$fail_count" -eq 0 ] && printf pass || printf fail)" \
    "$pass_count" "$skip_count" "$fail_count"

if [ "$fail_count" -gt 0 ]; then
    exit 1
fi

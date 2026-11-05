#!/bin/bash
set -euo pipefail

REPO_DIR="$(git rev-parse --show-toplevel)"
MODE="${1:-all}"
NODE_TEST_TIMEOUT_SECONDS="${NODE_TEST_TIMEOUT_SECONDS:-300}"
NODE_TEST_KILL_AFTER_SECONDS="${NODE_TEST_KILL_AFTER_SECONDS:-30}"

cd "$REPO_DIR"

run_node_syntax_checks() {
    local file

    while IFS= read -r file; do
        # GNOME Shell requires extension.js while its source is native ESM.
        # Node 18 otherwise parses every .js file as CommonJS and makes the
        # local Ubuntu 24.04 matrix fail after all Rust tests have completed.
        if grep -Eq '^[[:space:]]*(import[[:space:]{*(]|export[[:space:]{*])' "$file"; then
            node --input-type=module --check < "$file"
        else
            node --check "$file"
        fi
    done < <(git ls-files '*.js')
}

run_node_tests() {
    local file
    local status
    local -a node_test_args=(--test)
    local -a test_files=()

    # The guard below calls this function on the left of ||, where errexit is
    # off, so every step that can fail returns its status itself.
    node scripts/ci/manage-labels.js --check || return

    if node --help | grep -q -- "--test-force-exit"; then
        # All assertions must finish, but a leaked worker handle must not hold CI open.
        node_test_args+=(--test-force-exit)
    fi

    while IFS= read -r file; do
        test_files+=("$file")
    done < <(git ls-files '*.test.js' 'linux-features/*/test.js')

    if [ "${#test_files[@]}" -eq 0 ]; then
        return 0
    fi

    if [ -n "${NODE_TEST_REPORTER:-}" ]; then
        node_test_args+=(--test-reporter="$NODE_TEST_REPORTER")
    elif [ "${GITHUB_ACTIONS:-}" = "true" ] && node --help | grep -q -- "--test-reporter"; then
        # Keep the last completed test visible when a worker leaks a handle.
        node_test_args+=(--test-reporter=spec)
    fi

    case "$NODE_TEST_TIMEOUT_SECONDS" in
        *[!0-9]*|0)
            echo "NODE_TEST_TIMEOUT_SECONDS must be a positive integer" >&2
            return 2
            ;;
    esac
    case "$NODE_TEST_KILL_AFTER_SECONDS" in
        *[!0-9]*|0)
            echo "NODE_TEST_KILL_AFTER_SECONDS must be a positive integer" >&2
            return 2
            ;;
    esac

    if ! command -v timeout >/dev/null 2>&1; then
        if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
            echo "GNU timeout is required to bound Node tests in GitHub Actions" >&2
            return 2
        fi
        node "${node_test_args[@]}" "${test_files[@]}"
        return
    fi

    if timeout \
        --signal=TERM \
        --kill-after="${NODE_TEST_KILL_AFTER_SECONDS}s" \
        "${NODE_TEST_TIMEOUT_SECONDS}s" \
        node "${node_test_args[@]}" "${test_files[@]}"; then
        return 0
    else
        status=$?
    fi

    if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
        echo "Node test suite exited with status $status under the ${NODE_TEST_TIMEOUT_SECONDS}s watchdog; inspect the preceding output for a timeout or signal" >&2
    fi
    return "$status"
}

# Every test removes what it creates, also when it fails. The suite runs with a
# fresh TMPDIR, and anything left there fails the run and is named. The
# directory stays for inspection then; an empty one is removed.
run_node_tests_in_fresh_tmpdir() {
    local fresh
    local leftovers
    local name
    local status=0

    fresh="$(mktemp -d)"
    TMPDIR="$fresh" run_node_tests || status=$?
    leftovers="$(find "$fresh" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)"
    if [ -n "$leftovers" ]; then
        echo "Node tests left these entries in $fresh; each test must remove what it creates:" >&2
        while IFS= read -r name; do
            printf '  %s\n' "$name" >&2
        done <<<"$leftovers"
        [ "$status" -ne 0 ] || status=1
    elif ! rmdir -- "$fresh"; then
        echo "Could not remove $fresh after the run; a test process may still be writing there:" >&2
        find "$fresh" -mindepth 1 -maxdepth 1 -printf '  %f\n' >&2 || true
        [ "$status" -ne 0 ] || status=1
    fi
    return "$status"
}

case "$MODE" in
    all)
        run_node_syntax_checks
        run_node_tests_in_fresh_tmpdir
        ;;
    syntax)
        run_node_syntax_checks
        ;;
    test|tests)
        run_node_tests_in_fresh_tmpdir
        ;;
    *)
        echo "Usage: $0 [all|syntax|tests]" >&2
        exit 2
        ;;
esac

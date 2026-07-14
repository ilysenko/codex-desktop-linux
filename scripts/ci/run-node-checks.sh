#!/bin/bash
set -euo pipefail

REPO_DIR="$(git rev-parse --show-toplevel)"
MODE="${1:-all}"

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
    local -a test_files=()

    node scripts/ci/manage-labels.js --check

    while IFS= read -r file; do
        test_files+=("$file")
    done < <(git ls-files '*.test.js' 'linux-features/*/test.js')

    if [ "${#test_files[@]}" -eq 0 ]; then
        return 0
    fi

    node --test "${test_files[@]}"
}

case "$MODE" in
    all)
        run_node_syntax_checks
        run_node_tests
        ;;
    syntax)
        run_node_syntax_checks
        ;;
    test|tests)
        run_node_tests
        ;;
    *)
        echo "Usage: $0 [all|syntax|tests]" >&2
        exit 2
        ;;
esac

#!/bin/bash
set -euo pipefail

REPO_DIR="$(git rev-parse --show-toplevel)"
MODE="${1:-all}"

cd "$REPO_DIR"

run_node_syntax_checks() {
    local file

    while IFS= read -r file; do
        node --check "$file"
    done < <(git ls-files '*.js')
}

run_node_tests() {
    local file
    local -a test_files=()

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

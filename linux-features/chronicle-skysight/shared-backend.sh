#!/usr/bin/env bash

find_cargo_for_chronicle_skysight() {
    if command -v cargo >/dev/null 2>&1; then
        command -v cargo
        return 0
    fi
    if [ -x "$HOME/.cargo/bin/cargo" ]; then
        echo "$HOME/.cargo/bin/cargo"
        return 0
    fi
    return 1
}

build_chronicle_skysight_backend() {
    local source_binary="$SCRIPT_DIR/target/release/codex-record-replay-linux"
    local cargo_cmd=""

    if [ -n "${CODEX_RECORD_REPLAY_LINUX_SOURCE:-}" ]; then
        [ -x "$CODEX_RECORD_REPLAY_LINUX_SOURCE" ] || {
            echo "Chronicle / Skysight backend source is not executable: $CODEX_RECORD_REPLAY_LINUX_SOURCE" >&2
            return 1
        }
        printf '%s\n' "$CODEX_RECORD_REPLAY_LINUX_SOURCE"
        return 0
    fi

    if [ -x "$source_binary" ]; then
        printf '%s\n' "$source_binary"
        return 0
    fi

    if ! cargo_cmd="$(find_cargo_for_chronicle_skysight)"; then
        echo "cargo not found; Chronicle / Skysight backend cannot be built" >&2
        echo "Install/use a Rust toolchain, or set CODEX_RECORD_REPLAY_LINUX_SOURCE to an executable codex-record-replay-linux binary." >&2
        return 1
    fi

    echo "Building Chronicle / Skysight backend..." >&2
    (cd "$SCRIPT_DIR" && "$cargo_cmd" build --release -p codex-record-replay-linux >&2)
    [ -x "$source_binary" ] || {
        echo "Chronicle / Skysight backend missing after build: $source_binary" >&2
        return 1
    }
    printf '%s\n' "$source_binary"
}

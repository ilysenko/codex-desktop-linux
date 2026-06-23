#!/bin/bash
set -Eeuo pipefail

data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
venv="${CODEX_LINUX_READ_ALOUD_KOKORO_VENV:-$data_home/codex-desktop/read-aloud/kokoro-venv}"
model="${CODEX_LINUX_READ_ALOUD_KOKORO_MODEL:-$data_home/kokoro/kokoro-v1.0.onnx}"
voices="${CODEX_LINUX_READ_ALOUD_KOKORO_VOICES:-$data_home/kokoro/voices-v1.0.bin}"
model_url="${CODEX_LINUX_READ_ALOUD_KOKORO_MODEL_URL:-https://huggingface.co/zijuncheng/kokoro_model_v1.0/resolve/main/kokoro-v1.0.onnx}"
voices_url="${CODEX_LINUX_READ_ALOUD_KOKORO_VOICES_URL:-https://huggingface.co/zijuncheng/kokoro_model_v1.0/resolve/main/voices-v1.0.bin}"

truthy_env_value() {
    case "${1:-}" in
        1|true|TRUE|yes|YES|on|ON) return 0 ;;
        *) return 1 ;;
    esac
}

expected_sha_for_target() {
    local target="$1"
    case "$target" in
        "$model") printf '%s\n' "${CODEX_LINUX_READ_ALOUD_KOKORO_MODEL_SHA256:-}" ;;
        "$voices") printf '%s\n' "${CODEX_LINUX_READ_ALOUD_KOKORO_VOICES_SHA256:-}" ;;
        *) printf '%s\n' "" ;;
    esac
}

verify_download_sha256() {
    local target="$1"
    local expected_sha
    expected_sha="$(expected_sha_for_target "$target")"
    if [ -z "$expected_sha" ]; then
        echo "Refusing to download $(basename "$target") without an expected SHA256" >&2
        exit 1
    fi
    if ! printf '%s  %s\n' "$expected_sha" "$target" | sha256sum -c - >/dev/null 2>&1; then
        rm -f "$target"
        echo "Checksum mismatch for $target" >&2
        exit 1
    fi
}

choose_python() {
    local candidate
    for candidate in "${PYTHON:-}" python3.12 python3.13 python3.11 python3.10 python3; do
        [ -n "$candidate" ] || continue
        command -v "$candidate" >/dev/null 2>&1 || continue
        "$candidate" -c 'import sys; raise SystemExit(0 if (3, 10) <= sys.version_info < (3, 14) else 1)' >/dev/null 2>&1 && {
            printf '%s\n' "$candidate"
            return 0
        }
    done
    return 1
}

download_file() {
    local url="$1"
    local target="$2"
    local min_bytes="$3"
    local tmp="$target.tmp"
    local actual_bytes

    [ -f "$target" ] && return 0
    mkdir -p "$(dirname "$target")"
    rm -f "$tmp"

    if command -v curl >/dev/null 2>&1; then
        curl --fail --location --show-error --user-agent "codex-desktop-read-aloud" --output "$tmp" "$url"
    elif command -v wget >/dev/null 2>&1; then
        wget --user-agent="codex-desktop-read-aloud" --output-document "$tmp" "$url"
    else
        "$python_bin" - "$url" "$tmp" <<'PY'
import sys
import urllib.request
request = urllib.request.Request(sys.argv[1], headers={"User-Agent": "codex-desktop-read-aloud"})
with urllib.request.urlopen(request) as response, open(sys.argv[2], "wb") as output:
    output.write(response.read())
PY
    fi

    actual_bytes="$(wc -c < "$tmp" | tr -d ' ')"
    if [ "${actual_bytes:-0}" -lt "$min_bytes" ]; then
        rm -f "$tmp"
        echo "Downloaded file is unexpectedly small: $url" >&2
        exit 1
    fi

    mv "$tmp" "$target"
    verify_download_sha256 "$target"
}

python_bin="$(choose_python || true)"
[ -n "$python_bin" ] || {
    echo "Python 3.10-3.13 is required for kokoro-onnx" >&2
    exit 127
}

mkdir -p "$(dirname "$venv")"

if ! truthy_env_value "${CODEX_LINUX_READ_ALOUD_ALLOW_NETWORK_INSTALL:-0}"; then
    echo "Read Aloud network runtime install requires explicit CODEX_LINUX_READ_ALOUD_ALLOW_NETWORK_INSTALL=1" >&2
    exit 1
fi

requirements_file="${CODEX_LINUX_READ_ALOUD_PIP_REQUIREMENTS:-}"
if [ -z "$requirements_file" ]; then
    echo "Refusing to install Python packages without hashed requirements." >&2
    echo "Set CODEX_LINUX_READ_ALOUD_PIP_REQUIREMENTS to a pip requirements file using --hash entries." >&2
    exit 1
fi
[ -f "$requirements_file" ] || {
    echo "Read Aloud requirements file not found: $requirements_file" >&2
    exit 1
}

if command -v uv >/dev/null 2>&1; then
    if [ ! -x "$venv/bin/python" ]; then
        uv venv --python "$python_bin" "$venv"
    fi
    uv pip install --python "$venv/bin/python" --require-hashes -r "$requirements_file"
else
    if [ ! -x "$venv/bin/python" ]; then
        "$python_bin" -m venv "$venv"
    fi
    "$venv/bin/python" -m ensurepip --upgrade
    "$venv/bin/python" -m pip install --upgrade pip
    "$venv/bin/python" -m pip install --require-hashes -r "$requirements_file"
fi

echo "Kokoro runtime installed at $venv" >&2

if [ "${CODEX_LINUX_READ_ALOUD_SKIP_MODEL_DOWNLOAD:-0}" != "1" ]; then
    download_file "$model_url" "$model" 50000000
    download_file "$voices_url" "$voices" 1000000
    echo "Kokoro model installed at $model" >&2
    echo "Kokoro voices installed at $voices" >&2
else
    echo "Place kokoro-v1.0.onnx and voices-v1.0.bin under $data_home/kokoro" >&2
fi

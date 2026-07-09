#!/bin/bash
set -Eeuo pipefail

data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
venv="${CODEX_LINUX_READ_ALOUD_KOKORO_VENV:-$data_home/chatgpt-desktop/read-aloud/kokoro-venv}"
model="${CODEX_LINUX_READ_ALOUD_KOKORO_MODEL:-$data_home/kokoro/kokoro-v1.0.onnx}"
voices="${CODEX_LINUX_READ_ALOUD_KOKORO_VOICES:-$data_home/kokoro/voices-v1.0.bin}"
model_url="${CODEX_LINUX_READ_ALOUD_KOKORO_MODEL_URL:-https://huggingface.co/zijuncheng/kokoro_model_v1.0/resolve/main/kokoro-v1.0.onnx}"
voices_url="${CODEX_LINUX_READ_ALOUD_KOKORO_VOICES_URL:-https://huggingface.co/zijuncheng/kokoro_model_v1.0/resolve/main/voices-v1.0.bin}"

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
        curl --fail --location --show-error --user-agent "chatgpt-desktop-read-aloud" --output "$tmp" "$url"
    elif command -v wget >/dev/null 2>&1; then
        wget --user-agent="chatgpt-desktop-read-aloud" --output-document "$tmp" "$url"
    else
        "$python_bin" - "$url" "$tmp" <<'PY'
import sys
import urllib.request
request = urllib.request.Request(sys.argv[1], headers={"User-Agent": "chatgpt-desktop-read-aloud"})
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
}

python_bin="$(choose_python || true)"
[ -n "$python_bin" ] || {
    echo "Python 3.10-3.13 is required for kokoro-onnx" >&2
    exit 127
}

mkdir -p "$(dirname "$venv")"

if command -v uv >/dev/null 2>&1; then
    if [ ! -x "$venv/bin/python" ]; then
        uv venv --python "$python_bin" "$venv"
    fi
    uv pip install --python "$venv/bin/python" 'kokoro-onnx>=0.5.0' 'numpy>=2.0.2'
else
    if [ ! -x "$venv/bin/python" ]; then
        "$python_bin" -m venv "$venv"
    fi
    "$venv/bin/python" -m ensurepip --upgrade
    "$venv/bin/python" -m pip install --upgrade pip
    "$venv/bin/python" -m pip install 'kokoro-onnx>=0.5.0' 'numpy>=2.0.2'
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

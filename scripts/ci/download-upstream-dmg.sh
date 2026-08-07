#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "usage: $0 <upstream-dmg-url> <destination> [--reuse-existing]" >&2
    exit 2
}

[ "$#" -ge 2 ] && [ "$#" -le 3 ] || usage

UPSTREAM_DMG_URL="$1"
UPSTREAM_DMG_PATH="$2"
REUSE_EXISTING="${3:-}"
DOWNLOAD_ATTEMPTS="${CODEX_DMG_DOWNLOAD_ATTEMPTS:-3}"
RETRY_DELAY_SECONDS="${CODEX_DMG_RETRY_DELAY_SECONDS:-1}"

case "$REUSE_EXISTING" in
    ""|--reuse-existing) ;;
    *) usage ;;
esac
case "$DOWNLOAD_ATTEMPTS" in
    *[!0-9]*|0)
        echo "CODEX_DMG_DOWNLOAD_ATTEMPTS must be a positive integer" >&2
        exit 2
        ;;
esac
case "$RETRY_DELAY_SECONDS" in
    *[!0-9]*)
        echo "CODEX_DMG_RETRY_DELAY_SECONDS must be a non-negative integer" >&2
        exit 2
        ;;
esac
case "$UPSTREAM_DMG_URL" in
    https://*) ;;
    *)
        echo "Upstream DMG URL must use HTTPS" >&2
        exit 2
        ;;
esac

if [ "$REUSE_EXISTING" = "--reuse-existing" ] && [ -s "$UPSTREAM_DMG_PATH" ]; then
    echo "Using cached upstream DMG: $UPSTREAM_DMG_PATH"
    exit 0
fi

mkdir -p "$(dirname "$UPSTREAM_DMG_PATH")"
PART_PATH="$UPSTREAM_DMG_PATH.part"

cleanup() {
    rm -f -- "$PART_PATH"
}
trap cleanup EXIT HUP INT TERM

attempt=1
while [ "$attempt" -le "$DOWNLOAD_ATTEMPTS" ]; do
    rm -f -- "$PART_PATH"
    if curl \
            -fL \
            --retry 2 \
            --retry-all-errors \
            --connect-timeout 30 \
            --max-time 900 \
            -o "$PART_PATH" \
            -- "$UPSTREAM_DMG_URL"; then
        if [ -s "$PART_PATH" ]; then
            mv -f -- "$PART_PATH" "$UPSTREAM_DMG_PATH"
            trap - EXIT HUP INT TERM
            echo "Downloaded upstream DMG: $UPSTREAM_DMG_PATH"
            exit 0
        fi
        echo "Upstream DMG download attempt $attempt produced an empty file" >&2
    else
        echo "Upstream DMG download attempt $attempt failed" >&2
    fi

    if [ "$attempt" -lt "$DOWNLOAD_ATTEMPTS" ] && [ "$RETRY_DELAY_SECONDS" -gt 0 ]; then
        sleep "$RETRY_DELAY_SECONDS"
    fi
    attempt=$((attempt + 1))
done

echo "Could not download a non-empty upstream DMG after $DOWNLOAD_ATTEMPTS attempts" >&2
exit 1

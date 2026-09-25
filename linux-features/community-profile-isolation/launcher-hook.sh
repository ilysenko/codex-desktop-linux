#!/usr/bin/env bash
set -Eeuo pipefail

: "${HOME:?HOME is required}"
: "${CODEX_LINUX_APP_DIR:?CODEX_LINUX_APP_DIR is required}"

canonical="$HOME/.config/Codex-Community"
wrapper="$CODEX_LINUX_APP_DIR/.codex-linux/features/community-profile-isolation/codex-cli-wrapper.sh"

for arg in "$@"; do
  case "$arg" in
    --user-data-dir="$canonical")
      ;;
    --user-data-dir|--user-data-dir=*)
      printf 'ChatGPT Community refuses non-canonical --user-data-dir: %s\n' "$arg" >&2
      exit 64
      ;;
  esac
done

if [[ ! -x "$wrapper" ]]; then
  printf 'ChatGPT Community CLI isolation wrapper is missing or not executable: %s\n' \
    "$wrapper" >&2
  exit 69
fi

printf 'env CODEX_CLI_PATH=%s\n' "$wrapper"
printf 'electron-arg %s\n' "--user-data-dir=$canonical"

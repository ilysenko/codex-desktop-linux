#!/bin/bash
set -Eeuo pipefail

stylesheet="${CODEX_LINUX_OMARCHY_STYLESHEET:-${HOME}/.config/omarchy/current/theme/codex-desktop.css}"
uri="$(python3 - "$stylesheet" <<'PY'
from pathlib import Path
import sys
print(Path(sys.argv[1]).expanduser().absolute().as_uri())
PY
)"
printf 'env CODEX_LINUX_OMARCHY_STYLESHEET_URI=%s\n' "$uri"

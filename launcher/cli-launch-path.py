#!/usr/bin/env python3
"""Resolve a Codex CLI path to a canonical executable without running it."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import stat
import sys


class LaunchPathError(RuntimeError):
    pass


def resolve_cli_launch_path(raw_path: str) -> Path:
    if os.sep not in raw_path:
        discovered = shutil.which(raw_path)
        if discovered is None:
            raise LaunchPathError(f"Codex CLI command {raw_path!r} was not found in PATH")
        selected_path = Path(discovered)
    else:
        selected_path = Path(raw_path)

    try:
        canonical_cli = selected_path.resolve(strict=True)
        metadata = canonical_cli.stat()
    except OSError as error:
        raise LaunchPathError(f"Failed to resolve Codex CLI path {selected_path}: {error}") from error

    if not stat.S_ISREG(metadata.st_mode) or not os.access(canonical_cli, os.X_OK):
        raise LaunchPathError(f"Selected Codex CLI target {canonical_cli} is not an executable file")

    # mise uses a multicall binary: its shims all point at the mise executable,
    # which selects the requested tool from the shim's argv[0]. GUI children
    # such as Chrome native hosts do not provide mise's normal shell context,
    # so register the concrete npm-installed CLI instead of either the shim or
    # the canonical mise multicall binary.
    if selected_path.is_symlink() and canonical_cli.name == "mise":
        mise_install = (
            selected_path.parent.parent
            / "installs"
            / "node"
            / "latest"
            / "bin"
            / selected_path.name
        )
        try:
            installed_cli = mise_install.resolve(strict=True)
            installed_metadata = installed_cli.stat()
        except OSError as error:
            raise LaunchPathError(
                f"Failed to resolve the installed Codex CLI behind mise shim {selected_path}: {error}"
            ) from error
        if not stat.S_ISREG(installed_metadata.st_mode) or not os.access(installed_cli, os.X_OK):
            raise LaunchPathError(
                f"Installed Codex CLI target {installed_cli} is not an executable file"
            )
        return installed_cli
    return canonical_cli


def main() -> int:
    if len(sys.argv) != 2 or not sys.argv[1]:
        print(f"usage: {Path(sys.argv[0]).name} CLI_PATH", file=sys.stderr)
        return 64
    try:
        print(resolve_cli_launch_path(sys.argv[1]))
    except (OSError, LaunchPathError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

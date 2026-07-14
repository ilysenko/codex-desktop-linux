#!/usr/bin/env python3
"""Resolve a Codex CLI path without executing an untrusted standalone tree."""

from __future__ import annotations

import os
import shutil
import stat
import sys
from pathlib import Path
from typing import Optional


class TrustError(RuntimeError):
    pass


def standalone_home_from_path(path: Path) -> Optional[Path]:
    parts = path.parts
    for index in range(len(parts) - 2):
        if parts[index : index + 2] != ("packages", "standalone"):
            continue
        if parts[index + 2] not in ("current", "releases"):
            continue
        if index == 0:
            return None
        return Path(*parts[:index])
    return None


def unresolved_symlink_target(path: Path) -> Optional[Path]:
    try:
        target = Path(os.readlink(path))
    except OSError:
        return None
    if not target.is_absolute():
        target = path.parent / target
    return Path(os.path.abspath(target))


def path_is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def trusted_owner(uid: int) -> bool:
    return uid in (os.geteuid(), 0)


def validate_parent_chain(path: Path) -> None:
    parent = path.parent
    while True:
        metadata = parent.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            raise TrustError(
                f"Managed standalone Codex CLI ancestor {parent} is not a trusted directory"
            )
        if not trusted_owner(metadata.st_uid):
            raise TrustError(
                f"Managed standalone Codex CLI ancestor {parent} is owned by untrusted uid {metadata.st_uid}"
            )
        writable = metadata.st_mode & 0o022
        root_owned_sticky = (
            metadata.st_uid == 0
            and metadata.st_mode & stat.S_ISVTX
            and metadata.st_mode & 0o002
        )
        if writable and not root_owned_sticky:
            raise TrustError(
                f"Managed standalone Codex CLI ancestor {parent} is group/world-writable and therefore untrusted"
            )
        if parent.parent == parent:
            break
        parent = parent.parent


def validate_standalone_tree(standalone_root: Path) -> Path:
    root_metadata = standalone_root.lstat()
    if not stat.S_ISDIR(root_metadata.st_mode) or stat.S_ISLNK(root_metadata.st_mode):
        raise TrustError(
            f"Managed standalone Codex CLI root {standalone_root} is not a trusted directory"
        )

    canonical_root = standalone_root.resolve(strict=True)
    validate_parent_chain(canonical_root)

    pending = [standalone_root]
    while pending:
        path = pending.pop()
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            try:
                target = path.resolve(strict=True)
            except OSError as error:
                raise TrustError(
                    f"Managed standalone Codex CLI contains a broken symlink at {path}"
                ) from error
            if not path_is_within(target, canonical_root):
                raise TrustError(
                    f"Managed standalone Codex CLI contains an external symlink at {path}"
                )
            continue

        if not (stat.S_ISDIR(metadata.st_mode) or stat.S_ISREG(metadata.st_mode)):
            raise TrustError(
                f"Managed standalone Codex CLI contains an unsupported file type at {path}"
            )
        if not trusted_owner(metadata.st_uid):
            raise TrustError(
                f"Managed standalone Codex CLI path {path} is owned by untrusted uid {metadata.st_uid}"
            )
        if metadata.st_mode & 0o022:
            raise TrustError(
                f"Managed standalone Codex CLI path {path} is group/world-writable and therefore untrusted"
            )
        if stat.S_ISDIR(metadata.st_mode):
            pending.extend(path.iterdir())

    return canonical_root


def resolve_cli_launch_path(raw_path: str) -> Path:
    if os.sep not in raw_path:
        discovered = shutil.which(raw_path)
        if discovered is None:
            raise TrustError(f"Codex CLI command {raw_path!r} was not found in PATH")
        selected_path = Path(discovered)
    else:
        selected_path = Path(raw_path)
    lexical_path = Path(os.path.abspath(selected_path))
    try:
        canonical_cli = selected_path.resolve(strict=True)
    except OSError as error:
        raise TrustError(f"Failed to resolve Codex CLI path {selected_path}: {error}") from error

    candidates = [canonical_cli, lexical_path]
    raw_target = unresolved_symlink_target(lexical_path)
    if raw_target is not None:
        candidates.append(raw_target)

    codex_home = next(
        (home for candidate in candidates if (home := standalone_home_from_path(candidate))),
        None,
    )
    if codex_home is None:
        return selected_path

    canonical_root = validate_standalone_tree(codex_home / "packages" / "standalone")
    if not path_is_within(canonical_cli, canonical_root):
        raise TrustError(
            f"Managed standalone Codex CLI path {selected_path} resolves outside its trusted root"
        )
    target_metadata = canonical_cli.stat()
    if not stat.S_ISREG(target_metadata.st_mode) or not os.access(canonical_cli, os.X_OK):
        raise TrustError(
            f"Managed standalone Codex CLI target {canonical_cli} is not an executable file"
        )
    return canonical_cli


def main() -> int:
    if len(sys.argv) != 2 or not sys.argv[1]:
        print(f"usage: {Path(sys.argv[0]).name} CLI_PATH", file=sys.stderr)
        return 64
    try:
        print(resolve_cli_launch_path(sys.argv[1]))
    except (OSError, TrustError) as error:
        print(f"Codex CLI trust check failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Resolve a Codex CLI path without executing an untrusted standalone tree."""

from __future__ import annotations

import os
import shutil
import stat
import sys
import tempfile
from pathlib import Path
from typing import Optional


class TrustError(RuntimeError):
    pass


PROVENANCE_FILE = ".codex-standalone-provenance"


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


def validate_parent_chain(path: Path, subject: str) -> None:
    parent = path.parent
    while True:
        metadata = parent.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            raise TrustError(
                f"{subject} ancestor {parent} is not a trusted directory"
            )
        if not trusted_owner(metadata.st_uid):
            raise TrustError(
                f"{subject} ancestor {parent} is owned by untrusted uid {metadata.st_uid}"
            )
        writable = metadata.st_mode & 0o022
        root_owned_sticky = metadata.st_uid == 0 and metadata.st_mode & stat.S_ISVTX
        if writable and not root_owned_sticky:
            raise TrustError(
                f"{subject} ancestor {parent} is group/world-writable and therefore untrusted"
            )
        if parent.parent == parent:
            break
        parent = parent.parent


def validate_cli_target(lexical_path: Path, canonical_path: Path) -> Path:
    canonical_path = validate_cli_identity(lexical_path, canonical_path)
    validate_parent_chain(lexical_path, "Selected Codex CLI")
    return canonical_path


def validate_cli_identity(lexical_path: Path, canonical_path: Path) -> Path:
    entry_metadata = lexical_path.lstat()
    if not trusted_owner(entry_metadata.st_uid):
        raise TrustError(
            f"Selected Codex CLI entry {lexical_path} is owned by untrusted uid {entry_metadata.st_uid}"
        )
    target_metadata = canonical_path.stat()
    if not stat.S_ISREG(target_metadata.st_mode) or not os.access(canonical_path, os.X_OK):
        raise TrustError(f"Selected Codex CLI target {canonical_path} is not an executable file")
    if not trusted_owner(target_metadata.st_uid):
        raise TrustError(
            f"Selected Codex CLI target {canonical_path} is owned by untrusted uid {target_metadata.st_uid}"
        )
    if target_metadata.st_mode & 0o022:
        raise TrustError(
            f"Selected Codex CLI target {canonical_path} is group/world-writable and therefore untrusted"
        )
    validate_parent_chain(canonical_path, "Selected Codex CLI target")
    return canonical_path


def validate_standalone_tree(standalone_root: Path) -> Path:
    root_metadata = standalone_root.lstat()
    if not stat.S_ISDIR(root_metadata.st_mode) or stat.S_ISLNK(root_metadata.st_mode):
        raise TrustError(
            f"Managed standalone Codex CLI root {standalone_root} is not a trusted directory"
        )

    canonical_root = standalone_root.resolve(strict=True)
    validate_parent_chain(canonical_root, "Managed standalone Codex CLI")

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


def existing_default_standalone_home() -> Optional[Path]:
    raw_codex_home = os.environ.get("CODEX_HOME")
    if raw_codex_home:
        codex_home = Path(raw_codex_home)
    else:
        raw_home = os.environ.get("HOME")
        if not raw_home:
            return None
        codex_home = Path(raw_home) / ".codex"
    try:
        (codex_home / "packages" / "standalone").lstat()
    except OSError:
        return None
    return codex_home


def provenance_path() -> Optional[Path]:
    raw_home = os.environ.get("HOME")
    if not raw_home:
        return None
    try:
        canonical_home = Path(raw_home).resolve(strict=True)
    except OSError as error:
        raise TrustError(f"Failed to resolve HOME for standalone CLI provenance: {error}") from error
    return canonical_home / PROVENANCE_FILE


def read_standalone_provenance() -> Optional[Path]:
    path = provenance_path()
    if path is None:
        return None
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise TrustError(f"Standalone Codex CLI provenance {path} is not a regular file")
    if not trusted_owner(metadata.st_uid) or metadata.st_mode & 0o022:
        raise TrustError(f"Standalone Codex CLI provenance {path} is not trusted")
    validate_parent_chain(path, "Standalone Codex CLI provenance")
    value = path.read_text(encoding="utf-8").strip()
    codex_home = Path(value)
    if not value or not codex_home.is_absolute():
        raise TrustError(f"Standalone Codex CLI provenance {path} is invalid")
    return codex_home


def record_standalone_provenance(codex_home: Path, lexical_cli: Path) -> None:
    path = provenance_path()
    if path is None:
        return
    entry_metadata = lexical_cli.lstat()
    if not trusted_owner(entry_metadata.st_uid):
        raise TrustError(
            f"Selected Codex CLI entry {lexical_cli} is owned by untrusted uid {entry_metadata.st_uid}"
        )
    validate_parent_chain(path, "Standalone Codex CLI provenance")
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=path.parent, prefix=f".{PROVENANCE_FILE}.", delete=False
    ) as handle:
        temp_path = Path(handle.name)
        os.chmod(temp_path, 0o600)
        handle.write(f"{codex_home}\n")
        handle.flush()
        os.fsync(handle.fileno())
    try:
        os.replace(temp_path, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass


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

    detected_home = next(
        (home for candidate in candidates if (home := standalone_home_from_path(candidate))),
        None,
    )
    if detected_home is None:
        detected_home = existing_default_standalone_home()
    codex_home = read_standalone_provenance()
    if codex_home is None:
        if detected_home is None:
            return validate_cli_identity(lexical_path, canonical_cli)
        codex_home = detected_home
    elif detected_home is not None and detected_home != codex_home:
        raise TrustError(
            f"Selected Codex CLI provenance {detected_home} conflicts with recorded standalone home {codex_home}"
        )

    def validate_selection() -> Path:
        canonical_root = validate_standalone_tree(codex_home / "packages" / "standalone")
        if not path_is_within(canonical_cli, canonical_root):
            raise TrustError(
                f"Managed standalone Codex CLI path {selected_path} resolves outside its trusted root"
            )
        return validate_cli_target(lexical_path, canonical_cli)

    launch_path = validate_selection()
    if read_standalone_provenance() is None:
        record_standalone_provenance(codex_home, lexical_path)
        launch_path = validate_selection()
    return launch_path


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

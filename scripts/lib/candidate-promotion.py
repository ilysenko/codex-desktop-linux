#!/usr/bin/env python3
"""Durable helpers for interruption-safe candidate directory promotion."""

from __future__ import annotations

import argparse
import ctypes
import errno
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid


RENAME_EXCHANGE = 2
MARKER_NAME = ".codex-promotion-transaction"


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_file_durably(path: Path, contents: str) -> None:
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}-{uuid.uuid4().hex}")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(contents)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        fsync_directory(path.parent)
    except BaseException:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise


def marker_path(directory: Path) -> Path:
    return directory / MARKER_NAME


def read_marker(directory: Path) -> str | None:
    try:
        return marker_path(directory).read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return None


def remove_marker(directory: Path) -> None:
    try:
        marker_path(directory).unlink()
        fsync_directory(directory)
    except FileNotFoundError:
        pass


def identity(path: Path) -> tuple[int, int] | None:
    try:
        value = path.lstat()
    except FileNotFoundError:
        return None
    return value.st_dev, value.st_ino


def stored_identity(journal: dict[str, object]) -> tuple[int, int]:
    return int(journal["oldDevice"]), int(journal["oldInode"])


def load_journal(path: Path) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("schemaVersion") != 1:
        raise RuntimeError(f"Unsupported promotion journal schema: {path}")
    return value


def remove_journal(path: Path) -> None:
    try:
        path.unlink()
        fsync_directory(path.parent)
    except FileNotFoundError:
        pass


def cleanup_failed_prepare(candidate: Path, journal_path: Path, transaction: str) -> None:
    try:
        journal = load_journal(journal_path)
    except FileNotFoundError:
        journal = None
    if journal is not None:
        if str(journal.get("transactionId")) != transaction:
            raise RuntimeError(
                f"Refusing to remove a promotion journal for another transaction: {journal_path}"
            )
        # Remove the journal first. If cleanup is interrupted afterward, a
        # leftover marker on the disposable candidate cannot block recovery.
        remove_journal(journal_path)
    if read_marker(candidate) == transaction:
        remove_marker(candidate)


def atomic_exchange(left: Path, right: Path) -> None:
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        renameat2 = libc.renameat2
    except AttributeError as error:
        raise RuntimeError(
            "Atomic directory exchange requires renameat2(RENAME_EXCHANGE); "
            "this libc does not expose it"
        ) from error
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    result = renameat2(
        -100,
        os.fsencode(left),
        -100,
        os.fsencode(right),
        RENAME_EXCHANGE,
    )
    if result != 0:
        error_number = ctypes.get_errno()
        detail = os.strerror(error_number)
        if error_number in {errno.ENOSYS, errno.EINVAL, errno.ENOTSUP, errno.EOPNOTSUPP}:
            detail = f"atomic directory exchange is unsupported: {detail}"
        raise OSError(error_number, detail, f"{left} <-> {right}")
    try:
        fsync_directory(left.parent)
    except OSError as error:
        # The namespace exchange already happened atomically. Leave the journal
        # for recovery instead of reporting a false pre-exchange failure.
        print(f"warning: could not sync promotion parent: {error}", file=sys.stderr)


def prepare(args: argparse.Namespace) -> None:
    candidate = Path(args.candidate).absolute()
    final = Path(args.final).absolute()
    backup = Path(args.backup).absolute()
    journal_path = Path(args.journal).absolute()
    if candidate.parent != final.parent or backup.parent != final.parent:
        raise RuntimeError("Candidate, final, and backup paths must be siblings")
    if journal_path.exists():
        raise RuntimeError(f"Pending promotion journal must be recovered first: {journal_path}")
    if backup.exists():
        raise RuntimeError(f"Promotion backup already exists: {backup}")
    old_identity = identity(final)
    if old_identity is None or not candidate.is_dir():
        raise RuntimeError("Both the current app and candidate must exist before exchange")

    try:
        write_file_durably(marker_path(candidate), f"{args.transaction}\n")
        journal = {
            "schemaVersion": 1,
            "transactionId": args.transaction,
            "candidate": str(candidate),
            "final": str(final),
            "backup": str(backup),
            "oldDevice": old_identity[0],
            "oldInode": old_identity[1],
        }
        write_file_durably(journal_path, f"{json.dumps(journal, indent=2, sort_keys=True)}\n")
        if os.environ.get("CODEX_PROMOTION_TEST_FAIL_PREPARE_AFTER_JOURNAL") == "1":
            raise OSError("Simulated failure after writing the promotion journal")
    except Exception as error:
        try:
            cleanup_failed_prepare(candidate, journal_path, args.transaction)
        except Exception as cleanup_error:
            raise RuntimeError(
                f"{error}; additionally failed to clean up promotion preparation: {cleanup_error}"
            ) from error
        raise


def abort(args: argparse.Namespace) -> None:
    journal_path = Path(args.journal).absolute()
    if not journal_path.exists():
        return
    journal = load_journal(journal_path)
    transaction = str(journal["transactionId"])
    candidate = Path(str(journal["candidate"]))
    final = Path(str(journal["final"]))
    if read_marker(candidate) == transaction:
        remove_marker(candidate)
    if read_marker(final) == transaction:
        remove_marker(final)
    remove_journal(journal_path)


def exchange(args: argparse.Namespace) -> None:
    if os.environ.get("CODEX_PROMOTION_TEST_FAIL_EXCHANGE") == "1":
        raise RuntimeError("Simulated unsupported atomic directory exchange")
    atomic_exchange(Path(args.left).absolute(), Path(args.right).absolute())


def finalize(args: argparse.Namespace) -> None:
    journal_path = Path(args.journal).absolute()
    journal = load_journal(journal_path)
    transaction = str(journal["transactionId"])
    candidate = Path(str(journal["candidate"]))
    final = Path(str(journal["final"]))
    backup = Path(str(journal["backup"]))
    if read_marker(final) != transaction:
        raise RuntimeError("Accepted candidate marker did not move to the final app")
    if identity(candidate) != stored_identity(journal):
        raise RuntimeError("The exchanged previous app no longer matches the promotion journal")
    if backup.exists():
        raise RuntimeError(f"Promotion backup already exists: {backup}")
    if os.environ.get("CODEX_PROMOTION_TEST_FAIL_BACKUP_MOVE") == "1":
        raise RuntimeError("Simulated backup move failure")

    os.rename(candidate, backup)
    try:
        fsync_directory(final.parent)
        remove_marker(final)
        remove_journal(journal_path)
    except OSError as error:
        # The accepted app and backup are both already durable namespace entries.
        # Recovery will finish marker/journal cleanup on the next invocation.
        print(f"warning: promotion completed but metadata cleanup failed: {error}", file=sys.stderr)
    print(backup)


def recover(args: argparse.Namespace) -> None:
    journal_path = Path(args.journal).absolute()
    final = Path(args.final).absolute()
    if not journal_path.exists():
        # A crash after journal removal but before marker cleanup is harmless.
        remove_marker(final)
        return

    journal = load_journal(journal_path)
    transaction = str(journal["transactionId"])
    candidate = Path(str(journal["candidate"]))
    recorded_final = Path(str(journal["final"]))
    backup = Path(str(journal["backup"]))
    old_identity = stored_identity(journal)
    if recorded_final != final:
        raise RuntimeError(f"Promotion journal targets a different app: {recorded_final}")

    if read_marker(final) == transaction:
        if identity(candidate) == old_identity:
            if backup.exists():
                raise RuntimeError(f"Cannot recover promotion because backup exists: {backup}")
            os.rename(candidate, backup)
            fsync_directory(final.parent)
        elif identity(backup) != old_identity:
            raise RuntimeError(
                "Accepted app is available, but the previous app cannot be located for recovery"
            )
        remove_marker(final)
        remove_journal(journal_path)
        print(backup)
        return

    if read_marker(candidate) == transaction and identity(final) == old_identity:
        # Preparation completed but the atomic exchange never happened.
        remove_marker(candidate)
        remove_journal(journal_path)
        return

    if identity(backup) == old_identity and final.exists():
        # The backup rename completed before metadata cleanup was interrupted.
        remove_marker(final)
        remove_journal(journal_path)
        print(backup)
        return

    raise RuntimeError(f"Cannot safely recover interrupted promotion: {journal_path}")


def list_stale_backups(args: argparse.Namespace) -> None:
    final = Path(args.final).absolute()
    protected = Path(args.protect).absolute() if args.protect else None
    pattern = re.compile(rf"^{re.escape(final.name)}\.backup-(\d{{14}})(?:-([1-9]\d*))?$")
    managed: list[tuple[tuple[str, int], Path]] = []

    try:
        siblings = list(final.parent.iterdir())
    except FileNotFoundError:
        return

    for sibling in siblings:
        match = pattern.fullmatch(sibling.name)
        if match is None:
            continue
        try:
            metadata = sibling.lstat()
        except FileNotFoundError:
            continue
        # Never follow or remove a symlink, regular file, or similarly named
        # maintainer-owned path.
        if not stat.S_ISDIR(metadata.st_mode):
            continue
        managed.append(((match.group(1), int(match.group(2) or 0)), sibling.absolute()))

    keep: Path | None = None
    if protected is not None and any(path == protected for _, path in managed):
        keep = protected
    elif args.keep_latest and managed:
        keep = max(managed, key=lambda item: item[0])[1]

    for _, path in managed:
        if path != keep:
            print(path)


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser()
    subcommands = value.add_subparsers(dest="command", required=True)

    prepare_parser = subcommands.add_parser("prepare")
    prepare_parser.add_argument("--candidate", required=True)
    prepare_parser.add_argument("--final", required=True)
    prepare_parser.add_argument("--backup", required=True)
    prepare_parser.add_argument("--journal", required=True)
    prepare_parser.add_argument("--transaction", required=True)
    prepare_parser.set_defaults(function=prepare)

    exchange_parser = subcommands.add_parser("exchange")
    exchange_parser.add_argument("--left", required=True)
    exchange_parser.add_argument("--right", required=True)
    exchange_parser.set_defaults(function=exchange)

    for name, function in (("abort", abort), ("finalize", finalize)):
        command_parser = subcommands.add_parser(name)
        command_parser.add_argument("--journal", required=True)
        command_parser.set_defaults(function=function)

    recover_parser = subcommands.add_parser("recover")
    recover_parser.add_argument("--journal", required=True)
    recover_parser.add_argument("--final", required=True)
    recover_parser.set_defaults(function=recover)

    stale_parser = subcommands.add_parser("list-stale-backups")
    stale_parser.add_argument("--final", required=True)
    stale_parser.add_argument("--protect")
    stale_parser.add_argument("--keep-latest", action="store_true")
    stale_parser.set_defaults(function=list_stale_backups)
    return value


def main() -> int:
    args = parser().parse_args()
    try:
        args.function(args)
    except Exception as error:  # noqa: BLE001 - CLI should report a concise durable-operation error.
        print(f"candidate promotion failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

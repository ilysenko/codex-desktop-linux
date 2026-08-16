#!/usr/bin/env python3
"""Bound the Linux launcher log without rotating an active writer.

Launcher processes write to a per-app FIFO.  This process is the sole writer
of the regular log file, which means rotation can close the active file before
renaming it.  The FIFO is intentionally shared by warm-start and concurrent
launcher invocations; the router exits after the last writer has gone away.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import select
import signal
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_MAX_BYTES = 50 * 1024 * 1024
DEFAULT_MAX_AGE_SECONDS = 24 * 60 * 60
DEFAULT_RETENTION_FILES = 7
DEFAULT_IDLE_SECONDS = 2.0
MAX_ALLOWED_BYTES = 1024 * 1024 * 1024
MAX_ALLOWED_AGE_SECONDS = 30 * 24 * 60 * 60
MAX_ALLOWED_RETENTION_FILES = 32
ROTATED_NAME_RE = re.compile(r"\.rotated-[0-9T]+Z-[0-9]+-[0-9]+$")


class RouterError(RuntimeError):
    """A fail-closed startup or runtime error."""


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def absolute_path(value: str) -> Path:
    return Path(os.path.abspath(value))


def atomic_write(path: Path, payload: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(temporary, flags, mode)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            fd = -1
            handle.write(payload)
            handle.flush()
            os.fchmod(handle.fileno(), mode)
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if fd >= 0:
            os.close(fd)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        with path.open(encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, ValueError, TypeError):
        return None
    return value if isinstance(value, dict) else None


def parse_bounded_int(raw: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, value))


def parse_bounded_float(raw: str, default: float, minimum: float, maximum: float) -> float:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, value))


def open_pids_for_path(path: Path, excluded_pid: int) -> list[int]:
    """Return processes with an open descriptor for the same inode.

    This is deliberately used before startup takeover and before deleting a
    rotated file.  A process can disappear or be unreadable between /proc
    scans; those entries are ignored rather than treated as owners.
    """

    try:
        target_stat = path.stat()
    except FileNotFoundError:
        return []
    except OSError as error:
        raise RouterError(f"cannot inspect active log {path}: {error}") from error

    target_key = (target_stat.st_dev, target_stat.st_ino)
    owners: set[int] = set()
    proc_root = Path("/proc")
    try:
        processes = list(proc_root.iterdir())
    except OSError as error:
        raise RouterError(f"cannot inspect /proc for active log ownership: {error}") from error

    for process in processes:
        if not process.name.isdigit():
            continue
        pid = int(process.name)
        if pid == excluded_pid:
            continue
        fd_dir = process / "fd"
        try:
            descriptors = list(fd_dir.iterdir())
        except OSError:
            # A process can exit or be inaccessible between the directory
            # scan and the read.
            continue
        for descriptor in descriptors:
            try:
                descriptor_stat = descriptor.stat()
            except OSError:
                continue
            if (descriptor_stat.st_dev, descriptor_stat.st_ino) == target_key:
                owners.add(pid)
                break
    return sorted(owners)


class LogRouter:
    def __init__(self, args: argparse.Namespace) -> None:
        self.pid = os.getpid()
        self.fifo = absolute_path(args.fifo)
        self.active_log = absolute_path(args.active_log)
        self.state_dir = absolute_path(args.state_dir)
        self.pid_file = absolute_path(args.pid_file)
        self.ready_file = absolute_path(args.ready_file)
        self.receipt_file = absolute_path(args.receipt_file)
        self.max_bytes = parse_bounded_int(
            args.max_bytes, DEFAULT_MAX_BYTES, 1, MAX_ALLOWED_BYTES
        )
        self.max_age_seconds = parse_bounded_int(
            args.max_age_seconds, DEFAULT_MAX_AGE_SECONDS, 60, MAX_ALLOWED_AGE_SECONDS
        )
        self.retention_files = parse_bounded_int(
            args.retention_files, DEFAULT_RETENTION_FILES, 1, MAX_ALLOWED_RETENTION_FILES
        )
        self.idle_seconds = parse_bounded_float(
            args.idle_seconds, DEFAULT_IDLE_SECONDS, 0.5, 30.0
        )
        self.current = None
        self.current_size = 0
        self.current_opened_at = 0.0
        self.rotation_count = 0
        self.reclaimed_bytes = 0
        self.protected_files: list[dict[str, Any]] = []
        self.last_rotation: dict[str, Any] | None = None
        self.stop_requested = False
        self.reader_fd: int | None = None
        self.last_status = "starting"

    def receipt(self, status: str, error: str | None = None) -> None:
        self.last_status = status
        payload: dict[str, Any] = {
            "schemaVersion": 1,
            "status": status,
            "pid": self.pid,
            "fifo": str(self.fifo),
            "activeLog": str(self.active_log),
            "updatedAt": utc_timestamp(),
            "maxBytes": self.max_bytes,
            "maxAgeSeconds": self.max_age_seconds,
            "retentionFiles": self.retention_files,
            "idleSeconds": self.idle_seconds,
            "currentBytes": self.current_size,
            "rotationCount": self.rotation_count,
            "reclaimedBytes": self.reclaimed_bytes,
            "protectedFiles": self.protected_files[-16:],
            "lastRotation": self.last_rotation,
        }
        if error:
            payload["error"] = error[:512]
        try:
            atomic_write(self.receipt_file, json.dumps(payload, sort_keys=True) + "\n")
        except OSError:
            # The receipt is evidence, not a reason to fall back to an
            # unbounded direct writer.  The caller still owns the log pipe.
            pass

    def active_writer_conflict(self) -> list[int]:
        if not self.active_log.exists():
            return []
        return open_pids_for_path(self.active_log, self.pid)

    def rotated_paths(self) -> list[Path]:
        pattern = f"{self.active_log.name}.rotated-*"
        paths = []
        for path in self.active_log.parent.glob(pattern):
            if path.is_file() and ROTATED_NAME_RE.search(path.name):
                paths.append(path)
        return paths

    def reclaim_rotated(self) -> tuple[int, int]:
        candidates = sorted(
            self.rotated_paths(),
            key=lambda path: path.stat().st_mtime_ns,
            reverse=True,
        )
        reclaimed = 0
        protected = 0
        self.protected_files = []
        for index, path in enumerate(candidates):
            if index < self.retention_files:
                continue
            owners = open_pids_for_path(path, self.pid)
            if owners:
                protected += 1
                self.protected_files.append({"path": str(path), "pids": owners})
                continue
            try:
                size = path.stat().st_size
                path.unlink()
            except FileNotFoundError:
                continue
            except OSError as error:
                self.protected_files.append(
                    {"path": str(path), "error": str(error)[:256]}
                )
                continue
            reclaimed += size
        return reclaimed, protected

    def open_active(self) -> None:
        self.active_log.parent.mkdir(parents=True, exist_ok=True)
        self.current = self.active_log.open("ab", buffering=0)
        self.current_size = self.active_log.stat().st_size
        self.current_opened_at = time.time()

    def rotate(self, reason: str) -> None:
        if self.current is None:
            return
        conflict = self.active_writer_conflict()
        if conflict:
            message = (
                "active launcher log became owned by another process before rotation: "
                + ",".join(map(str, conflict))
            )
            self.receipt("blocked-active-writer", message)
            raise RouterError(message)
        old_size = self.current_size
        self.current.flush()
        self.current.close()
        self.current = None
        rotated = self.active_log.with_name(
            f"{self.active_log.name}.rotated-"
            f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
            f"-{self.pid}-{self.rotation_count + 1}"
        )
        try:
            os.replace(self.active_log, rotated)
        except FileNotFoundError:
            # An owner outside this router removed the path.  Recreate the
            # active file but report the anomaly instead of deleting anything.
            rotated = None
        self.open_active()
        self.rotation_count += 1
        self.last_rotation = {
            "at": utc_timestamp(),
            "reason": reason,
            "bytes": old_size,
            "rotatedFile": str(rotated) if rotated else None,
        }
        if rotated:
            reclaimed, _ = self.reclaim_rotated()
            self.reclaimed_bytes += reclaimed
        self.receipt("running")

    def should_rotate(self) -> str | None:
        if self.current_size <= 0:
            return None
        if self.current_size >= self.max_bytes:
            return "size"
        if time.time() - self.current_opened_at >= self.max_age_seconds:
            return "age"
        return None

    def write(self, payload: bytes) -> None:
        if self.current is None:
            raise RouterError("log router has no active file")
        offset = 0
        while offset < len(payload):
            reason = self.should_rotate()
            if reason:
                self.rotate(reason)
            remaining = max(1, self.max_bytes - self.current_size)
            chunk_size = min(len(payload) - offset, remaining, 64 * 1024)
            chunk = payload[offset : offset + chunk_size]
            try:
                self.current.write(chunk)
            except OSError as error:
                raise RouterError(f"cannot write launcher log: {error}") from error
            self.current_size += len(chunk)
            offset += len(chunk)

    def write_ready(self) -> None:
        atomic_write(
            self.pid_file,
            f"{self.pid}\n",
        )
        atomic_write(
            self.ready_file,
            json.dumps(
                {
                    "schemaVersion": 1,
                    "pid": self.pid,
                    "fifo": str(self.fifo),
                    "activeLog": str(self.active_log),
                    "readyAt": utc_timestamp(),
                },
                sort_keys=True,
            )
            + "\n",
        )

    def cleanup_state(self) -> None:
        for path, expected in ((self.pid_file, f"{self.pid}\n"),):
            try:
                if path.read_text(encoding="utf-8") == expected:
                    path.unlink()
            except (FileNotFoundError, OSError):
                pass
        ready = read_json(self.ready_file)
        if ready and ready.get("pid") == self.pid:
            try:
                self.ready_file.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                pass

    def close_current(self) -> None:
        if self.current is not None:
            try:
                self.current.flush()
                self.current.close()
            except OSError:
                pass
            self.current = None

    def stop(self, _signum: int, _frame: Any) -> None:
        self.stop_requested = True

    def run(self) -> int:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.receipt("starting")
        conflict = self.active_writer_conflict()
        if conflict:
            message = f"active launcher log is already open by pid(s): {','.join(map(str, conflict))}"
            self.receipt("blocked-active-writer", message)
            raise RouterError(message)

        self.active_log.parent.mkdir(parents=True, exist_ok=True)
        if self.active_log.exists():
            existing_size = self.active_log.stat().st_size
            existing_age = time.time() - self.active_log.stat().st_mtime
            if existing_size >= self.max_bytes or existing_age >= self.max_age_seconds:
                # No writer was present above, so this takeover is safe.  The
                # rotation code below owns the new file after it is opened.
                self.open_active()
                self.rotate("startup")
            else:
                self.open_active()
        else:
            self.open_active()

        try:
            self.reader_fd = os.open(self.fifo, os.O_RDONLY | os.O_NONBLOCK)
        except OSError as error:
            self.close_current()
            raise RouterError(f"cannot open launcher log FIFO {self.fifo}: {error}") from error

        self.write_ready()
        self.receipt("running")
        seen_writer = False
        idle_since: float | None = None

        while not self.stop_requested:
            assert self.reader_fd is not None
            try:
                readable, _, _ = select.select([self.reader_fd], [], [], 1.0)
            except (OSError, ValueError) as error:
                raise RouterError(f"cannot wait on launcher log FIFO: {error}") from error

            if not readable:
                reason = self.should_rotate()
                if reason:
                    self.rotate(reason)
                if idle_since is not None and time.monotonic() - idle_since >= self.idle_seconds:
                    break
                continue

            try:
                payload = os.read(self.reader_fd, 64 * 1024)
            except BlockingIOError:
                continue
            except OSError as error:
                raise RouterError(f"cannot read launcher log FIFO: {error}") from error

            if payload:
                seen_writer = True
                idle_since = None
                self.write(payload)
                continue

            # Reopen after EOF so a new launcher can attach after the last
            # writer has closed.  The short idle window avoids a stale router
            # surviving forever while retaining a race-free handoff.
            os.close(self.reader_fd)
            self.reader_fd = None
            idle_since = time.monotonic() if seen_writer or idle_since is None else idle_since
            time.sleep(0.05)
            if not self.stop_requested:
                self.reader_fd = os.open(self.fifo, os.O_RDONLY | os.O_NONBLOCK)

        self.receipt("stopped")
        return 0

    def close(self) -> None:
        if self.reader_fd is not None:
            try:
                os.close(self.reader_fd)
            except OSError:
                pass
            self.reader_fd = None
        self.close_current()
        self.cleanup_state()


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fifo", required=True)
    parser.add_argument("--active-log", required=True)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--pid-file", required=True)
    parser.add_argument("--ready-file", required=True)
    parser.add_argument("--receipt-file", required=True)
    parser.add_argument("--max-bytes", default=str(DEFAULT_MAX_BYTES))
    parser.add_argument("--max-age-seconds", default=str(DEFAULT_MAX_AGE_SECONDS))
    parser.add_argument("--retention-files", default=str(DEFAULT_RETENTION_FILES))
    parser.add_argument("--idle-seconds", default=str(DEFAULT_IDLE_SECONDS))
    return parser.parse_args()


def main() -> int:
    args = arguments()
    router = LogRouter(args)
    signal.signal(signal.SIGTERM, router.stop)
    signal.signal(signal.SIGINT, router.stop)
    signal.signal(signal.SIGHUP, router.stop)
    try:
        return router.run()
    except RouterError as error:
        if router.last_status != "blocked-active-writer":
            router.receipt("failed", str(error))
        return 1
    except BrokenPipeError:
        router.receipt("failed", "launcher log FIFO writer closed unexpectedly")
        return 1
    except OSError as error:
        router.receipt("failed", str(error))
        return 1
    finally:
        router.close()


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Focused tests for the owner-safe launcher log router."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


REPO_DIR = Path(__file__).resolve().parents[1]
ROUTER = REPO_DIR / "launcher" / "launcher-log-router.py"


class LauncherLogRouterTests(unittest.TestCase):
    def start_router(
        self,
        root: Path,
        *,
        max_bytes: int = 16,
        idle_seconds: float = 0.5,
    ) -> tuple[subprocess.Popen[str], Path, Path, Path, Path]:
        fifo = root / "launcher-log.fifo"
        active = root / "launcher.log"
        state = root / "state"
        state.mkdir()
        os.mkfifo(fifo, 0o600)
        pid_file = state / "router.pid"
        ready_file = state / "router.ready"
        receipt_file = state / "router.json"
        process = subprocess.Popen(
            [
                sys.executable,
                str(ROUTER),
                "--fifo",
                str(fifo),
                "--active-log",
                str(active),
                "--state-dir",
                str(state),
                "--pid-file",
                str(pid_file),
                "--ready-file",
                str(ready_file),
                "--receipt-file",
                str(receipt_file),
                "--max-bytes",
                str(max_bytes),
                "--max-age-seconds",
                "60",
                "--retention-files",
                "1",
                "--idle-seconds",
                str(idle_seconds),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        deadline = time.monotonic() + 5
        while not ready_file.exists() and process.poll() is None:
            if time.monotonic() >= deadline:
                process.kill()
                process.wait()
                self.fail("launcher log router did not become ready")
            time.sleep(0.01)
        return process, fifo, active, state, receipt_file

    def test_size_rotation_and_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            process, fifo, active, _state, receipt_file = self.start_router(root)
            with fifo.open("wb") as writer:
                writer.write(b"0123456789abcdefGHIJ")
            self.assertEqual(process.wait(timeout=5), 0)

            rotated = sorted(root.glob("launcher.log.rotated-*"))
            self.assertEqual(active.read_bytes(), b"GHIJ")
            self.assertEqual(len(rotated), 1)
            self.assertEqual(rotated[0].read_bytes(), b"0123456789abcdef")
            receipt = json.loads(receipt_file.read_text())
            self.assertEqual(receipt["status"], "stopped")
            self.assertEqual(receipt["rotationCount"], 1)
            self.assertEqual(receipt["maxBytes"], 16)

    def test_active_writer_is_protected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            active = root / "launcher.log"
            active.write_bytes(b"protected")
            with active.open("ab"):
                process, _fifo, _active, _state, receipt_file = self.start_router_with_existing_active(
                    root
                )
                self.assertEqual(process.wait(timeout=5), 1)
            receipt = json.loads(receipt_file.read_text())
            self.assertEqual(receipt["status"], "blocked-active-writer")

    def test_rotation_refuses_a_new_active_writer(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            process, fifo, active, _state, receipt_file = self.start_router(
                root, max_bytes=4, idle_seconds=5
            )
            with active.open("ab"):
                with fifo.open("wb") as writer:
                    writer.write(b"12345")
                self.assertEqual(process.wait(timeout=5), 1)
                self.assertEqual(active.read_bytes(), b"1234")
                self.assertEqual(list(root.glob("launcher.log.rotated-*")), [])
                receipt = json.loads(receipt_file.read_text())
                self.assertEqual(receipt["status"], "blocked-active-writer")

    def start_router_with_existing_active(
        self, root: Path
    ) -> tuple[subprocess.Popen[str], Path, Path, Path, Path]:
        fifo = root / "launcher-log.fifo"
        active = root / "launcher.log"
        state = root / "state"
        state.mkdir()
        os.mkfifo(fifo, 0o600)
        pid_file = state / "router.pid"
        ready_file = state / "router.ready"
        receipt_file = state / "router.json"
        process = subprocess.Popen(
            [
                sys.executable,
                str(ROUTER),
                "--fifo",
                str(fifo),
                "--active-log",
                str(active),
                "--state-dir",
                str(state),
                "--pid-file",
                str(pid_file),
                "--ready-file",
                str(ready_file),
                "--receipt-file",
                str(receipt_file),
                "--max-bytes",
                "16",
                "--max-age-seconds",
                "60",
                "--retention-files",
                "1",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        return process, fifo, active, state, receipt_file


if __name__ == "__main__":
    unittest.main()

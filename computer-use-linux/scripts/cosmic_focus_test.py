#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Exercise the real COSMIC helper against a delayed Wayland protocol peer."""

import heapq
import json
import os
from pathlib import Path
import select
import socket
import struct
import subprocess
import sys
import threading
import time
import unittest

from socket_fixture import socket_tempdir

BINARY = str(Path(sys.argv.pop(1)).resolve())
OUTPUT = 0xFE000001
FOREIGN = 0xFF000000
HEAD = FOREIGN + 1
MODE = FOREIGN + 2


def uint(*values):
    return struct.pack("=" + "I" * len(values), *values)


def string(value):
    data = value.encode() + b"\0"
    return uint(len(data)) + data + b"\0" * (-len(data) % 4)


def array(*values):
    return uint(4 * len(values), *values)


def event(object_id, opcode, payload=b""):
    return uint(object_id, ((8 + len(payload)) << 16) | opcode) + payload


def window_id():
    value = 0xCBF29CE484222325
    for byte in b"fixture-window":
        value = ((value ^ byte) * 0x100000001B3) & ((1 << 64) - 1)
    return max(1, value & ((1 << 53) - 1))


class Peer:
    """Minimal server for the interfaces the helper uses; never touches a desktop."""

    def __init__(self, connection, *, state_delay=0.1, focused=True,
                 activation_delay=0.1, close=False, output_delay=None, windows=True, geometry=False, geometry_delay=0):
        self.connection = connection
        self.state_delay = state_delay
        self.focused = focused
        self.activation_delay = activation_delay
        self.close = close
        self.windows = windows
        self.output_delay = output_delay
        self.geometry = geometry
        self.geometry_delay = geometry_delay
        self.output_id = None
        self.info_id = None
        self.objects = {1: "wl_display"}
        self.pending = []
        self.sequence = 0
        self.errors = []
        self.globals = [
            ("zcosmic_toplevel_info_v1", 3),
            ("zcosmic_toplevel_manager_v1", 4),
            ("ext_foreign_toplevel_list_v1", 1),
            ("wl_seat", 1),
        ]
        if geometry:
            self.globals.extend([("zxdg_output_manager_v1", 3), ("wl_output", 4)])
        if output_delay is not None:
            self.globals.append(("zwlr_output_manager_v1", 4))

    def send(self, data, delay=0):
        self.sequence += 1
        heapq.heappush(self.pending, (time.monotonic() + delay, self.sequence, data))

    def request(self, object_id, opcode, payload):
        interface = self.objects[object_id]
        if interface == "wl_display":
            new_id, = struct.unpack("=I", payload)
            if opcode == 1:
                self.objects[new_id] = "wl_registry"
                for name, (iface, version) in enumerate(self.globals, 1):
                    self.send(event(new_id, 0, uint(name) + string(iface) + uint(version)))
            elif opcode == 0:
                self.send(event(new_id, 0, uint(1)))
                self.send(event(1, 1, uint(new_id)))
        elif interface == "wl_registry":
            name, = struct.unpack("=I", payload[:4])
            version, new_id = struct.unpack("=II", payload[-8:])
            iface, _ = self.globals[name - 1]
            self.objects[new_id] = iface
            if iface == "zcosmic_toplevel_info_v1":
                self.info_id = new_id
            elif iface == "wl_output":
                self.output_id = new_id
            elif iface == "zcosmic_toplevel_manager_v1":
                self.send(event(new_id, 0, array(2)))
            elif iface == "ext_foreign_toplevel_list_v1" and self.windows:
                self.send(event(new_id, 0, uint(FOREIGN)))
                self.send(event(FOREIGN, 4, string("fixture-window")))
                self.send(event(FOREIGN, 2, string("Fixture editor")))
                self.send(event(FOREIGN, 3, string("fixture.editor")))
                self.send(event(FOREIGN, 1))
                self.objects[FOREIGN] = "ext_foreign_toplevel_handle_v1"
            elif iface == "zwlr_output_manager_v1":
                delay = self.output_delay
                self.send(event(new_id, 0, uint(HEAD)), delay)
                self.send(event(HEAD, 3, uint(MODE)), delay)
                self.send(event(MODE, 0, uint(1920, 1080)), delay)
                for op, data in [(4, uint(1)), (5, uint(MODE)),
                                 (6, uint(0, 0)), (7, uint(0)), (8, uint(256))]:
                    self.send(event(HEAD, op, data), delay)
                self.send(event(new_id, 1, uint(1)), delay)
        elif interface == "zxdg_output_manager_v1" and opcode == 1:
            new_id, output_id = struct.unpack("=II", payload)
            self.objects[new_id] = "zxdg_output_v1"
            # Right display, with vertical offset. Geometry is output-relative.
            self.send(event(new_id, 0, uint(2560, 390)), self.geometry_delay)
            self.send(event(new_id, 1, uint(1680, 1050)), self.geometry_delay)
            self.send(event(output_id, 2), self.geometry_delay)
        elif interface == "zcosmic_toplevel_info_v1" and opcode == 1:
            new_id, _ = struct.unpack("=II", payload)
            self.objects[new_id] = "zcosmic_toplevel_handle_v1"
            if self.close:
                self.send(event(FOREIGN, 0), 0.1)
            elif self.state_delay is not None:
                states = array(2) if self.focused else array()
                self.send(event(new_id, 8, states), self.state_delay)
                if self.geometry and self.output_id:
                    self.send(event(new_id, 9, uint(self.output_id, 100, 50, 800, 600)), self.state_delay + 0.03)
                self.send(event(self.info_id, 2), self.state_delay + 0.03)
                self.send(event(FOREIGN, 1), self.state_delay + 0.03)
        elif interface == "zcosmic_toplevel_manager_v1" and opcode == 2:
            target, _ = struct.unpack("=II", payload)
            if self.activation_delay is not None:
                self.send(event(target, 8, array(2)), self.activation_delay)
                self.send(event(FOREIGN, 1), self.activation_delay)

    def run(self):
        buffer = b""
        deadline = time.monotonic() + 3
        try:
            with self.connection:
                while time.monotonic() < deadline:
                    now = time.monotonic()
                    while self.pending and self.pending[0][0] <= now:
                        _, _, data = heapq.heappop(self.pending)
                        self.connection.sendall(data)
                    wait = deadline - now
                    if self.pending:
                        wait = min(wait, max(0, self.pending[0][0] - now))
                    ready, _, _ = select.select([self.connection], [], [], wait)
                    if not ready:
                        continue
                    data = self.connection.recv(65536)
                    if not data:
                        return
                    buffer += data
                    while len(buffer) >= 8:
                        object_id, header = struct.unpack("=II", buffer[:8])
                        size, opcode = header >> 16, header & 0xFFFF
                        if len(buffer) < size:
                            break
                        self.request(object_id, opcode, buffer[8:size])
                        buffer = buffer[size:]
                raise TimeoutError("helper did not close its Wayland connection")
        except (BrokenPipeError, ConnectionResetError):
            pass  # A one-shot client may leave as soon as its snapshot is ready.
        except Exception as exc:
            self.errors.append(exc)


class FocusTests(unittest.TestCase):
    def run_helper(self, command, **scenario):
        cache = Path.home() / ".cache"
        cache.mkdir(exist_ok=True)
        with socket_tempdir("cul-wl-", ["wayland-test"], dir=cache) as directory:
            with socket.socket(socket.AF_UNIX) as listener:
                listener.bind(str(Path(directory) / "wayland-test"))
                listener.listen(1)
                listener.settimeout(3)
                env = dict(os.environ, XDG_RUNTIME_DIR=directory, WAYLAND_DISPLAY="wayland-test")
                env.pop("WAYLAND_SOCKET", None)
                process = subprocess.Popen([BINARY, *command], env=env,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    connection, _ = listener.accept()
                    peer = Peer(connection, **scenario)
                    worker = threading.Thread(target=peer.run)
                    worker.start()
                    stdout, stderr = process.communicate(timeout=3)
                    worker.join(timeout=3)
                    self.assertFalse(worker.is_alive())
                    self.assertEqual(peer.errors, [])
                    return process.returncode, stdout.decode(), stderr.decode()
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.communicate()

    def test_delayed_initial_focus(self):
        code, output, error = self.run_helper(["focused-window"])
        self.assertEqual(code, 0, error)
        self.assertTrue(json.loads(output)["focused"])

    def test_window_ids_survive_json_double_roundtrip(self):
        code, output, error = self.run_helper(["list-windows"])
        self.assertEqual(code, 0, error)
        value = json.loads(output)[0]["window_id"]
        self.assertLessEqual(value, (1 << 53) - 1)
        self.assertEqual(int(float(value)), value)

    def test_window_geometry_uses_output_logical_origin(self):
        code, output, error = self.run_helper(["list-windows"], geometry=True)
        self.assertEqual(code, 0, error)
        self.assertEqual(json.loads(output)[0]["bounds"],
                         {"x": 2660, "y": 440, "width": 800, "height": 600})

    def test_geometry_waits_for_independent_output_snapshot(self):
        code, output, error = self.run_helper(["list-windows"], geometry=True,
                                              state_delay=0.01, geometry_delay=0.3)
        self.assertEqual(code, 0, error)
        self.assertEqual(json.loads(output)[0]["bounds"],
                         {"x": 2660, "y": 440, "width": 800, "height": 600})

    def test_empty_desktop_is_a_valid_snapshot(self):
        code, output, error = self.run_helper(["list-windows"], windows=False)
        self.assertEqual(code, 0, error)
        self.assertEqual(json.loads(output), [])

    def test_missing_state_is_an_error(self):
        code, _, error = self.run_helper(["list-windows"], state_delay=None)
        self.assertNotEqual(code, 0, "missing state must not be reported as focused:false")
        self.assertIn("state", error.lower())

    def test_closed_window_is_removed(self):
        code, output, error = self.run_helper(["list-windows"], close=True)
        self.assertEqual(code, 0, error)
        self.assertEqual(json.loads(output), [])

    def test_delayed_activation_is_verified(self):
        code, output, error = self.run_helper(
            ["activate-window", "--window-id", str(window_id())], focused=False)
        self.assertEqual(code, 0, error)
        self.assertTrue(json.loads(output)["ok"])

    def test_refused_activation_is_not_success(self):
        code, output, error = self.run_helper(
            ["activate-window", "--window-id", str(window_id())],
            focused=False, activation_delay=None)
        self.assertEqual(code, 0, error)
        self.assertFalse(json.loads(output)["ok"])

    def test_already_focused_activation(self):
        code, output, error = self.run_helper(
            ["activate-window", "--window-id", str(window_id())], activation_delay=None)
        self.assertEqual(code, 0, error)
        self.assertTrue(json.loads(output)["ok"])

    def test_output_snapshot_waits_for_done(self):
        code, output, error = self.run_helper(
            ["monitor-layout"], state_delay=0.01, output_delay=0.15)
        self.assertEqual(code, 0, error)
        self.assertEqual(json.loads(output), [
            {"x": 0, "y": 0, "width": 1920, "height": 1080, "scale": 1.0}])


if __name__ == "__main__":
    unittest.main(verbosity=2)

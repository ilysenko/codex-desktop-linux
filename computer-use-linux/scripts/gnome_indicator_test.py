#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""Exercise the real MCP/indicator handshake on a private GNOME D-Bus fixture.

No host input or screenshots: ydotool and gnome-screenshot are fixture commands,
and physical input, session discovery, and other command backends are disabled.
"""
import contextlib
import fcntl
import json
import os
from pathlib import Path
import select
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import zlib

from socket_fixture import INDICATOR_SOCKET, TEMPDIR_NAME, private_bus_config, socket_tempdir

SERVER, INDICATOR = (str(Path(arg).resolve()) for arg in sys.argv[1:3])
SERVICE = 'com.openai.Codex.WindowControl'
OBJECT = '/com/openai/Codex/WindowControl'
XML = '''<node><interface name="com.openai.Codex.WindowControl">
<method name="GetIndicatorState"><arg type="s" direction="out"/></method>
<method name="HideIndicator"><arg type="b" direction="out"/></method>
<method name="ShowIndicator"><arg type="s" direction="in"/><arg type="u" direction="in"/></method>
</interface></node>'''


def stop(proc):
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def rpc(proc, ident, method, params):
    proc.stdin.write(json.dumps(dict(jsonrpc='2.0', id=ident, method=method, params=params))+'\n')
    proc.stdin.flush()
    deadline = time.monotonic()+10
    while time.monotonic() < deadline:
        if select.select([proc.stdout], [], [], .1)[0]:
            line = proc.stdout.readline()
            if not line:
                raise RuntimeError('MCP exited')
            response = json.loads(line)
            if response.get('id') == ident:
                assert 'error' not in response, response
                return response['result']
    raise TimeoutError(method)


def run_private(directory):
    from gi.repository import Gio, GLib

    class IndicatorTests(unittest.TestCase):
        def setUp(self):
            self.root = Path(self.enterContext(tempfile.TemporaryDirectory(dir=directory)))
            self.events = []
            self.visible = False
            self.hidden_at = 0
            self.delay_ms = 0
            self.timers = set()
            self.client_number = 0
            self.bus = Gio.DBusConnection.new_for_address_sync(
                os.environ['DBUS_SESSION_BUS_ADDRESS'],
                Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
                None, None)
            self.addCleanup(self.bus.close_sync, None)
            for name in ('org.gnome.Shell', SERVICE):
                result = self.bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
                    'org.freedesktop.DBus', 'RequestName', GLib.Variant('(su)', (name, 4)),
                    None, Gio.DBusCallFlags.NONE, 5000, None)
                self.assertEqual(result.unpack(), (1,))
            self.bus.register_object(OBJECT, Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0],
                                     self.method, None, None)
            self.addCleanup(self.cancel_timers)
            self.env = dict(os.environ, XDG_RUNTIME_DIR=str(self.root),
                XDG_CURRENT_DESKTOP='GNOME', XDG_SESSION_DESKTOP='gnome', XDG_SESSION_TYPE='wayland',
                XDG_CACHE_HOME=str(self.root/'cache'), XDG_CONFIG_HOME=str(self.root/'config'),
                CODEX_COMPUTER_USE_DISABLE_ABS_POINTER='1', CODEX_COMPUTER_USE_FORCE_YDOTOOL_KEYBOARD='1',
                CODEX_COMPUTER_USE_INDICATOR='0', CODEX_COMPUTER_USE_SCREENSHOT_BACKEND='gnome-screenshot',
                YDOTOOL_SOCKET=str(self.root/'input.sock'),
                PATH=str(self.root)+':/usr/bin:/bin')
            for name in ('DISPLAY', 'WAYLAND_DISPLAY', 'AT_SPI_BUS_ADDRESS'):
                self.env.pop(name, None)
            for name in ('systemctl', 'gdbus', 'xdotool', 'wtype', 'xrandr', 'ydotoold'):
                self.command(name, '#!/bin/sh\nexit 1\n')
            self.input_log = self.root/'input.log'
            self.capture_log = self.root/'capture.log'
            input_socket = self.enterContext(socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM))
            input_socket.bind(self.env['YDOTOOL_SOCKET'])
            self.command('ydotool', '#!/usr/bin/python3\nimport json,os,sys\n'
                'if sys.argv[1:] in (["help"], ["--help"]):\n'
                '    print("Usage: ydotool <cmd> <args>\\nAvailable commands:\\n  click\\n  mousemove\\n  type\\n  key\\n  debug")\n'
                '    sys.exit(0)\n'
                'if "XDG_RUNTIME_DIR" not in os.environ: sys.exit(0)\n'
                f'with open({str(self.input_log)!r}, "a") as f: f.write(json.dumps(sys.argv[1:])+"\\n")\n')
            def chunk(kind, data):
                return struct.pack('!I', len(data))+kind+data+struct.pack('!I', zlib.crc32(kind+data))
            png = b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR', struct.pack('!IIBBBBB', 2, 2, 8, 2, 0, 0, 0))
            png += chunk(b'IDAT', zlib.compress(b'\0'+b'\0'*6+b'\0'+b'\0'*6))+chunk(b'IEND', b'')
            (self.root/'screen.png').write_bytes(png)
            self.command('gnome-screenshot', '#!/usr/bin/python3\nimport shutil,sys,time\n'
                'if "--version" in sys.argv: print("gnome-screenshot fixture"); sys.exit(0)\n'
                f'with open({str(self.capture_log)!r}, "a") as f: f.write(str(time.monotonic())+"\\n")\n'
                f'shutil.copyfile({str(self.root/"screen.png")!r},sys.argv[-1])\n')
            self.stderr = self.enterContext(tempfile.TemporaryFile(mode='w+'))
            self.indicator = subprocess.Popen([INDICATOR], env=self.env, stderr=self.stderr)
            self.addCleanup(stop, self.indicator)
            self.path = self.root/INDICATOR_SOCKET
            self.wait_for(lambda: self.path.exists())
            # A processed action is a barrier: startup finished and the loop is
            # active, with an indicator that will require compositor settling.
            with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as client:
                client.sendto(b'{"tool":"click","agent":"fixture"}', str(self.path))
            self.wait_for(lambda: self.visible)
            self.events.clear()

        def command(self, name, text):
            path = self.root/name
            path.write_text(text)
            path.chmod(0o700)

        def cancel_timers(self):
            for timer in self.timers:
                GLib.source_remove(timer)

        def method(self, conn, sender, path, interface, name, params, invocation):
            if name == 'GetIndicatorState':
                invocation.return_value(GLib.Variant('(s)', (json.dumps(dict(visible=self.visible)),)))
            elif name == 'ShowIndicator':
                self.visible = True
                self.events.append(('show', time.monotonic()))
                invocation.return_value(None)
            else:
                self.events.append(('hide', time.monotonic()))
                def reply():
                    now = time.monotonic()
                    shown = self.visible or now-self.hidden_at < .120
                    if self.visible:
                        self.hidden_at = now
                    self.visible = False
                    self.events.append(('reply', now))
                    invocation.return_value(GLib.Variant('(b)', (shown,)))
                    if self.delay_ms:
                        self.timers.discard(timer)
                    return False
                if self.delay_ms is None:
                    return  # A running renderer that never acknowledges hiding.
                if self.delay_ms:
                    timer = GLib.timeout_add(self.delay_ms, reply)
                    self.timers.add(timer)
                else:
                    reply()

        def wait_for(self, predicate):
            deadline = time.monotonic()+5
            while not predicate():
                self.assertIsNone(self.indicator.poll(), 'indicator exited')
                self.assertLess(time.monotonic(), deadline, self.events)
                time.sleep(.005)

        def count(self, name):
            return sum(event == name for event, _ in self.events)

        @contextlib.contextmanager
        def client(self, locked=True):
            self.client_number += 1
            with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as client:
                client.bind(str(self.root/f'client{self.client_number}.sock'))
                client.settimeout(3)
                with open(self.path.with_suffix('.capture'), 'a') as lock:
                    if locked:
                        fcntl.flock(lock, fcntl.LOCK_SH)
                    try:
                        yield client
                    finally:
                        fcntl.flock(lock, fcntl.LOCK_UN)
                        client.sendto(b'{"capture":"end"}', str(self.path))

        def begin(self, client):
            client.sendto(b'{"capture":"begin"}', str(self.path))

        def acknowledgement(self, client):
            reply, sender = client.recvfrom(16)
            self.assertEqual(sender, str(self.path))
            return reply

        @contextlib.contextmanager
        def mcp(self):
            proc = subprocess.Popen([SERVER, 'mcp'], env=self.env, stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=self.stderr, text=True)
            try:
                rpc(proc, 1, 'initialize', dict(protocolVersion='2024-11-05', capabilities={},
                    clientInfo=dict(name='gnome-indicator-regression', version='1')))
                proc.stdin.write(json.dumps(dict(jsonrpc='2.0', method='notifications/initialized'))+'\n')
                proc.stdin.flush()
                yield proc
            finally:
                stop(proc)
                proc.stdin.close()
                proc.stdout.close()

        def test_one_hide_acknowledges_concurrent_begins_in_the_batch(self):
            self.delay_ms = 60
            with self.client() as first, self.client() as second:
                self.begin(first)
                self.wait_for(lambda: self.count('hide') == 1)
                self.begin(second)
                self.assertEqual(self.acknowledgement(first), b'shown')
                self.assertEqual(self.acknowledgement(second), b'shown')
                self.assertEqual(self.count('hide'), 1, self.events)
                self.assertFalse(self.visible)

        def test_a_show_between_begins_requires_another_hide(self):
            self.delay_ms = 60
            # Exercise a batch containing a cancelled capture and an action
            # permitted after its shared lock has gone away.
            with self.client(locked=False) as client:
                self.begin(client)
                self.wait_for(lambda: self.count('hide') == 1)
                client.sendto(b'{"tool":"click"}', str(self.path))
                self.begin(client)
                self.assertEqual(self.acknowledgement(client), b'shown')
                self.assertEqual(self.acknowledgement(client), b'shown')
                self.assertEqual(self.count('hide'), 2, self.events)
                self.assertEqual(self.count('show'), 1, self.events)

        def test_lock_without_begin_hides_until_the_last_capture_releases(self):
            with self.client() as first:
                with self.client() as second:
                    self.wait_for(lambda: self.count('reply') == 1)
                    self.assertFalse(self.visible)
                    self.assertEqual(self.count('show'), 0)
                    self.begin(second)
                    self.assertIn(self.acknowledgement(second), (b'shown', b'empty'))
                # Processing another begin is a barrier after the other hold's
                # end; the remaining shared hold must still prevent resumption.
                self.begin(first)
                self.assertIn(self.acknowledgement(first), (b'shown', b'empty'))
                self.assertEqual(self.count('show'), 0)
            self.wait_for(lambda: self.visible)
            self.assertEqual(self.count('show'), 1, self.events)

        def test_delayed_hide_allows_post_action_screenshot_and_settling(self):
            self.delay_ms = 150
            with self.mcp() as proc:
                result = rpc(proc, 2, 'tools/call', dict(name='press_key',
                    arguments=dict(key='Escape', screenshot_after=True)))
            output = result['structuredContent']
            self.assertTrue(output['ok'], output)
            self.assertFalse(output.get('screenshot_error'), output)
            self.assertTrue(any(item['type'] == 'image' for item in result['content']), result)
            self.assertEqual(self.count('hide'), 1, self.events)
            self.assertEqual(len(self.input_log.read_text().splitlines()), 1)
            captured, = map(float, self.capture_log.read_text().splitlines())
            hidden = next(at for event, at in self.events if event == 'reply')
            self.assertGreaterEqual(captured-hidden, .120)

        def test_delayed_hide_allows_an_empty_indicator_screenshot(self):
            self.visible = False
            self.hidden_at = 0
            self.delay_ms = 150
            with self.mcp() as proc:
                result = rpc(proc, 2, 'tools/call', dict(name='screenshot', arguments={}))
            self.assertFalse(result.get('isError'), result)
            self.assertTrue(any(item['type'] == 'image' for item in result['content']), result)
            self.assertEqual(self.count('hide'), 1, self.events)

        def test_unresponsive_renderer_fails_screenshot_without_replaying_action(self):
            self.delay_ms = None
            with self.mcp() as proc:
                result = rpc(proc, 2, 'tools/call', dict(name='press_key',
                    arguments=dict(key='Escape', screenshot_after=True)))
            output = result['structuredContent']
            self.assertTrue(output['ok'], output)
            self.assertIn('did not acknowledge hiding', output['screenshot_error'])
            self.assertFalse(self.capture_log.exists())
            self.assertEqual(len(self.input_log.read_text().splitlines()), 1)
            with open(self.path.with_suffix('.capture'), 'a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

    loop = GLib.MainLoop()
    thread = threading.Thread(target=loop.run, daemon=True)
    thread.start()
    try:
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(IndicatorTests)
        return unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful()
    finally:
        loop.quit()
        thread.join(timeout=5)


if __name__ == '__main__':
    if len(sys.argv) > 3 and sys.argv[3] == '--private':
        raise SystemExit(0 if run_private(sys.argv[4]) else 1)
    # Each test's directory holds the overlay socket, the longest one here.
    with socket_tempdir('cul-gnome-', [f'{TEMPDIR_NAME}/{INDICATOR_SOCKET}'],
                        bus_dir='') as directory:
        env = dict(os.environ, XDG_RUNTIME_DIR=directory)
        # No service directories: accessibility/portal discovery must never
        # activate real desktop processes on this private bus.
        config = private_bus_config(Path(directory)/'bus.conf', directory)
        proc = subprocess.Popen(['dbus-run-session', '--config-file', str(config), '--', '/usr/bin/python3', __file__,
            SERVER, INDICATOR, '--private', directory], env=env, start_new_session=True)
        try:
            raise SystemExit(proc.wait(timeout=90))
        finally:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass

#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""get_app_state must refuse a targeted screenshot before capturing anything.

A targeted call for an unfocused window used to capture the whole desktop and
only then refuse, so a portal session raised a consent prompt and grabbed every
monitor for nothing. This drives the real MCP server against a fixture Hyprland
window registry (a fake hyprctl) and a fixture gnome-screenshot that logs each
capture. No host input or screenshots: the private D-Bus session has no
service directories, and display, Wayland and AT-SPI variables are removed.
"""
import json
import os
from pathlib import Path
import select
import signal
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import zlib

SERVER = str(Path(sys.argv[1]).resolve())
TARGET = 0x5000
OTHER = 0x6000


def stop(proc):
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)
    for pipe in (proc.stdin, proc.stdout):
        if pipe:
            pipe.close()


def rpc(proc, ident, method, params):
    proc.stdin.write(json.dumps(dict(jsonrpc='2.0', id=ident, method=method, params=params))+'\n')
    proc.stdin.flush()
    deadline = time.monotonic()+30
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


def client(address, title, focused):
    return dict(address=hex(address), mapped=True, hidden=False, at=[0, 0], size=[2, 2],
        workspace=dict(id=1, name='1'), monitor=0, **{'class': 'fixture.App'}, title=title,
        pid=os.getpid(), xwayland=False, focusHistoryID=0 if focused else 1)


class CaptureOrderTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory(dir=sys.argv[3])))
        self.capture_log = self.root/'capture.log'
        self.env = dict(os.environ, XDG_RUNTIME_DIR=str(self.root),
            XDG_CURRENT_DESKTOP='Hyprland', XDG_SESSION_TYPE='wayland',
            HYPRLAND_INSTANCE_SIGNATURE='fixture',
            XDG_CACHE_HOME=str(self.root/'cache'), XDG_CONFIG_HOME=str(self.root/'config'),
            CU_DISABLE_ABS_POINTER='1', COMPUTER_USE_LINUX_INDICATOR='0',
            CODEX_COMPUTER_USE_SCREENSHOT_BACKEND='gnome-screenshot',
            PATH=str(self.root)+':/usr/bin:/bin')
        for name in ('DISPLAY', 'WAYLAND_DISPLAY', 'AT_SPI_BUS_ADDRESS', 'NIRI_SOCKET',
                     'SWAYSOCK', 'I3SOCK', 'COMPUTER_USE_LINUX_HYPRLAND_BACKGROUND'):
            self.env.pop(name, None)
        for name in ('systemctl', 'gdbus', 'xdotool', 'wtype', 'xrandr', 'ydotool', 'ydotoold',
                     'grim', 'kscreen-doctor', 'swaymsg', 'i3-msg', 'niri'):
            self.command(name, '#!/bin/sh\nexit 1\n')

        def chunk(kind, data):
            return struct.pack('!I', len(data))+kind+data+struct.pack('!I', zlib.crc32(kind+data))
        png = b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR', struct.pack('!IIBBBBB', 2, 2, 8, 2, 0, 0, 0))
        png += chunk(b'IDAT', zlib.compress(b'\0'+b'\0'*6+b'\0'+b'\0'*6))+chunk(b'IEND', b'')
        (self.root/'screen.png').write_bytes(png)
        self.command('gnome-screenshot', '#!/usr/bin/python3\nimport shutil,sys,time\n'
            'if "--version" in sys.argv: print("gnome-screenshot fixture"); sys.exit(0)\n'
            f'with open({str(self.capture_log)!r}, "a") as f: f.write(str(time.monotonic())+"\\n")\n'
            f'shutil.copyfile({str(self.root/"screen.png")!r},sys.argv[-1])\n')
        self.clients_json = self.root/'clients.json'
        self.command('hyprctl', '#!/usr/bin/python3\nimport json,sys\n'
            'args=[a for a in sys.argv[1:] if a!="-j"]\n'
            'if args[:1]==["-i"]: args=args[2:]\n'
            f'if args==["clients"]: print(open({str(self.clients_json)!r}).read())\n'
            'elif args==["monitors"]: print(json.dumps([{"id":0,"name":"FIX-1","x":0,"y":0,'
            '"width":2,"height":2,"scale":1.0,"focused":True,"activeWorkspace":{"id":1}}]))\n'
            'else: sys.exit(1)\n')

    def command(self, name, text):
        path = self.root/name
        path.write_text(text)
        path.chmod(0o700)

    def captures(self):
        return self.capture_log.read_text().count('\n') if self.capture_log.exists() else 0

    def app_state(self, target_focused):
        self.clients_json.write_text(json.dumps([
            client(TARGET, 'fixture target', target_focused),
            client(OTHER, 'fixture other', not target_focused)]))
        proc = subprocess.Popen([SERVER, 'mcp'], env=self.env, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        self.addCleanup(stop, proc)
        rpc(proc, 1, 'initialize', dict(protocolVersion='2025-06-18', capabilities={},
            clientInfo=dict(name='capture-order-fixture', version='0')))
        proc.stdin.write(json.dumps(dict(jsonrpc='2.0', method='notifications/initialized'))+'\n')
        proc.stdin.flush()
        result = rpc(proc, 2, 'tools/call', dict(name='get_app_state', arguments=dict(
            window_id=TARGET, include_screenshot=True, max_nodes=1)))
        return result.get('structuredContent') or {}

    def test_unfocused_target_refuses_without_capturing(self):
        state = self.app_state(target_focused=False)
        self.assertEqual((state.get('window_context') or {}).get('window_id'), TARGET, state)
        self.assertIn('already be focused', state.get('screenshot_error') or '', state)
        self.assertIsNone(state.get('screenshot'), state)
        self.assertEqual(self.captures(), 0, 'the desktop was captured before refusing')

    def test_focused_target_still_captures(self):
        # Control: proves the fixture capture path is live, so a zero count
        # above means the refusal happened before capture.
        state = self.app_state(target_focused=True)
        self.assertEqual(self.captures(), 1, state)


if __name__ == '__main__':
    if len(sys.argv) > 2 and sys.argv[2] == '--private':
        result = unittest.main(argv=[sys.argv[0]], exit=False).result
        raise SystemExit(0 if result.wasSuccessful() else 1)
    with tempfile.TemporaryDirectory(prefix='cul-capture-order-') as directory:
        env = dict(os.environ, XDG_RUNTIME_DIR=directory)
        config = Path(directory)/'bus.conf'
        config.write_text('<busconfig><type>session</type>'
            f'<listen>unix:tmpdir={directory}</listen>'
            '<policy context="default"><allow own="*"/>'
            '<allow send_destination="*"/><allow receive_sender="*"/></policy></busconfig>')
        proc = subprocess.Popen(['dbus-run-session', '--config-file', str(config), '--', '/usr/bin/python3',
            __file__, SERVER, '--private', directory], env=env, start_new_session=True)
        try:
            raise SystemExit(proc.wait(timeout=120))
        finally:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass

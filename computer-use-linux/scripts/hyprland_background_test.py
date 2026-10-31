#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""Hyprland background mode: input and capture without focusing the target.

Drives the real MCP server against a fixture hyprctl that logs every request
a fixture Hyprland socket and a fixture grim that log every request and
capture, on a private D-Bus session. With COMPUTER_USE_LINUX_HYPRLAND_BACKGROUND=1,
type_text and press_key must reach the target through send_key_state over the
socket (never in a process's argv), show on the indicator, never dispatch a
focus change, and a
target on a hidden workspace must be captured with grim -T until two frames
match, never through the portal. No host input or screenshots.
"""
import json
import os
from pathlib import Path
import select
import socket
import socketserver
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import zlib

SERVER = str(Path(sys.argv[1]).resolve())
TARGET = 0x5000
FOCUSED = 0x6000


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


def client(address, workspace, focused):
    return dict(address=hex(address), mapped=True, hidden=False, at=[0, 0], size=[2, 2],
        workspace=dict(id=workspace, name=str(workspace)), monitor=0,
        **{'class': 'fixture.App'}, title=f'fixture {address:x}', pid=os.getpid(),
        xwayland=False, focusHistoryID=0 if focused else 1, stableId=f'{address:x}')


def png():
    def chunk(kind, data):
        return struct.pack('!I', len(data))+kind+data+struct.pack('!I', zlib.crc32(kind+data))
    image = b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR', struct.pack('!IIBBBBB', 2, 2, 8, 2, 0, 0, 0))
    return image+chunk(b'IDAT', zlib.compress(b'\0'+b'\0'*6+b'\0'+b'\0'*6))+chunk(b'IEND', b'')


class HyprlandSocket(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def serve_hyprland_socket(path, log, fail):
    """Answers each [[BATCH]] request with one ok per command, as Hyprland does.

    When the fail file holds [request, command, mode], that request goes
    wrong from that command index on: "error" answers errors (a window that
    closed mid-batch), "truncate" closes the stream without the remaining
    answers, and "resume" answers one error and then ok again.
    """
    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            request = self.rfile.read().decode()
            with open(log, 'a') as out:
                out.write(json.dumps(request)+'\n')
            number = len(Path(log).read_text().splitlines())
            failing, at, mode = json.loads(fail.read_text()) if fail.exists() else (0, 0, '')
            commands = request.removeprefix('[[BATCH]]').split(' ; ')
            replies = ['ok' if number != failing or i < at else 'window not found'
                       for i in range(len(commands))]
            if number == failing and mode == 'truncate':
                replies = replies[:at]
            elif number == failing and mode == 'resume':
                replies[at+1:] = ['ok']*len(replies[at+1:])
            self.wfile.write('\n\n\n'.join(replies).encode())
    server = HyprlandSocket(str(path), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class BackgroundModeTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory(dir=sys.argv[3])))
        self.hyprctl_log = self.root/'hyprctl.log'
        self.grim_log = self.root/'grim.log'
        self.portal_log = self.root/'gnome-screenshot.log'
        self.socket_log = self.root/'socket.log'
        (self.root/'hypr'/'fixture').mkdir(parents=True)
        self.socket_fail = self.root/'socket-fail.json'
        hyprland = serve_hyprland_socket(self.root/'hypr'/'fixture'/'.socket.sock', self.socket_log,
                                         self.socket_fail)
        self.addCleanup(hyprland.server_close)
        self.addCleanup(hyprland.shutdown)
        self.keymap = self.root/'keymap'
        self.keymap.write_text('English (US)')
        self.env = dict(os.environ, XDG_RUNTIME_DIR=str(self.root),
            XDG_CURRENT_DESKTOP='Hyprland', XDG_SESSION_TYPE='wayland',
            HYPRLAND_INSTANCE_SIGNATURE='fixture',
            XDG_CACHE_HOME=str(self.root/'cache'), XDG_CONFIG_HOME=str(self.root/'config'),
            CU_DISABLE_ABS_POINTER='1', COMPUTER_USE_LINUX_INDICATOR='0',
            CODEX_COMPUTER_USE_SCREENSHOT_BACKEND='gnome-screenshot',
            COMPUTER_USE_LINUX_HYPRLAND_BACKGROUND='1',
            PATH=str(self.root)+':/usr/bin:/bin')
        for name in ('DISPLAY', 'WAYLAND_DISPLAY', 'AT_SPI_BUS_ADDRESS', 'NIRI_SOCKET',
                     'SWAYSOCK', 'I3SOCK'):
            self.env.pop(name, None)
        for name in ('systemctl', 'gdbus', 'xdotool', 'wtype', 'xrandr', 'ydotool', 'ydotoold',
                     'kscreen-doctor', 'swaymsg', 'i3-msg', 'niri'):
            self.command(name, '#!/bin/sh\nexit 1\n')
        (self.root/'frame.png').write_bytes(png())
        self.command('gnome-screenshot', '#!/usr/bin/python3\nimport shutil,sys\n'
            'if "--version" in sys.argv: print("gnome-screenshot fixture"); sys.exit(0)\n'
            f'open({str(self.portal_log)!r}, "a").write("capture\\n")\n'
            f'shutil.copyfile({str(self.root/"frame.png")!r},sys.argv[-1])\n')
        self.command('grim', '#!/usr/bin/python3\nimport sys\n'
            f'open({str(self.grim_log)!r}, "a").write(" ".join(sys.argv[1:])+"\\n")\n'
            f'sys.stdout.buffer.write(open({str(self.root/"frame.png")!r},"rb").read())\n')
        clients = [client(TARGET, 9, False), client(FOCUSED, 1, True)]
        (self.root/'clients.json').write_text(json.dumps(clients))
        self.command('hyprctl', '#!/usr/bin/python3\nimport json,sys\n'
            f'open({str(self.hyprctl_log)!r}, "a").write(json.dumps(sys.argv[1:])+"\\n")\n'
            'args=sys.argv[1:]\n'
            'if args[:1]==["-i"]: args=args[2:]\n'
            'plain=[a for a in args if a!="-j"]\n'
            f'if plain==["clients"]: print(open({str(self.root/"clients.json")!r}).read())\n'
            'elif plain==["monitors"]: print(json.dumps([{"id":0,"name":"FIX-1","x":0,"y":0,'
            '"width":2,"height":2,"scale":1.0,"focused":True,"activeWorkspace":{"id":1},'
            '"specialWorkspace":{"id":0}}]))\n'
            f'elif plain==["devices"]: print(json.dumps({{"keyboards":[{{"name":"kb","main":True,'
            f'"active_keymap":open({str(self.keymap)!r}).read()}}]}}))\n'
            'elif args[:1]==["dispatch"]: print("ok")\n'
            'else: sys.exit(1)\n')

    def command(self, name, text):
        path = self.root/name
        path.write_text(text)
        path.chmod(0o700)

    def server(self):
        proc = subprocess.Popen([SERVER, 'mcp'], env=self.env, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        self.addCleanup(stop, proc)
        rpc(proc, 1, 'initialize', dict(protocolVersion='2025-06-18', capabilities={},
            clientInfo=dict(name='hyprland-background-fixture', version='0')))
        proc.stdin.write(json.dumps(dict(jsonrpc='2.0', method='notifications/initialized'))+'\n')
        proc.stdin.flush()
        self.ident = 1
        return proc

    def call(self, proc, name, arguments):
        self.ident += 1
        result = rpc(proc, self.ident, 'tools/call', dict(name=name, arguments=arguments))
        text = ''.join(c.get('text', '') for c in result.get('content', []) if c['type'] == 'text')
        return result, text

    def requests(self):
        if not self.hyprctl_log.exists():
            return []
        return [json.loads(line) for line in self.hyprctl_log.read_text().splitlines()]

    def batches(self):
        if not self.socket_log.exists():
            return []
        return [json.loads(line) for line in self.socket_log.read_text().splitlines()]

    def argv_leaks(self):
        return [r for r in self.requests() if any('send_key_state' in part for part in r)]

    def indicator(self):
        """Binds the overlay socket so the server's indicator events land here."""
        self.env.pop('COMPUTER_USE_LINUX_INDICATOR')
        overlay = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        overlay.bind(str(self.root/'computer-use-linux-indicator.sock'))
        overlay.settimeout(5)
        self.addCleanup(overlay.close)
        return overlay

    def indicator_event(self, overlay, tool):
        while True:
            event = json.loads(overlay.recv(65536))
            if event.get('tool') == tool:
                return event

    def focus_dispatches(self):
        return [r for r in self.requests()
                if 'dispatch' in r and any('focus' in part for part in r)]

    def test_type_text_sends_keys_to_target_without_focusing(self):
        proc = self.server()
        _, text = self.call(proc, 'type_text', dict(window_id=TARGET, text='Hi!'))
        self.assertIn('send_key_state', text)
        batch = ' ; '.join(self.batches())
        self.assertTrue(batch.startswith('[[BATCH]]'), batch)
        address = f'address:{hex(TARGET)}'
        for mods, key in (('SHIFT', 'h'), ('', 'i'), ('SHIFT', '1')):
            for state in ('down', 'up'):
                self.assertIn(f'mods = "{mods}", key = "{key}", state = "{state}", window = "{address}"', batch)
        self.assertEqual(self.argv_leaks(), [], 'keys were exposed in hyprctl argv')
        self.assertEqual(self.focus_dispatches(), [])

    def test_failure_reports_how_many_presses_arrived(self):
        proc = self.server()
        # Second batch (presses 65-70): press 66 goes down, then the target fails.
        self.socket_fail.write_text(json.dumps([2, 3, 'error']))
        result, text = self.call(proc, 'type_text', dict(window_id=TARGET, text='a'*70))
        self.assertTrue(result.get('isError') or '"ok":false' in text, text)
        self.assertIn('65 of 70 key presses were delivered', text)
        self.assertIn('went down without its release', text)
        self.assertIn('send only the remainder', text)
        self.assertEqual(len(self.batches()), 2)
        self.socket_log.unlink()
        self.socket_fail.write_text(json.dumps([1, 0, 'error']))
        _, text = self.call(proc, 'type_text', dict(window_id=TARGET, text='abc'))
        self.assertIn('No keys were sent', text)

    def test_incomplete_reply_is_uncertain_delivery(self):
        proc = self.server()
        # The stream closes before any answer, after an ok prefix, or answers
        # ok again after an error: none of these says what ran.
        for request, at, mode, confirmed in ((1, 0, 'truncate', 0), (2, 3, 'truncate', 64),
                                             (1, 2, 'resume', 0)):
            with self.subTest(mode=mode, at=at):
                self.socket_log.unlink(missing_ok=True)
                self.socket_fail.write_text(json.dumps([request, at, mode]))
                _, text = self.call(proc, 'type_text', dict(window_id=TARGET, text='a'*70))
                self.assertIn(f'{confirmed} of 70 key presses were confirmed', text)
                self.assertIn('may have been delivered', text)
                self.assertIn('Inspect the target before retrying', text)
                self.assertNotIn('No keys were sent', text)
                self.assertNotIn('send only the remainder', text)

    def test_indicator_shows_background_input_masked_when_field_unknown(self):
        overlay = self.indicator()
        proc = self.server()
        self.call(proc, 'type_text', dict(window_id=TARGET, text='hunter2'))
        event = self.indicator_event(overlay, 'type_text')
        # The fixture app has no accessibility tree, so the field may be secret.
        self.assertNotIn('hunter2', event['text'])
        self.assertIn('•', event['text'])
        self.call(proc, 'press_key', dict(window_id=TARGET, key='Ctrl+L'))
        self.assertEqual(self.indicator_event(overlay, 'press_key')['keys'], ['••••••••'])
        self.assertEqual(len(self.batches()), 2)

    def test_press_key_chord_without_focusing(self):
        proc = self.server()
        self.call(proc, 'press_key', dict(window_id=TARGET, key='Ctrl+Shift+T'))
        self.assertIn('mods = "CTRL SHIFT", key = "t"', ' ; '.join(self.batches()))
        self.assertEqual(self.argv_leaks(), [])
        self.assertEqual(self.focus_dispatches(), [])

    def test_unmappable_text_and_non_us_keymap_send_nothing(self):
        proc = self.server()
        _, text = self.call(proc, 'type_text', dict(window_id=TARGET, text='café'))
        self.assertIn("'é' is unsupported", text)
        self.keymap.write_text('German')
        _, text = self.call(proc, 'type_text', dict(window_id=TARGET, text='abc'))
        self.assertIn('active keymap is not US', text)
        self.assertEqual(self.batches(), [])
        self.assertEqual(self.focus_dispatches(), [])

    def test_hidden_workspace_capture_uses_grim_until_frames_match(self):
        proc = self.server()
        result, _ = self.call(proc, 'get_app_state', dict(
            window_id=TARGET, include_screenshot=True, max_nodes=1))
        state = result.get('structuredContent') or {}
        self.assertIn('settled', (state.get('screenshot') or {}).get('source', ''), state)
        self.assertIn('hidden workspace 9', state.get('message', ''))
        captures = self.grim_log.read_text().splitlines()
        self.assertEqual(len(captures), 3, captures)
        self.assertTrue(all(c == f'-t png -T {TARGET:x} -' for c in captures), captures)
        self.assertFalse(self.portal_log.exists(), 'the portal captured the desktop')
        result, _ = self.call(proc, 'screenshot', dict(window_id=TARGET))
        caption = json.loads(next(c['text'] for c in result['content'] if c['type'] == 'text'))
        self.assertFalse(caption['window_raised'])
        self.assertFalse(self.portal_log.exists(), 'the portal captured the desktop')
        self.assertEqual(self.focus_dispatches(), [])

    def test_opt_out_keeps_focus_then_type(self):
        self.env.pop('COMPUTER_USE_LINUX_HYPRLAND_BACKGROUND')
        proc = self.server()
        self.call(proc, 'type_text', dict(window_id=TARGET, text='abc'))
        self.assertEqual(self.batches(), [])
        self.assertTrue(self.focus_dispatches(), self.requests())


if __name__ == '__main__':
    if len(sys.argv) > 2 and sys.argv[2] == '--private':
        result = unittest.main(argv=[sys.argv[0]], exit=False).result
        raise SystemExit(0 if result.wasSuccessful() else 1)
    with tempfile.TemporaryDirectory(prefix='cul-hyprland-bg-') as directory:
        env = dict(os.environ, XDG_RUNTIME_DIR=directory)
        config = Path(directory)/'bus.conf'
        config.write_text('<busconfig><type>session</type>'
            f'<listen>unix:tmpdir={directory}</listen>'
            '<policy context="default"><allow own="*"/>'
            '<allow send_destination="*"/><allow receive_sender="*"/></policy></busconfig>')
        proc = subprocess.Popen(['dbus-run-session', '--config-file', str(config), '--', '/usr/bin/python3',
            __file__, SERVER, '--private', directory], env=env, start_new_session=True)
        try:
            raise SystemExit(proc.wait(timeout=180))
        finally:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass

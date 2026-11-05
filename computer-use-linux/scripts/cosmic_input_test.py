#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Real MCP regression against a private portal and COSMIC-helper fixture.

Requires /usr/bin/python3 with PyGObject and dbus-run-session. No desktop input
is emitted: the portal records it and every physical input backend is disabled.
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
import threading
import time
import zlib

from socket_fixture import INDICATOR_SOCKET, private_bus_config, socket_tempdir

BINARY = str(Path(sys.argv[1]).resolve())

HELPER = '''#!/usr/bin/python3
import json, os, sys
from pathlib import Path
state = Path(os.environ['CUL_TEST_STATE'])
current = state.read_text()
def window(i):
    return dict(window_id=i, title='Editor' if i == 1 else 'Other', app_id='fixture.editor',
        wm_class=None, pid=None, bounds=dict(x=2660,y=440,width=800,height=600),
        workspace=None,focused=current == str(i),hidden=False,client_type='wayland',backend='cosmic-wayland')
cmd = sys.argv[1]
if cmd == 'probe':
    out = dict(ok=True,can_list_windows=True,can_activate_windows=True,detail='fixture')
elif cmd == 'list-windows': out = [] if os.environ.get('CUL_TEST_INTROSPECT') == '1' else [window(1), window(2)]
elif cmd == 'focused-window': out = None if os.environ.get('CUL_TEST_INTROSPECT') == '1' else window(int(current))
elif cmd == 'monitor-layout':
    out = [dict(x=0,y=0,width=2560,height=1440,scale=1.0),dict(x=2560,y=390,width=1680,height=1050,scale=1.0)]
elif cmd == 'activate-window':
    target = sys.argv[-1]
    if not Path(os.environ['CUL_TEST_REFUSE']).exists(): state.write_text(target)
    out = dict(ok=state.read_text() == target,detail='fixture activation')
else: raise RuntimeError(cmd)
print(json.dumps(out))
'''

XML = '''<node><interface name="org.freedesktop.portal.RemoteDesktop">
<property name="version" type="u" access="read"/>
<property name="AvailableDeviceTypes" type="u" access="read"/>
<method name="CreateSession"><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
<method name="SelectDevices"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
<method name="Start"><arg type="o" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
<method name="NotifyKeyboardKeysym"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="in"/></method>
<method name="NotifyKeyboardKeycode"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="in"/></method>
<method name="NotifyPointerMotionAbsolute"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="u" direction="in"/><arg type="d" direction="in"/><arg type="d" direction="in"/></method>
<method name="NotifyPointerButton"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="in"/></method>
<method name="NotifyPointerAxisDiscrete"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="u" direction="in"/><arg type="i" direction="in"/></method>
</interface><interface name="org.freedesktop.portal.ScreenCast">
<method name="SelectSources"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
</interface></node>'''


def rpc(proc, ident, method, params):
    proc.stdin.write(json.dumps(dict(jsonrpc='2.0', id=ident, method=method, params=params))+'\n')
    proc.stdin.flush()
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if not select.select([proc.stdout], [], [], 1)[0]:
            continue
        line = proc.stdout.readline()
        if not line:
            raise RuntimeError('MCP exited')
        response = json.loads(line)
        if response.get('id') == ident:
            assert 'error' not in response, response
            return response['result']
    raise TimeoutError(method)


def payload(result):
    return result.get('structuredContent') or json.loads(next(
        item['text'] for item in result['content'] if item['type'] == 'text'))


def run_private(directory):
    from gi.repository import Gio, GLib
    directory = Path(directory)
    state = directory/'focus'
    refuse = directory/'refuse'
    helper = directory/'cosmic-helper'
    helper.write_text(HELPER)
    helper.chmod(0o700)
    log = []
    introspect = False
    overview = False
    connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    connection.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
                         'org.freedesktop.DBus', 'RequestName',
                         GLib.Variant('(su)', ('org.freedesktop.portal.Desktop', 0)),
                         None, Gio.DBusCallFlags.NONE, 5000, None)

    def method(conn, sender, path, interface, name, parameters, invocation):
        args = parameters.unpack()
        if name.startswith('Notify'):
            log.append((name, state.read_text(), args[2:]))
            invocation.return_value(None)
            return
        options = args[-1]
        request = '/org/freedesktop/portal/desktop/request/' + sender.lstrip(':').replace('.', '_') + '/' + options['handle_token']
        results = {}
        if name == 'CreateSession':
            results['session_handle'] = GLib.Variant('s', '/org/freedesktop/portal/desktop/session/fixture/session')
        if name == 'Start':
            if os.environ.get('CUL_TEST_KEEP_FOCUS') != '1':
                state.write_text('2')  # Simulate consent landing on the other monitor.
            if os.environ.get('CUL_TEST_DENY_FOCUS') == '1':
                refuse.touch()
            results['devices'] = GLib.Variant('u', 3)
            results['streams'] = GLib.Variant('a(ua{sv})', [
                (10, {'position': GLib.Variant('(ii)', (0, 0)), 'size': GLib.Variant('(ii)', (2560, 1440))}),
                (20, {'position': GLib.Variant('(ii)', (2560, 390)), 'size': GLib.Variant('(ii)', (1680, 1050))})])
        invocation.return_value(GLib.Variant('(o)', (request,)))
        def respond():
            conn.emit_signal(sender, request, 'org.freedesktop.portal.Request', 'Response',
                             GLib.Variant('(ua{sv})', (1 if name == 'Start' and os.environ.get('CUL_TEST_CANCEL') == '1' else 0, results)))
            return False
        GLib.idle_add(respond)

    # Exercise the app-only focus backend too. The absence of the Shell
    # extension is intentional: it must not turn app input into exact targeting.
    connection.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
                         'org.freedesktop.DBus', 'RequestName',
                         GLib.Variant('(su)', ('org.gnome.Shell', 0)),
                         None, Gio.DBusCallFlags.NONE, 5000, None)
    def gnome_method(conn, sender, path, interface, name, parameters, invocation):
        nonlocal overview
        if name == 'FocusApp':
            overview = True
            log.append(('FocusApp', 'overview', ()))
            invocation.return_value(None)
        else:
            windows = {}
            if introspect:
                for i in (1, 2):
                    windows[i] = {'title': GLib.Variant('s', 'Editor' if i == 1 else 'Other'),
                        'app-id': GLib.Variant('s', 'fixture.editor' if i == 1 else 'fixture.other'),
                        'has-focus': GLib.Variant('b', not overview and state.read_text() == str(i)),
                        'x': GLib.Variant('i', 2660), 'y': GLib.Variant('i', 440),
                        'width': GLib.Variant('u', 800), 'height': GLib.Variant('u', 600)}
            invocation.return_value(GLib.Variant('(a{ta{sv}})', (windows,)))
    gnome_xml = '<node><interface name="org.gnome.Shell.Introspect"><method name="GetWindows"><arg type="a{ta{sv}}" direction="out"/></method></interface><interface name="org.gnome.Shell"><method name="FocusApp"><arg type="s" direction="in"/></method></interface></node>'
    gnome_info = Gio.DBusNodeInfo.new_for_xml(gnome_xml)
    for interface in gnome_info.interfaces:
        path = '/org/gnome/Shell/Introspect' if interface.name.endswith('Introspect') else '/org/gnome/Shell'
        connection.register_object(path, interface, gnome_method, None, None)
    info = Gio.DBusNodeInfo.new_for_xml(XML)
    for interface in info.interfaces:
        connection.register_object('/org/freedesktop/portal/desktop', interface, method,
                                   lambda *args: GLib.Variant('u', 1 if args[-1] == 'version' else 3), None)
    loop = GLib.MainLoop()
    thread = threading.Thread(target=loop.run, daemon=True)
    thread.start()
    env = dict(os.environ, XDG_CURRENT_DESKTOP='COSMIC', XDG_SESSION_DESKTOP='COSMIC',
               XDG_SESSION_TYPE='wayland', WAYLAND_DISPLAY='fixture-no-real-display',
               COMPUTER_USE_LINUX_COSMIC_HELPER=str(helper), CU_DISABLE_ABS_POINTER='1',
               COMPUTER_USE_LINUX_FORCE_PORTAL_KEYBOARD='1', COMPUTER_USE_LINUX_INDICATOR='0',
               COMPUTER_USE_LINUX_SCREENSHOT_BACKEND='gnome-screenshot',
               CUL_TEST_STATE=str(state), CUL_TEST_REFUSE=str(refuse),
               PATH=str(directory)+':'+os.environ['PATH'])
    for key in ('DISPLAY', 'AT_SPI_BUS_ADDRESS', 'COMPUTER_USE_LINUX_FORCE_YDOTOOL_POINTER',
                'COMPUTER_USE_LINUX_FORCE_YDOTOOL_KEYBOARD'):
        env.pop(key, None)
    # A deterministic full-desktop capture. No screenshot service touches a real display.
    def chunk(kind, data):
        return struct.pack('!I', len(data))+kind+data+struct.pack('!I', zlib.crc32(kind+data))
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', 4240,1440,8,2,0,0,0))
    png += chunk(b'IDAT', zlib.compress((b'\0'+b'\0'*(4240*3))*1440)) + chunk(b'IEND', b'')
    (directory/'screen.png').write_bytes(png)
    screenshot = directory/'gnome-screenshot'
    screenshot.write_text('#!/usr/bin/python3\nimport shutil,sys\nshutil.copyfile('+repr(str(directory/'screen.png'))+',sys.argv[-1])\n')
    screenshot.chmod(0o700)
    # Avoid running host commands even if an unexpected fallback regresses.
    for name in ('ydotool', 'xdotool', 'wtype', 'xrandr'):
        path = directory/name
        path.write_text('#!/bin/sh\nexit 1\n')
        path.chmod(0o700)
    try:
        scenarios = [('type_text', {'text': "ґєії'", 'window_id': 1}, False),
                     ('type_text', {'text': 'implicit'}, False),
                     ('type_text', {'text': 'app selector', 'app_id': 'fixture.editor'}, False),
                     ('type_text', {'text': 'must not leak', 'window_id': 1}, True),
                     ('press_key', {'key': 'Ctrl+A', 'window_id': 1}, False),
                     ('press_key', {'key': 'Enter'}, False),
                     ('press_key', {'key': 'Enter', 'window_id': 1}, True),
                     ('press_key', {'key': 'Enter', 'window_id': 1}, 'cancel'),
                     ('type_text', {'text': 'cancelled', 'window_id': 1}, 'cancel'),
                     ('click', {'x': 3820, 'y': 710, 'window_id': 1}, False),
                     ('click', {'x': 3820, 'y': 710, 'app_id': 'fixture.editor'}, False),
                     ('scroll', {'x': 3820, 'y': 710, 'direction': 'down', 'window_id': 1}, False),
                     ('click', {'x': 3820, 'y': 710, 'window_id': 1}, True),
                     ('scroll', {'x': 3820, 'y': 710, 'direction': 'down', 'window_id': 1}, True),
                     ('click', {'x': 10, 'y': 20, 'relative': True, 'window_id': 1}, False),
                     ('drag', {'start_x': 100, 'start_y': 100, 'end_x': 3820, 'end_y': 710}, False),
                     ('drag', {'start_x': 100, 'start_y': 50, 'end_x': 3820, 'end_y': 410}, False),
                     # 3000,100 is above the right monitor, on no monitor; 5000,700 is off
                     # the 4240x1440 capture. The portal sends nothing and names each endpoint.
                     ('drag', {'start_x': 3000, 'start_y': 100, 'end_x': 5000, 'end_y': 700,
                               '_notes': ['WARNING: start coordinate 3000,100 is on no monitor of the captured desktop (4240x1440).',
                                          'WARNING: end coordinate 5000,700 is outside the captured desktop (4240x1440).']}, 'unsent'),
                     ('drag', {'start_x': 100, 'start_y': 100, 'end_x': 3000, 'end_y': 100,
                               '_notes': ['WARNING: end coordinate 3000,100 is on no monitor of the captured desktop (4240x1440).']}, 'unsent'),
                     ('type_text', {'text': 'implicit app focus', '_introspect': True, '_keep_focus': True}, False),
                     ('type_text', {'text': 'app focus', 'app_id': 'fixture.editor', '_introspect': True, '_keep_focus': True}, False),
                     ('press_key', {'key': 'Enter', '_introspect': True, '_keep_focus': True}, False),
                     ('click', {'x': 3820, 'y': 710, 'app_id': 'fixture.editor', '_introspect': True, '_keep_focus': True}, False),
                     ('scroll', {'x': 3820, 'y': 710, 'direction': 'down', 'app_id': 'fixture.editor', '_introspect': True, '_keep_focus': True}, False),
                     ('type_text', {'text': 'changed focus', '_introspect': True}, 'changed'),
                     ('press_key', {'key': 'Enter', '_introspect': True}, 'changed')]
        for name, arguments, denied in scenarios:
            introspect = arguments.pop('_introspect', False)
            notes = arguments.pop('_notes', [])
            overview = False
            os.environ['CUL_TEST_KEEP_FOCUS'] = '1' if arguments.pop('_keep_focus', False) else '0'
            env['CUL_TEST_INTROSPECT'] = '1' if introspect else '0'
            state.write_text('1')
            refuse.unlink(missing_ok=True)
            log.clear()
            os.environ['CUL_TEST_DENY_FOCUS'] = '1' if denied is True else '0'
            os.environ['CUL_TEST_CANCEL'] = '1' if denied == 'cancel' else '0'
            with tempfile.TemporaryFile(mode='w+') as stderr:
                proc = subprocess.Popen([BINARY, 'mcp'], env=env, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=stderr, text=True)
                try:
                    rpc(proc, 1, 'initialize', dict(protocolVersion='2024-11-05',capabilities={},clientInfo=dict(name='cosmic-input-regression',version='1')))
                    proc.stdin.write(json.dumps(dict(jsonrpc='2.0',method='notifications/initialized'))+'\n')
                    proc.stdin.flush()
                    result = rpc(proc, 2, 'tools/call', dict(name=name,arguments=arguments))
                    output = payload(result)
                    if denied:
                        assert result.get('isError') and not output['ok'], output
                        assert not log, log
                        if denied == 'cancel':
                            assert 'RemoteDesktop Start denied' in output['message'], output
                        if notes:
                            assert output['message'].endswith(' ' + ' '.join(notes)), output
                    else:
                        assert not result.get('isError') and output['ok'], output
                        assert log, 'no portal input recorded'
                        if name in ('type_text', 'press_key') or arguments.get('window_id') or arguments.get('app_id'):
                            assert all(item[1] == '1' for item in log), log
                        if name in ('click', 'drag', 'scroll'):
                            # Every sent point is on a shared monitor, even where a drag crosses the gap.
                            assert 'WARNING' not in output['message'], output
                            motions = [item[2] for item in log if item[0] == 'NotifyPointerMotionAbsolute']
                            expected = (20, 1260.0, 320.0) if not arguments.get('relative') else (20, 110.0, 70.0)
                            if name == 'drag':
                                expected = (20, arguments['end_x'] - 2560.0, arguments['end_y'] - 390.0)
                            assert motions[-1] == expected, motions
                            if name == 'drag':
                                assert len(motions) > 2, 'drag must emit intermediate motion while pressed: ' + repr(motions)
                    if arguments.get('relative'):
                        crop = payload(rpc(proc, 3, 'tools/call', dict(name='screenshot', arguments={'window_id': 1})))
                        assert crop['coordinate_width'] == 800 and crop['coordinate_height'] == 600, crop
                    print(json.dumps(dict(tool=name,arguments=arguments,denied=denied,introspect=introspect,events=log)), flush=True)
                finally:
                    proc.terminate()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait()
                    stderr.seek(0)
                    errors = stderr.read()
                    if errors:
                        print(errors, file=sys.stderr)
    finally:
        loop.quit()
        thread.join(timeout=5)


if __name__ == '__main__':
    if len(sys.argv) > 2 and sys.argv[2] == '--private':
        run_private(sys.argv[3])
    else:
        # The directory is the server's runtime dir and the private bus's.
        with socket_tempdir('cul-portal-', [INDICATOR_SOCKET], bus_dir='',
                            dir=Path.home()/'.cache') as directory:
            env = dict(os.environ, XDG_RUNTIME_DIR=directory, XDG_CONFIG_HOME=directory+'/config')
            # No service directories: the fixture owns the portal name itself.
            config = private_bus_config(Path(directory)/'bus.conf', directory)
            proc = subprocess.Popen(['dbus-run-session', '--config-file', str(config), '--',
                                     '/usr/bin/python3', __file__, BINARY, '--private', directory],
                                    env=env, start_new_session=True)
            try:
                raise SystemExit(proc.wait(timeout=120))
            finally:
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass

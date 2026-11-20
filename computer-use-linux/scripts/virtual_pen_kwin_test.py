#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""delivery="background" pointer input through the virtual pen on KWin.

KWin 6.6 (Ubuntu 26.04, in a container) runs on a vkms output with its DRM
backend, so libinput reads the machine's input devices, the virtual pen's
among them; KWin's virtual backend reads none. Opt-in with
COMPUTER_USE_LINUX_TEST_KWIN_SEAT=1: it needs docker, passwordless sudo
(modprobe vkms) and no graphical session on seat0, since uinput devices are
machine-wide and KWin opens every input device. Without the variable it
skips.

In the container a GTK 4 window logs every event with its device's source.
A relative mouse nudge shows where the user's pointer is. Background left, right,
middle and double clicks, a drag and two scrolls go through the pen and the
touchscreen: the window sees pen and touch input with the buttons named and
no mouse event, and a second nudge shows the user's pointer where it was. A point under another window is refused before
input, and so is a call while KWin shows the desktop or on a minimized
target. While the pen runs, kcminputrc holds its workspace mapping; after the
server exits, no virtual device and none of its kcminputrc groups are left.
With KWin's SyncWithMouse tablet option on, there is no route.
"""
import contextlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from agent_seat_test import Server, check, stop, wait_for
from socket_fixture import private_bus_config
import virtual_pen_test as gnome

HERE = Path(__file__).resolve().parent
SHOW_DESKTOP = """
import time
from gi.repository import Gio, GLib
bus = Gio.bus_get_sync(Gio.BusType.SESSION)
bus.call_sync('org.kde.KWin', '/KWin', 'org.kde.KWin', 'showDesktop', GLib.Variant('(b)', (True,)),
              None, Gio.DBusCallFlags.NONE, 2000)
time.sleep(600)
"""
MINIMIZED = """
import gi
gi.require_version('Gtk', '4.0')
from gi.repository import GLib, Gtk
app = Gtk.Application(application_id='dev.avifenesh.CulPenMinimized')
def activate(app):
    window = Gtk.ApplicationWindow(application=app, title='cul-pen-minimized')
    window.set_default_size(300, 300)
    window.present()
    GLib.timeout_add(1000, lambda: window.minimize() and False)
app.connect('activate', activate)
app.run([])
"""
SCREENSHOT = """
import struct, sys, zlib
from gi.repository import Gio, GLib
width, height = int(sys.argv[1]), int(sys.argv[2])
def png(path):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    raw = b''.join(b'\\0' + b'\\0' * (3 * width) for _ in range(height))
    open(path, 'wb').write(b'\\x89PNG\\r\\n\\x1a\\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
                           + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))
XML = '''<node><interface name="org.gnome.Shell.Screenshot"><method name="Screenshot">
<arg type="b" direction="in"/><arg type="b" direction="in"/><arg type="s" direction="in"/>
<arg type="b" direction="out"/><arg type="s" direction="out"/></method></interface></node>'''
def call(connection, sender, path, interface, method, parameters, invocation):
    filename = parameters.unpack()[2]
    png(filename)
    invocation.return_value(GLib.Variant('(bs)', (True, filename)))
def acquired(connection, name):
    connection.register_object('/org/gnome/Shell/Screenshot', Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0],
                               call, None, None)
Gio.bus_own_name(Gio.BusType.SESSION, 'org.gnome.Shell.Screenshot', Gio.BusNameOwnerFlags.NONE, acquired, None, None)
GLib.MainLoop().run()
"""
IMAGE = 'computer-use-linux-kwin-pen:local'
SOCKET = 'cul-kwin-0'


def guest(binary):
    failures = []
    out = Path('/out')
    runtime = Path('/run/user/0')
    runtime.mkdir(parents=True, exist_ok=True)
    os.chmod(runtime, 0o700)
    env = dict(os.environ, XDG_RUNTIME_DIR=str(runtime), XDG_SESSION_TYPE='wayland', XDG_CURRENT_DESKTOP='KDE',
               COMPUTER_USE_LINUX_INDICATOR='0', CODEX_COMPUTER_USE_INDICATOR='0', AT_SPI_BUS_ADDRESS='unix:path=/nonexistent', NO_AT_BRIDGE='1')
    env.pop('DISPLAY', None)
    with contextlib.ExitStack() as cleanup:
        config = private_bus_config(out / 'bus.conf', runtime)
        bus = subprocess.Popen(['dbus-daemon', '--config-file', str(config), '--nofork', '--print-address=1'],
                               stdout=subprocess.PIPE, text=True, env=env)
        cleanup.callback(stop, bus)
        env['DBUS_SESSION_BUS_ADDRESS'] = bus.stdout.readline().strip()
        kwin = subprocess.Popen(['kwin_wayland', '--drm', '--socket', SOCKET, '--no-lockscreen',
                                 '--no-global-shortcuts'],
                                env=dict(env, KWIN_DRM_DEVICES=os.environ['CARD']),
                                stdout=(out / 'kwin.log').open('w'), stderr=subprocess.STDOUT)
        cleanup.callback(stop, kwin)
        wait_for(lambda: (runtime / SOCKET).exists(), 'the KWin socket', 30)
        env['WAYLAND_DISPLAY'] = SOCKET
        # Plasma's screenshots come from the desktop portal, which asks the
        # user; here a stand-in answers the server's first screenshot route
        # with a blank image of the output's size, so capture pixels are
        # layout pixels as on a 100% Plasma desktop.
        mode = next(Path('/sys/class/drm').glob(Path(os.environ['CARD']).name + '-*/modes')).read_text().split()[0]
        width, height = (int(side) for side in mode.split('x'))
        shot = subprocess.Popen(['/usr/bin/python3', '-c', SCREENSHOT, str(width), str(height)], env=env)
        cleanup.callback(stop, shot)
        owner = ['gdbus', 'call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path',
                 '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.NameHasOwner', 'org.gnome.Shell.Screenshot']
        wait_for(lambda: 'true' in subprocess.run(owner, env=env, capture_output=True, text=True).stdout,
                 'the screenshot stand-in', 10)
        root = out / 'gtk'
        root.mkdir(exist_ok=True)
        app = subprocess.Popen(['/usr/bin/python3', str(HERE / 'virtual_pen_test.py'), '--gtk', str(root)],
                               env=dict(env, GDK_BACKEND='wayland', GTK_A11Y='none'),
                               stdout=(out / 'app.log').open('w'), stderr=subprocess.STDOUT)
        cleanup.callback(stop, app)
        geometry = json.loads(wait_for(lambda: (root / 'geometry.json').exists()
                                       and (root / 'geometry.json').read_text(), 'GTK window geometry', 20))
        server = Server(binary, env)
        cleanup.callback(server.close)
        def background_pointer(server):
            return (server.call('doctor', {}).get('capabilities') or {}).get('background_pointer') or {}
        report = background_pointer(server)
        print('doctor', json.dumps(report)[:300], flush=True)
        check(failures, report.get('routes') == ['kwin-pen', 'kwin-touch'], f'doctor offers the KWin routes: {report}')
        target = next(w for w in server.call('list_windows', {})['windows'] if w.get('title') == 'cul-pen-target')
        wid = target['window_id']
        check(failures, server.call('activate_window', dict(window_id=wid)).get('ok'), 'activate the GTK window')
        time.sleep(1)
        shot = server.call('screenshot', dict(max_width=64))
        check(failures, shot.get('coordinate_width'), f'screenshot: {json.dumps(shot)[:1500]}')
        bounds = next(w for w in server.call('list_windows', {})['windows'] if w['window_id'] == wid)['bounds']
        origin = (bounds['x'], bounds['y'])
        print(f'window at {bounds}, geometry {geometry}', flush=True)
        px, py, _, _ = geometry['pad']
        sx, sy, sw, sh = geometry['scroller']

        def at(local):
            return dict(x=int(origin[0] + local[0]), y=int(origin[1] + local[1]))

        def events(since=0.0):
            return gnome.events(root, since)
        # Where the user's pointer is: a relative nudge shows it.
        since = time.monotonic()
        gnome.nudge_mouse()
        user_point = wait_for(lambda: [(e['x'], e['y']) for e in events(since)
                                       if e['kind'] == 'motion' and e['source'] == 'mouse'],
                              'mouse motion before the pen', 5)[-1]
        print('user pointer', user_point, flush=True)
        pen_start = time.monotonic()

        def background(tool, **arguments):
            result = server.call(tool, dict(arguments, window_id=wid, delivery='background'))
            report = result.get('background') or {}
            check(failures, result.get('ok') and report.get('used') is True,
                  f'background {tool} {arguments}: {result.get("message")} {report}')
            return result

        def pen_presses(since, button, point):
            return [e for e in events(since) if e['kind'] == 'press' and e['source'] == 'pen'
                    and e.get('button') == button and gnome.near(e, point)]
        rc = Path('/root/.config/kcminputrc')
        for button, code, offset in (('left', 1, 100), ('right', 3, 160), ('middle', 2, 220)):
            point = (px + offset, py + 120)
            since = time.monotonic()
            result = background('click', **at(point), button=button)
            check(failures, (result.get('background') or {}).get('route') == 'kwin-pen',
                  f'{button} route: {result.get("background")}')
            time.sleep(.4)
            presses = pen_presses(since, code, point)
            check(failures, len(presses) == 1,
                  f'{button} click: one pen press with button {code} at {point}: {events(since)[:8]}')
            check(failures, presses and [e for e in events(presses[0]['t']) if e['kind'] == 'proximity-out'],
                  f'{button} click: the pen left proximity after it')
            if button == 'left':
                text = rc.read_text() if rc.exists() else ''
                check(failures, 'computer-use-linux virtual pen]' in text and 'MapToWorkspace=true' in text,
                      f'the pen maps to the whole workspace: {text}')
        point = (px + 280, py + 120)
        since = time.monotonic()
        background('click', **at(point), click_count=2)
        time.sleep(.4)
        check(failures, len(pen_presses(since, 1, point)) == 2, f'double click: two pen presses at {point}')
        start, end = (px + 100, py + 200), (px + 300, py + 260)
        since = time.monotonic()
        background('drag', start_x=at(start)['x'], start_y=at(start)['y'], end_x=at(end)['x'], end_y=at(end)['y'])
        time.sleep(.4)
        seen = events(since)
        check(failures, any(e['kind'] == 'press' and e['source'] == 'pen' and gnome.near(e, start) for e in seen)
              and any(e['kind'] == 'release' and e['source'] == 'pen' and gnome.near(e, end) for e in seen)
              and sum(e['kind'] == 'motion' and e['source'] == 'pen' for e in seen) >= 5,
              f'drag: pen press at {start}, motion, release at {end}: {seen[:3]} ... {seen[-3:]}')
        point = (sx + sw // 2, sy + sh // 2)
        before = 0
        for name in ('scroll', 'scroll after a pen click'):
            if name != 'scroll':
                background('click', **at((px + 200, py + 400)))
            since = time.monotonic()
            result = background('scroll', **at(point), direction='down', pages=1)
            check(failures, (result.get('background') or {}).get('route') == 'kwin-touch',
                  f'{name} route: {result.get("background")} {result.get("message")}')
            time.sleep(1)
            seen = events(since)
            scrolled = [e['value'] for e in seen if e['kind'] == 'scrolled']
            check(failures, any(e['kind'] == 'touch-begin' and e['source'] == 'touch' for e in seen)
                  and scrolled and max(scrolled) > before + 100, f'{name}: touch pan moved the list: {scrolled[-3:]}')
            before = max(scrolled) if scrolled else before
        # KWin re-sends the pointer's position when the surface under it
        # changes focus; the pointer itself must not move or click.
        mouse = [e for e in events(pen_start) if e.get('source') == 'mouse'
                 and (e['kind'] != 'motion' or abs(e['x'] - user_point[0]) > 2 or abs(e['y'] - user_point[1]) > 2)]
        check(failures, not mouse, f'no mouse movement or button during pen input: {mouse[:5]}')
        since = time.monotonic()
        gnome.nudge_mouse()
        moved = wait_for(lambda: [e for e in events(since) if e['kind'] == 'motion' and e['source'] == 'mouse'],
                         'mouse motion after the nudge', 5)
        print('pointer after the nudge', moved[:2], flush=True)
        check(failures, abs(moved[-1]['x'] - user_point[0]) <= 2 and abs(moved[-1]['y'] - user_point[1]) <= 2,
              f'user pointer still at {user_point}: {moved[-2:]}')
        cover = subprocess.Popen(['/usr/bin/python3', '-c', gnome.COVER], env=dict(env, GDK_BACKEND='wayland'),
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cleanup.callback(stop, cover)
        cover_window = wait_for(lambda: next((w for w in server.call('list_windows', {})['windows']
                                              if w.get('title') == 'cul-pen-cover' and w.get('bounds')), None),
                                'the cover window', 20)
        time.sleep(1)
        b = cover_window['bounds']
        covered = (b['x'] + b['width'] // 2, b['y'] + b['height'] // 2)
        since = time.monotonic()
        refused = server.call('click', dict(x=covered[0], y=covered[1], window_id=wid, delivery='background'))
        check(failures, refused.get('ok') is False and 'stacked above' in refused.get('message', ''),
              f'a covered point is refused: {refused.get("message")}')
        time.sleep(.5)
        check(failures, not [e for e in events(since) if e['kind'] == 'press'], 'refused click sent no press')
        stop(cover)
        # Show Desktop hides windows without minimizing them.
        # KWin ends Show Desktop when the client that asked leaves the bus.
        shower = subprocess.Popen(['/usr/bin/python3', '-c', SHOW_DESKTOP], env=env)
        cleanup.callback(stop, shower)
        time.sleep(1.5)
        since = time.monotonic()
        refused = server.call('click', dict(at((px + 100, py + 300)), window_id=wid, delivery='background'))
        check(failures, refused.get('ok') is False and 'showing the desktop' in refused.get('message', ''),
              f'Show Desktop is refused: {refused.get("message")}')
        stop(shower)
        time.sleep(1)
        check(failures, not [e for e in events(since) if e['kind'] == 'press'], 'Show Desktop click sent no press')
        # A minimized window is no target.
        hidden = subprocess.Popen(['/usr/bin/python3', '-c', MINIMIZED], env=dict(env, GDK_BACKEND='wayland'),
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cleanup.callback(stop, hidden)
        minimized = wait_for(lambda: next((w for w in server.call('list_windows', {})['windows']
                                           if w.get('title') == 'cul-pen-minimized' and w.get('hidden')), None),
                             'the minimized window', 20)
        refused = server.call('click', dict(at((px + 100, py + 300)), window_id=minimized['window_id'],
                                            delivery='background'))
        check(failures, refused.get('ok') is False and 'minimized' in refused.get('message', ''),
              f'a minimized target is refused: {refused.get("message")}')
        stop(hidden)
        # The on-screen indicator's overlay (its pill sits over the window's
        # top rows) takes no input and must not count as cover, on the
        # second call too, once the overlay is up.
        if (Path(binary).parent / 'codex-computer-use-indicator').exists():
            shown = Server(binary, {key: value for key, value in env.items() if key not in ('COMPUTER_USE_LINUX_INDICATOR', 'CODEX_COMPUTER_USE_INDICATOR')})
            cleanup.callback(shown.close)
            under_pill = (px + 400, py + 3)
            for attempt in (1, 2):
                since = time.monotonic()
                result = shown.call('click', dict(at(under_pill), window_id=wid, delivery='background'))
                time.sleep(.6)
                check(failures, result.get('ok') and pen_presses(since, 1, under_pill),
                      f'click {attempt} under the indicator overlay: {result.get("message")}')
            shown.close()
        else:
            print('SKIP indicator overlay: no codex-computer-use-indicator next to the server', flush=True)
        server.close()
        time.sleep(1)
        check(failures, not gnome.leftover_devices(), f'no virtual device after exit: {gnome.leftover_devices()}')
        text = rc.read_text() if rc.exists() else ''
        check(failures, 'computer-use-linux virtual' not in text, f'no kcminputrc group left: {text}')
        # The tablet cursor following the mouse would move the user's pointer.
        subprocess.run(['kwriteconfig6', '--file', 'kcminputrc', '--group', 'Tablet', '--key', 'SyncWithMouse',
                        'true'], env=env, check=True)
        synced = Server(binary, env)
        cleanup.callback(synced.close)
        report = background_pointer(synced)
        check(failures, report.get('available') is False and 'SyncWithMouse' in report.get('reason', ''),
              f'SyncWithMouse leaves no route: {report}')
        synced.close()
    return failures


def host(binary):
    if not os.environ.get('COMPUTER_USE_LINUX_TEST_KWIN_SEAT'):
        print('SKIP kwin pen: set COMPUTER_USE_LINUX_TEST_KWIN_SEAT=1 on a machine with docker and no desktop session')
        return
    missing = [tool for tool in ('docker', 'sudo') if not shutil.which(tool)]
    if missing:
        sys.exit(f'kwin pen fixture: missing {missing}')
    if subprocess.run(['sudo', '-n', 'true'], capture_output=True).returncode != 0:
        sys.exit('kwin pen fixture: needs passwordless sudo')
    busy = gnome.seat0_graphical_sessions()
    if busy:
        sys.exit(f'kwin pen fixture: seat0 has graphical sessions {busy}; uinput input would reach them')
    subprocess.run(['docker', 'build', '-q', '-t', IMAGE, '-f', str(HERE / 'virtual_pen_kwin.Dockerfile'), str(HERE)],
                   check=True, stdout=subprocess.DEVNULL)
    cache = Path(os.environ.get('XDG_CACHE_HOME', Path.home() / '.cache'))
    out = Path(os.environ.get('CUL_PEN_TEST_KEEP_LOGS') or cache / f'cul-kwin-pen-{os.getpid()}')
    out.mkdir(parents=True, exist_ok=True)
    loaded = Path('/sys/module/vkms').exists()
    subprocess.run(['sudo', '-n', 'modprobe', 'vkms'], check=True)
    try:
        subprocess.run(['sudo', '-n', 'udevadm', 'settle'], check=True)
        card = str(Path('/dev/dri/by-path/platform-vkms-card').resolve())
        binary = Path(binary).resolve()
        # --network host: libinput learns of new devices through udev's
        # netlink group, which a separate network namespace never hears.
        status = subprocess.run(['docker', 'run', '--rm', '--privileged', '--network', 'host',
                                 '-v', '/dev:/dev', '-v', '/run/udev:/run/udev:ro',
                                 '-v', f'{HERE}:/scripts:ro', '-v', f'{binary.parent}:/cul:ro', '-v', f'{out}:/out',
                                 '-e', f'CARD={card}', IMAGE, 'python3', '/scripts/virtual_pen_kwin_test.py',
                                 '--guest', f'/cul/{binary.name}'], timeout=600).returncode
    finally:
        # The GNOME fixture loads vkms under its own udev rule, and udev keeps
        # a device's tags until it goes away: leave none behind.
        if not loaded and not gnome.unload_vkms():
            print('kwin pen fixture: vkms is still in use and stays loaded', flush=True)
    if not os.environ.get('CUL_PEN_TEST_KEEP_LOGS'):
        subprocess.run(['docker', 'run', '--rm', '-v', f'{out}:/out', IMAGE, 'sh', '-c', 'rm -rf /out/*'],
                       capture_output=True)
        out.rmdir()
    if status != 0:
        sys.exit('kwin pen fixture failed')
    print('kwin pen: all checks passed', flush=True)


if __name__ == '__main__':
    if sys.argv[1] == '--guest':
        failures = guest(sys.argv[2])
        if failures:
            sys.exit(f'{len(failures)} kwin pen check(s) failed')
    else:
        host(sys.argv[1])

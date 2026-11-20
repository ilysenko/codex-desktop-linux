#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""delivery="background" pointer input through the GNOME virtual pen, against
a real GNOME Shell on a real seat.

GNOME Shell runs as the display server of seat0 on the virtual terminal
COMPUTER_USE_LINUX_TEST_GNOME_SEAT names (for example tty6), on a vkms
output, with libinput reading the seat's devices: a headless mutter reads
none, so it never sees a uinput device. The fixture needs passwordless sudo
for that (modprobe vkms, an ACL on /dev/uinput, a login session on the
terminal, chvt), and refuses to run while any graphical session is on seat0:
uinput devices are machine-wide, so this must never run on a desktop someone
uses. Without the variable it skips.

A fullscreen GTK 4 window logs every event with its device's source. A
normal click first puts the user's pointer on the window through the uinput
pointer. Then background clicks (left, right, middle, double), a drag and a
scroll go through the pen and the touchscreen: the window sees pen and touch
events at the points, and no mouse event, so the user's pointer stays where
the normal click left it. A point under another window is refused before
input. After the server exits no virtual device and no tablet or touchscreen
setting is left behind. The pen's proximity ends HOVER seconds after its last
action, and wev, which binds no tablet, shows what an app without tablet
support sees of a pen click.
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
from socket_fixture import INDICATOR_SOCKET, private_bus_config, socket_tempdir
from agent_seat_test import Server, check, stop, wait_for

UUID = 'codex-window-control@openai.com'
EXTENSION = Path(__file__).resolve().parent.parent / 'gnome-shell-extension'
DISPLAY_NAME = 'cul-pen-0'
HOVER = 8


def gtk_app(root):
    import gi
    gi.require_version('Gtk', '4.0')
    gi.require_version('Gdk', '4.0')
    from gi.repository import Gdk, GLib, Gtk
    log = (root / 'events.jsonl').open('a', buffering=1)
    sources = {Gdk.InputSource.MOUSE: 'mouse', Gdk.InputSource.PEN: 'pen',
               Gdk.InputSource.TOUCHSCREEN: 'touch'}
    kinds = {Gdk.EventType.BUTTON_PRESS: 'press', Gdk.EventType.BUTTON_RELEASE: 'release',
             Gdk.EventType.MOTION_NOTIFY: 'motion', Gdk.EventType.TOUCH_BEGIN: 'touch-begin',
             Gdk.EventType.TOUCH_UPDATE: 'touch-update', Gdk.EventType.TOUCH_END: 'touch-end',
             Gdk.EventType.PROXIMITY_IN: 'proximity-in', Gdk.EventType.PROXIMITY_OUT: 'proximity-out',
             Gdk.EventType.SCROLL: 'scroll', Gdk.EventType.ENTER_NOTIFY: 'enter',
             Gdk.EventType.LEAVE_NOTIFY: 'leave'}

    app = Gtk.Application(application_id='dev.avifenesh.CulPenTarget')

    def activate(_app):
        window = Gtk.ApplicationWindow(application=app, title='cul-pen-target')
        box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
        pad = Gtk.DrawingArea()
        pad.set_hexpand(True)
        pad.set_vexpand(True)
        scroller = Gtk.ScrolledWindow()
        scroller.set_size_request(400, -1)
        rows = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        for index in range(300):
            rows.append(Gtk.Label(label=f'row {index}'))
        scroller.set_child(rows)
        box.append(pad)
        box.append(scroller)
        window.set_child(box)

        def changed(adjustment):
            log.write(json.dumps(dict(kind='scrolled', value=adjustment.get_value(), t=time.monotonic())) + '\n')
        scroller.get_vadjustment().connect('value-changed', changed)

        legacy = Gtk.EventControllerLegacy()
        legacy.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)

        def event(controller, _event):
            event = controller.get_current_event()
            if event is None:
                return False
            kind = kinds.get(event.get_event_type())
            if kind:
                found, x, y = event.get_position()
                device = event.get_device()
                if event.get_device_tool() is not None:
                    source = 'pen'
                elif device == window.get_display().get_default_seat().get_pointer():
                    source = 'mouse'
                else:
                    source = sources.get(device.get_source(), 'other')
                entry = dict(kind=kind, source=source,
                             x=round(x, 1) if found else None, y=round(y, 1) if found else None,
                             t=time.monotonic())
                if kind in ('press', 'release'):
                    entry['button'] = event.get_button()
                log.write(json.dumps(entry) + '\n')
            return False
        legacy.connect('event', event)
        window.add_controller(legacy)
        # Undecorated, so the window's frame rect is its surface and widget
        # coordinates plus the frame's origin are layout coordinates.
        window.set_decorated(False)
        window.set_default_size(900, 600)
        window.present()

        def geometry():
            if pad.get_width() < 100:
                return True
            _, pad_rect = pad.compute_bounds(window)
            _, scroll_rect = scroller.compute_bounds(window)
            rect = lambda r: [r.get_x(), r.get_y(), r.get_width(), r.get_height()]
            (root / 'geometry.json').write_text(json.dumps(dict(pad=rect(pad_rect), scroller=rect(scroll_rect))))
            return False
        GLib.timeout_add(300, geometry)

        last_pointer = [None]

        def pointer():
            seat = window.get_display().get_default_seat()
            surface = window.get_surface()
            if seat and surface:
                found, x, y, _ = surface.get_device_position(seat.get_pointer())
                value = [x, y] if found else None
                (root / 'pointer.json').write_text(json.dumps(value))
                if value != last_pointer[0]:
                    last_pointer[0] = value
                    log.write(json.dumps(dict(kind='pointer', value=value, t=time.monotonic())) + '\n')
            return True
        GLib.timeout_add(100, pointer)

    app.connect('activate', activate)
    app.run([])


def events(root, since=0.0):
    path = root / 'events.jsonl'
    if not path.exists():
        return []
    return [entry for entry in (json.loads(line) for line in path.read_text().splitlines() if line.strip())
            if entry['t'] >= since]


def near(entry, point, slack=2.5):
    return entry['x'] is not None and abs(entry['x'] - point[0]) <= slack and abs(entry['y'] - point[1]) <= slack


def nudge_mouse():
    """Move a fresh uinput relative mouse right one unit and back."""
    import fcntl
    import struct
    ev_syn, ev_key, ev_rel, rel_x, btn_left = 0, 1, 2, 0, 0x110
    with open('/dev/uinput', 'wb', buffering=0) as uinput:
        fcntl.ioctl(uinput, 0x40045564, ev_key)
        fcntl.ioctl(uinput, 0x40045564, ev_rel)
        fcntl.ioctl(uinput, 0x40045565, btn_left)
        fcntl.ioctl(uinput, 0x40045566, rel_x)
        fcntl.ioctl(uinput, 0x40045566, 1)
        setup = struct.pack('HHHH80sI', 0x06, 0x6375, 0x6d73, 1, b'cul-pen fixture mouse', 0)
        fcntl.ioctl(uinput, 0x405c5503, setup)
        fcntl.ioctl(uinput, 0x5501)
        try:
            time.sleep(1)
            for value in (1, -1):
                uinput.write(struct.pack('qqHHi', 0, 0, ev_rel, rel_x, value)
                             + struct.pack('qqHHi', 0, 0, ev_syn, 0, 0))
                time.sleep(.1)
            time.sleep(.3)
        finally:
            fcntl.ioctl(uinput, 0x5502)


def seat0_graphical_sessions():
    sessions = []
    listing = subprocess.run(['loginctl', 'list-sessions', '--no-legend'], capture_output=True, text=True).stdout
    for line in listing.splitlines():
        session = line.split()[0] if line.split() else None
        if not session:
            continue
        props = subprocess.run(['loginctl', 'show-session', session, '-p', 'Seat', '-p', 'Type', '-p', 'State'],
                               capture_output=True, text=True).stdout
        fields = dict(part.split('=', 1) for part in props.splitlines() if '=' in part)
        if fields.get('Seat') == 'seat0' and fields.get('Type') in ('wayland', 'x11', 'mir') \
                and fields.get('State') != 'closing':
            sessions.append(session)
    return sessions


def leftover_devices():
    text = Path('/proc/bus/input/devices').read_text()
    return [line for line in text.splitlines() if 'computer-use-linux virtual' in line]


def run(binary, root, tty):
    failures = []
    runtime = root / 'run'
    with contextlib.ExitStack() as cleanup:
        config = private_bus_config(root / 'bus.conf', runtime, services=['ca.desrt.dconf'])
        env = dict(os.environ, XDG_RUNTIME_DIR=str(runtime),
                   XDG_CONFIG_HOME=str(root / 'config'), XDG_DATA_HOME=str(root / 'data'),
                   XDG_CACHE_HOME=str(root / 'cache'), XDG_SESSION_TYPE='wayland', XDG_CURRENT_DESKTOP='GNOME',
                   WAYLAND_DISPLAY=DISPLAY_NAME, GDK_BACKEND='wayland', COMPUTER_USE_LINUX_INDICATOR='0', CODEX_COMPUTER_USE_INDICATOR='0',
                   AT_SPI_BUS_ADDRESS='unix:path=' + str(root / 'no-a11y'), NO_AT_BRIDGE='1')
        env.pop('DISPLAY', None)
        # The bus starts dconf-service, which writes settings under the
        # bus's own XDG_CONFIG_HOME: give it the fixture's.
        bus = subprocess.Popen(['dbus-daemon', '--config-file', str(config), '--nofork', '--print-address=1'],
                               stdout=subprocess.PIPE, text=True, env=env)
        cleanup.callback(stop, bus)
        env['DBUS_SESSION_BUS_ADDRESS'] = bus.stdout.readline().strip()
        for key in ('PIXELFLUX_CU', 'PIXELFLUX_CU_TOKEN', 'COMPUTER_USE_LINUX_DEVTOOLS', 'CODEX_COMPUTER_USE_DEVTOOLS', 'TMUX', 'STY'):
            env.pop(key, None)
        env['YDOTOOL_SOCKET'] = str(root / 'no-ydotool.sock')
        shutil.copytree(EXTENSION, root / 'data' / 'gnome-shell' / 'extensions' / UUID)
        gsettings = lambda *args: subprocess.run(['gsettings', *args], env=env, check=True)
        gsettings('set', 'org.gnome.shell', 'enabled-extensions', f"['{UUID}']")
        gsettings('set', 'org.gnome.shell', 'welcome-dialog-last-shown-version', '999')
        # mutter ignores vkms (its 61-mutter.rules) and takes every other KMS
        # device on the seat. This file of the same name masks that rule for
        # the run: mutter gets the vkms output only, so it renders and
        # captures on one device. udev keeps a device's tags until the device
        # goes away, so vkms is loaded after the rule, fresh.
        rule = Path('/run/udev/rules.d/61-mutter.rules')
        subprocess.run(['sudo', '-n', 'tee', str(rule)], input=UDEV_RULE, text=True, check=True,
                       stdout=subprocess.DEVNULL)
        subprocess.run(['sudo', '-n', 'modprobe', '-r', 'vkms'], capture_output=True)
        subprocess.run(['sudo', '-n', 'modprobe', 'vkms'], check=True)
        cleanup.callback(subprocess.run, ['sudo', '-n', 'modprobe', '-r', 'vkms'], capture_output=True)
        cleanup.callback(lambda: (subprocess.run(['sudo', '-n', 'rm', '-f', str(rule)]),
                                  subprocess.run(['sudo', '-n', 'udevadm', 'trigger', '-s', 'drm', '--settle'])))
        subprocess.run(['sudo', '-n', 'udevadm', 'trigger', '-s', 'drm', '--settle'], check=True)
        user = subprocess.run(['id', '-un'], capture_output=True, text=True, check=True).stdout.strip()
        subprocess.run(['sudo', '-n', 'setfacl', '-m', f'u:{user}:rw', '/dev/uinput'], check=True)
        cleanup.callback(subprocess.run, ['sudo', '-n', 'setfacl', '-x', f'u:{user}', '/dev/uinput'])
        launcher = root / 'shell.sh'
        exports = ' '.join(f"{key}='{env[key]}'" for key in (
            'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
            'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP'))
        launcher.write_text(f'#!/bin/bash\nexport {exports}\nexec gnome-shell --wayland --display-server '
                            f'--no-x11 --wayland-display={DISPLAY_NAME} > {root}/shell.log 2>&1\n')
        launcher.chmod(0o755)
        unit = f'cul-pen-shell-{os.getpid()}'
        subprocess.run(['sudo', '-n', 'systemd-run', '--quiet', f'--unit={unit}', '--collect', '-p', 'PAMName=login',
                        '-p', f'TTYPath=/dev/{tty}', '-p', 'StandardInput=tty-force', '-p', f'User={user}',
                        str(launcher)], check=True)
        cleanup.callback(subprocess.run, ['sudo', '-n', 'systemctl', 'stop', unit], capture_output=True)
        subprocess.run(['sudo', '-n', 'chvt', tty.removeprefix('tty')], check=True)
        wait_for(lambda: (runtime / DISPLAY_NAME).exists(), 'GNOME Shell wayland socket', 30)
        owner = ['gdbus', 'call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path',
                 '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.NameHasOwner',
                 'dev.avifenesh.ComputerUseLinux.WindowControl']
        wait_for(lambda: 'true' in subprocess.run(owner, env=env, capture_output=True, text=True).stdout,
                 'the GNOME Shell extension on the bus', 30)
        app = subprocess.Popen(['/usr/bin/python3', __file__, '--gtk', str(root)], env=dict(env, GTK_A11Y='none'),
                               stdout=(root / 'app.log').open('w'), stderr=subprocess.STDOUT)
        cleanup.callback(stop, app)
        geometry = json.loads(wait_for(lambda: (root / 'geometry.json').exists()
                                       and (root / 'geometry.json').read_text(), 'GTK window geometry', 20))
        server = Server(binary, env)
        cleanup.callback(server.close)
        windows = server.call('list_windows', {})
        target = next(w for w in windows['windows'] if w.get('title') == 'cul-pen-target')
        wid = target['window_id']
        check(failures, server.call('activate_window', dict(window_id=wid)).get('ok'), 'activate the GTK window')
        time.sleep(1)
        shot = server.call('screenshot', dict(max_width=64))
        check(failures, shot.get('coordinate_width'), f'screenshot: {json.dumps(shot)[:300]}')
        bounds = next(w for w in server.call('list_windows', {})['windows'] if w['window_id'] == wid)['bounds']
        origin = (bounds['x'], bounds['y'])
        print(f'window at {bounds}, geometry {geometry}', flush=True)
        px, py, pw, ph = geometry['pad']
        sx, sy, sw, sh = geometry['scroller']

        def at(local):
            return dict(x=int(origin[0] + local[0]), y=int(origin[1] + local[1]))
        user_point = (px + 40, py + 40)
        # The user's pointer, placed by a normal click through the uinput pointer.
        normal = server.call('click', dict(at(user_point), window_id=wid))
        check(failures, normal.get('ok'), f'normal click: {normal.get("message")}')
        time.sleep(.5)
        placed = events(root)
        check(failures, any(e['kind'] == 'press' and e['source'] == 'mouse' and near(e, user_point) for e in placed),
              f'normal click reached the window as a mouse press at {user_point}')
        print('pointer after the normal click', (root / 'pointer.json').read_text(), flush=True)
        pen_start = time.monotonic()

        def background(tool, **arguments):
            result = server.call(tool, dict(arguments, window_id=wid, delivery='background'))
            report = result.get('background') or {}
            check(failures, result.get('ok') and report.get('used') is True,
                  f'background {tool} {arguments}: {result.get("message")} {report}')
            return result

        def pen_presses(since, button, point):
            return [e for e in events(root, since) if e['kind'] == 'press' and e['source'] == 'pen'
                    and e.get('button') == button and near(e, point)]

        for button, code, offset in (('left', 1, 100), ('right', 3, 160), ('middle', 2, 220)):
            point = (px + offset, py + 120)
            since = time.monotonic()
            result = background('click', **at(point), button=button)
            check(failures, (result.get('background') or {}).get('route') == 'gnome-pen', f'{button} route: {result.get("background")}')
            time.sleep(.4)
            presses = pen_presses(since, code, point)
            check(failures, len(presses) == 1,
                  f'{button} click: one pen press with button {code} at {point}: {events(root, since)[:8]}')
            # libinput's 50 ms proximity timeout is off: the pen still hovers.
            check(failures, presses and not [e for e in events(root, presses[0]['t']) if e['kind'] == 'proximity-out'],
                  f'{button} click: the pen still hovers 0.4 s later')
        point = (px + 280, py + 120)
        since = time.monotonic()
        background('click', **at(point), click_count=2)
        time.sleep(.4)
        check(failures, len(pen_presses(since, 1, point)) == 2, f'double click: two pen presses at {point}')
        start, end = (px + 100, py + 200), (px + 300, py + 260)
        since = time.monotonic()
        result = background('drag', start_x=at(start)['x'], start_y=at(start)['y'], end_x=at(end)['x'], end_y=at(end)['y'])
        time.sleep(.4)
        seen = events(root, since)
        check(failures, any(e['kind'] == 'press' and e['source'] == 'pen' and near(e, start) for e in seen)
              and any(e['kind'] == 'release' and e['source'] == 'pen' and near(e, end) for e in seen)
              and sum(e['kind'] == 'motion' and e['source'] == 'pen' for e in seen) >= 5,
              f'drag: pen press at {start}, motion, release at {end}: {seen[:3]} ... {seen[-3:]}')
        point = (sx + sw // 2, sy + sh // 2)
        since = time.monotonic()
        result = background('scroll', **at(point), direction='down', pages=1)
        check(failures, (result.get('background') or {}).get('route') == 'gnome-touch', f'scroll route: {result.get("background")}')
        time.sleep(1)
        seen = events(root, since)
        scrolled = [e['value'] for e in seen if e['kind'] == 'scrolled']
        check(failures, any(e['kind'] == 'touch-begin' and e['source'] == 'touch' for e in seen)
              and scrolled and max(scrolled) > 100,
              f'scroll: touch pan moved the list down: {scrolled[-3:]}')
        # The user's pointer never moved: no mouse event after the pen began,
        # and GTK still has it where the normal click left it.
        mouse = [e for e in events(root, pen_start) if e.get('source') == 'mouse']
        check(failures, not mouse, f'no mouse events during pen input: {mouse[:5]}')
        # Where the user's pointer is: nudge it one unit with a relative
        # mouse, as the user would, and read where it shows up.
        since = time.monotonic()
        nudge_mouse()
        moved = wait_for(lambda: [e for e in events(root, since) if e.get('source') == 'mouse' and e['kind'] == 'motion'],
                         'the nudged mouse', 5)
        check(failures, near(moved[0], user_point, slack=4), f'user pointer still at {user_point}: {moved[0]}')
        # A point under another window is refused before any input.
        cover = subprocess.Popen(['/usr/bin/python3', '-c', COVER], env=env)
        cleanup.callback(stop, cover)
        time.sleep(2)
        since = time.monotonic()
        refused = server.call('click', dict(at((px + 60, py + 60)), window_id=wid, delivery='background'))
        check(failures, refused.get('ok') is False and 'stacked above' in refused.get('message', ''),
              f'covered point refused: {refused.get("message")}')
        stop(cover)
        time.sleep(.5)
        check(failures, not [e for e in events(root, since) if e['kind'] == 'press'], 'refused click sent no press')
        # Hover: the pen leaves proximity HOVER seconds after its last action.
        last = time.monotonic()
        background('click', **at((px + 120, py + 300)))
        press = wait_for(lambda: [e for e in events(root, last) if e['kind'] == 'press'], 'hover click press', 5)[0]['t']
        out = wait_for(lambda: [e for e in events(root, press) if e['kind'] == 'proximity-out'], 'pen proximity out', HOVER + 6)
        hover = out[0]['t'] - press
        print(f'pen hovered {hover:.1f} s', flush=True)
        check(failures, HOVER - 1 <= hover <= HOVER + 3, f'hover ended after {hover:.1f} s')
        # An app without tablet support: wev logs every pointer and touch event.
        if shutil.which('wev'):
            wev = subprocess.Popen(['wev'], env=env, stdout=(root / 'wev.log').open('w'), stderr=subprocess.STDOUT)
            cleanup.callback(stop, wev)
            time.sleep(2)
            listing = server.call('list_windows', {})
            wev_window = next((w for w in listing['windows'] if (w.get('app_id') or '').endswith('wev')
                               or (w.get('title') or '') == 'wev'), None)
            if wev_window and wev_window.get('bounds'):
                b = wev_window['bounds']
                result = server.call('click', dict(x=b['x'] + b['width'] // 2, y=b['y'] + b['height'] // 2,
                                                   window_id=wev_window['window_id'], delivery='background'))
                time.sleep(1)
                text = (root / 'wev.log').read_text()
                print(f'wev after a pen click: ok={result.get("ok")} pointer button lines='
                      f'{text.count("[wl_pointer] button")} tablet lines={text.count("tablet")}', flush=True)
        server.close()
        time.sleep(.5)
        check(failures, not leftover_devices(), f'no virtual device after exit: {leftover_devices()}')
        dump = subprocess.run(['dconf', 'dump', '/org/gnome/desktop/peripherals/'], env=env,
                              capture_output=True, text=True).stdout
        check(failures, 'tablets' not in dump and 'touchscreens' not in dump, f'no tablet or touch setting left: {dump}')
    return failures


UDEV_RULE = 'SUBSYSTEM=="drm", KERNEL=="card[0-9]*", ENV{ID_PATH}!="platform-vkms", TAG+="mutter-device-ignore"\n'

COVER = """
import os
os.environ['GTK_A11Y'] = 'none'
import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk
app = Gtk.Application(application_id='dev.avifenesh.CulPenCover')
def activate(app):
    window = Gtk.ApplicationWindow(application=app, title='cul-pen-cover')
    window.set_default_size(300, 300)
    window.present()
app.connect('activate', activate)
app.run([])
"""


def main():
    binary = str(Path(sys.argv[1]).resolve())
    tty = os.environ.get('COMPUTER_USE_LINUX_TEST_GNOME_SEAT')
    if not tty:
        print('SKIP gnome pen: set COMPUTER_USE_LINUX_TEST_GNOME_SEAT to a free virtual terminal (tty6) on a machine with no desktop session')
        return
    missing = [tool for tool in ('gnome-shell', 'gsettings', 'dconf', 'setfacl', 'sudo') if not shutil.which(tool)]
    if missing:
        sys.exit(f'gnome pen fixture: missing {missing}')
    if subprocess.run(['sudo', '-n', 'true'], capture_output=True).returncode != 0:
        sys.exit('gnome pen fixture: needs passwordless sudo')
    busy = seat0_graphical_sessions()
    if busy:
        sys.exit(f'gnome pen fixture: seat0 has graphical sessions {busy}; uinput input would reach them')
    cache = Path(os.environ.get('XDG_CACHE_HOME', Path.home() / '.cache'))
    cache.mkdir(parents=True, exist_ok=True)
    with socket_tempdir('cul-pen-', [f'run/{INDICATOR_SOCKET}', f'run/{DISPLAY_NAME}'], bus_dir='run', dir=cache) as directory:
        root = Path(directory)
        (root / 'run').mkdir(mode=0o700)
        try:
            failures = run(binary, root, tty)
        finally:
            keep = os.environ.get('CUL_PEN_TEST_KEEP_LOGS')
            if keep:
                Path(keep).mkdir(parents=True, exist_ok=True)
                for name in ('shell.log', 'app.log', 'events.jsonl', 'wev.log'):
                    if (root / name).exists():
                        shutil.copy(root / name, Path(keep) / name)
    if failures:
        sys.exit(f'{len(failures)} gnome pen check(s) failed')
    print('gnome pen: all checks passed', flush=True)


if __name__ == '__main__':
    if sys.argv[1] == '--gtk':
        gtk_app(Path(sys.argv[2]))
    else:
        main()

#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""delivery="background" pointer input through the GNOME virtual pen, against
a real GNOME Shell on a real seat.

GNOME Shell runs as the display server of seat0 on the virtual terminal
COMPUTER_USE_LINUX_TEST_GNOME_SEAT names (for example tty6), on a vkms
output, with libinput reading the seat's devices: a headless mutter reads
none, so it never sees a uinput device. The fixture needs passwordless sudo
for that (modprobe vkms, an ACL on /dev/uinput, a login session on the
terminal, its getty masked for the run, chvt), and refuses to run while any graphical session is on seat0:
uinput devices are machine-wide, so this must never run on a desktop someone
uses. Without the variable it skips.

A fullscreen GTK 4 window logs every event with its device's source. A
normal click first puts the user's pointer on the window through the uinput
pointer. Then background clicks (left, right, middle, double), a drag and a
scroll go through the pen and the touchscreen: the window sees pen and touch
events at the points, and no mouse event, so the user's pointer stays where
the normal click left it. A point under another window is refused before
input. The session's schemas carry GNOME 48's stylus defaults, which swap the
barrel buttons, and a right click must still be a right click, also after a
second server's pen came and went (they share one settings path). The pen
leaves proximity right after each action, and a scroll right after a pen
click must still pan (libinput drops touches while a paired pen is near).
When Chromium or Google Chrome is installed, the same clicks, a double
click, a drag and a scroll go to a page in it, native Wayland and under
Xwayland, which must see pen and touch input with the buttons named. After
the server exits no virtual device and no tablet, stylus or touchscreen
setting is left behind. wev, which binds no tablet, shows what an app
without tablet support sees of a pen click.
"""
import contextlib
import json
import os
import re
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


def unload_vkms(timeout=10):
    """Removes vkms, retrying while its last user lets go; whether it is gone."""
    deadline = time.monotonic() + timeout
    while True:
        subprocess.run(['sudo', '-n', 'modprobe', '-r', 'vkms'], capture_output=True)
        if not Path('/sys/module/vkms').exists():
            return True
        if time.monotonic() > deadline:
            return False
        time.sleep(.5)


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
        # udevd notices new rules through inotify, which a bind mount of
        # /run/udev (the KWin fixture's container) can leave deaf.
        subprocess.run(['sudo', '-n', 'udevadm', 'control', '--reload'], check=True)
        if not unload_vkms():
            sys.exit('gnome pen fixture: vkms is loaded and in use, so it cannot be reloaded under the rule')
        subprocess.run(['sudo', '-n', 'modprobe', 'vkms'], check=True)
        cleanup.callback(unload_vkms)
        cleanup.callback(lambda: (subprocess.run(['sudo', '-n', 'rm', '-f', str(rule)]),
                                  subprocess.run(['sudo', '-n', 'udevadm', 'control', '--reload']),
                                  subprocess.run(['sudo', '-n', 'udevadm', 'trigger', '-s', 'drm', '--settle'])))
        subprocess.run(['sudo', '-n', 'udevadm', 'trigger', '-s', 'drm', '--settle'], check=True)
        user = subprocess.run(['id', '-un'], capture_output=True, text=True, check=True).stdout.strip()
        subprocess.run(['sudo', '-n', 'setfacl', '-m', f'u:{user}:rw', '/dev/uinput'], check=True)
        cleanup.callback(subprocess.run, ['sudo', '-n', 'setfacl', '-x', f'u:{user}', '/dev/uinput'])
        # Without --no-x11 mutter listens for X clients and starts Xwayland
        # for the first one: the Chromium check runs under it too.
        xwayland = shutil.which('Xwayland')
        # GNOME 48's stylus defaults (gsettings-desktop-schemas f25d3e7c) as
        # schema overrides: the lower button a right click, the upper one a
        # middle click. GNOME 46 passes the codes through.
        schemas = root / 'schemas'
        schemas.mkdir()
        for source in Path('/usr/share/glib-2.0/schemas').iterdir():
            if source.suffix in ('.xml', '.override'):
                shutil.copy(source, schemas / source.name)
        (schemas / 'zz_cul-gnome48-stylus.gschema.override').write_text(
            "[org.gnome.desktop.peripherals.tablet.stylus]\nbutton-action='right'\nsecondary-button-action='middle'\n")
        subprocess.run(['glib-compile-schemas', str(schemas)], check=True)
        env['GSETTINGS_SCHEMA_DIR'] = str(schemas)
        launcher = root / 'shell.sh'
        exports = ' '.join(f"{key}='{env[key]}'" for key in (
            'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
            'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP', 'GSETTINGS_SCHEMA_DIR'))
        launcher.write_text(f'#!/bin/bash\nexport {exports}\nexec gnome-shell --wayland --display-server '
                            f'{"" if xwayland else "--no-x11 "}--wayland-display={DISPLAY_NAME} > {root}/shell.log 2>&1\n')
        launcher.chmod(0o755)
        # logind starts a getty on the active terminal when no session holds
        # it (autovt), and one left from an earlier run takes the terminal
        # back and hangs up the shell's session. Masked until the end of the
        # run (--runtime: nothing survives a reboot either).
        gettys = [f'getty@{tty}.service', f'autovt@{tty}.service']
        subprocess.run(['sudo', '-n', 'systemctl', 'mask', '--runtime', '--now', *gettys], capture_output=True)
        cleanup.callback(subprocess.run, ['sudo', '-n', 'systemctl', 'unmask', '--runtime', *gettys],
                         capture_output=True)
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
        x_display = None
        if xwayland:
            # mutter names the display it took: "Using public X11 display :0".
            x_display = wait_for(lambda: (re.search(r'public X11 display (:\d+)', (root / 'shell.log').read_text())
                                          or [None, None])[1], 'the Xwayland display', 20)
            # mutter writes the X authority it gives Xwayland's clients into
            # its runtime directory.
            x_authority = wait_for(lambda: sorted(runtime.glob('.mutter-Xwaylandauth.*')), 'the Xwayland authority', 20)[0]
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
            # The pen leaves proximity after the action.
            check(failures, presses and [e for e in events(root, presses[0]['t']) if e['kind'] == 'proximity-out'],
                  f'{button} click: the pen left proximity after it')
            if button == 'left':
                # A second server's pen comes and goes; its reset of the
                # shared stylus settings must not swap this server's buttons.
                other = Server(binary, env)
                theirs = other.call('click', dict(at((px + 40, py + 500)), window_id=wid, delivery='background'))
                check(failures, theirs.get('ok') and (theirs.get('background') or {}).get('used') is True,
                      f'a second server clicks through its own pen: {theirs.get("message")}')
                other.close()
                time.sleep(.5)
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
        # libinput drops touches while a paired pen is in proximity and for
        # 90 ms after: a scroll right after a pen click must still pan.
        background('click', **at((px + 200, py + 400)))
        before = max(scrolled) if scrolled else 0
        since = time.monotonic()
        background('scroll', **at(point), direction='down', pages=1)
        time.sleep(1)
        seen = events(root, since)
        scrolled = [e['value'] for e in seen if e['kind'] == 'scrolled']
        check(failures, any(e['kind'] == 'touch-begin' and e['source'] == 'touch' for e in seen)
              and scrolled and max(scrolled) > before + 100,
              f'scroll after a pen click: touch pan moved the list further: {scrolled[-3:]}')
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
        # The pen leaves proximity right after the release.
        last = time.monotonic()
        background('click', **at((px + 120, py + 300)))
        press = wait_for(lambda: [e for e in events(root, last) if e['kind'] == 'press'], 'click press', 5)[0]['t']
        out = wait_for(lambda: [e for e in events(root, press) if e['kind'] == 'proximity-out'], 'pen proximity out', 3)
        print(f'pen left proximity {out[0]["t"] - press:.2f} s after the press', flush=True)
        check(failures, out[0]['t'] - press < .5, f'pen left proximity {out[0]["t"] - press:.2f} s after the press')
        chrome = chrome_binary()
        if chrome:
            logger = chrome_logger(root)
            cleanup.callback(logger.shutdown)
            for platform in ('wayland', 'x11'):
                if platform == 'x11' and not x_display:
                    print('SKIP chrome x11: no Xwayland', flush=True)
                    continue
                chrome_checks(failures, server, root, dict(env, DISPLAY=x_display, XAUTHORITY=str(x_authority)) if x_display else env,
                              chrome, platform, logger.server_address[1], cleanup)
        else:
            print('SKIP chrome: no chromium or google-chrome', flush=True)
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
        check(failures, 'tablets' not in dump and 'touchscreens' not in dump and 'stylus' not in dump,
              f'no tablet, stylus or touch setting left: {dump}')
    return failures

CHROME_PAGE = """<!doctype html><title>cul-pen-chrome</title>
<style>html,body{margin:0;height:100%;overflow:hidden;font:14px sans-serif;user-select:none}
#pad{position:absolute;left:0;top:0;width:60%;height:100%;background:#ddd}
#list{position:absolute;right:0;top:0;width:40%;height:100%;overflow-y:scroll}</style>
<div id=pad></div><div id=list></div>
<script>
const list = document.getElementById('list');
for (let i = 0; i < 300; i++) { const row = document.createElement('div'); row.textContent = 'row ' + i; row.style.height = '24px'; list.appendChild(row); }
const send = entry => fetch('/log', {method: 'POST', body: JSON.stringify(entry), keepalive: true});
const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
for (const kind of ['pointerdown', 'pointerup', 'click', 'auxclick', 'contextmenu', 'dblclick', 'pointermove']) {
  addEventListener(kind, event => {
    if (kind === 'pointermove' && !event.buttons && event.pointerType !== 'pen') return;
    send({kind, type: event.pointerType || null, button: event.button, buttons: event.buttons,
          x: event.clientX, y: event.clientY, target: event.target.id});
    if (kind === 'contextmenu') event.preventDefault();
  }, true);
}
for (const kind of ['touchstart', 'touchend', 'wheel']) addEventListener(kind, event => send({kind, target: event.target.id}), {capture: true, passive: true});
list.addEventListener('scroll', () => send({kind: 'scrolled', value: list.scrollTop}));
addEventListener('load', () => send({kind: 'ready', pad: rect('pad'), list: rect('list')}));
</script>"""


def chrome_binary():
    return next((path for path in (shutil.which(name) for name in ('chromium', 'chromium-browser', 'google-chrome'))
                 if path), None)


def chrome_logger(root):
    """Serves the page and appends what it posts to chrome.jsonl."""
    import http.server
    import threading
    log = (root / 'chrome.jsonl').open('a', buffering=1)

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = CHROME_PAGE.encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            entry = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            entry['t'] = time.monotonic()
            log.write(json.dumps(entry) + '\n')
            self.send_response(204)
            self.end_headers()

        def log_message(self, *_):
            pass
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def chrome_events(root, since=0.0):
    path = root / 'chrome.jsonl'
    if not path.exists():
        return []
    return [entry for entry in (json.loads(line) for line in path.read_text().splitlines() if line.strip())
            if entry['t'] >= since]


def chrome_checks(failures, server, root, env, chrome, platform, port, cleanup):
    """Background clicks, a drag and a scroll on Chromium, native Wayland or
    under Xwayland: each must reach the page as the pen or touch input it is,
    with the button the call named."""
    name = f'chrome {platform}'
    profile = root / f'chrome-{platform}'
    chrome_env = dict(env)
    if platform == 'x11':
        chrome_env.pop('WAYLAND_DISPLAY', None)
    process = subprocess.Popen([chrome, f'--user-data-dir={profile}', '--no-first-run', '--no-default-browser-check',
                                '--password-store=basic', '--disable-gpu', f'--ozone-platform={platform}',
                                '--window-size=1000,700', f'--app=http://127.0.0.1:{port}/?{platform}'],
                               env=chrome_env, stdout=(root / f'chrome-{platform}.log').open('w'),
                               stderr=subprocess.STDOUT)
    cleanup.callback(stop, process)
    started = time.monotonic()
    ready = wait_for(lambda: [e for e in chrome_events(root, started) if e['kind'] == 'ready'], f'{name} page', 40)[-1]
    window = wait_for(lambda: next((w for w in server.call('list_windows', {})['windows']
                                    if w.get('title') == 'cul-pen-chrome'), None), f'{name} window', 20)
    wid = window['window_id']
    check(failures, server.call('activate_window', dict(window_id=wid)).get('ok'), f'{name}: activate')
    time.sleep(1.5)
    bounds = next(w for w in server.call('list_windows', {})['windows'] if w['window_id'] == wid)['bounds']
    print(f'{name} window {window.get("app_id")} at {bounds}, page {ready}', flush=True)
    pad, scroller = ready['pad'], ready['list']
    # The page's client area ends at the window's bottom right, inside any
    # frame; the first click calibrates the exact offset.
    guess = (bounds['x'] + bounds['width'] - (pad[2] + scroller[2]), bounds['y'] + bounds['height'] - pad[3])

    def screen(local, offset):
        return dict(x=int(offset[0] + local[0]), y=int(offset[1] + local[1]))

    def call(tool, **arguments):
        result = server.call(tool, dict(arguments, window_id=wid, delivery='background'))
        report = result.get('background') or {}
        check(failures, result.get('ok') and report.get('used') is True,
              f'{name} background {tool} {arguments}: {result.get("message")} {report}')
        return result

    def seen(since, kind, **match):
        return [e for e in chrome_events(root, since) if e['kind'] == kind
                and all(e.get(key) == value for key, value in match.items())]
    since = time.monotonic()
    point = (pad[0] + 150, pad[1] + 150)
    result = call('click', **screen(point, guess))
    check(failures, (result.get('background') or {}).get('route') == 'gnome-pen', f'{name} left route: {result.get("background")}')
    clicks = wait_for(lambda: seen(since, 'click'), f'{name} left click', 5)
    downs = seen(since, 'pointerdown')
    print(f'{name} left click: {downs} {clicks}', flush=True)
    offset = (guess[0] + point[0] - clicks[0]['x'], guess[1] + point[1] - clicks[0]['y'])
    check(failures, downs and downs[0]['button'] == 0 and downs[0]['type'] == 'pen',
          f'{name} left click: a pen pointerdown with button 0: {downs}')

    def near_page(entry, local, slack=3):
        return abs(entry['x'] - local[0]) <= slack and abs(entry['y'] - local[1]) <= slack
    for button, dom_button, kind, offset_x in (('right', 2, 'contextmenu', 250), ('middle', 1, 'auxclick', 350)):
        point = (pad[0] + offset_x, pad[1] + 150)
        since = time.monotonic()
        call('click', **screen(point, offset), button=button)
        time.sleep(.6)
        downs = seen(since, 'pointerdown')
        check(failures, len(downs) == 1 and downs[0]['button'] == dom_button and downs[0]['type'] == 'pen'
              and near_page(downs[0], point) and seen(since, kind),
              f'{name} {button} click: one pen pointerdown with button {dom_button} at {point} and a {kind}: '
              f'{chrome_events(root, since)[:6]}')
        if button == 'right':
            check(failures, not seen(since, 'auxclick', button=1), f'{name} right click is not a middle click')
    point = (pad[0] + 150, pad[1] + 300)
    since = time.monotonic()
    call('click', **screen(point, offset), click_count=2)
    time.sleep(.8)
    check(failures, len(seen(since, 'pointerdown', button=0)) == 2 and seen(since, 'dblclick'),
          f'{name} double click: two pointerdowns and a dblclick: {chrome_events(root, since)[:8]}')
    start, end = (pad[0] + 100, pad[1] + 400), (pad[0] + 300, pad[1] + 480)
    since = time.monotonic()
    call('drag', start_x=screen(start, offset)['x'], start_y=screen(start, offset)['y'],
         end_x=screen(end, offset)['x'], end_y=screen(end, offset)['y'])
    time.sleep(.6)
    downs, ups = seen(since, 'pointerdown'), seen(since, 'pointerup')
    moves = [e for e in seen(since, 'pointermove') if e['buttons'] == 1]
    check(failures, downs and near_page(downs[0], start) and ups and near_page(ups[-1], end) and len(moves) >= 5
          and all(e['type'] == 'pen' for e in downs + ups + moves),
          f'{name} drag: pen down at {start}, {len(moves)} moves, up at {end}: {downs[:1]} {ups[-1:]}')
    point = (scroller[0] + scroller[2] / 2, scroller[1] + scroller[3] / 2)
    since = time.monotonic()
    result = call('scroll', **screen(point, offset), direction='down', pages=1)
    check(failures, (result.get('background') or {}).get('route') == 'gnome-touch', f'{name} scroll route: {result.get("background")}')
    time.sleep(1.2)
    scrolled = [e['value'] for e in seen(since, 'scrolled')]
    check(failures, scrolled and max(scrolled) > 100, f'{name} scroll: the list scrolled down: {scrolled[-3:]}')
    mouse = [e for e in chrome_events(root, started) if e.get('type') == 'mouse' and e['kind'] != 'pointermove']
    check(failures, not mouse, f'{name}: no mouse button events: {mouse[:4]}')
    stop(process)


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
                for name in ('shell.log', 'app.log', 'events.jsonl', 'wev.log', 'chrome.jsonl',
                             'chrome-wayland.log', 'chrome-x11.log'):
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

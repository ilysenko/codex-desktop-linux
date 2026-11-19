#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""delivery="background" through the agent seat, against real display servers.

x11: a private Xvfb with openbox, two xterms and a GTK 3 window. The agent
types into one xterm and the GTK entry while the user's focused xterm keeps
its focus and its own typing. Alt+F4, which openbox grabs, has no agent-seat
route: the first such call sends nothing and returns the one-time notice,
the repeated call closes the window through normal focused input, and a
later background click under openbox goes through the user's pointer
without the notice. After openbox exits, the agent pointer presses a GTK
button.
A server killed with SIGKILL leaves its XInput master behind, and the next
server removes it; a server that exits normally removes its own.

sway: a headless sway (WLR_BACKENDS=headless) with two foot terminals and a
GTK 3 window. The agent types into one foot through a transient seat while
seat0 keeps its focus and the user's typing. A GTK client has no agent-seat
route (GTK never binds a seat added after it starts): the first call gets the
notice and sends nothing, the repeated call types through seat0, and so do
later calls with no route, without the notice. The transient seat is gone
after the server exits. Needs sway 1.10 or later; COMPUTER_USE_LINUX_TEST_SWAY
may name a command that runs sway (for example in a container) with the same
XDG_RUNTIME_DIR path and pid namespace. Clients run in this process's
namespaces either way.

Missing tools skip the x11 fixture outside CI and fail it in CI. The sway
fixture skips when no sway 1.10 or later is available.
"""
import contextlib
import json
import os
from pathlib import Path
import re
import select
import shutil
import signal
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from socket_fixture import INDICATOR_SOCKET, private_bus_config, socket_tempdir

SWAY = os.environ.get('COMPUTER_USE_LINUX_TEST_SWAY', 'sway')


def wait_for(probe, what, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = probe()
        if value:
            return value
        time.sleep(.05)
    raise TimeoutError(what)


def stop(proc):
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


def gtk_app(root, toolkit_title):
    import gi
    gi.require_version('Gtk', '3.0')
    from gi.repository import GLib, Gtk
    window = Gtk.Window(title=toolkit_title)
    window.set_default_size(400, 200)
    box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
    entry = Gtk.Entry()
    entry.connect('changed', lambda e: (root / 'gtk-entry').write_text(e.get_text()))
    button = Gtk.Button(label='Agent button')
    button.set_size_request(200, 80)
    def clicked(_button):
        with (root / 'gtk-clicked').open('a') as log:
            log.write('clicked\n')
    button.connect('clicked', clicked)
    box.pack_start(entry, False, False, 0)
    box.pack_start(button, False, False, 0)
    window.add(box)
    window.show_all()
    def ready():
        alloc = button.get_allocation()
        gdk_window = button.get_window()
        if gdk_window is None:
            return True
        _, x, y = gdk_window.get_origin()
        center = [x + alloc.x + alloc.width // 2, y + alloc.y + alloc.height // 2]
        (root / 'gtk-button').write_text(json.dumps(center))
        return False
    GLib.timeout_add(300, ready)
    Gtk.main()


class Server:
    def __init__(self, binary, env):
        self.proc = subprocess.Popen([binary, 'mcp'], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, text=True)
        self.ident = 0
        self.rpc('initialize', dict(protocolVersion='2025-06-18', capabilities={},
                                    clientInfo=dict(name='agent-seat-test', version='1')))
        self.proc.stdin.write(json.dumps(dict(jsonrpc='2.0', method='notifications/initialized')) + '\n')
        self.proc.stdin.flush()

    def rpc(self, method, params):
        self.ident += 1
        self.proc.stdin.write(json.dumps(dict(jsonrpc='2.0', id=self.ident, method=method, params=params)) + '\n')
        self.proc.stdin.flush()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if select.select([self.proc.stdout], [], [], .1)[0]:
                line = self.proc.stdout.readline()
                if not line:
                    raise RuntimeError('MCP exited')
                response = json.loads(line)
                if response.get('id') == self.ident:
                    assert 'error' not in response, response
                    return response['result']
        raise TimeoutError(method)

    def call(self, name, arguments):
        result = self.rpc('tools/call', dict(name=name, arguments=arguments))
        structured = result.get('structuredContent')
        if structured is None:
            text = ''.join(block.get('text', '') for block in result.get('content', []))
            try:
                structured = json.loads(text)
            except ValueError:
                structured = dict(ok=not result.get('isError'), message=text)
        if os.environ.get('CUL_SEAT_TEST_VERBOSE'):
            print('RESULT', name, json.dumps(structured)[:600], flush=True)
        return structured

    def close(self):
        self.proc.stdin.close()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=5)


def notice(result):
    """The one-time notice: nothing sent, the reason, and how to continue."""
    background = result.get('background') or {}
    return (result.get('ok') is False and background.get('delivered') is False
            and background.get('retry_to_continue') is True and background.get('used') is False
            and 'agent-workspace-linux' in result.get('message', '') and 'repeat the call' in result.get('message', ''))


def focused_fallback(result):
    """Delivered through normal focused input, reported without the notice."""
    return (result.get('ok') is True and result.get('background') == {'requested': True, 'used': False}
            and 'agent-workspace-linux' not in result.get('message', ''))


def scrub(env, root):
    """No route to the host's input: a fallback to focused input must land
    on the private display only."""
    for key in ('PIXELFLUX_CU', 'PIXELFLUX_CU_TOKEN', 'COMPUTER_USE_LINUX_HYPRLAND_BACKGROUND', 'CODEX_COMPUTER_USE_HYPRLAND_BACKGROUND',
                'COMPUTER_USE_LINUX_DEVTOOLS', 'CODEX_COMPUTER_USE_DEVTOOLS', 'KITTY_LISTEN_ON', 'WEZTERM_UNIX_SOCKET', 'TMUX', 'STY'):
        env.pop(key, None)
    env.update(YDOTOOL_SOCKET=str(root / 'no-ydotool.sock'), CU_DISABLE_ABS_POINTER='1')
    return env


def check(failures, condition, message):
    if not condition:
        failures.append(message)
        print('FAIL', message, flush=True)


def read(path):
    return path.read_text() if path.exists() else None


def settled(path, expected, timeout=5):
    """The file's text once it equals expected, or its last text at timeout."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and read(path) != expected:
        time.sleep(.05)
    return read(path)


def xvfb(cleanup):
    read_fd, write_fd = os.pipe()
    proc = subprocess.Popen(['Xvfb', '-displayfd', str(write_fd), '-screen', '0', '1280x800x24', '-nolisten', 'tcp'],
                            pass_fds=(write_fd,), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    cleanup.callback(stop, proc)
    os.close(write_fd)
    try:
        assert select.select([read_fd], [], [], 10)[0], 'Xvfb startup timed out'
        return ':' + os.read(read_fd, 64).decode().strip()
    finally:
        os.close(read_fd)


def run_x11(binary, root):
    failures = []
    with contextlib.ExitStack() as cleanup:
        env = dict(os.environ, XDG_SESSION_TYPE='x11', XDG_CURRENT_DESKTOP='openbox', GDK_BACKEND='x11',
                   COMPUTER_USE_LINUX_INDICATOR='0', AT_SPI_BUS_ADDRESS='unix:path=' + str(root / 'no-a11y'))
        for key in ('WAYLAND_DISPLAY', 'WAYLAND_SOCKET', 'SWAYSOCK', 'HYPRLAND_INSTANCE_SIGNATURE', 'NIRI_SOCKET'):
            env.pop(key, None)
        scrub(env, root)
        env['DISPLAY'] = xvfb(cleanup)
        def spawn(*args):
            proc = subprocess.Popen(list(args), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            cleanup.callback(stop, proc)
            return proc
        def out(*args):
            return subprocess.run(list(args), env=env, capture_output=True, text=True, timeout=10).stdout
        openbox = spawn('openbox')
        wait_for(lambda: '_NET_SUPPORTING_WM_CHECK(WINDOW)' in out('xprop', '-root', '_NET_SUPPORTING_WM_CHECK'), 'openbox')
        user_file, agent_file = root / 'user.txt', root / 'agent.txt'
        spawn('xterm', '-T', 'userterm', '-geometry', '60x10+0+0', '-e', 'sh', '-c', 'stty -echo; exec cat > ' + str(user_file))
        spawn('xterm', '-T', 'agentterm', '-geometry', '60x10+640+0', '-e', 'sh', '-c', 'stty -echo; exec cat > ' + str(agent_file))
        close_file = root / 'close.txt'
        spawn('xterm', '-T', 'closeterm', '-geometry', '30x5+0+600', '-e', 'sh', '-c', 'stty -echo; exec cat > ' + str(close_file))
        spawn('/usr/bin/python3', __file__, '--gtk', str(root), 'CUL seat fixture')
        user = wait_for(lambda: out('xdotool', 'search', '--name', '^userterm$').split(), 'userterm')[0]
        wait_for(lambda: out('xdotool', 'search', '--name', '^agentterm$').split(), 'agentterm')
        wait_for(lambda: out('xdotool', 'search', '--name', '^closeterm$').split(), 'closeterm')
        wait_for(lambda: (root / 'gtk-button').exists(), 'GTK fixture')
        out('xdotool', 'windowactivate', '--sync', user)
        out('xdotool', 'type', 'user1\n')
        focus = lambda: out('xdotool', 'getwindowfocus').strip()
        user_focus = focus()
        def masters():
            # (name, device id): X reuses a dead client's resource ids, so a
            # new master can carry the old name; the device id tells them apart.
            found = []
            for line in out('xinput', 'list', '--short').splitlines():
                match = re.search(r'(codex-computer-use-linux agent [0-9a-f]+ pointer)\s+id=(\d+)\s+\[master', line)
                if match:
                    found.append((match.group(1), int(match.group(2))))
            return found

        server = Server(binary, env)
        doctor = server.call('doctor', {})
        capabilities = json.dumps(doctor)
        check(failures, '"seat"' in capabilities and 'x11-master' in capabilities, 'doctor reports the x11-master seat route')
        result = server.call('type_text', dict(text='Agent!x\n', delivery='background', title='agentterm'))
        check(failures, result.get('ok') is True, f'type_text into the agent xterm: {result}')
        # Ctrl+U erases the pending line in the terminal, so the chord must
        # arrive with Control held, not as a plain u.
        result = server.call('type_text', dict(text='zzz', delivery='background', title='agentterm'))
        check(failures, result.get('ok') is True, f'type_text zzz: {result}')
        result = server.call('press_key', dict(key='Ctrl+u', delivery='background', title='agentterm'))
        check(failures, result.get('ok') is True, f'press_key Ctrl+u: {result}')
        result = server.call('type_text', dict(text='line', delivery='background', title='agentterm'))
        check(failures, result.get('ok') is True, f'type_text line: {result}')
        result = server.call('press_key', dict(key='Enter', delivery='background', title='agentterm'))
        check(failures, result.get('ok') is True, f'press_key Enter: {result}')
        # openbox grabs Alt+F4 on the root window, so the agent seat has no
        # route for it. The first such call in the session sends nothing.
        result = server.call('press_key', dict(key='Alt+F4', delivery='background', title='closeterm'))
        check(failures, notice(result) and 'grabbed' in result['background'].get('reason', ''), f'the first call with no route is the notice: {result}')
        time.sleep(.5)
        check(failures, out('xdotool', 'search', '--name', '^closeterm$').strip() != '', 'the notice closed nothing')
        check(failures, focus() == user_focus, 'the notice left the user focus alone')
        result = server.call('type_text', dict(text='Gtk ok', delivery='background', title='CUL seat fixture'))
        check(failures, result.get('ok') is True, f'type_text into the GTK entry: {result}')
        check(failures, len(masters()) == 1, f'one agent master while the seat is in use: {masters()}')
        out('xdotool', 'type', 'user2\n')
        check(failures, focus() == user_focus, 'the user keeps keyboard focus')
        check(failures, settled(user_file, 'user1\nuser2\n') == 'user1\nuser2\n', f'user text intact: {read(user_file)!r}')
        check(failures, settled(agent_file, 'Agent!x\nline\n') == 'Agent!x\nline\n', f'agent text in the agent xterm: {read(agent_file)!r}')
        check(failures, settled(root / 'gtk-entry', 'Gtk ok') == 'Gtk ok', f'agent text in the GTK entry: {read(root / "gtk-entry")!r}')

        # Repeating the call delivers it through normal focused input:
        # openbox closes the window.
        result = server.call('press_key', dict(key='Alt+F4', delivery='background', title='closeterm'))
        check(failures, focused_fallback(result), f'the repeated call goes through focused input: {result}')
        check(failures, wait_for(lambda: out('xdotool', 'search', '--name', '^closeterm$').strip() == '', 'closeterm closed', 5), 'Alt+F4 reached closeterm')
        for name in ('userterm', 'agentterm'):
            check(failures, out('xdotool', 'search', '--name', f'^{name}$').strip() != '', f'Alt+F4 closed only its target; {name} is open')
        # Later calls with no route deliver without the notice: a background
        # click under a window manager raises and focuses the target, then
        # clicks with the user's pointer.
        agent_window = out('xdotool', 'search', '--name', '^agentterm$').split()[0]
        geometry = dict(line.split('=', 1) for line in out('xdotool', 'getwindowgeometry', '--shell', agent_window).split())
        result = server.call('click', dict(x=int(geometry['X']) + 20, y=int(geometry['Y']) + 20, delivery='background', window_title='agentterm'))
        check(failures, focused_fallback(result), f'a background click under openbox goes through the user pointer: {result}')
        check(failures, focus() == agent_window, f'the focused click focused the agent xterm: {focus()} != {agent_window}')

        chrome_binary = shutil.which('google-chrome') or shutil.which('chromium')
        if chrome_binary:
            # Chrome reads X11 keys through XInput 2 and honors the agent focus.
            page = "data:text/html,<title>chrome-start</title><textarea autofocus oninput='document.title=this.value'></textarea>"
            chrome_proc = spawn(chrome_binary, f'--user-data-dir={root / "chrome"}', '--no-first-run',
                                '--no-default-browser-check', '--disable-gpu', f'--app={page}')
            chrome = wait_for(lambda: out('xdotool', 'search', '--name', '^chrome-start$').split(), 'Chrome window', 60)[-1]
            time.sleep(1)
            # openbox focuses a new window; give the user back their xterm.
            out('xdotool', 'windowactivate', '--sync', user)
            user_focus = focus()
            result = server.call('type_text', dict(text='hello chrome', delivery='background', window_id=int(chrome)))
            check(failures, result.get('ok') is True, f'type_text into Chrome: {result}')
            title = wait_for(lambda: out('xdotool', 'getwindowname', chrome).strip() == 'hello chrome', 'Chrome text', 5) if result.get('ok') else False
            check(failures, title, 'the agent text reached the Chrome textarea')
            check(failures, focus() == user_focus, 'the user keeps keyboard focus while Chrome gets keys')
            stop(chrome_proc)
        else:
            print('SKIP Chrome check: no google-chrome or chromium', flush=True)

        # A server killed with SIGKILL cannot remove its master; the next one does.
        server.proc.kill()
        server.proc.wait(timeout=5)
        stale = masters()
        check(failures, len(stale) == 1, f'the killed server left its master: {stale}')
        # Another client takes the freed X resource range, so the next
        # server's master gets a different name than the leftover one.
        # closeterm's range is free too, so take two.
        spawn('xprop', '-root', '-spy', '_NET_ACTIVE_WINDOW')
        spawn('xprop', '-root', '-spy', '_NET_ACTIVE_WINDOW')
        time.sleep(.5)
        server = Server(binary, env)
        result = server.call('type_text', dict(text='again\n', delivery='background', title='agentterm'))
        check(failures, result.get('ok') is True, f'type_text after a crash: {result}')
        check(failures, len(masters()) == 1 and masters() != stale, f'the stale master was swept: {masters()}')

        # Without a window manager, the agent pointer clicks.
        stop(openbox)
        out('xprop', '-root', '-remove', '_NET_SUPPORTING_WM_CHECK')
        out('xdotool', 'windowfocus', '--sync', user)
        user_focus = focus()
        x, y = json.loads((root / 'gtk-button').read_text())
        gtk_window = int(out('xdotool', 'search', '--onlyvisible', '--name', '^CUL seat fixture$').split()[-1])
        # A point over another window is refused before any button goes out.
        result = server.call('click', dict(x=5, y=5, delivery='background', window_id=gtk_window))
        check(failures, result.get('ok') is False and 'not the target' in result.get('message', ''), f'a click off the target is refused: {result}')
        result = server.call('click', dict(x=x, y=y, delivery='background', window_id=gtk_window))
        check(failures, result.get('ok') is True, f'background click without a window manager: {result}')
        check(failures, settled(root / 'gtk-clicked', 'clicked\n') == 'clicked\n', 'the agent pointer pressed the GTK button')
        check(failures, focus() == user_focus, 'the user keeps keyboard focus after the agent click')
        server.close()
        check(failures, masters() == [], f'a server that exits removes its master: {masters()}')
    return failures


def sway_version():
    try:
        text = subprocess.run(SWAY.split() + ['--version'], capture_output=True, text=True, timeout=60).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    match = re.search(r'sway version (\d+)\.(\d+)', text)
    return (int(match.group(1)), int(match.group(2))) if match else None


def run_sway(binary, root):
    failures = []
    runtime = root / 'run'
    with contextlib.ExitStack() as cleanup:
        config = root / 'sway.conf'
        (root / 'keys.conf').write_text('bindsym Ctrl+e exec true\n')
        config.write_text('output HEADLESS-1 resolution 1280x800\ndefault_border none\nbindsym Ctrl+q exec true\n'
                          f'bindsym --to-code Ctrl+1 exec true\ninclude {root}/keys.conf\n'
                          'mode "resize" {\n    bindsym h resize shrink width 10px\n    bindsym Escape mode default\n}\n')
        env = dict(os.environ, XDG_RUNTIME_DIR=str(runtime), WLR_BACKENDS='headless', WLR_LIBINPUT_NO_DEVICES='1',
                   WLR_RENDERER='pixman', XDG_SESSION_TYPE='wayland', XDG_CURRENT_DESKTOP='sway',
                   COMPUTER_USE_LINUX_INDICATOR='0')
        for key in ('DISPLAY', 'WAYLAND_DISPLAY', 'WAYLAND_SOCKET', 'SWAYSOCK', 'HYPRLAND_INSTANCE_SIGNATURE', 'NIRI_SOCKET'):
            env.pop(key, None)
        scrub(env, root)
        sway = subprocess.Popen(SWAY.split() + ['-c', str(config)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cleanup.callback(stop, sway)
        sock = wait_for(lambda: next(iter(runtime.glob('sway-ipc.*.sock')), None), 'sway IPC socket')
        display = wait_for(lambda: next(iter(sorted(runtime.glob('wayland-*[0-9]'))), None), 'Wayland socket')
        env.update(SWAYSOCK=str(sock), WAYLAND_DISPLAY=display.name)
        def msg(*args):
            return subprocess.run(['swaymsg', *args], env=env, capture_output=True, text=True, timeout=10).stdout
        def nodes(node):
            yield node
            for key in ('nodes', 'floating_nodes'):
                for child in node.get(key, []):
                    yield from nodes(child)
        def find(name):
            return next((node for node in nodes(json.loads(msg('-t', 'get_tree', '-r') or '{}')) if node.get('name') == name), None)
        def seats():
            return {seat['name']: seat['focus'] for seat in json.loads(msg('-t', 'get_seats', '-r') or '[]')}
        user_file, agent_file = root / 'user.txt', root / 'agent.txt'
        # Clients start here, not through swaymsg exec, so they share this
        # process's pid and pty namespaces even when sway runs in a container.
        client_env = dict(env, GDK_BACKEND='wayland')
        client_env.pop('WLR_BACKENDS', None)
        def spawn(*args):
            proc = subprocess.Popen(list(args), env=client_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            cleanup.callback(stop, proc)
        spawn('foot', '-T', 'userterm', 'sh', '-c', f'stty -echo; exec cat > {user_file}')
        spawn('foot', '-T', 'agentterm', 'sh', '-c', f'stty -echo; exec cat > {agent_file}')
        click_log = root / 'clickterm.log'
        # foot logs its Wayland events, so the test sees the click arrive.
        clickterm_proc = subprocess.Popen(['foot', '-T', 'clickterm', 'sh', '-c', 'exec cat > /dev/null'],
                                          env=dict(client_env, WAYLAND_DEBUG='1'), stdout=subprocess.DEVNULL,
                                          stderr=click_log.open('w'))
        cleanup.callback(stop, clickterm_proc)
        spawn('/usr/bin/python3', __file__, '--gtk', str(root), 'CUL seat fixture')
        user = wait_for(lambda: find('userterm'), 'userterm')
        agent = wait_for(lambda: find('agentterm'), 'agentterm')
        wait_for(lambda: find('CUL seat fixture'), 'GTK fixture')
        wait_for(lambda: find('clickterm'), 'clickterm')
        # The agent's window sits on a workspace the user is not looking at.
        msg(f"[con_id={agent['id']}] move to workspace 2")
        msg(f"[con_id={user['id']}] focus")
        def workspaces():
            return {ws['name']: (ws['visible'], ws['focused']) for ws in json.loads(msg('-t', 'get_workspaces', '-r') or '[]')}
        def user_types(text):
            subprocess.run(['wtype', '-s', '300', text], env=env, timeout=10)
        user_types('user1\n')
        wait_for(lambda: read(user_file) == 'user1\n', 'user typing before the agent', 5)

        server = Server(binary, env)
        doctor = json.dumps(server.call('doctor', {}))
        check(failures, '"seat"' in doctor and 'sway-transient-seat' in doctor, 'doctor reports the sway seat route')
        result = server.call('type_text', dict(text='Agent!x\n', delivery='background', title='agentterm'))
        check(failures, result.get('ok') is True, f'type_text into the agent foot: {result}')
        # Ctrl+U erases the pending line in the terminal, so the chord must
        # arrive with Control held, not as a plain u.
        result = server.call('type_text', dict(text='zzz', delivery='background', title='agentterm'))
        check(failures, result.get('ok') is True, f'type_text zzz: {result}')
        result = server.call('press_key', dict(key='Ctrl+u', delivery='background', title='agentterm'))
        check(failures, result.get('ok') is True, f'press_key Ctrl+u: {result}')
        result = server.call('type_text', dict(text='line', delivery='background', title='agentterm'))
        check(failures, result.get('ok') is True, f'type_text line: {result}')
        result = server.call('press_key', dict(key='Enter', delivery='background', title='agentterm'))
        check(failures, result.get('ok') is True, f'press_key Enter: {result}')
        # Bound chords, Super chords and keys outside the default binding mode
        # have no agent-seat route. The notice comes once per session, so
        # each case gets a fresh server to show its reason.
        def first_call(tool, **arguments):
            fresh = Server(binary, env)
            try:
                return fresh.call(tool, arguments)
            finally:
                fresh.close()
        for chord, word in (('Ctrl+q', 'binds'), ('Ctrl+e', 'binds'), ('Super+Return', 'Super')):
            result = first_call('press_key', key=chord, delivery='background', title='agentterm')
            check(failures, notice(result) and word in result['background'].get('reason', ''), f'{chord} gets the notice: {result}')
        msg('mode resize')
        result = first_call('type_text', text='h', delivery='background', title='agentterm')
        check(failures, notice(result) and 'binding mode' in result['background'].get('reason', ''), f'keys outside the default mode get the notice: {result}')
        msg('mode default')
        current = seats()
        # The seat lives for one call, so no other client can bind it between calls.
        check(failures, list(current) == ['seat0'], f'no agent seat outlives its call: {current}')
        check(failures, current.get('seat0') == user['id'], f'seat0 keeps the user foot: {current}')
        check(failures, workspaces().get('1') == (True, True) and not workspaces().get('2', (False,))[0], f'the user stays on workspace 1: {workspaces()}')
        # GTK binds only the seats present when it started, so the agent seat
        # has no route to it. The first such call sends nothing.
        result = server.call('type_text', dict(text='gtk', delivery='background', title='CUL seat fixture'))
        check(failures, notice(result) and 'GTK' in result['background'].get('reason', ''), f'the first call with no route is the notice: {result}')
        clickterm = find('clickterm')
        rect, user_rect = clickterm['rect'], find('userterm')['rect']
        result = server.call('click', dict(x=user_rect['x'] + 5, y=user_rect['y'] + 5, delivery='background', window_title='clickterm'))
        check(failures, result.get('ok') is False and 'not over the target' in result.get('message', ''), f'a click off the target is refused: {result}')
        result = server.call('click', dict(x=rect['x'] + rect['width'] // 2, y=rect['y'] + rect['height'] // 2, delivery='background', window_title='clickterm'))
        check(failures, result.get('ok') is True, f'background click with the agent pointer: {result}')
        pressed = re.compile(r'wl_pointer@\d+\.button\(\d+, \d+, 272, 1\)')
        delivered = result.get('ok') and wait_for(lambda: pressed.search(read(click_log) or ''), 'click delivery', 5)
        check(failures, bool(delivered), 'the click reached clickterm as a wl_pointer button press')
        current = seats()
        check(failures, current.get('seat0') == user['id'], f'seat0 focus survives the agent click: {current}')
        check(failures, settled(agent_file, 'Agent!x\nline\n') == 'Agent!x\nline\n', f'agent text in the agent foot: {read(agent_file)!r}')
        check(failures, read(root / 'gtk-entry') is None, 'the notice sent nothing to the GTK client')
        check(failures, read(user_file) == 'user1\n', f'nothing reached the user foot: {read(user_file)!r}')
        # Focused typing goes through wtype, which would bind the agent seat;
        # the server drops that seat first, so the text reaches seat0's foot.
        result = server.call('type_text', dict(text='focused\n'))
        check(failures, result.get('ok') is True, f'focused type_text after background input: {result}')
        check(failures, settled(user_file, 'user1\nfocused\n') == 'user1\nfocused\n', f'focused text reached the user foot: {read(user_file)!r}')
        # Repeating the call delivers it through seat0, and a later call with
        # no route does too, without the notice.
        result = server.call('type_text', dict(text='gtk', delivery='background', title='CUL seat fixture'))
        check(failures, focused_fallback(result), f'the repeated call goes through focused input: {result}')
        check(failures, settled(root / 'gtk-entry', 'gtk') == 'gtk', f'the repeated call reached the GTK entry: {read(root / "gtk-entry")!r}')
        result = server.call('type_text', dict(text='more', delivery='background', title='CUL seat fixture'))
        check(failures, focused_fallback(result), f'a later call with no route goes through focused input: {result}')
        check(failures, settled(root / 'gtk-entry', 'gtkmore') == 'gtkmore', f'the later call reached the GTK entry: {read(root / "gtk-entry")!r}')
        msg(f"[con_id={user['id']}] focus")
        server.close()
        wait_for(lambda: not any(name.startswith('transient-') for name in seats()), 'transient seat removal', 5)
        check(failures, list(seats()) == ['seat0'], f'the transient seat is gone after exit: {seats()}')
        # wtype binds the last wl_seat it sees, so the user's typing runs
        # once the agent seat is gone; seat0 still has the user foot.
        user_types('user2\n')
        expected = 'user1\nfocused\nuser2\n'
        check(failures, settled(user_file, expected) == expected, f'user text intact: {read(user_file)!r}')
    return failures


def main():
    binary = str(Path(sys.argv[1]).resolve())
    mode = sys.argv[2]
    ci = bool(os.environ.get('CI'))
    if mode == 'x11':
        tools = ['Xvfb', 'openbox', 'xterm', 'xdotool', 'xinput', 'xprop', 'wmctrl']
        missing = [tool for tool in tools if not shutil.which(tool)]
        if missing:
            print(f'SKIP x11: missing {missing}')
            sys.exit(1 if ci else 0)
    else:
        missing = [tool for tool in ['swaymsg', 'foot', 'wtype'] if not shutil.which(tool)]
        version = sway_version()
        if missing or version is None or version < (1, 10):
            print(f'SKIP sway: needs sway 1.10 or later (found {version}), missing {missing}')
            sys.exit(0)
    cache = Path(os.environ.get('XDG_CACHE_HOME', Path.home() / '.cache'))
    cache.mkdir(parents=True, exist_ok=True)
    with socket_tempdir('cul-seat-', [f'run/{INDICATOR_SOCKET}'], bus_dir='run', dir=cache) as directory:
        root = Path(directory)
        runtime = root / 'run'
        runtime.mkdir(mode=0o700)
        config = private_bus_config(root / 'bus.conf', runtime)
        env = dict(os.environ, XDG_CACHE_HOME=directory, XDG_CONFIG_HOME=directory, XDG_RUNTIME_DIR=str(runtime))
        subprocess.run(['dbus-run-session', '--config-file', str(config), '--', '/usr/bin/python3',
                        __file__, '--private', binary, mode, directory], env=env, check=True, timeout=180)


if __name__ == '__main__':
    if sys.argv[1] == '--gtk':
        gtk_app(Path(sys.argv[2]), sys.argv[3])
    elif sys.argv[1] == '--private':
        binary, mode, root = sys.argv[2], sys.argv[3], Path(sys.argv[4])
        failures = run_x11(binary, root) if mode == 'x11' else run_sway(binary, root)
        if failures:
            print(f'{len(failures)} agent seat check(s) failed', flush=True)
            sys.exit(1)
        print(f'agent seat {mode}: all checks passed', flush=True)
    else:
        main()

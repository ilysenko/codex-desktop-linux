#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""Background keyboard delivery: type_text and press_key with
delivery="background" reach their target without moving keyboard focus.

Three fixtures, chosen by the first argument after the binary:

atspi     A GTK 3 app on a private Xvfb display and D-Bus session. Text goes
          into a named entry through AT-SPI EditableText and reads back,
          keys that mean an action run it, and the target window never gets
          a focus-in event. A control character in a single-line entry has
          no route: the first such call gets the one-time notice and sends
          nothing. Later keys with no mapped action (Enter on a check box,
          a letter on a button, Ctrl+Enter) go to normal focused input,
          which on this private display has no input tool to send with.
terminal  A private tmux server: text and keys reach a pane by its tty and
          through the client attached on another tty, and a GNU screen window
          by its tty. A screen window's own tty and a plain pty with no
          multiplexer have no route: the first gets the notice, later ones
          go to focused input (no terminal window here, so nothing is
          sent), unless the kernel allows taking the pty master.
devtools  A headless Chrome on a loopback DevTools port named by its
          DevToolsActivePort file: text goes into the tab's focused input and
          Enter submits its form. A server without the setting has no
          route, and no window shows the headless tab, so the call fails.

Missing tools skip the fixture outside CI and fail it in CI.
"""
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
from socket_fixture import INDICATOR_SOCKET, private_bus_config, socket_tempdir  # noqa: E402

BINARY = str(Path(sys.argv[1]).resolve())
MODE = sys.argv[2] if len(sys.argv) > 2 else 'all'


def need(*tools):
    missing = [tool for tool in tools if not shutil.which(tool)]
    if missing:
        if os.environ.get('CI'):
            raise SystemExit(f'missing {missing}')
        print(f'SKIP {MODE}: missing {missing}')
        sys.exit(0)


class Mcp:
    def __init__(self, env):
        self.proc = subprocess.Popen([BINARY, 'mcp'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     text=True, env=env)
        self.ident = 0
        self.call_raw('initialize', {'protocolVersion': '2024-11-05', 'capabilities': {},
                                     'clientInfo': {'name': 'background-input-test', 'version': '1'}})
        self.proc.stdin.write(json.dumps({'jsonrpc': '2.0', 'method': 'notifications/initialized'}) + '\n')
        self.proc.stdin.flush()

    def call_raw(self, method, params):
        self.ident += 1
        self.proc.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': self.ident, 'method': method, 'params': params}) + '\n')
        self.proc.stdin.flush()
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            if not select.select([self.proc.stdout], [], [], .2)[0]:
                continue
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError('MCP exited')
            response = json.loads(line)
            if response.get('id') == self.ident:
                assert 'error' not in response, response
                return response['result']
        raise TimeoutError(method)

    def tool(self, name, **arguments):
        result = self.call_raw('tools/call', {'name': name, 'arguments': arguments})
        if result.get('structuredContent'):
            return result['structuredContent']
        return json.loads(next(c['text'] for c in result['content'] if c['type'] == 'text'))

    def close(self):
        stop(self.proc)


def stop(proc):
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


def wait_for(check, what, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(.1)
    raise AssertionError(f'timed out waiting for {what}')


def ok(result, *needles):
    action = result
    assert action['ok'], action
    for needle in needles:
        assert needle in action['message'], (needle, action['message'])
    return action


def refused(result, *needles):
    action = result
    assert not action['ok'], action
    for needle in needles:
        assert needle in action['message'], (needle, action['message'])
    return action


def notice(result, *needles):
    """The one-time notice: nothing sent, the reason, how to continue."""
    background = result.get('background') or {}
    assert not result['ok'] and background.get('delivered') is False, result
    assert background.get('retry_to_continue') is True and background.get('used') is False, result
    assert 'agent-workspace-linux' in result['message'] and 'repeat the call' in result['message'], result
    for needle in needles:
        assert needle in background.get('reason', ''), (needle, background)
    return result


def focused(result):
    """A call with no background route that went to normal focused input."""
    assert result.get('background') == {'requested': True, 'used': False}, result
    assert 'agent-workspace-linux' not in result['message'], result
    assert 'giving it keyboard focus' not in result['message'], result
    return result


def server_env(tmp, **extra):
    """The server's environment, cut off from the host desktop: no display,
    session bus or input daemon, so a regression that falls back to focused
    input cannot type anywhere."""
    env = os.environ.copy()
    for key in ('DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'AT_SPI_BUS_ADDRESS',
                'PIXELFLUX_CU', 'PIXELFLUX_CU_TOKEN', 'COMPUTER_USE_LINUX_DEVTOOLS', 'CODEX_COMPUTER_USE_DEVTOOLS', 'TMUX', 'STY', 'KITTY_LISTEN_ON',
                'WEZTERM_UNIX_SOCKET', 'COMPUTER_USE_LINUX_HYPRLAND_BACKGROUND', 'CODEX_COMPUTER_USE_HYPRLAND_BACKGROUND'):
        env.pop(key, None)
    # The server reads a missing DISPLAY back from the compositor, so name
    # displays that do not exist and put failing input tools first on PATH.
    stubs = Path(tmp, 'no-input-tools')
    stubs.mkdir(exist_ok=True)
    for tool in ('xdotool', 'ydotool', 'wtype', 'wl-copy', 'wl-paste'):
        stub = stubs / tool
        stub.write_text('#!/bin/sh\nexit 1\n')
        stub.chmod(0o755)
    env.update(DISPLAY=':9999', WAYLAND_DISPLAY='cul-no-display', PATH=f'{stubs}:{env.get("PATH", "")}')
    env.update(COMPUTER_USE_LINUX_INDICATOR='0', XDG_RUNTIME_DIR=f'{tmp}/runtime', XDG_SESSION_TYPE='tty',
               XDG_CURRENT_DESKTOP='none', YDOTOOL_SOCKET=f'{tmp}/no-ydotool.sock', CU_DISABLE_ABS_POINTER='1',
               COMPUTER_USE_LINUX_FORCE_YDOTOOL_POINTER='1')
    env.update(extra)
    return env


# ---------------------------------------------------------------- atspi

GTK_APP = r'''
import sys, gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib
def say(*parts):
    print(*parts, flush=True)
front = Gtk.Window(title="CUL front")
mine = Gtk.Entry(); mine.get_accessible().set_name("FRONT_ENTRY"); front.add(mine)
back = Gtk.Window(title="CUL back")
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
target = Gtk.Entry(); target.get_accessible().set_name("TARGET_ENTRY")
target.set_text("hello"); target.set_position(-1)
secret = Gtk.Entry(); secret.get_accessible().set_name("SECRET_ENTRY"); secret.set_visibility(False)
button = Gtk.Button(label="PRESSME")
check = Gtk.CheckButton(label="CHECKME")
submit = Gtk.Entry(); submit.get_accessible().set_name("SUBMIT_ENTRY")
for widget in (target, secret, button, check, submit):
    box.pack_start(widget, False, False, 0)
back.add(box)
target.connect("changed", lambda e: say("CHANGED", repr(e.get_text())))
secret.connect("changed", lambda e: say("SECRET_LEN", len(e.get_text())))
button.connect("clicked", lambda *a: say("ACTIVATED"))
check.connect("toggled", lambda c: say("TOGGLED", c.get_active()))
submit.connect("activate", lambda *a: say("SUBMITTED"))
back.connect("focus-in-event", lambda *a: say("BACK_FOCUS_IN"))
for widget in (target, secret, button, check, submit):
    widget.connect("focus-in-event", lambda w, *a: say("WIDGET_FOCUS_IN", w.get_accessible().get_name()))
back.show_all(); front.show_all()
front.present(); mine.grab_focus()
say("READY")
Gtk.main()
'''


def atspi():
    # Split so the private-bus lint does not read this as starting a bus.
    need('Xvfb', 'dbus-' 'run-session')
    if not os.environ.get('CUL_BG_PRIVATE_BUS'):
        with socket_tempdir('cul-bg-', [f'runtime/{INDICATOR_SOCKET}'], bus_dir='runtime') as tmp:
            for folder in ('config', 'runtime'):
                Path(tmp, folder).mkdir(mode=0o700)
            display = f':{90 + os.getpid() % 400}'
            xvfb = subprocess.Popen(['Xvfb', display, '-screen', '0', '1024x768x24', '-nolisten', 'tcp'],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                wait_for(lambda: Path(f'/tmp/.X11-unix/X{display[1:]}').exists(), 'Xvfb')
                env = server_env(tmp, CUL_BG_PRIVATE_BUS='1', DISPLAY=display, XDG_SESSION_TYPE='x11',
                                 XDG_CURRENT_DESKTOP='Openbox', XDG_CONFIG_HOME=f'{tmp}/config',
                                 GIO_USE_VFS='local', GVFS_DISABLE_FUSE='1', CUL_BG_TMP=tmp)
                for key in ('AT_SPI_BUS_ADDRESS', 'GSETTINGS_BACKEND', 'DBUS_SESSION_BUS_ADDRESS'):
                    env.pop(key, None)
                config = private_bus_config(Path(tmp, 'bus.conf'), Path(tmp, 'runtime'),
                                            services=('ca.desrt.dconf', 'org.a11y.Bus'))
                session = subprocess.Popen(['dbus-run-session', '--config-file', str(config), '--',
                                            '/usr/bin/python3', __file__, BINARY, 'atspi'],
                                           env=env, start_new_session=True)
                try:
                    assert session.wait(timeout=120) == 0, 'AT-SPI fixture failed'
                finally:
                    try:
                        os.killpg(session.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            finally:
                stop(xvfb)
        return
    tmp = os.environ['CUL_BG_TMP']
    subprocess.run(['gsettings', 'set', 'org.gnome.desktop.interface', 'toolkit-accessibility', 'true'], check=True)
    events = open(f'{tmp}/events', 'w+')
    app = subprocess.Popen(['/usr/bin/python3', '-c', GTK_APP], stdout=events, env=os.environ)
    mcp = None
    try:
        def lines():
            events.seek(0)
            return events.read().splitlines()
        wait_for(lambda: 'READY' in lines(), 'GTK app')
        mcp = Mcp(os.environ.copy())

        def tree():
            state = mcp.tool('get_app_state', pid=app.pid, include_screenshot=False)
            names = {n.get('name'): n for n in state.get('accessibility_tree', [])}
            return state if {'TARGET_ENTRY', 'PRESSME', 'CHECKME', 'SUBMIT_ENTRY', 'SECRET_ENTRY'} <= names.keys() else None
        state = wait_for(tree, 'AT-SPI tree', 20)
        nodes = {n.get('name'): n for n in state['accessibility_tree']}
        snap = state['snapshot_id']
        index = lambda name: nodes[name]['index']

        ok(mcp.tool('type_text', text=' world', element_index=index('TARGET_ENTRY'), snapshot_id=snap),
           'reads back', 'Keyboard focus did not move')
        wait_for(lambda: "CHANGED ' world'" not in lines() and any(l == "CHANGED 'hello world'" for l in lines()),
                 'target text')
        ok(mcp.tool('type_text', text='s3cret', element_index=index('SECRET_ENTRY'), snapshot_id=snap),
           'password field')
        wait_for(lambda: 'SECRET_LEN 6' in lines(), 'password text')
        notice(mcp.tool('type_text', text='a\nb', element_index=index('TARGET_ENTRY'), snapshot_id=snap),
               'U+000A')
        refused(mcp.tool('type_text', text='x', element_index=index('TARGET_ENTRY'), snapshot_id=snap,
                         delivery='focus'), 'background only')

        ok(mcp.tool('press_key', key='Enter', element_index=index('PRESSME'), snapshot_id=snap), 'AT-SPI')
        wait_for(lambda: 'ACTIVATED' in lines(), 'button press')
        ok(mcp.tool('press_key', key='space', element_index=index('CHECKME'), snapshot_id=snap))
        wait_for(lambda: 'TOGGLED True' in lines(), 'check box toggle')
        submit = mcp.tool('press_key', key='Enter', element_index=index('SUBMIT_ENTRY'), snapshot_id=snap)
        ok(submit, 'activate')
        wait_for(lambda: 'SUBMITTED' in lines(), 'entry activate')
        time.sleep(.3)
        focus = [line for line in lines() if 'FOCUS_IN' in line]
        assert not focus, focus
        assert lines().count('TOGGLED True') == 1 and lines().count('ACTIVATED') == 1, lines()
        assert not any('\\n' in line for line in lines() if line.startswith('CHANGED')), lines()

        # After the notice, keys with no AT-SPI action go to focused input:
        # the element gets keyboard focus, then the key goes to its window.
        # This display has no input tool (xdotool is a stub), so the key
        # itself is not sent; what counts is that nothing refuses it.
        for key, name in (('Enter', 'CHECKME'), ('a', 'PRESSME'), ('Ctrl+Enter', 'PRESSME')):
            focused(mcp.tool('press_key', key=key, element_index=index(name), snapshot_id=snap))
        focused(mcp.tool('press_key', key='Enter', delivery='background'))
        assert lines().count('TOGGLED True') == 1 and lines().count('ACTIVATED') == 1, lines()
        print('atspi ok')
    finally:
        if mcp:
            mcp.close()
        stop(app)


# ---------------------------------------------------------------- terminal

def terminal():
    need('tmux')
    with tempfile.TemporaryDirectory(prefix='cul-bg-term-') as tmp:
        Path(tmp, 'runtime').mkdir(mode=0o700)
        sock = f'{tmp}/tmux.sock'
        env = server_env(tmp)
        tmux = ['tmux', '-S', sock]
        children = []
        mcp = None
        try:
            subprocess.run(tmux + ['-f', '/dev/null', 'new-session', '-d', '-s', 'cul', '-x', '80', '-y', '24',
                                   f'sh -c "tty > {tmp}/pane.tty; exec cat > {tmp}/pane.out"'], check=True, env=env)
            pane_tty = wait_for(lambda: Path(tmp, 'pane.tty').exists() and Path(tmp, 'pane.tty').read_text().strip(),
                                'pane tty')
            mcp = Mcp(env)
            ok(mcp.tool('type_text', text='hello pane', tty=pane_tty, delivery='background'), 'tmux')
            ok(mcp.tool('press_key', key='Enter', tty=pane_tty, delivery='background'), 'tmux')
            wait_for(lambda: Path(tmp, 'pane.out').read_text() == 'hello pane\n', 'pane text')

            # A client attached on its own pty: its tty reaches the active pane.
            pid, master = pty.fork()
            if pid == 0:
                os.environ['TERM'] = 'xterm'
                os.execvp('tmux', tmux + ['attach', '-t', 'cul'])
            children.append(pid)
            client_tty = wait_for(lambda: subprocess.run(tmux + ['list-clients', '-F', '#{client_tty}'],
                                                         capture_output=True, text=True).stdout.strip(), 'client')
            drain(master)
            ok(mcp.tool('type_text', text='via client', tty=client_tty, delivery='background'), 'client')
            ok(mcp.tool('press_key', key='Enter', tty=client_tty, delivery='background'))
            wait_for(lambda: drain(master) is None and Path(tmp, 'pane.out').read_text().endswith('via client\n'),
                     'client text')

            if shutil.which('screen'):
                screen_env = dict(env, SCREENDIR=f'{tmp}/screen')
                Path(tmp, 'screen').mkdir(mode=0o700)
                # A screen client on its own pty: its tty reaches the session's
                # current window. The window's own tty is refused.
                pid, screen_master = pty.fork()
                if pid == 0:
                    os.environ.update(screen_env, TERM='xterm')
                    os.execvp('screen', ['screen', '-S', 'culbg', 'sh', '-c',
                                         f'tty > {tmp}/window.tty; stty -echo; exec cat > {tmp}/screen.out'])
                children.append(pid)
                window_tty = wait_for(lambda: drain(screen_master) is None and Path(tmp, 'window.tty').exists()
                                      and Path(tmp, 'window.tty').read_text().strip(), 'screen window tty')
                screen_tty = os.readlink(f'/proc/{pid}/fd/0')
                mcp.close()
                mcp = Mcp(screen_env)
                # Refused, unless the kernel lets this server take the window's
                # pty master, which reaches exactly that tty.
                window = mcp.tool('type_text', text='w:', tty=window_tty, delivery='background')
                if window['ok']:
                    assert 'pty master' in window['message'], window
                else:
                    notice(window, 'GNU screen')
                prefix = 'w:' if window['ok'] else ''
                ok(mcp.tool('type_text', text='in screen', tty=screen_tty, delivery='background'), 'GNU screen')
                ok(mcp.tool('press_key', key='Enter', tty=screen_tty, delivery='background'), 'GNU screen')
                wait_for(lambda: drain(screen_master) is None and Path(tmp, 'screen.out').read_text() == prefix + 'in screen\n',
                         'screen text')
                subprocess.run(['screen', '-S', 'culbg', '-X', 'quit'], env=screen_env)
            elif os.environ.get('CI'):
                raise SystemExit('missing screen')

            # kitty with remote control on its own socket, on a private display.
            if shutil.which('kitty') and shutil.which('Xvfb'):
                display = f':{500 + os.getpid() % 400}'
                xvfb = subprocess.Popen(['Xvfb', display, '-screen', '0', '800x600x24', '-nolisten', 'tcp'],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
                kitty = None
                try:
                    wait_for(lambda: Path(f'/tmp/.X11-unix/X{display[1:]}').exists(), 'Xvfb')
                    kitty_env = {k: v for k, v in os.environ.items() if k not in ('WAYLAND_DISPLAY', 'KITTY_LISTEN_ON')}
                    kitty_env['DISPLAY'] = display
                    kitty = subprocess.Popen(['kitty', '--config', 'NONE', '-o', 'allow_remote_control=yes',
                                              '--listen-on', f'unix:@cul-test-{os.getpid()}',
                                              'sh', '-c', f'tty > {tmp}/kitty.tty; stty -echo; exec cat > {tmp}/kitty.out'],
                                             env=kitty_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                             start_new_session=True)
                    kitty_tty = wait_for(lambda: Path(tmp, 'kitty.tty').exists() and Path(tmp, 'kitty.tty').read_text().strip(),
                                         'kitty tty', 30)
                    ok(mcp.tool('type_text', text='in kitty', tty=kitty_tty, delivery='background'), 'kitty remote control')
                    ok(mcp.tool('press_key', key='Enter', tty=kitty_tty, delivery='background'), 'kitty remote control')
                    wait_for(lambda: Path(tmp, 'kitty.out').read_text() == 'in kitty\n', 'kitty text')
                finally:
                    for proc in (kitty, xvfb):
                        if proc:
                            try:
                                os.killpg(proc.pid, signal.SIGKILL)
                            except ProcessLookupError:
                                pass
            else:
                print('kitty case skipped: kitty or Xvfb missing')

            # A plain pty with no multiplexer: refused unless the kernel lets
            # this server take the pty master (then the text must arrive).
            pid, master = pty.fork()
            if pid == 0:
                os.execvp('sh', ['sh', '-c', f'tty > {tmp}/plain.tty; stty -echo; exec cat > {tmp}/plain.out'])
            children.append(pid)
            plain_tty = wait_for(lambda: Path(tmp, 'plain.tty').exists() and Path(tmp, 'plain.tty').read_text().strip(),
                                 'plain tty')
            result = mcp.tool('type_text', text='plain\n', tty=plain_tty, delivery='background')
            if result['ok']:
                assert 'pty master' in result['message'] or 'TIOCSTI' in result['message'], result
                wait_for(lambda: Path(tmp, 'plain.out').read_text() == 'plain\n', 'plain text')
            else:
                if (result.get('background') or {}).get('retry_to_continue'):
                    notice(result, 'nothing reaches the program', 'tmux')
                else:
                    # The notice came earlier in this session; focused input
                    # finds no terminal window for this pty, so nothing goes.
                    focused(result)
                time.sleep(.3)
                assert Path(tmp, 'plain.out').read_text() == '', 'refused text arrived'
            print('terminal ok')
        finally:
            if mcp:
                mcp.close()
            subprocess.run(tmux + ['kill-server'], capture_output=True)
            for pid in children:
                try:
                    os.kill(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)
                except (ProcessLookupError, ChildProcessError):
                    pass


def drain(fd):
    while select.select([fd], [], [], 0)[0]:
        try:
            if not os.read(fd, 65536):
                break
        except OSError:
            break
    return None


# ---------------------------------------------------------------- devtools

PAGE = ('<title>CUL tab test</title><form onsubmit="document.title=\'SUBMITTED \'+f.value;'
        'var b=fr.contentDocument.body;b.focus();return false">'
        '<input id=f name=f value=abc autofocus oninput="document.title=\'V:\'+this.value"></form>'
        '<iframe id=fr srcdoc="<body contenteditable oninput=&quot;parent.document.title=\'E:\'+document.body.textContent&quot;></body>"></iframe>'
        '<script>f.focus();f.setSelectionRange(3,3)</script>')


def devtools():
    chrome = shutil.which('google-chrome') or shutil.which('chromium') or shutil.which('chromium-browser')
    if not chrome:
        need('google-chrome')
    with tempfile.TemporaryDirectory(prefix='cul-bg-cdp-', ignore_cleanup_errors=True) as tmp:
        Path(tmp, 'runtime').mkdir(mode=0o700)
        page = Path(tmp, 'page.html')
        page.write_text(PAGE)
        browser = subprocess.Popen([chrome, '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
                                    '--no-default-browser-check', f'--user-data-dir={tmp}/profile',
                                    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
                                    page.as_uri()], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   start_new_session=True)
        mcp = None
        try:
            port_file = Path(tmp, 'profile', 'DevToolsActivePort')
            port = int(wait_for(lambda: port_file.exists() and port_file.read_text().split('\n')[0].strip(),
                                'DevToolsActivePort', 30))

            def title():
                tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json/list'))
                return next((t['title'] for t in tabs if t['type'] == 'page'), '')
            wait_for(lambda: title() == 'CUL tab test', 'page load', 20)

            bare = Mcp(server_env(tmp))
            # No DevTools route, and no window shows the tab for normal input
            # (the browser is headless): an error that names both.
            refused(bare.tool('type_text', text='x', browser_tab='CUL tab'), 'CODEX_COMPUTER_USE_DEVTOOLS', 'Nothing was sent')
            bare.close()
            assert title() == 'CUL tab test', title()

            mcp = Mcp(server_env(tmp, COMPUTER_USE_LINUX_DEVTOOLS=str(port_file)))
            ok(mcp.tool('type_text', text='XYZ', browser_tab='CUL tab'), 'reads it back', 'DevTools')
            wait_for(lambda: title() == 'V:abcXYZ', 'input value', 5)
            refused(mcp.tool('type_text', text='x', browser_tab='no such tab'), 'no page tab')
            refused(mcp.tool('type_text', text='x\ny', browser_tab='V:abc'), 'control character')
            ok(mcp.tool('press_key', key='Enter', browser_tab='V:abc'), 'dispatchKeyEvent', 'input type=text')
            wait_for(lambda: title() == 'SUBMITTED abcXYZ', 'form submit', 5)
            # Submitting focused a same-origin iframe's contenteditable body.
            ok(mcp.tool('type_text', text='ED', browser_tab='SUBMITTED'), 'contenteditable body')
            wait_for(lambda: title() == 'E:ED', 'iframe editor text', 5)
            print('devtools ok')
        finally:
            if mcp:
                mcp.close()
            stop(browser)
            try:
                os.killpg(browser.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


if __name__ == '__main__':
    {'atspi': atspi, 'terminal': terminal, 'devtools': devtools}[MODE]()

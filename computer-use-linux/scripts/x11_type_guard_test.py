#!/usr/bin/env python3
"""Opt-in Xvfb/MCP regression for issue #272, isolated from the real desktop.

Requires Xvfb, xterm, xdotool, xkbcomp, setxkbmap and dbus-run-session. Checks byte-exact
stable input, restored layout changes, keyboard grabs, restored focus changes, and
PointerRoot/no-fixed-focus dispatch behavior.
"""
import json
import os
from pathlib import Path
import select
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time


def rpc(proc, request):
    proc.stdin.write(json.dumps(request) + "\n")
    proc.stdin.flush()
    if "id" not in request:
        return None
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if not select.select([proc.stdout], [], [], 1)[0]:
            continue
        line = proc.stdout.readline()
        if not line:
            raise RuntimeError("MCP exited")
        response = json.loads(line)
        if response.get("id") == request["id"]:
            assert "error" not in response, response
            return response["result"]
    raise TimeoutError("MCP response deadline exceeded")


def main():
    binary = str(Path(sys.argv[1]).resolve())
    cache = Path.home() / ".cache"
    cache.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="cul-x11-type-", dir=cache) as scratch:
        if not os.environ.get("CUL_X11_PRIVATE_BUS"):
            env = os.environ.copy()
            runtime = Path(scratch) / "runtime"
            runtime.mkdir(mode=0o700)
            bus_config = Path(scratch) / "bus.conf"
            # No service directories: this test must not activate desktop
            # portals, mount a document FUSE filesystem, or start host apps.
            bus_config.write_text(
                '<busconfig><type>session</type>'
                f'<listen>unix:tmpdir={runtime}</listen>'
                '<policy context="default"><allow own="*"/>'
                '<allow send_destination="*"/><allow receive_sender="*"/>'
                '</policy></busconfig>')
            env.update(CUL_X11_PRIVATE_BUS="1", XDG_CACHE_HOME=scratch,
                       XDG_CONFIG_HOME=scratch, XDG_RUNTIME_DIR=str(runtime),
                       CODEX_COMPUTER_USE_INDICATOR="0",
                       CODEX_COMPUTER_USE_SCREENSHOT_BACKEND="x11")
            for key in ("AT_SPI_BUS_ADDRESS", "WAYLAND_DISPLAY", "DISPLAY"):
                env.pop(key, None)
            subprocess.run(["dbus-run-session", "--config-file", str(bus_config),
                            "--", sys.executable, __file__, binary],
                           env=env, check=True, timeout=180)
            return
        env = os.environ.copy()
        env.update(XDG_SESSION_TYPE="x11", XDG_CURRENT_DESKTOP="Xvfb",
                   CODEX_COMPUTER_USE_XDOTOOL_TYPE_DELAY_MS="30")
        shim_dir = Path(scratch) / "bin"
        shim_dir.mkdir()
        shim = shim_dir / "xdotool"
        shim.write_text("#!/usr/bin/env python3\nimport os, socket, sys\n"
                        "if sys.argv[1:2] == ['type']:\n"
                        "    with open(os.environ['CUL_X11_DISPATCH_MARKER'], 'a') as marker:\n"
                        "        marker.write('type\\n')\n"
                        "    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as notify:\n"
                        "        notify.sendto(b'type', os.environ['CUL_X11_NOTIFY'])\n"
                        f"os.execv({shutil.which('xdotool')!r}, sys.argv)\n")
        shim.chmod(0o755)
        env["PATH"] = str(shim_dir) + os.pathsep + env["PATH"]
        interrupt = Path(scratch) / "interrupt.py"
        interrupt.write_text('''import ctypes, json, os, sys, time
assert os.environ.get("CUL_X11_PRIVATE_BUS") == "1"
x=ctypes.CDLL("libX11.so.6")
P=ctypes.c_void_p; W=ctypes.c_ulong; I=ctypes.c_int; U=ctypes.c_uint
def bind(name, result, args):
    f=getattr(x,name); f.restype=result; f.argtypes=args; return f
open_display=bind("XOpenDisplay",P,[ctypes.c_char_p])
root=bind("XDefaultRootWindow",W,[P])
create=bind("XCreateSimpleWindow",W,[P,W,I,I,U,U,U,W,W])
map_window=bind("XMapWindow",I,[P,W])
sync=bind("XSync",I,[P,I])
get_focus=bind("XGetInputFocus",I,[P,ctypes.POINTER(W),ctypes.POINTER(I)])
set_focus=bind("XSetInputFocus",I,[P,W,I,W])
grab=bind("XGrabKeyboard",I,[P,W,I,I,I,W])
ungrab=bind("XUngrabKeyboard",I,[P,W])
close=bind("XCloseDisplay",I,[P])
d=open_display(None); assert d
def focus():
    value=W(); revert=I();get_focus(d,ctypes.byref(value),ctypes.byref(revert));return value.value
before=focus()
if sys.argv[1] in ("pointer-root", "focus-none"):
    focus_id = 1 if sys.argv[1] == "pointer-root" else 0
    set_focus(d,focus_id,1,0);sync(d,0)
    assert focus() == focus_id
    close(d)
    sys.exit(0)
w=create(d,root(d),0,0,10,10,0,0,0); map_window(d,w);sync(d,0)
if sys.argv[1] == "grab": assert grab(d,w,0,1,1,0) == 0
else: set_focus(d,w,1,0);sync(d,0)
during=focus()
time.sleep(0.1)
if sys.argv[1] == "grab": ungrab(d,0)
else: set_focus(d,before,1,0)
sync(d,0)
after=focus()
print(json.dumps({"before":before,"during":during,"after":after}))
close(d)
''')
        read_fd, write_fd = os.pipe()
        xvfb = subprocess.Popen(["Xvfb", "-displayfd", str(write_fd), "-screen", "0",
                                 "800x600x24", "-nolisten", "tcp"],
                                pass_fds=(write_fd,), stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL)
        os.close(write_fd)
        try:
            assert select.select([read_fd], [], [], 10)[0], "Xvfb did not start"
            env["DISPLAY"] = ":" + os.read(read_fd, 64).decode().strip()
            os.close(read_fd)
            for index, (label, text, disturbance) in enumerate([
                ("stable-ascii", "br:;'\"[]{}<>~^\\|!@#%&*()_+=?/abcXYZ0198\n", None),
                ("stable-unmapped-symbol", "hello Ω Ж 😀\n", None),
                ("layout-restored-1", "TESTE:;'\"[]{}<>~^\\|!@#%&*()_+=?/abcXYZ0198" * 3, "layout"),
                ("layout-restored-2", "TESTE:;'\"[]{}<>~^\\|!@#%&*()_+=?/abcXYZ0198" * 3, "layout"),
                ("layout-restored-3", "TESTE:;'\"[]{}<>~^\\|!@#%&*()_+=?/abcXYZ0198" * 3, "layout"),
                ("keyboard-grab-stable-layout-and-focus", "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" * 2, "grab"),
                ("focus-restored", "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" * 2, "focus"),
                ("focus-none", "No fixed focus still dispatches\n", "focus-none"),
                ("pointer-root", "Pointer root still dispatches\n", "pointer-root"),
            ]):
                capture = Path(scratch) / f"{index}.txt"
                marker = Path(scratch) / f"{index}.dispatch"
                env["CUL_X11_DISPATCH_MARKER"] = str(marker)
                notify = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
                notify.bind(str(Path(scratch) / f"{index}.sock"))
                env["CUL_X11_NOTIFY"] = notify.getsockname()
                terminal = subprocess.Popen(
                    ["xterm", "-title", "CUL-X11-TYPE-TEST", "-e", "sh", "-c",
                     'stty raw -echo; exec cat > "$1"', "sh", str(capture)], env=env,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                mcp = None
                errors = []
                flipper = None
                try:
                    window = subprocess.check_output(
                        ["xdotool", "search", "--sync", "--onlyvisible", "--name", "^CUL-X11-TYPE-TEST$"],
                        env=env, timeout=10).decode().splitlines()[-1]
                    subprocess.run(["xdotool", "windowfocus", "--sync", window],
                                   env=env, check=True, timeout=5)
                    subprocess.run(["setxkbmap", "br"], env=env, check=True, timeout=5)
                    mcp = subprocess.Popen([binary, "mcp"], env=env, stdin=subprocess.PIPE,
                                           stdout=subprocess.PIPE, text=True)
                    rpc(mcp, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                        "protocolVersion": "2025-11-25", "capabilities": {},
                        "clientInfo": {"name": "x11-type-guard-test", "version": "1"}}})
                    rpc(mcp, {"jsonrpc": "2.0", "method": "notifications/initialized"})
                    focus_mode = disturbance in ("pointer-root", "focus-none")
                    if focus_mode:
                        subprocess.run([sys.executable, str(interrupt), disturbance],
                                       env=env, check=True, timeout=5)
                    before_map = subprocess.check_output(["xkbcomp", "-xkb", env["DISPLAY"], "-"], env=env, stderr=subprocess.DEVNULL, timeout=5)
                    if disturbance and not focus_mode:
                        def replace_layout():
                            try:
                                if not select.select([notify], [], [], 15)[0]:
                                    raise TimeoutError("xdotool dispatch did not start")
                                assert notify.recv(64) == b"type"
                                time.sleep(0.5)
                                if disturbance == "layout":
                                    subprocess.run(["setxkbmap", "us"], env=env, check=True, timeout=5)
                                    time.sleep(0.3)
                                    subprocess.run(["setxkbmap", "br"], env=env, check=True, timeout=5)
                                else:
                                    state = json.loads(subprocess.check_output(
                                        [sys.executable, str(interrupt), disturbance], env=env, timeout=5))
                                    assert state["before"] == state["after"] == int(window), state
                                    if disturbance == "grab":
                                        assert state["during"] == state["before"], state
                            except Exception as error:
                                errors.append(error)
                        flipper = threading.Thread(target=replace_layout)
                        flipper.start()
                    result = rpc(mcp, {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                                       "params": {"name": "type_text", "arguments": {
                                           "text": text, "screenshot_after": not disturbance}}})
                    if flipper:
                        flipper.join(timeout=20)
                        assert not flipper.is_alive() and not errors, errors
                    output = result.get("structuredContent") or json.loads(
                        next(item["text"] for item in result["content"] if item["type"] == "text"))
                    assert marker.read_text().splitlines() == ["type"], "text was replayed"
                    if focus_mode:
                        assert output["ok"], output
                        assert not result.get("isError", False), result
                        assert "Action sent through xdotool (X11 XTEST)." in output["message"], output
                        if disturbance == "pointer-root":
                            assert "X11 keyboard monitoring does not support PointerRoot" in output["message"], output
                        else:
                            assert "layout-change detection was unavailable" not in output["message"], output
                    elif disturbance:
                        assert not output["ok"], output
                        if disturbance == "layout":
                            assert "layout changed during type_text" in json.dumps(output), output
                        else:
                            assert "keyboard focus changed or was grabbed" in json.dumps(output), output
                            after_map = subprocess.check_output(["xkbcomp", "-xkb", env["DISPLAY"], "-"], env=env, stderr=subprocess.DEVNULL, timeout=5)
                            assert before_map == after_map, "keymap must stay stable"
                            received = capture.read_bytes()
                            expected = text.encode()
                            assert received != expected, (label, received)
                            if disturbance == "grab":
                                lost = len(expected) - len(received)
                                assert lost > 0, (label, received)
                                position = next(i for i, (a, b) in enumerate(zip(expected, received)) if a != b)
                                assert received == expected[:position] + expected[position+lost:], "loss must be contiguous"
                    else:
                        assert output["ok"], output
                        assert "WARNING: X11 keyboard layout" in output["message"], output
                        assert "Field contents were not verified" in output["message"], output
                        assert "screenshot" in output, output
                        assert capture.read_bytes() == text.replace("\n", "\r").encode(), (label, capture.read_bytes())
                    print(f"PASS {label}", flush=True)
                finally:
                    if flipper:
                        flipper.join(timeout=12)
                    if mcp:
                        mcp.terminate()
                        mcp.wait(timeout=5)
                    terminal.terminate()
                    terminal.wait(timeout=5)
                    notify.close()
        finally:
            xvfb.terminate()
            xvfb.wait(timeout=5)


if __name__ == "__main__":
    main()

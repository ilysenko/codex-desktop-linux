# SPDX-License-Identifier: MIT
"""Directories for test fixtures that bind or connect to Unix sockets.

A socket path must fit sun_path, so a fixture under a long TMPDIR fails with
"AF_UNIX path too long" or dbus-daemon's "Socket name too long", which read
like product bugs. Fixtures make their directory here instead: in the temp
dir (or the base they name) when the longest socket path fits, else in
XDG_RUNTIME_DIR, else they stop with a message that names the limit and the
path. src/test_sockets.rs applies the same rule to the Rust unit tests.
"""
import os
import tempfile

# sun_path holds 108 bytes, including the terminating NUL.
SOCKET_PATH_MAX = 107
# dbus-daemon refuses a listen path longer than this.
DBUS_SOCKET_PATH_MAX = 99
# The socket a private bus makes for <listen>unix:tmpdir=DIR</listen>.
DBUS_TMPDIR_SOCKET = 'dbus-' + 'X' * 10
# The real server's overlay socket in XDG_RUNTIME_DIR. Its capture handshake
# uses it even with the indicator off.
INDICATOR_SOCKET = 'computer-use-linux-indicator.sock'
# The name tempfile.TemporaryDirectory(dir=...) gives without a prefix.
TEMPDIR_NAME = 'tmp' + 'X' * 8


def socket_tempdir(prefix, sockets, bus_dir=None, dir=None):
    """tempfile.TemporaryDirectory(prefix=prefix) whose socket paths fit.

    sockets are the socket paths the fixture binds or connects to, relative
    to the new directory. bus_dir is the directory, relative to it ('' for
    itself), that a private bus gets as <listen>unix:tmpdir=...</listen>.
    The bus is checked against dbus-daemon's own limit even when another
    socket is longer, so a layout change cannot drop the check. dir is the
    preferred base; it defaults to the temp dir.
    """
    # TemporaryDirectory adds eight random characters to the prefix.
    name = prefix + 'X' * 8
    checks = [(path, SOCKET_PATH_MAX) for path in sockets]
    if bus_dir is not None:
        checks.append((os.path.join(bus_dir, DBUS_TMPDIR_SOCKET), DBUS_SOCKET_PATH_MAX))

    def overflow(base):
        for relative, limit in checks:
            path = os.path.join(base, name, relative)
            length = len(os.fsencode(path))
            if length > limit:
                return f'{path} is {length} bytes, over the {limit}-byte limit'
        return None

    base = tempfile.gettempdir() if dir is None else os.fspath(dir)
    first = overflow(base)
    if first is None:
        return tempfile.TemporaryDirectory(prefix=prefix, dir=base)
    runtime = os.environ.get('XDG_RUNTIME_DIR', '')
    if os.path.isabs(runtime) and os.path.isdir(runtime):
        second = overflow(runtime)
        if second is None:
            return tempfile.TemporaryDirectory(prefix=prefix, dir=runtime)
        fallback = f'under XDG_RUNTIME_DIR, {second}'
    elif runtime:
        fallback = f'XDG_RUNTIME_DIR ({runtime}) is not an absolute directory'
    else:
        fallback = 'XDG_RUNTIME_DIR is unset'
    remedy = 'Set TMPDIR' if dir is None else f'Move {base}'
    raise SystemExit(f'Unix socket path too long: {first}; {fallback}. '
                     f'{remedy} or XDG_RUNTIME_DIR to a shorter path.')

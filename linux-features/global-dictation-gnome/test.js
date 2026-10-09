'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const test = require('node:test');
const {stageEnabledLinuxFeatureInstall, loadEnabledLinuxFeatures} =
    require('../../scripts/lib/linux-features.js');
const feature = __dirname;
const repo = path.resolve(feature, '../..');
const uuid = 'global-dictation-gnome@chatgpt-community.local';
const helperPath = '/opt/codex-desktop/resources/native/codex-global-dictation-linux';

function scratch(t) {
    // Never use os.tmpdir(): this machine's /tmp is RAM-backed.
    const base = path.join(os.homedir(), '.cache/codex-desktop-dev');
    fs.mkdirSync(base, {recursive: true});
    const dir = fs.mkdtempSync(path.join(base, 'gnome-dictation-test-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    return dir;
}
function write(file, content, mode = 0o644) {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, content, {mode});
}
function harness() {
    const events = [], calls = [], lifecycle = [];
    const focus = {};
    const shellGlobal = {stage: {key_focus: null}, display: {focus_window: focus},
        get_pointer: () => [0, 0, h.modifiers]};
    const Main = {sessionMode: {isLocked: false, hasWindows: true}, actionMode: 1, modalCount: 0};
    class Variant {
        constructor(type, value) { this.type = type; this.value = value; }
        deep_unpack() { return this.value; }
    }
    const h = {modifiers: 0, exe: helperPath, pid: 123, failEvent: -1, config: {helperPath}, Main};
    const keyboard = {notify_key(time, key, state) {
        events.push([key, state]);
        if (events.length === h.failEvent) throw new Error('submission failed');
    }, run_dispose() { lifecycle.push('dispose'); }};
    const bus = {call(...args) { calls.push(args); }, call_finish(result) {
        if (result instanceof Error) throw result;
        return new Variant('(u)', [h.pid]);
    }};
    const Clutter = {KeyState: {PRESSED: 1, RELEASED: 0},
        ModifierType: Object.fromEntries(['SHIFT', 'CONTROL', 'MOD1', 'MOD3', 'MOD4', 'MOD5',
            'SUPER', 'HYPER', 'META'].map((name, index) => [`${name}_MASK`, 1 << index])),
        InputDeviceType: {KEYBOARD_DEVICE: 1}, get_default_backend: () => ({get_default_seat: () => ({
            create_virtual_device: () => keyboard})})};
    const Gio = {DBus: {session: bus}, DBusCallFlags: {NO_AUTO_START: 4},
        BusNameOwnerFlags: {NONE: 0}, Cancellable: class {cancel() { lifecycle.push('cancel'); }},
        DBusExportedObject: {wrapJSObject(xml, object) {
            h.xml = xml; h.exportedObject = object;
            return {export(connection, objectPath) { h.objectPath = objectPath; lifecycle.push('export'); },
                unexport() { lifecycle.push('unexport'); }};
        }}, bus_own_name_on_connection(connection, name, flags, acquired, lost) {
            h.service = name; h.acquired = acquired; h.lost = lost; return 7;
        }, bus_unown_name(id) { assert.equal(id, 7); lifecycle.push('unown'); }};
    const GLib = {Variant, VariantType: class {constructor(type) { this.type = type; }},
        file_get_contents(file) {
            assert.equal(file, '/extension/config.json');
            h.configReads = (h.configReads ?? 0) + 1;
            if (h.configReadError) throw new Error('Installer configuration unavailable');
            return [!h.configMissing, new TextEncoder().encode(h.configRaw ?? JSON.stringify(h.config))];
        },
        file_read_link(file) {
            assert.equal(file, `/proc/${h.pid}/exe`);
            if (h.readLinkError) throw new Error('/proc executable unavailable');
            return h.exe;
        },
        get_monotonic_time: () => 123456};
    const source = fs.readFileSync(path.join(feature, 'extension/extension.js'), 'utf8')
        .replace(/^import .*;\n/gm, '').replace('export default class', 'class');
    const ExtensionClass = vm.runInNewContext(`${source}\nDictationExtension`, {
        Clutter, Gio, GLib, Shell: {ActionMode: {NORMAL: 1}}, Main, global: shellGlobal,
        Extension: class {constructor() { this.path = '/extension'; }}, TextDecoder,
        console: {error() {}},
    });
    const extension = new ExtensionClass();
    extension.enable(); h.acquired?.();
    function invocation(sender = ':1.42') {
        return {result: null, get_sender: () => sender,
            return_value(value) { this.result = {ok: true, type: value.type}; },
            return_dbus_error(name, message) { this.result = {ok: false, name, message}; }};
    }
    function authorize(error) {
        const call = calls.at(-1); assert.ok(call);
        call.at(-1)(bus, error ?? {});
    }
    return Object.assign(h, {extension, keyboard, events, calls, lifecycle, shellGlobal, invocation, authorize});
}

test('fixed D-Bus contract, bounded caller lookup and exact executable authorization', async () => {
    const h = harness();
    assert.equal(h.extension.GetVersion(), 1);
    assert.equal(h.service, 'org.chatgpt.Community.Dictation');
    assert.equal(h.objectPath, '/org/chatgpt/Community/Dictation');
    assert.match(h.xml, /interface name="org.chatgpt.Community.Dictation1"/);
    assert.match(h.xml, /<method name="Paste"\/>/);
    const i = h.invocation(); const pending = h.extension.PasteAsync([], i);
    assert.deepEqual(h.events, []); assert.equal(i.result, null);
    const call = h.calls[0];
    assert.deepEqual(call.slice(0, 4), ['org.freedesktop.DBus', '/org/freedesktop/DBus',
        'org.freedesktop.DBus', 'GetConnectionUnixProcessID']);
    assert.equal(call[4].type, '(s)'); assert.equal(call[4].value[0], ':1.42');
    assert.equal(call[6], 4); assert.equal(call[7], 1000);
    h.authorize(); await pending;
    assert.deepEqual(h.events, [[29, 1], [47, 1], [47, 0], [29, 0]]);
    assert.deepEqual(i.result, {ok: true, type: '()'});
});

test('paste submits physical Ctrl+V without looking up Latin keysyms in the current layout', async () => {
    const h = harness();
    h.keyboard.notify_keyval = () => { throw new Error('No Latin v in the current layout'); };
    const i = h.invocation(); const pending = h.extension.PasteAsync([], i);
    h.authorize(); await pending;
    assert.deepEqual(i.result, {ok: true, type: '()'});
    assert.deepEqual(h.events, [[29, 1], [47, 1], [47, 0], [29, 0]]);
});

test('real GJS private-bus dispatch returns uint32 version, denies async Paste and disables cleanly',
    {timeout: 20000}, t => {
        const tools = {};
        for (const name of ['gjs', 'dbus-run-session', 'gdbus', 'timeout']) {
            tools[name] = (process.env.PATH ?? '').split(path.delimiter)
                .map(dir => path.resolve(dir, name)).find(candidate => {
                    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); }
                    catch { return false; }
                });
            if (!tools[name]) {
                t.skip(`Private-bus GJS integration requires ${name}; executable unavailable`);
                return;
            }
        }
        const root = scratch(t), runtime = path.join(root, 'runtime');
        const socket = path.join(runtime, 'bus');
        const env = {...process.env, HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp'),
            XDG_RUNTIME_DIR: runtime, XDG_CONFIG_HOME: path.join(root, 'config'),
            XDG_CACHE_HOME: path.join(root, 'cache'), XDG_DATA_HOME: path.join(root, 'data'),
            DICTATION_TEST_EXTENSION_DIR: root, DICTATION_TEST_BUS_SOCKET: socket,
            DICTATION_TEST_GDBUS: tools.gdbus};
        for (const key of ['HOME', 'TMPDIR', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME'])
            fs.mkdirSync(env[key], {mode: 0o700});
        for (const key of ['DBUS_SESSION_BUS_ADDRESS', 'DBUS_SESSION_BUS_PID', 'DBUS_STARTER_ADDRESS',
            'DBUS_STARTER_BUS_TYPE', 'DISPLAY', 'WAYLAND_DISPLAY']) delete env[key];
        write(path.join(root, 'config.json'), JSON.stringify({helperPath: '/does-not-authorize-gdbus'}));
        const busConfig = path.join(root, 'bus.conf');
        const xmlSocket = socket.replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
        })[c]);
        // A private socket on disk, not /tmp and never the user's session bus.
        write(busConfig, `<busconfig><type>session</type><listen>unix:path=${xmlSocket}</listen>
<auth>EXTERNAL</auth><policy context="default"><allow user="*"/><allow own="*"/>
<allow send_destination="*"/><allow receive_sender="*"/></policy></busconfig>`);
        const source = fs.readFileSync(path.join(feature, 'extension/extension.js'), 'utf8')
            .replace(/^import (?!Gio from |GLib from ).*;\n/gm, '')
            .replace('export default class', 'class');
        const driver = path.join(root, 'private-bus-test.js');
        write(driver, `import System from 'system';
const events = [];
let disposed = 0;
const keyboard = {notify_key(time, key, state) { events.push([key, state]); },
    run_dispose() { disposed++; }};
const Clutter = {KeyState: {PRESSED: 1, RELEASED: 0},
    ModifierType: Object.fromEntries(['SHIFT', 'CONTROL', 'MOD1', 'MOD3', 'MOD4', 'MOD5',
        'SUPER', 'HYPER', 'META'].map((name, index) => [name + '_MASK', 1 << index])),
    InputDeviceType: {KEYBOARD_DEVICE: 1}, get_default_backend: () => ({get_default_seat: () => ({
        create_virtual_device: () => keyboard})})};
const Main = {sessionMode: {isLocked: false, hasWindows: true}, actionMode: 1, modalCount: 0};
const Shell = {ActionMode: {NORMAL: 1}};
const global = {stage: {key_focus: null}, display: {focus_window: {}}, get_pointer: () => [0, 0, 0]};
class Extension { constructor() { this.path = GLib.getenv('DICTATION_TEST_EXTENSION_DIR'); } }
${source}
function check(condition, message) { if (!condition) throw new Error(message); }
const loop = new GLib.MainLoop(null, false);
const extension = new DictationExtension();
const children = new Set();
let failed = false;
function delay() {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
        resolve(); return GLib.SOURCE_REMOVE;
    }));
}
function call(destination, objectPath, method, args = []) {
    const child = Gio.Subprocess.new([GLib.getenv('DICTATION_TEST_GDBUS'), 'call', '--session',
        '--timeout', '2', '--dest', destination, '--object-path', objectPath, '--method', method,
        ...args], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    children.add(child);
    return new Promise((resolve, reject) => {
        child.communicate_utf8_async(null, null, (process, result) => {
            children.delete(child);
            try {
                const [ok, stdout, stderr] = process.communicate_utf8_finish(result);
                check(ok, 'Could not collect gdbus reply');
                resolve({status: process.get_exit_status(), stdout: stdout.trim(), stderr});
            } catch (error) { reject(error); }
        });
    });
}
const watchdog = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 8, () => {
    failed = true;
    printerr('Private-bus GJS integration timed out');
    for (const child of children) child.force_exit();
    extension.disable();
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
async function run() {
    check(GLib.getenv('DBUS_SESSION_BUS_ADDRESS')?.includes(
        'unix:path=' + GLib.getenv('DICTATION_TEST_BUS_SOCKET')), 'Not on the isolated test bus');
    extension.enable();
    check(extension._enabled, 'Actual extension failed to enable with real Gio/GLib');
    while (!extension._nameReady) await delay();
    const uniqueOwner = Gio.DBus.session.get_unique_name();
    const version = await call(SERVICE, OBJECT, 'org.chatgpt.Community.Dictation1.GetVersion');
    check(version.status === 0 && version.stdout === '(uint32 1,)',
        'GetVersion must return unsigned uint32 1: ' + JSON.stringify(version));
    const paste = await call(SERVICE, OBJECT, 'org.chatgpt.Community.Dictation1.Paste');
    check(paste.status !== 0 && paste.stderr.includes(ERROR) &&
        paste.stderr.includes('Caller is not the installed dictation helper'),
        'Real async Paste must reject the gdbus executable: ' + JSON.stringify(paste));
    check(events.length === 0 && !extension._busy && extension._pending === null,
        'Rejected async Paste emitted events or left pending work');
    extension.disable();
    check(!extension._enabled && extension._owner === 0 && extension._exported === null &&
        extension._keyboard === null && disposed === 1, 'Disable did not clean extension state');
    const owner = await call('org.freedesktop.DBus', '/org/freedesktop/DBus',
        'org.freedesktop.DBus.NameHasOwner', [SERVICE]);
    check(owner.status === 0 && owner.stdout === '(false,)', 'Disable did not release the bus name');
    const removed = await call(uniqueOwner, OBJECT, 'org.chatgpt.Community.Dictation1.GetVersion');
    check(removed.status !== 0 && /UnknownMethod|UnknownObject/.test(removed.stderr),
        'Disable did not unexport the real D-Bus object: ' + JSON.stringify(removed));
    check(events.length === 0, 'Unexpected virtual keyboard events');
    print('REAL_DBUS_OK: uint32=1; async caller denied; events=0; name released; object unexported');
}
run().catch(error => { failed = true; logError(error); }).finally(() => {
    for (const child of children) child.force_exit();
    extension.disable();
    GLib.source_remove(watchdog);
    loop.quit();
});
loop.run();
if (failed) System.exit(1);
`);
        const result = spawnSync(tools.timeout, ['--kill-after=1s', '12s', tools['dbus-run-session'],
            `--config-file=${busConfig}`, '--', tools.gjs, '-m', driver],
        {env, encoding: 'utf8', timeout: 15000});
        assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}\n${result.stdout}`);
        assert.match(result.stdout, /REAL_DBUS_OK: uint32=1; async caller denied; events=0; name released; object unexported/);
        t.diagnostic('Real Gio async dispatch and unsigned reply verified on a private cache-backed bus');
    });

test('live configuration changes authorize only the new exact executable without re-enabling', async () => {
    const h = harness();
    const newPath = '/run/user/1000/appimage-new/resources/native/codex-global-dictation-linux';
    assert.equal(h.configReads, 1);
    const first = h.invocation(); const pending = h.extension.PasteAsync([], first);
    assert.equal(h.configReads, 1); // Configuration is read after the async PID lookup, not at entry.
    h.config = {helperPath: newPath}; h.exe = newPath;
    h.authorize(); await pending;
    assert.equal(h.configReads, 2); assert.equal(first.result.ok, true);
    assert.deepEqual(h.events, [[29, 1], [47, 1], [47, 0], [29, 0]]);
    h.events.length = 0;
    for (const stalePath of [helperPath, newPath.replace('appimage-new', 'appimage-old'), `${newPath}-other`]) {
        h.exe = stalePath;
        const i = h.invocation(); const rejected = h.extension.PasteAsync([], i);
        h.authorize(); await rejected;
        assert.equal(i.result.ok, false); assert.deepEqual(h.events, []);
    }
    assert.equal(h.lifecycle.filter(event => event === 'export').length, 1);
});

test('missing or malformed live config fails closed after PID lookup with no events', async () => {
    const corruptions = [h => { h.configMissing = true; }, h => { h.configReadError = true; },
        h => { h.configRaw = '{broken JSON'; }];
    for (const config of [null, [], {}, {helperPath: 1}, {helperPath: ''},
        {helperPath: 'codex-global-dictation-linux'}, {helperPath: '/bad\npath'},
        {helperPath: '/bad\u0000path'}]) corruptions.push(h => { h.config = config; });
    for (const corrupt of corruptions) {
        const h = harness(); const i = h.invocation();
        const pending = h.extension.PasteAsync([], i); corrupt(h); h.authorize(); await pending;
        assert.equal(i.result.ok, false); assert.deepEqual(h.events, []);
        assert.equal(h.configReads, 2); assert.equal(h.extension._busy, false);
        h.extension.disable(); h.extension.enable();
        assert.equal(h.extension._enabled, false); // Initial enable validation is retained too.
    }
});

test('rejects unauthorized, missing/deleted executable, invalid PID and failed lookup without events', async () => {
    for (const scenario of ['other', 'deleted', 'invalid-pid', 'lookup', 'proc']) {
        const h = harness();
        if (scenario === 'other') h.exe = `${helperPath}-other`;
        if (scenario === 'deleted') h.exe = `${helperPath} (deleted)`;
        if (scenario === 'invalid-pid') h.pid = 0;
        if (scenario === 'proc') h.readLinkError = true;
        const i = h.invocation(); const pending = h.extension.PasteAsync([], i);
        h.authorize(scenario === 'lookup' ? new Error('timeout / disconnected / /proc unavailable') : null);
        await pending;
        assert.equal(i.result.ok, false); assert.deepEqual(h.events, []);
    }
});

test('lock, non-normal shell, shell entry focus, no window, modifiers and busy fail before events', async () => {
    const cases = [h => { h.Main.sessionMode.isLocked = true; },
        h => { h.Main.sessionMode.hasWindows = false; }, h => { h.Main.actionMode = 2; },
        h => { h.Main.modalCount = 1; }, h => { h.shellGlobal.stage.key_focus = {}; },
        h => { h.shellGlobal.display.focus_window = null; }];
    for (let bit = 0; bit < 9; bit++) cases.push(h => { h.modifiers = 1 << bit; });
    for (const change of cases) {
        const h = harness(); change(h); const i = h.invocation();
        await h.extension.PasteAsync([], i);
        assert.equal(i.result.ok, false); assert.deepEqual(h.events, []); assert.equal(h.calls.length, 0);
    }
    const h = harness(); const first = h.invocation();
    const pending = h.extension.PasteAsync([], first);
    const second = h.invocation(); await h.extension.PasteAsync([], second);
    assert.match(second.result.message, /busy/); assert.equal(h.calls.length, 1);
    h.authorize(); await pending; assert.equal(first.result.ok, true);
});

test('rechecks focus, lock and modifiers after async authorization', async () => {
    for (const change of [h => { h.Main.sessionMode.isLocked = true; },
        h => { h.modifiers = 1; }, h => { h.shellGlobal.display.focus_window = {}; },
        h => { h.Main.actionMode = 2; }, h => { h.shellGlobal.stage.key_focus = {}; }]) {
        const h = harness(); const i = h.invocation();
        const pending = h.extension.PasteAsync([], i); change(h); h.authorize(); await pending;
        assert.equal(i.result.ok, false); assert.deepEqual(h.events, []);
    }
});

test('key submission failures always attempt releases; no success acknowledgement on failure', async () => {
    for (const failEvent of [1, 2, 3, 4]) {
        const h = harness(); h.failEvent = failEvent;
        const i = h.invocation(); const pending = h.extension.PasteAsync([], i);
        h.authorize(); await pending;
        assert.equal(i.result.ok, false);
        assert.deepEqual(h.events.at(-1), [29, 0]);
        if (failEvent > 1) assert.ok(h.events.some(([key, state]) => key === 47 && state === 0));
        assert.equal(h.extension._busy, false);
    }
});

test('disable cancels/unexports/unowns/disposes and pending work cannot inject after re-enable', async () => {
    const h = harness(); const i = h.invocation(); const pending = h.extension.PasteAsync([], i);
    h.extension.disable();
    assert.deepEqual(h.lifecycle, ['export', 'cancel', 'unown', 'unexport', 'dispose']);
    h.extension.enable(); h.acquired(); h.authorize(); await pending;
    assert.equal(i.result.ok, false); assert.deepEqual(h.events, []);
    h.extension.disable(); h.extension.disable();
});

test('invalid sender, missing configuration and lost bus name fail closed', async () => {
    const invalid = harness(); const caller = invalid.invocation('well.known.name');
    await invalid.extension.PasteAsync([], caller);
    assert.equal(caller.result.ok, false);
    assert.deepEqual(invalid.events, []); assert.equal(invalid.calls.length, 0);
    const h = harness(); h.lost();
    const i = h.invocation(); await h.extension.PasteAsync([], i);
    assert.equal(i.result.ok, false); assert.deepEqual(h.events, []);
    h.extension.disable(); h.config = {}; h.extension.enable();
    assert.equal(h.extension._enabled, false);
});

function installerFixture(t) {
    const root = scratch(t), bin = path.join(root, 'bin');
    const app = path.join(root, 'app'), home = path.join(root, 'home');
    const featuresDir = path.join(root, 'features');
    fs.cpSync(path.join(feature, 'extension'), path.join(featuresDir, 'global-dictation-gnome/extension'), {recursive: true});
    const uid = process.getuid() || 1000;
    write(path.join(bin, 'id'), `#!/bin/sh\nprintf "${uid}\\n"\n`, 0o755);
    // Model trusted sandbox ancestors independently of the host cache's umask.
    // Inside the fixture use real modes and ownership, with a root-run UID shim.
    write(path.join(bin, 'stat'), [
        '#!/bin/bash', 'target="$4"',
        'read -r owner mode < <(/usr/bin/stat -c "%u %a" -- "$target")',
        `[[ "$owner" != ${process.getuid()} ]] || owner=${uid}`,
        'if [[ "$target" == / || "$TEST_GNOME_FIXTURE_ROOT" == "$target/"* ]]; then',
        '    owner=0; mode=755', 'fi',
        `[[ "$target" != "\${TEST_GNOME_FOREIGN_PATH:-}" ]] || owner=${uid + 1}`,
        '[[ "$target" != "${TEST_GNOME_ROOT_OWNER_PATH:-}" ]] || owner=0',
        'printf "%s %s\\n" "$owner" "$mode"', '',
    ].join('\n'), 0o755);
    write(path.join(bin, 'gnome-shell'), '#!/bin/sh\nprintf "GNOME Shell 48.2\\n"\n', 0o755);
    write(path.join(app, 'resources/native/codex-global-dictation-linux'), '#!/bin/sh\nexit 0\n', 0o755);
    fs.mkdirSync(home, {mode: 0o700});
    const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home,
        XDG_CURRENT_DESKTOP: 'GNOME', XDG_SESSION_CLASS: 'user', TEST_GNOME_FIXTURE_ROOT: root,
        XDG_DATA_HOME: '', CODEX_LINUX_APP_DIR: app, CODEX_LINUX_FEATURES_DIR: featuresDir};
    const parent = path.join(home, '.local/share/gnome-shell/extensions');
    const destination = path.join(parent, uuid);
    function run(overrides = {}) {
        const result = spawnSync('bash', [path.join(feature, 'install-extension.sh')], {
            env: {...env, ...overrides}, encoding: 'utf8', timeout: 7000});
        assert.equal(result.status, 0, result.stderr); return result;
    }
    function clean() {
        assert.deepEqual(fs.readdirSync(parent), [uuid]);
    }
    return {root, bin, app, home, featuresDir, env, parent, destination, run, clean, uid};
}

test('installer sync is explicit, idempotent and updates transactionally with a canonical helper config', t => {
    const f = installerFixture(t);
    assert.match(f.run().stderr, /Installed\/updated.*Enable .*log out/);
    const config = JSON.parse(fs.readFileSync(path.join(f.destination, 'config.json')));
    assert.equal(config.helperPath, fs.realpathSync(path.join(f.app, 'resources/native/codex-global-dictation-linux')));
    const before = fs.statSync(f.destination).ino;
    write(path.join(f.bin, 'mktemp'), '#!/bin/sh\nexit 1\n', 0o755);
    assert.equal(f.run().stderr, ''); assert.equal(fs.statSync(f.destination).ino, before);
    fs.unlinkSync(path.join(f.bin, 'mktemp'));
    fs.appendFileSync(path.join(f.featuresDir, 'global-dictation-gnome/extension/extension.js'), '\n// update\n');
    assert.match(f.run().stderr, /Installed\/updated/);
    assert.match(fs.readFileSync(path.join(f.destination, 'extension.js'), 'utf8'), /update/);
    f.clean();
});

test('installer rejects non-GNOME desktops and non-user sessions before probing or writing', t => {
    const f = installerFixture(t), probe = path.join(f.root, 'gnome-probe');
    // GNOME is installed and compatible, but must never be probed on rejected sessions.
    write(path.join(f.bin, 'gnome-shell'), '#!/bin/sh\nprintf "probed\\n" > "$GNOME_PROBE_LOG"\nprintf "GNOME Shell 48.2\\n"\n', 0o755);
    const data = path.join(f.root, 'rejected-data');
    for (const desktop of ['', 'KDE', 'sway', 'Hyprland', 'gnome', 'GNOMEish',
        'GNOME-Classic', 'ubuntu:GNOME-Classic', 'other:X-GNOME']) {
        assert.match(f.run({XDG_CURRENT_DESKTOP: desktop, GNOME_PROBE_LOG: probe,
            XDG_DATA_HOME: data}).stderr, /Active desktop is not GNOME/);
        assert.equal(fs.existsSync(probe), false);
        assert.equal(fs.existsSync(data), false);
        assert.deepEqual(fs.readdirSync(f.home), []);
    }
    for (const sessionClass of ['greeter', 'lock-screen', 'background', 'manager', 'USER']) {
        assert.match(f.run({XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', XDG_SESSION_CLASS: sessionClass,
            GNOME_PROBE_LOG: probe, XDG_DATA_HOME: data}).stderr, /Not a user session/);
        assert.equal(fs.existsSync(probe), false);
        assert.equal(fs.existsSync(data), false);
        assert.deepEqual(fs.readdirSync(f.home), []);
    }
});

test('installer accepts exact GNOME desktop components and an unspecified session class', t => {
    const f = installerFixture(t);
    for (const desktop of ['GNOME', 'ubuntu:GNOME', 'GNOME:GNOME-Classic', 'custom:GNOME:other']) {
        const result = f.run({XDG_CURRENT_DESKTOP: desktop});
        assert.doesNotMatch(result.stderr, /WARN:/);
        assert.ok(fs.existsSync(f.destination));
        f.clean();
    }
    assert.equal(f.run({XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', XDG_SESSION_CLASS: ''}).stderr, '');
    f.clean();
});

test('installer refuses root, unsupported or hanging GNOME, missing helper and unsafe environment paths', t => {
    const f = installerFixture(t);
    write(path.join(f.bin, 'id'), '#!/bin/sh\necho 0\n', 0o755);
    assert.match(f.run().stderr, /root/);
    write(path.join(f.bin, 'id'), `#!/bin/sh\necho ${f.uid}\n`, 0o755);
    for (const version of ['44.9', '51.0', '145.0']) {
        write(path.join(f.bin, 'gnome-shell'), `#!/bin/sh\necho 'GNOME Shell ${version}'\n`, 0o755);
        assert.match(f.run().stderr, /Unsupported/);
    }
    write(path.join(f.bin, 'gnome-shell'), '#!/bin/sh\nsleep 10\n', 0o755);
    assert.match(f.run().stderr, /timeout/);
    write(path.join(f.bin, 'gnome-shell'), '#!/bin/sh\necho "GNOME Shell 45.0"\n', 0o755);
    assert.match(f.run({HOME: '', XDG_DATA_HOME: ''}).stderr, /unavailable/);
    for (const unsafe of ['relative', '/', `${f.root}/../escape`, `${f.root}/bad\npath`])
        assert.match(f.run({XDG_DATA_HOME: unsafe}).stderr, /Unsafe/);
    fs.symlinkSync(f.home, path.join(f.root, 'link'));
    assert.match(f.run({XDG_DATA_HOME: path.join(f.root, 'link/data')}).stderr, /Unsafe/);
    fs.chmodSync(path.join(f.app, 'resources/native/codex-global-dictation-linux'), 0o644);
    assert.match(f.run().stderr, /not executable/);
    assert.equal(fs.existsSync(f.parent), false);
});

test('installer rejects writable or foreign-owned ancestors before installing', t => {
    const f = installerFixture(t);
    for (const mode of [0o775, 0o777]) {
        fs.chmodSync(f.home, mode);
        assert.match(f.run().stderr, /Unsafe data directory/);
        assert.equal(fs.existsSync(f.parent), false);
        assert.equal(fs.statSync(f.home).mode & 0o777, mode);
    }
    fs.chmodSync(f.home, 0o755);
    assert.match(f.run({TEST_GNOME_FOREIGN_PATH: f.home}).stderr, /Unsafe data directory/);
    assert.equal(fs.existsSync(f.parent), false);
    fs.mkdirSync(f.parent, {recursive: true, mode: 0o700});
    fs.chmodSync(f.parent, 0o777);
    assert.match(f.run().stderr, /Unsafe extension parent/);
    assert.deepEqual(fs.readdirSync(f.parent), []);
    assert.equal(fs.statSync(f.parent).mode & 0o777, 0o777);
    fs.chmodSync(f.parent, 0o755);
    assert.match(f.run({TEST_GNOME_FOREIGN_PATH: f.parent}).stderr, /Unsafe extension parent/);
    assert.deepEqual(fs.readdirSync(f.parent), []);
});

test('installer preserves writable or foreign-owned managed state without repairing it', t => {
    const f = installerFixture(t); f.run();
    const paths = [f.destination, ...['extension.js', 'metadata.json', 'config.json',
        '.chatgpt-community-owned.sha256'].map(file => path.join(f.destination, file))];
    for (const target of paths) {
        const original = fs.statSync(target).mode & 0o777;
        for (const writable of [0o020, 0o002]) {
            fs.chmodSync(target, original | writable);
            assert.match(f.run().stderr, /Unmanaged or modified/);
            assert.equal(fs.statSync(target).mode & 0o777, original | writable);
            f.clean();
        }
        fs.chmodSync(target, original);
        for (const ownerOverride of ['TEST_GNOME_FOREIGN_PATH', 'TEST_GNOME_ROOT_OWNER_PATH']) {
            assert.match(f.run({[ownerOverride]: target}).stderr, /Unmanaged or modified/);
            f.clean();
        }
    }
    assert.equal(f.run().stderr, '');
});

test('backup permissions changed during rename are rejected and preserved', t => {
    const f = installerFixture(t); f.run();
    const before = fs.readFileSync(path.join(f.destination, 'extension.js'), 'utf8');
    fs.appendFileSync(path.join(f.featuresDir, 'global-dictation-gnome/extension/extension.js'), '//new\n');
    write(path.join(f.bin, 'mv'), '#!/bin/sh\n/usr/bin/mv "$@" || exit 1\ncase "$3" in *.previous.*) chmod 0666 "$3/extension.js";; esac\n', 0o755);
    assert.match(f.run().stderr, /Backup changed during rename; restoring user changes/);
    assert.equal(fs.readFileSync(path.join(f.destination, 'extension.js'), 'utf8'), before);
    assert.equal(fs.statSync(path.join(f.destination, 'extension.js')).mode & 0o777, 0o666);
    f.clean();
});

test('installer preserves unmanaged, modified, extra-entry and symlinked destinations', t => {
    const f = installerFixture(t);
    fs.mkdirSync(f.destination, {recursive: true, mode: 0o700}); write(path.join(f.destination, 'mine'), 'keep');
    assert.match(f.run().stderr, /Unmanaged or modified/);
    assert.equal(fs.readFileSync(path.join(f.destination, 'mine'), 'utf8'), 'keep');
    fs.rmSync(f.destination, {recursive: true}); f.run();
    for (const filename of ['extension.js', 'config.json', '.chatgpt-community-owned.sha256']) {
        const file = path.join(f.destination, filename), original = fs.readFileSync(file);
        fs.appendFileSync(file, 'modified');
        assert.match(f.run().stderr, /Unmanaged or modified/);
        assert.equal(fs.readFileSync(file, 'utf8'), `${original}modified`);
        fs.writeFileSync(file, original);
    }
    write(path.join(f.destination, 'extra'), 'keep');
    assert.match(f.run().stderr, /Unmanaged or modified/); fs.unlinkSync(path.join(f.destination, 'extra'));
    const saved = path.join(f.root, 'saved'); fs.renameSync(f.destination, saved);
    fs.symlinkSync(saved, f.destination); assert.match(f.run().stderr, /Unmanaged or modified/);
    assert.ok(fs.lstatSync(f.destination).isSymbolicLink()); fs.unlinkSync(f.destination);
    fs.renameSync(saved, f.destination);
    fs.renameSync(path.join(f.destination, 'extension.js'), path.join(f.root, 'extension.js'));
    fs.symlinkSync(path.join(f.root, 'extension.js'), path.join(f.destination, 'extension.js'));
    assert.match(f.run().stderr, /Unmanaged or modified/); f.clean();
});

test('lock excludes concurrent launchers and failed promotion restores the previous extension', t => {
    const f = installerFixture(t); f.run();
    const lock = path.join(f.parent, `.${uuid}.lock`); fs.mkdirSync(lock);
    assert.match(f.run().stderr, /Another sync/); assert.ok(fs.existsSync(lock)); fs.rmdirSync(lock);
    const before = fs.readFileSync(path.join(f.destination, 'extension.js'), 'utf8');
    fs.appendFileSync(path.join(f.featuresDir, 'global-dictation-gnome/extension/extension.js'), '//new\n');
    write(path.join(f.bin, 'mv'), '#!/bin/sh\nif [ "$1" = "-T" ]; then exit 1; fi\nexec /usr/bin/mv "$@"\n', 0o755);
    assert.match(f.run().stderr, /Source sync failed/);
    assert.equal(fs.readFileSync(path.join(f.destination, 'extension.js'), 'utf8'), before); f.clean();
});

test('backup edited by rename is restored without promotion or retained scratch', t => {
    const f = installerFixture(t); f.run();
    const before = fs.readFileSync(path.join(f.destination, 'extension.js'), 'utf8');
    fs.appendFileSync(path.join(f.featuresDir, 'global-dictation-gnome/extension/extension.js'), '//new\n');
    write(path.join(f.bin, 'mv'), '#!/bin/sh\n/usr/bin/mv "$@" || exit 1\ncase "$3" in *.previous.*) printf "//user edit\\n" >> "$3/extension.js";; esac\n', 0o755);
    const result = f.run();
    assert.match(result.stderr, /Backup changed during rename; restoring user changes/);
    assert.doesNotMatch(result.stderr, /Installed\/updated/);
    assert.equal(fs.readFileSync(path.join(f.destination, 'extension.js'), 'utf8'), `${before}//user edit\n`);
    f.clean();
    assert.match(f.run().stderr, /Unmanaged or modified/);
    f.clean();
});

test('backup edited during promotion is preserved before cleanup while unchanged scratch is removed', t => {
    const f = installerFixture(t); f.run();
    const before = fs.readFileSync(path.join(f.destination, 'extension.js'), 'utf8');
    fs.appendFileSync(path.join(f.featuresDir, 'global-dictation-gnome/extension/extension.js'), '//new\n');
    write(path.join(f.bin, 'mv'), [
        '#!/bin/sh', '/usr/bin/mv "$@" || exit 1',
        'if [ "$1" = "-T" ]; then', '    parent="${3%/*}"',
        `    for backup in "$parent"/.${uuid}.previous.*; do`,
        '        printf "//user edit\\n" >> "$backup/extension.js"',
        '    done', 'fi', '',
    ].join('\n'), 0o755);
    const result = f.run();
    const entries = fs.readdirSync(f.parent);
    const backups = entries.filter(entry => entry.startsWith(`.${uuid}.previous.`));
    assert.equal(backups.length, 1);
    assert.deepEqual(entries.sort(), [uuid, ...backups].sort());
    const backup = path.join(f.parent, backups[0]);
    assert.ok(result.stderr.includes(`Preserved user changes at ${backup}`));
    assert.match(result.stderr, /Installed\/updated/);
    assert.equal(fs.readFileSync(path.join(backup, 'extension.js'), 'utf8'), `${before}//user edit\n`);
    assert.equal(fs.readFileSync(path.join(f.destination, 'extension.js'), 'utf8'), `${before}//new\n`);
    assert.equal(f.run().stderr, '');
    assert.equal(fs.readFileSync(path.join(backup, 'extension.js'), 'utf8'), `${before}//user edit\n`);
});

test('handled interruption immediately after backup rename restores the old directory', t => {
    const f = installerFixture(t); f.run();
    const before = fs.readFileSync(path.join(f.destination, 'extension.js'), 'utf8');
    fs.appendFileSync(path.join(f.featuresDir, 'global-dictation-gnome/extension/extension.js'), '//new\n');
    write(path.join(f.bin, 'mv'), '#!/bin/sh\n/usr/bin/mv "$@" || exit 1\ncase "$3" in *.previous.*) kill -TERM "$PPID";; esac\n', 0o755);
    assert.match(f.run().stderr, /Source sync interrupted/);
    assert.equal(fs.readFileSync(path.join(f.destination, 'extension.js'), 'utf8'), before);
    f.clean();
});

test('helper realpath and JSON escaping work with spaces, quotes and backslashes; XDG overrides HOME', t => {
    const f = installerFixture(t);
    const app = path.join(f.root, 'app "quote" \\ space'); fs.renameSync(f.app, app);
    const data = path.join(f.root, 'xdg data');
    assert.match(f.run({CODEX_LINUX_APP_DIR: app, XDG_DATA_HOME: data, HOME: ''}).stderr, /Installed\/updated/);
    const dir = path.join(data, 'gnome-shell/extensions', uuid);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))).helperPath,
        fs.realpathSync(path.join(app, 'resources/native/codex-global-dictation-linux')));
    assert.equal(fs.existsSync(f.parent), false);
});

test('framework stages resources/prelaunch without env, enforces requirement, removes disabled artifacts', t => {
    const root = scratch(t), featuresRoot = path.join(root, 'linux-features'), app = path.join(root, 'app');
    fs.cpSync(feature, path.join(featuresRoot, 'global-dictation-gnome'), {recursive: true});
    write(path.join(featuresRoot, 'global-dictation/feature.json'), JSON.stringify({
        id: 'global-dictation', title: 'Fixture parent', description: 'No native build in unit tests', defaultEnabled: false}));
    write(path.join(featuresRoot, 'global-dictation/README.md'), 'Fixture parent');
    const config = path.join(featuresRoot, 'features.json');
    write(config, JSON.stringify({enabled: ['global-dictation-gnome']}));
    const options = {featuresRoot, featuresConfigPath: config};
    assert.deepEqual(loadEnabledLinuxFeatures(options).map(f => f.id),
        ['global-dictation', 'global-dictation-gnome']);
    write(config, JSON.stringify({enabled: ['global-dictation', 'global-dictation-gnome']}));
    const plan = stageEnabledLinuxFeatureInstall(app, options);
    assert.equal(plan.resources.length, 1); assert.equal(plan.runtimeHooks.length, 1);
    assert.deepEqual(plan.runtimeHooks.map(hook => hook.key), ['prelaunch']);
    const extension = path.join(app, '.codex-linux/features/global-dictation-gnome/extension');
    assert.deepEqual(fs.readdirSync(extension).sort(), ['extension.js', 'metadata.json']);
    assert.equal(fs.existsSync(path.join(app, '.codex-linux/env.d')), false);
    assert.equal(fs.statSync(path.join(app, '.codex-linux/prelaunch.d/global-dictation-gnome-install-extension.sh')).mode & 0o777, 0o755);
    write(config, JSON.stringify({enabled: []}));
    stageEnabledLinuxFeatureInstall(app, options);
    assert.equal(fs.existsSync(extension), false);
    assert.equal(fs.existsSync(path.join(app, '.codex-linux/env.d')), false);
    assert.equal(fs.existsSync(path.join(app, '.codex-linux/prelaunch.d/global-dictation-gnome-install-extension.sh')), false);
});

test('update-builder includes enabled companion resources and snapshot, excludes disabled manifests', t => {
    const root = scratch(t), config = path.join(root, 'features.json');
    for (const enabled of [['global-dictation', 'global-dictation-gnome'], []]) {
        write(config, JSON.stringify({enabled}));
        const builder = path.join(root, enabled.length ? 'enabled-builder' : 'disabled-builder');
        const result = spawnSync('bash', ['-c', [
            'set -euo pipefail', '. "$1/scripts/lib/package-common.sh"',
            'stage_update_builder_linux_features_tree "$2"',
            'stage_update_builder_linux_features_config "$2"',
        ].join('\n'), 'test', repo, builder], {encoding: 'utf8', timeout: 15000,
            env: {...process.env, REPO_DIR: repo, APP_DIR: path.join(root, 'app'), CODEX_LINUX_FEATURES_CONFIG: config}});
        assert.equal(result.status, 0, result.stderr);
        const bundled = path.join(builder, 'linux-features/global-dictation-gnome');
        assert.equal(fs.existsSync(bundled), enabled.length > 0);
        if (enabled.length) {
            assert.equal(fs.readFileSync(path.join(bundled, 'extension/extension.js'), 'utf8'),
                fs.readFileSync(path.join(feature, 'extension/extension.js'), 'utf8'));
            assert.equal(fs.existsSync(path.join(bundled, 'env')), false);
            const bundledManifest = JSON.parse(fs.readFileSync(path.join(bundled, 'feature.json')));
            assert.deepEqual(Object.keys(bundledManifest.runtimeHooks), ['prelaunch']);
        }
        const snapshot = path.join(builder, 'linux-features/features.json');
        if (enabled.length)
            assert.deepEqual(JSON.parse(fs.readFileSync(snapshot)).enabled, enabled);
        else
            assert.equal(fs.existsSync(snapshot), false);
    }
});

test('metadata versions and manifest agree with installer; no clipboard or portal fallback implementation', () => {
    const metadata = JSON.parse(fs.readFileSync(path.join(feature, 'extension/metadata.json')));
    assert.equal(metadata.uuid, uuid); assert.deepEqual(metadata['shell-version'], ['45', '46', '47', '48', '49', '50']);
    const manifest = JSON.parse(fs.readFileSync(path.join(feature, 'feature.json')));
    assert.equal(manifest.defaultEnabled, false); assert.deepEqual(manifest.requires, ['global-dictation']);
    assert.deepEqual(Object.keys(manifest.runtimeHooks), ['prelaunch']);
    assert.equal(fs.existsSync(path.join(feature, 'env')), false);
    const source = fs.readFileSync(path.join(feature, 'extension/extension.js'), 'utf8');
    assert.doesNotMatch(source, /RemoteDesktop|org\.freedesktop\.portal|St\.Clipboard|set_text|\.notify_keyval\(/);
    assert.match(source, /\.notify_key\(/);
    const installer = fs.readFileSync(path.join(feature, 'install-extension.sh'), 'utf8');
    assert.doesNotMatch(installer, /\b(sudo|curl|wget)\b/);
    assert.doesNotMatch(installer, /^\s*gnome-extensions\s+enable/m);
});

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SERVICE = 'org.chatgpt.Community.Dictation';
const OBJECT = '/org/chatgpt/Community/Dictation';
const XML = `<node><interface name="org.chatgpt.Community.Dictation1">
<method name="GetVersion"><arg type="u" direction="out"/></method>
<method name="Paste"/>
</interface></node>`;
const ERROR = 'org.chatgpt.Community.Dictation1.Error.Rejected';
// Linux evdev codes, not XKB keycodes (+8) or keysyms: emulate physical Ctrl+V.
// notify_keyval can silently drop Latin v when the current layout is non-Latin.
const KEY_LEFTCTRL = 29;
const KEY_V = 47;
const MODIFIERS = Clutter.ModifierType.SHIFT_MASK |
    Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK |
    Clutter.ModifierType.MOD3_MASK | Clutter.ModifierType.MOD4_MASK |
    Clutter.ModifierType.MOD5_MASK | Clutter.ModifierType.SUPER_MASK |
    Clutter.ModifierType.HYPER_MASK | Clutter.ModifierType.META_MASK;

export default class DictationExtension extends Extension {
    enable() {
        this._generation = (this._generation ?? 0) + 1;
        this._enabled = false;
        this._nameReady = false;
        this._busy = false;
        try {
            this._readHelperPath();
            this._bus = Gio.DBus.session;
            this._keyboard = Clutter.get_default_backend().get_default_seat()
                .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            this._exported = Gio.DBusExportedObject.wrapJSObject(XML, this);
            this._exported.export(this._bus, OBJECT);
            this._enabled = true;
            this._owner = Gio.bus_own_name_on_connection(this._bus, SERVICE,
                Gio.BusNameOwnerFlags.NONE,
                () => { this._nameReady = this._enabled; },
                () => { this._nameReady = false; });
        } catch (error) {
            this.disable();
            console.error(`ChatGPT Community dictation companion: ${error.message}`);
        }
    }

    GetVersion() {
        return 1;
    }

    _focus() {
        if (!this._enabled || !this._nameReady || Main.sessionMode.isLocked ||
            !Main.sessionMode.hasWindows || Main.actionMode !== Shell.ActionMode.NORMAL ||
            Main.modalCount > 0 || global.stage.key_focus !== null)
            throw new Error('Shell is not in an unlocked normal application state');
        const window = global.display.focus_window;
        if (!window)
            throw new Error('No focused application window');
        if ((global.get_pointer()[2] & MODIFIERS) !== 0)
            throw new Error('Physical modifiers are pressed');
        return window;
    }

    _readHelperPath() {
        const [ok, bytes] = GLib.file_get_contents(`${this.path}/config.json`);
        if (!ok)
            throw new Error('Missing installer configuration');
        const config = JSON.parse(new TextDecoder().decode(bytes));
        if (config === null || typeof config !== 'object' || Array.isArray(config) ||
            typeof config.helperPath !== 'string' || !config.helperPath.startsWith('/') ||
            /[\x00-\x1f]/.test(config.helperPath))
            throw new Error('Invalid helper path');
        return config.helperPath;
    }

    _authorize(sender, cancellable) {
        return new Promise((resolve, reject) => {
            this._bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
                'org.freedesktop.DBus', 'GetConnectionUnixProcessID',
                new GLib.Variant('(s)', [sender]), new GLib.VariantType('(u)'),
                Gio.DBusCallFlags.NO_AUTO_START, 1000, cancellable,
                (connection, result) => {
                    try {
                        const [pid] = connection.call_finish(result).deep_unpack();
                        if (!Number.isInteger(pid) || pid <= 0 ||
                            GLib.file_read_link(`/proc/${pid}/exe`) !== this._readHelperPath())
                            throw new Error('Caller is not the installed dictation helper');
                        resolve();
                    } catch (error) {
                        reject(error);
                    }
                });
        });
    }

    async PasteAsync(_params, invocation) {
        let acquired = false;
        let cancellable;
        const generation = this._generation;
        try {
            if (this._busy)
                throw new Error('Paste is busy');
            const focus = this._focus();
            const sender = invocation.get_sender();
            if (typeof sender !== 'string' || !sender.startsWith(':'))
                throw new Error('Missing unique caller identity');
            this._busy = true;
            acquired = true;
            cancellable = new Gio.Cancellable();
            this._pending = cancellable;
            await this._authorize(sender, cancellable);
            if (generation !== this._generation || !this._enabled)
                throw new Error('Extension was disabled');
            if (this._focus() !== focus)
                throw new Error('Focus changed during authorization');
            this._pasteKeys();
            // Submission acknowledgement only: the application may ignore Ctrl+V.
            invocation.return_value(new GLib.Variant('()', []));
        } catch (error) {
            invocation.return_dbus_error(ERROR, error.message);
        } finally {
            if (acquired && this._pending === cancellable) {
                this._pending = null;
                this._busy = false;
            }
        }
    }

    _pasteKeys() {
        const keyboard = this._keyboard;
        const pressed = [];
        let failure;
        try {
            for (const key of [KEY_LEFTCTRL, KEY_V]) {
                // Include a failed press in cleanup: submission may have partly succeeded.
                pressed.push(key);
                keyboard.notify_key(GLib.get_monotonic_time(), key, Clutter.KeyState.PRESSED);
            }
        } catch (error) {
            failure = error;
        } finally {
            for (const key of pressed.reverse()) {
                try {
                    keyboard.notify_key(GLib.get_monotonic_time(), key, Clutter.KeyState.RELEASED);
                } catch (error) {
                    failure ??= error;
                }
            }
        }
        if (failure)
            throw failure;
    }

    disable() {
        this._enabled = false;
        this._nameReady = false;
        this._generation = (this._generation ?? 0) + 1;
        this._pending?.cancel();
        this._pending = null;
        this._busy = false;
        if (this._owner)
            Gio.bus_unown_name(this._owner);
        this._owner = 0;
        this._exported?.unexport();
        this._exported = null;
        this._keyboard?.run_dispose();
        this._keyboard = null;
        this._bus = null;

    }
}

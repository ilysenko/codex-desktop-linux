import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SERVICE_NAME = 'com.openai.Codex.WindowControl';
const OBJECT_PATH = '/com/openai/Codex/WindowControl';
const BACKEND = 'gnome-shell-extension';

const WINDOW_CONTROL_XML = `
<node>
  <interface name="${SERVICE_NAME}">
    <method name="ListWindows">
      <arg name="json" type="s" direction="out"/>
    </method>
    <method name="ActivateWindow">
      <arg name="window_id" type="t" direction="in"/>
      <arg name="ok" type="b" direction="out"/>
      <arg name="message" type="s" direction="out"/>
    </method>
    <method name="CaptureScreenshot">
      <arg name="filename" type="s" direction="in"/>
      <arg name="ok" type="b" direction="out"/>
      <arg name="message" type="s" direction="out"/>
    </method>
    <method name="MoveWindow">
      <arg name="window_id" type="t" direction="in"/>
      <arg name="x" type="i" direction="in"/>
      <arg name="y" type="i" direction="in"/>
      <arg name="ok" type="b" direction="out"/>
      <arg name="message" type="s" direction="out"/>
    </method>
    <method name="ResizeWindow">
      <arg name="window_id" type="t" direction="in"/>
      <arg name="width" type="i" direction="in"/>
      <arg name="height" type="i" direction="in"/>
      <arg name="ok" type="b" direction="out"/>
      <arg name="message" type="s" direction="out"/>
    </method>
    <method name="GetMonitorLayout">
      <arg name="json" type="s" direction="out"/>
    </method>
  </interface>
</node>
`;

const WindowControlDBus = GObject.registerClass(
class WindowControlDBus extends GObject.Object {
    constructor() {
        super();

        this._dbusObject = Gio.DBusExportedObject.wrapJSObject(
            WINDOW_CONTROL_XML, this);
        this._dbusObject.export(Gio.DBus.session, OBJECT_PATH);
        this._nameId = Gio.DBus.session.own_name(
            SERVICE_NAME,
            Gio.BusNameOwnerFlags.NONE,
            null,
            () => log(`ChatGPT Window Control lost DBus name ${SERVICE_NAME}`));
    }

    destroy() {
        if (this._nameId) {
            Gio.DBus.session.unown_name(this._nameId);
            this._nameId = 0;
        }

        this._dbusObject?.unexport();
        this._dbusObject?.run_dispose();
        this._dbusObject = null;
    }

    ListWindowsAsync(_params, invocation) {
        this._returnJson(invocation, this._listWindows());
    }

    ActivateWindowAsync([windowId], invocation) {
        const requestedId = Number(windowId);
        const window = this._listMetaWindows().find(
            candidate => Number(candidate.get_id()) === requestedId);

        if (!window) {
            invocation.return_value(new GLib.Variant('(bs)', [
                false,
                `No window matched window_id ${requestedId}`,
            ]));
            return;
        }

        try {
            if (Main.overview.visible)
                Main.overview.hide();

            if (window.minimized && typeof window.unminimize === 'function')
                window.unminimize();

            Main.activateWindow(window, global.get_current_time());
            invocation.return_value(new GLib.Variant('(bs)', [
                true,
                `Activated window_id ${requestedId}`,
            ]));
        } catch (error) {
            invocation.return_value(new GLib.Variant('(bs)', [
                false,
                `Activation failed: ${error.message}`,
            ]));
        }
    }

    CaptureScreenshotAsync([filename], invocation) {
        const path = String(filename ?? '').trim();
        if (!this._isAllowedScreenshotPath(path)) {
            invocation.return_value(new GLib.Variant('(bs)', [
                false,
                'Screenshot path must be an absolute Codex temp PNG path',
            ]));
            return;
        }

        let stream = null;
        try {
            const file = Gio.File.new_for_path(path);
            stream = file.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            const screenshot = new Shell.Screenshot();
            screenshot.screenshot(false, stream, (_object, result) => {
                let ok = false;
                let message = path;
                try {
                    const finishResult = screenshot.screenshot_finish(result);
                    ok = Array.isArray(finishResult)
                        ? Boolean(finishResult[0])
                        : Boolean(finishResult);
                    if (!ok)
                        message = 'GNOME Shell screenshot returned false';
                } catch (error) {
                    message = `GNOME Shell screenshot failed: ${error.message}`;
                } finally {
                    try {
                        stream.close(null);
                    } catch (error) {
                        if (ok) {
                            ok = false;
                            message = `Failed to close screenshot stream: ${error.message}`;
                        }
                    }
                }
                invocation.return_value(new GLib.Variant('(bs)', [ok, message]));
            });
        } catch (error) {
            try {
                stream?.close(null);
            } catch (_) {
                // Best effort cleanup after the original failure.
            }
            invocation.return_value(new GLib.Variant('(bs)', [
                false,
                `Failed to start GNOME Shell screenshot: ${error.message}`,
            ]));
        }
    }

    MoveWindowAsync([windowId, x, y], invocation) {
        this._withWindow(windowId, invocation, window => {
            // move_frame positions the frame rect (what list_windows reports).
            window.move_frame(true, x, y);
            return `Moved window_id ${Number(windowId)} to ${x},${y}`;
        });
    }

    ResizeWindowAsync([windowId, width, height], invocation) {
        this._withWindow(windowId, invocation, window => {
            if (width <= 0 || height <= 0)
                throw new Error(`invalid size ${width}x${height}`);
            // GNOME 49 removed Meta.Window.get_maximized() (use is_maximized())
            // and dropped the flags argument from unmaximize(). Support both
            // API generations: shell 45-48 (get_maximized + flags) and 49+.
            if (window.is_maximized?.())
                window.unmaximize();
            else if (window.get_maximized?.())
                window.unmaximize(Meta.MaximizeFlags.BOTH);
            const rect = window.get_frame_rect();
            window.move_resize_frame(true, rect.x, rect.y, width, height);
            return `Resized window_id ${Number(windowId)} to ${width}x${height}`;
        });
    }

    GetMonitorLayoutAsync(_params, invocation) {
        const monitors = Main.layoutManager.monitors.map(monitor => ({
            index: monitor.index,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            primary: monitor.index === Main.layoutManager.primaryIndex,
            scale: monitor.geometry_scale ?? 1,
        }));
        this._returnJson(invocation, monitors);
    }

    _withWindow(windowId, invocation, action) {
        const requestedId = Number(windowId);
        const window = this._listMetaWindows().find(
            candidate => Number(candidate.get_id()) === requestedId);

        if (!window) {
            invocation.return_value(new GLib.Variant('(bs)', [
                false,
                `No window matched window_id ${requestedId}`,
            ]));
            return;
        }

        try {
            const message = action(window);
            invocation.return_value(new GLib.Variant('(bs)', [
                true,
                message,
            ]));
        } catch (error) {
            invocation.return_value(new GLib.Variant('(bs)', [
                false,
                `Window operation failed: ${error.message}`,
            ]));
        }
    }

    _returnJson(invocation, value) {
        invocation.return_value(new GLib.Variant('(s)', [
            JSON.stringify(value),
        ]));
    }

    _listWindows() {
        return this._listMetaWindows()
            .map(window => this._windowInfo(window))
            .filter(window => window !== null);
    }

    _listMetaWindows() {
        return global.get_window_actors()
            .map(actor => actor.meta_window)
            .filter(window => window && !window.is_override_redirect?.())
            .filter(window => window.get_window_type?.() !== Meta.WindowType.DESKTOP);
    }

    _windowInfo(window) {
        if (!window)
            return null;

        const app = Shell.WindowTracker.get_default().get_window_app(window);
        const rect = window.get_frame_rect();
        const workspace = window.get_workspace?.();

        return {
            window_id: Number(window.get_id()),
            title: window.get_title?.() ?? null,
            app_id: app?.get_id?.() ?? null,
            wm_class: window.get_wm_class?.() ?? null,
            pid: window.get_pid?.() ?? null,
            bounds: rect ? {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
            } : null,
            workspace: workspace?.index?.() ?? null,
            focused: global.display.focus_window === window && !Main.overview.visible,
            hidden: window.minimized ?? false,
            client_type: clientTypeName(window.get_client_type?.()),
            backend: BACKEND,
        };
    }

    _isAllowedScreenshotPath(path) {
        if (!path.endsWith('.png'))
            return false;

        const canonicalPath = GLib.canonicalize_filename(path, null);
        const tmpDir = GLib.canonicalize_filename(GLib.get_tmp_dir(), null);
        if (GLib.path_get_dirname(canonicalPath) !== tmpDir)
            return false;

        const basename = GLib.path_get_basename(canonicalPath);
        return basename.startsWith('computer-use-linux-gnome-extension-');
    }
});

function clientTypeName(value) {
    if (value === undefined || value === null)
        return null;
    if (value === Meta.WindowClientType.WAYLAND)
        return 'wayland';
    if (value === Meta.WindowClientType.X11)
        return 'x11';
    return 'unknown';
}

export default class CodexWindowControlExtension extends Extension {
    enable() {
        this._dbusServer = new WindowControlDBus();
    }

    disable() {
        this._dbusServer?.destroy();
        this._dbusServer = null;
    }
}

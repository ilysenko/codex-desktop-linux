// SPDX-License-Identifier: MIT
//! A virtual pen and touchscreen for background pointer input on GNOME.
//!
//! GNOME runs one seat, so the uinput absolute pointer and the portal move
//! the pointer the user holds. A tablet tool is different: mutter gives each
//! tablet its own sprite and cursor (meta-wayland-tablet-tool.c renders the
//! tool's cursor through "meta_backend_get_cursor_renderer_for_sprite" with
//! the tablet's sprite), and sends its events through zwp_tablet_tool_v2, not
//! wl_pointer, so the user's mouse cursor stays where it is. Touch points are
//! their own sequences too. The idea and the tested approach come from
//! Ondra-Zik (agent-sh/computer-use-linux#480).
//!
//! What the pen leaves to the desktop:
//! - mutter focuses a window on a tablet tip press as on a button press, so a
//!   pen click gives the clicked window the user's keyboard focus;
//! - mutter sends tablet events only to clients that bound the tablet seat
//!   ("meta_wayland_tablet_tool_ensure_resource"); there is no pointer
//!   emulation, so a client without tablet support never sees the pen
//!   (GTK 3 and 4, Qt, Chromium, Firefox and Xwayland bind it);
//! - scrolling is a one-finger touch pan, which only scrolls where the app
//!   pans on touch;
//! - a hovering pen leaves proximity after [HOVER_LIFETIME].
//!
//! Mapping: mutter maps a tablet or touchscreen to one monitor when its
//! "output" setting (org.gnome.desktop.peripherals.tablet or .touchscreen,
//! at the path keyed by the device's vendor and product id) names one, or
//! when a heuristic matches (meta-input-mapper.c: the device name contains
//! the monitor's vendor, its physical size matches, or, for a touchscreen
//! with no match, the builtin panel). An unmapped device covers the whole
//! layout. The devices here declare one unit per millimetre over a 65 m
//! range, so the size heuristic never matches; where a mapping still differs
//! from what a point needs, the device's output setting is written, mutter's
//! org.gnome.Mutter.InputMapping.GetDeviceMapping confirms where the device
//! now maps before any event goes out, and the setting is reset when the
//! device goes away. Those settings paths belong to this server's own
//! vendor and product ids; no other device's setting is touched.
//!
//! Lifecycle: created on first use, the pen leaves proximity after
//! [HOVER_LIFETIME], and both devices go away after
//! [crate::agent_seat::IDLE_LIFETIME] without use, or when the server exits.

use crate::agent_seat::SessionFacts;
use anyhow::{anyhow, bail, Context, Result};
use evdev::{
    uinput::VirtualDevice, AbsInfo, AbsoluteAxisCode, AttributeSet, BusType, EventType, InputEvent,
    InputId, KeyCode, PropType, UinputAbsSetup,
};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The route name results report for pen input.
pub(crate) const PEN_ROUTE: &str = "gnome-pen";
/// The route name results report for touch scrolling.
pub(crate) const TOUCH_ROUTE: &str = "gnome-touch";
/// How long the pen hovers after an action before it leaves proximity.
pub(crate) const HOVER_LIFETIME: Duration = Duration::from_secs(8);
/// The pan distance of one wheel notch, in logical pixels.
pub(crate) const PAN_PER_NOTCH: f64 = 60.0;
/// A pan stays this far inside the window and the monitor edges: GNOME
/// Shell starts its edge swipes from a monitor's edge.
const PAN_MARGIN: f64 = 48.0;
/// The shortest pan stroke worth sending.
const MIN_STROKE: f64 = 40.0;
const MAX_STROKES: usize = 40;

const VENDOR: u16 = 0x6375;
const PEN_PRODUCT: u16 = 0x7065;
const TOUCH_PRODUCT: u16 = 0x7463;
const AXIS_MAX: i32 = 65535;
const PRESSURE_MAX: i32 = 4095;
const MAPPING_TIMEOUT: Duration = Duration::from_secs(3);
const STEP: Duration = Duration::from_millis(12);

const PEN_NAME: &str = "codex-computer-use-linux virtual pen";
const TOUCH_NAME: &str = "codex-computer-use-linux virtual touch";

/// Why the pen has no route in a session, or None when it has one. Pure:
/// the facts come from [SessionFacts::from_env].
pub(crate) fn classify(facts: &SessionFacts) -> std::result::Result<(), String> {
    let desktop = facts.current_desktop.as_str();
    let has = |name: &str| desktop.split(':').any(|part| part.trim() == name);
    if facts.native_x11 {
        return Err("the session runs X11, where a tablet moves the core pointer".to_string());
    }
    if desktop.contains("gnome") && facts.wayland {
        return Ok(());
    }
    if has("kde") {
        return Err("KWin gives a tablet its own cursor too (Plasma 6.2 and later), but maps a tablet without a configured output to the active output, which follows the user's pointer, and needs a configured output for touch, so the virtual pen is GNOME only".to_string());
    }
    Err("the virtual pen needs GNOME on Wayland: on wlroots compositors, Hyprland, niri and COSMIC a tablet moves the one seat cursor".to_string())
}

/// The pen route here, or why there is none.
pub(crate) fn availability() -> std::result::Result<(), String> {
    classify(&SessionFacts::from_env())?;
    let writable = std::ffi::CString::new("/dev/uinput")
        .ok()
        // SAFETY: path is a NUL-terminated CString that outlives the call,
        // and access only reads it.
        .is_some_and(|path| unsafe { libc::access(path.as_ptr(), libc::W_OK) } == 0);
    if !writable {
        return Err("/dev/uinput is not writable for this user, so no virtual pen can be made (the same access the uinput pointer needs)".to_string());
    }
    Ok(())
}

/// Doctor line for the pen route.
pub(crate) fn doctor_summary() -> serde_json::Value {
    match availability() {
        Ok(()) => serde_json::json!({
            "available": true,
            "routes": [PEN_ROUTE, TOUCH_ROUTE],
            "note": "Background click and drag use a virtual pen, background scroll a one-finger touch pan; the user's mouse pointer does not move. A pen tap or a touch gives the window keyboard focus. Apps without tablet support never see the pen, scrolling needs touch panning in the app, a drag stays inside one window, and the pen hovers for up to 8 s after an action. Needs the Codex GNOME Shell extension to check the window under the point.",
        }),
        Err(reason) => serde_json::json!({ "available": false, "reason": reason }),
    }
}

/// A pan stroke: where the finger goes down and where it lifts, in logical
/// layout pixels.
pub(crate) type Stroke = ((f64, f64), (f64, f64));

/// A rectangle in logical layout pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub(crate) fn contains(&self, (x, y): (f64, f64)) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }

    fn inset(&self, margin: f64) -> Rect {
        Rect {
            x: self.x + margin,
            y: self.y + margin,
            width: (self.width - 2.0 * margin).max(0.0),
            height: (self.height - 2.0 * margin).max(0.0),
        }
    }

    fn intersect(&self, other: &Rect) -> Rect {
        let left = self.x.max(other.x);
        let top = self.y.max(other.y);
        let right = (self.x + self.width).min(other.x + other.width);
        let bottom = (self.y + self.height).min(other.y + other.height);
        Rect {
            x: left,
            y: top,
            width: (right - left).max(0.0),
            height: (bottom - top).max(0.0),
        }
    }

    fn union(&self, other: &Rect) -> Rect {
        let left = self.x.min(other.x);
        let top = self.y.min(other.y);
        let right = (self.x + self.width).max(other.x + other.width);
        let bottom = (self.y + self.height).max(other.y + other.height);
        Rect {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
        }
    }
}

/// A monitor's EDID triple and connector, as mutter's "output" setting
/// names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MonitorSpec {
    pub connector: String,
    pub vendor: String,
    pub product: String,
    pub serial: String,
}

/// A logical monitor: its rectangle, the monitor it shows, and its
/// rotation (DisplayConfig's transform, 0 for none).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Monitor {
    pub rect: Rect,
    pub spec: MonitorSpec,
    pub transform: u32,
}

/// One monitor of DisplayConfig.GetCurrentState: its spec, and the size of
/// its current mode.
#[derive(Debug, Clone)]
pub(crate) struct PhysicalMonitor {
    pub spec: MonitorSpec,
    pub current_mode: Option<(i32, i32)>,
}

/// One logical monitor of DisplayConfig.GetCurrentState.
#[derive(Debug, Clone)]
pub(crate) struct LogicalMonitorState {
    pub x: i32,
    pub y: i32,
    pub scale: f64,
    pub transform: u32,
    pub connectors: Vec<String>,
}

/// The logical layout from GetCurrentState's parts. In logical layout mode
/// a monitor's logical size is its mode divided by its scale; in physical
/// mode it is the mode. Rotations by 90 or 270 degrees swap the sides.
pub(crate) fn layout_from_state(
    monitors: &[PhysicalMonitor],
    logical: &[LogicalMonitorState],
    layout_logical: bool,
) -> Vec<Monitor> {
    logical
        .iter()
        .filter_map(|state| {
            let monitor = state.connectors.first().and_then(|connector| {
                monitors
                    .iter()
                    .find(|monitor| &monitor.spec.connector == connector)
            })?;
            let (mut width, mut height) = monitor.current_mode?;
            if state.transform % 2 == 1 {
                std::mem::swap(&mut width, &mut height);
            }
            let scale = if layout_logical && state.scale.is_finite() && state.scale > 0.0 {
                state.scale
            } else {
                1.0
            };
            Some(Monitor {
                rect: Rect {
                    x: f64::from(state.x),
                    y: f64::from(state.y),
                    width: (f64::from(width) / scale).round(),
                    height: (f64::from(height) / scale).round(),
                },
                spec: monitor.spec.clone(),
                transform: state.transform,
            })
        })
        .collect()
}

/// The layout the devices are mapped in, and how capture pixels map into it.
#[derive(Debug, Clone)]
pub(crate) struct Layout {
    pub monitors: Vec<Monitor>,
    pub bounds: Rect,
    /// Capture pixels per logical pixel.
    pub scale: f64,
}

impl Layout {
    /// The layout for a whole-desktop capture of capture_width x
    /// capture_height pixels; an error when the capture is not the layout at
    /// one scale.
    pub(crate) fn new(
        monitors: Vec<Monitor>,
        (capture_width, capture_height): (u32, u32),
    ) -> std::result::Result<Self, String> {
        let bounds = monitors
            .iter()
            .map(|monitor| monitor.rect)
            .reduce(|a, b| a.union(&b))
            .filter(|bounds| bounds.width > 0.0 && bounds.height > 0.0)
            .ok_or_else(|| "mutter reported no monitor".to_string())?;
        if capture_width == 0 || capture_height == 0 {
            return Err("the screenshot size is unknown; take a screenshot first".to_string());
        }
        let scale_x = f64::from(capture_width) / bounds.width;
        let scale_y = f64::from(capture_height) / bounds.height;
        if (scale_x - scale_y).abs() > 0.01 {
            return Err(format!(
                "the {capture_width}x{capture_height} screenshot does not cover the {}x{} monitor layout at one scale",
                bounds.width, bounds.height
            ));
        }
        Ok(Self {
            monitors,
            bounds,
            scale: scale_x,
        })
    }

    /// The logical point at the centre of capture pixel (x, y).
    pub(crate) fn logical_point(&self, x: i32, y: i32) -> (f64, f64) {
        (
            self.bounds.x + (f64::from(x) + 0.5) / self.scale,
            self.bounds.y + (f64::from(y) + 0.5) / self.scale,
        )
    }

    pub(crate) fn monitor_at(&self, point: (f64, f64)) -> Option<&Monitor> {
        self.monitors
            .iter()
            .find(|monitor| monitor.rect.contains(point))
    }
}

/// The device value for a logical point on a device mapped across area.
/// libinput scales a value v to "(v - min) * size / (max - min + 1)".
pub(crate) fn device_value(point: (f64, f64), area: &Rect) -> (i32, i32) {
    let axis = |value: f64, origin: f64, size: f64| {
        let span = f64::from(AXIS_MAX) + 1.0;
        (((value - origin) / size) * span)
            .floor()
            .clamp(0.0, f64::from(AXIS_MAX)) as i32
    };
    (
        axis(point.0, area.x, area.width),
        axis(point.1, area.y, area.height),
    )
}

fn window_rect(window: &crate::windowing::types::WindowInfo) -> Option<Rect> {
    let bounds = window.bounds.as_ref()?;
    Some(Rect {
        x: f64::from(bounds.x?),
        y: f64::from(bounds.y?),
        width: f64::from(bounds.width),
        height: f64::from(bounds.height),
    })
}

/// Checks that a logical point lies on the target window and that no
/// window above it covers the point. windows run bottom to top, as GNOME
/// Shell stacks them. Returns the target's rectangle.
pub(crate) fn check_point_on_target(
    windows: &[crate::windowing::types::WindowInfo],
    target_id: u64,
    point: (f64, f64),
) -> std::result::Result<Rect, String> {
    let target = windows
        .iter()
        .find(|window| window.window_id == target_id)
        .ok_or_else(|| format!("window_id {target_id} is not in GNOME Shell's window list"))?;
    if target.hidden {
        return Err(format!("window_id {target_id} is minimized"));
    }
    let rect = window_rect(target)
        .ok_or_else(|| format!("window_id {target_id} has no known position"))?;
    if !rect.contains(point) {
        return Err(format!(
            "({:.0}, {:.0}) in layout pixels is outside window_id {target_id}, which spans ({:.0}, {:.0}) to ({:.0}, {:.0})",
            point.0,
            point.1,
            rect.x,
            rect.y,
            rect.x + rect.width,
            rect.y + rect.height
        ));
    }
    let same_workspace =
        |window: &crate::windowing::types::WindowInfo| match (window.workspace, target.workspace) {
            (Some(a), Some(b)) => a == b || a < 0 || b < 0,
            _ => true,
        };
    // The focused window is on the workspace the user sees. With none (the
    // overview is open, or nothing has focus) that workspace is unknown.
    let focused = windows.iter().find(|window| window.focused).ok_or_else(|| {
        "no window has keyboard focus, so the visible workspace is unknown (the overview may be open)"
            .to_string()
    })?;
    if focused.workspace.is_none_or(|index| index < 0)
        && target.workspace.is_some_and(|index| index >= 0)
    {
        return Err(
            "the focused window is on every workspace, so the visible workspace is unknown"
                .to_string(),
        );
    }
    if !same_workspace(focused) {
        return Err(format!(
            "window_id {target_id} is not on the workspace the user sees"
        ));
    }
    let top = windows
        .iter()
        .rev()
        .filter(|window| !window.hidden && same_workspace(window))
        .find(|window| window_rect(window).is_some_and(|rect| rect.contains(point)))
        .expect("the target contains the point");
    if top.window_id != target_id {
        return Err(format!(
            "window_id {} ({}) is stacked above window_id {target_id} at that point",
            top.window_id,
            top.title.as_deref().unwrap_or("untitled")
        ));
    }
    Ok(rect)
}

/// Finger strokes that pan by motion (logical pixels, along one axis), each
/// starting at start and staying inside bounds. A point outside bounds, or
/// one with too little room in the pan's direction, has no strokes.
pub(crate) fn pan_strokes(
    start: (f64, f64),
    motion: (f64, f64),
    bounds: &Rect,
) -> std::result::Result<Vec<Stroke>, String> {
    let horizontal = motion.0 != 0.0;
    let distance = if horizontal { motion.0 } else { motion.1 };
    if !bounds.contains(start) {
        return Err(format!(
            "a touch pan must start {PAN_MARGIN:.0} px or more from the monitor's edges and 8 px or more inside the window, and ({:.0}, {:.0}) is not",
            start.0, start.1
        ));
    }
    let (lo, hi, begin, fixed) = if horizontal {
        (bounds.x, bounds.x + bounds.width, start.0, start.1)
    } else {
        (bounds.y, bounds.y + bounds.height, start.1, start.0)
    };
    let backward = distance < 0.0;
    let room = if backward { begin - lo } else { hi - begin };
    let mut remaining = distance.abs();
    if room < MIN_STROKE.min(remaining) {
        return Err(format!(
            "the point is {room:.0} px from where a pan in that direction must stop; scroll from a point farther from the window's or the monitor's edge"
        ));
    }
    let mut strokes = Vec::new();
    while remaining > 0.5 && strokes.len() < MAX_STROKES {
        let length = room.min(remaining);
        let end = if backward {
            begin - length
        } else {
            begin + length
        };
        let point = |along: f64| {
            if horizontal {
                (along, fixed)
            } else {
                (fixed, along)
            }
        };
        strokes.push((point(begin), point(end)));
        remaining -= length;
    }
    if remaining > 0.5 {
        return Err(format!(
            "the scroll needs more than {MAX_STROKES} touch strokes from this point; scroll fewer pages, or from a point with more room in that direction"
        ));
    }
    Ok(strokes)
}

/// Where a pan may run: the window and its monitor, away from both edges.
pub(crate) fn pan_bounds(window: &Rect, monitor: &Rect) -> Rect {
    window.inset(8.0).intersect(&monitor.inset(PAN_MARGIN))
}

/// Pen buttons.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PenButton {
    /// The tip.
    Tip,
    /// BTN_STYLUS, the lower barrel button: a middle click (GTK and
    /// Xwayland map it to button 2, as xf86-input-wacom does).
    Lower,
    /// BTN_STYLUS2, the upper barrel button: a right click (button 3).
    Upper,
}

/// What the devices do, in logical layout pixels.
#[derive(Debug, Clone)]
pub(crate) enum Gesture {
    Click {
        at: (f64, f64),
        button: PenButton,
        count: u32,
    },
    /// Tip down at the first point, through the rest, up at the last.
    Drag { path: Vec<(f64, f64)> },
    /// Touch strokes, each a press, a move and a release.
    Pan { strokes: Vec<Stroke> },
}

/// Why the devices sent nothing, or what failed after input started.
#[derive(Debug)]
pub(crate) enum PenError {
    /// The desktop or this user lacks what the route needs; nothing was sent.
    NoRoute(String),
    /// A failure before any event; nothing was sent.
    NotSent(String),
    /// A failure after input started.
    Partial(String),
}

impl std::fmt::Display for PenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PenError::NoRoute(message)
            | PenError::NotSent(message)
            | PenError::Partial(message) => f.write_str(message),
        }
    }
}

/// Where a device sends its events: the uinput device, or a recorder in
/// tests.
pub(crate) trait Events: Send {
    fn emit(&mut self, events: &[InputEvent]) -> std::io::Result<()>;
}

impl Events for VirtualDevice {
    fn emit(&mut self, events: &[InputEvent]) -> std::io::Result<()> {
        VirtualDevice::emit(self, events)
    }
}

fn abs(code: AbsoluteAxisCode, value: i32) -> InputEvent {
    InputEvent::new(EventType::ABSOLUTE.0, code.0, value)
}

fn key(code: KeyCode, value: i32) -> InputEvent {
    InputEvent::new(EventType::KEY.0, code.0, value)
}

/// The pen's event frames, apart from the device so tests can read them.
pub(crate) struct PenEvents<E: Events> {
    events: E,
    in_proximity: bool,
    tip_down: bool,
}

impl<E: Events> PenEvents<E> {
    pub(crate) fn new(events: E) -> Self {
        Self {
            events,
            in_proximity: false,
            tip_down: false,
        }
    }

    fn send(&mut self, frame: &[InputEvent]) -> Result<()> {
        self.events.emit(frame).context("uinput write failed")
    }

    /// Enters proximity at value, or moves there. Entering again resets
    /// libinput's motion history, so the tool lands exactly on the point.
    pub(crate) fn hover(&mut self, (x, y): (i32, i32), fresh: bool) -> Result<()> {
        if fresh && self.in_proximity {
            self.leave()?;
        }
        if self.in_proximity {
            return self.send(&[
                abs(AbsoluteAxisCode::ABS_X, x),
                abs(AbsoluteAxisCode::ABS_Y, y),
            ]);
        }
        self.send(&[
            abs(AbsoluteAxisCode::ABS_X, x),
            abs(AbsoluteAxisCode::ABS_Y, y),
            abs(AbsoluteAxisCode::ABS_PRESSURE, 0),
            key(KeyCode::BTN_TOOL_PEN, 1),
        ])?;
        self.in_proximity = true;
        Ok(())
    }

    pub(crate) fn press(&mut self, button: PenButton, down: bool) -> Result<()> {
        let value = i32::from(down);
        match button {
            PenButton::Tip => {
                self.send(&[
                    abs(
                        AbsoluteAxisCode::ABS_PRESSURE,
                        if down { PRESSURE_MAX / 2 } else { 0 },
                    ),
                    key(KeyCode::BTN_TOUCH, value),
                ])?;
                self.tip_down = down;
                Ok(())
            }
            PenButton::Lower => self.send(&[key(KeyCode::BTN_STYLUS, value)]),
            PenButton::Upper => self.send(&[key(KeyCode::BTN_STYLUS2, value)]),
        }
    }

    /// A few more frames at value, one unit apart, before a press or
    /// release there: without them GTK reported a drag's release short of
    /// its end point.
    pub(crate) fn settle(&mut self, (x, y): (i32, i32)) -> Result<()> {
        for step in 0..4 {
            let nudge = if step % 2 == 0 { 1 } else { 0 };
            let jittered = if x < AXIS_MAX { x + nudge } else { x - nudge };
            self.send(&[
                abs(AbsoluteAxisCode::ABS_X, jittered),
                abs(AbsoluteAxisCode::ABS_Y, y),
            ])?;
            std::thread::sleep(Duration::from_millis(8));
        }
        self.send(&[
            abs(AbsoluteAxisCode::ABS_X, x),
            abs(AbsoluteAxisCode::ABS_Y, y),
        ])
    }

    /// Leaves proximity, lifting the tip and both buttons first.
    pub(crate) fn leave(&mut self) -> Result<()> {
        if !self.in_proximity {
            return Ok(());
        }
        self.send(&[
            abs(AbsoluteAxisCode::ABS_PRESSURE, 0),
            key(KeyCode::BTN_TOUCH, 0),
            key(KeyCode::BTN_STYLUS, 0),
            key(KeyCode::BTN_STYLUS2, 0),
            key(KeyCode::BTN_TOOL_PEN, 0),
        ])?;
        self.in_proximity = false;
        self.tip_down = false;
        Ok(())
    }
}

/// The touchscreen's event frames.
pub(crate) struct TouchEvents<E: Events> {
    events: E,
    tracking_id: i32,
}

impl<E: Events> TouchEvents<E> {
    pub(crate) fn new(events: E) -> Self {
        Self {
            events,
            tracking_id: 0,
        }
    }

    fn send(&mut self, frame: &[InputEvent]) -> Result<()> {
        self.events.emit(frame).context("uinput write failed")
    }

    pub(crate) fn down(&mut self, (x, y): (i32, i32)) -> Result<()> {
        self.tracking_id = (self.tracking_id + 1) % 65535;
        self.send(&[
            abs(AbsoluteAxisCode::ABS_MT_SLOT, 0),
            abs(AbsoluteAxisCode::ABS_MT_TRACKING_ID, self.tracking_id),
            abs(AbsoluteAxisCode::ABS_MT_POSITION_X, x),
            abs(AbsoluteAxisCode::ABS_MT_POSITION_Y, y),
            key(KeyCode::BTN_TOUCH, 1),
            abs(AbsoluteAxisCode::ABS_X, x),
            abs(AbsoluteAxisCode::ABS_Y, y),
        ])
    }

    pub(crate) fn motion(&mut self, (x, y): (i32, i32)) -> Result<()> {
        self.send(&[
            abs(AbsoluteAxisCode::ABS_MT_SLOT, 0),
            abs(AbsoluteAxisCode::ABS_MT_POSITION_X, x),
            abs(AbsoluteAxisCode::ABS_MT_POSITION_Y, y),
            abs(AbsoluteAxisCode::ABS_X, x),
            abs(AbsoluteAxisCode::ABS_Y, y),
        ])
    }

    pub(crate) fn up(&mut self) -> Result<()> {
        self.send(&[
            abs(AbsoluteAxisCode::ABS_MT_SLOT, 0),
            abs(AbsoluteAxisCode::ABS_MT_TRACKING_ID, -1),
            key(KeyCode::BTN_TOUCH, 0),
        ])
    }
}

/// Which of the two devices.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Pen,
    Touch,
}

impl Kind {
    fn settings(self) -> String {
        match self {
            Kind::Pen => format!(
                "org.gnome.desktop.peripherals.tablet:/org/gnome/desktop/peripherals/tablets/{VENDOR:04x}:{PEN_PRODUCT:04x}/"
            ),
            Kind::Touch => format!(
                "org.gnome.desktop.peripherals.touchscreen:/org/gnome/desktop/peripherals/touchscreens/{VENDOR:04x}:{TOUCH_PRODUCT:04x}/"
            ),
        }
    }
}

fn axis(code: AbsoluteAxisCode, max: i32, resolution: i32) -> UinputAbsSetup {
    UinputAbsSetup::new(code, AbsInfo::new(0, 0, max, 0, 0, resolution))
}

fn create(kind: Kind) -> Result<(VirtualDevice, PathBuf)> {
    if cfg!(test) {
        bail!("unit tests do not create real uinput devices");
    }
    // One unit per millimetre: a 65 m device, far from any monitor's size.
    let builder = VirtualDevice::builder().context("uinput builder (is /dev/uinput writable?)")?;
    let mut device = match kind {
        Kind::Pen => builder
            .name(PEN_NAME)
            .input_id(InputId::new(BusType::BUS_VIRTUAL, VENDOR, PEN_PRODUCT, 1))
            .with_properties(&AttributeSet::from_iter([PropType::DIRECT]))?
            .with_absolute_axis(&axis(AbsoluteAxisCode::ABS_X, AXIS_MAX, 1))?
            .with_absolute_axis(&axis(AbsoluteAxisCode::ABS_Y, AXIS_MAX, 1))?
            .with_absolute_axis(&axis(AbsoluteAxisCode::ABS_PRESSURE, PRESSURE_MAX, 0))?
            .with_keys(&AttributeSet::from_iter([
                KeyCode::BTN_TOOL_PEN,
                KeyCode::BTN_TOUCH,
                KeyCode::BTN_STYLUS,
                KeyCode::BTN_STYLUS2,
            ]))?
            .build(),
        Kind::Touch => builder
            .name(TOUCH_NAME)
            .input_id(InputId::new(BusType::BUS_VIRTUAL, VENDOR, TOUCH_PRODUCT, 1))
            .with_properties(&AttributeSet::from_iter([PropType::DIRECT]))?
            .with_absolute_axis(&axis(AbsoluteAxisCode::ABS_X, AXIS_MAX, 1))?
            .with_absolute_axis(&axis(AbsoluteAxisCode::ABS_Y, AXIS_MAX, 1))?
            .with_absolute_axis(&axis(AbsoluteAxisCode::ABS_MT_SLOT, 1, 0))?
            .with_absolute_axis(&axis(AbsoluteAxisCode::ABS_MT_TRACKING_ID, 65535, 0))?
            .with_absolute_axis(&axis(AbsoluteAxisCode::ABS_MT_POSITION_X, AXIS_MAX, 1))?
            .with_absolute_axis(&axis(AbsoluteAxisCode::ABS_MT_POSITION_Y, AXIS_MAX, 1))?
            .with_keys(&AttributeSet::from_iter([KeyCode::BTN_TOUCH]))?
            .build(),
    }
    .context("failed to create the uinput device")?;
    let node = device
        .enumerate_dev_nodes_blocking()
        .context("failed to read the uinput device node")?
        .filter_map(std::result::Result::ok)
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("event"))
        })
        .ok_or_else(|| anyhow!("the uinput device has no event node"))?;
    Ok((device, node))
}

/// Where mutter maps a device.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Mapping {
    /// Not known to mutter yet.
    Unknown,
    /// The whole layout.
    Layout,
    Monitor(Rect),
}

fn mapping(connection: &zbus::blocking::Connection, node: &Path) -> Result<Mapping> {
    let node = node
        .to_str()
        .ok_or_else(|| anyhow!("device node is not UTF-8"))?;
    let path = zbus::zvariant::ObjectPath::try_from(node).context("device node path")?;
    let reply = connection.call_method(
        Some("org.gnome.Mutter.InputMapping"),
        "/org/gnome/Mutter/InputMapping",
        Some("org.gnome.Mutter.InputMapping"),
        "GetDeviceMapping",
        &(path,),
    );
    match reply {
        Ok(message) => {
            let (x, y, width, height): (i32, i32, i32, i32) = message
                .body()
                .deserialize()
                .context("GetDeviceMapping returned an unexpected reply")?;
            Ok(Mapping::Monitor(Rect {
                x: f64::from(x),
                y: f64::from(y),
                width: f64::from(width),
                height: f64::from(height),
            }))
        }
        Err(zbus::Error::MethodError(_, Some(text), _)) if text.contains("not mapped") => {
            Ok(Mapping::Layout)
        }
        Err(zbus::Error::MethodError(_, Some(text), _)) if text.contains("does not exist") => {
            Ok(Mapping::Unknown)
        }
        Err(error) => Err(anyhow!(
            "mutter's org.gnome.Mutter.InputMapping did not answer: {error}"
        )),
    }
}

/// Waits until mutter maps the device as accept wants.
fn wait_mapping(
    connection: &zbus::blocking::Connection,
    node: &Path,
    accept: impl Fn(Mapping) -> bool,
) -> Result<Mapping> {
    let deadline = Instant::now() + MAPPING_TIMEOUT;
    loop {
        let current = mapping(connection, node)?;
        if accept(current) {
            return Ok(current);
        }
        if Instant::now() >= deadline {
            bail!("mutter maps the device to {current:?}, not where the point is");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn gvariant_string(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn set_output(kind: Kind, output: [&str; 4]) -> Result<()> {
    let value = format!("[{}]", output.map(gvariant_string).join(", "));
    let status = std::process::Command::new("gsettings")
        .args(["set", &kind.settings(), "output", &value])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .context("failed to run gsettings")?;
    if !status.status.success() {
        bail!(
            "gsettings set {} output failed: {}",
            kind.settings(),
            String::from_utf8_lossy(&status.stderr).trim()
        );
    }
    Ok(())
}

fn reset_output(kind: Kind) {
    let _ = std::process::Command::new("gsettings")
        .args(["reset", &kind.settings(), "output"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

struct Pen {
    events: PenEvents<VirtualDevice>,
    node: PathBuf,
    wrote_output: bool,
    /// Whether libinput has seen the pen leave proximity on its own.
    primed: bool,
}

impl Drop for Pen {
    fn drop(&mut self) {
        let _ = self.events.leave();
        if self.wrote_output {
            reset_output(Kind::Pen);
        }
    }
}

struct Touch {
    events: TouchEvents<VirtualDevice>,
    node: PathBuf,
    wrote_output: bool,
}

impl Drop for Touch {
    fn drop(&mut self) {
        if self.wrote_output {
            reset_output(Kind::Touch);
        }
    }
}

struct Devices {
    pen: Option<Pen>,
    touch: Option<Touch>,
    last_use: Instant,
}

static DEVICES: Mutex<Option<Devices>> = Mutex::new(None);
static REAPER: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn lock_devices() -> std::sync::MutexGuard<'static, Option<Devices>> {
    DEVICES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Lifts the pen out of proximity after [HOVER_LIFETIME] and removes the
/// devices after [crate::agent_seat::IDLE_LIFETIME]. One at a time; it exits
/// once the devices are gone.
fn start_reaper() {
    let spawned = std::thread::Builder::new()
        .name("cul-virtual-pen-reaper".to_string())
        .spawn(|| loop {
            let wait = {
                let mut guard = lock_devices();
                let Some(devices) = guard.as_mut() else {
                    REAPER.store(false, std::sync::atomic::Ordering::SeqCst);
                    return;
                };
                let idle = devices.last_use.elapsed();
                if idle >= crate::agent_seat::IDLE_LIFETIME {
                    let _process = process_lock(Duration::from_secs(2));
                    *guard = None;
                    REAPER.store(false, std::sync::atomic::Ordering::SeqCst);
                    return;
                }
                if idle >= HOVER_LIFETIME {
                    if let Some(pen) = devices.pen.as_mut() {
                        let _ = pen.events.leave();
                    }
                }
                // A later action can start a new hover: look again soon.
                Duration::from_millis(500)
            };
            std::thread::sleep(wait);
        });
    if spawned.is_err() {
        REAPER.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Removes both devices now. Called when the server exits.
pub(crate) fn shutdown() {
    let _process = process_lock(Duration::from_secs(2));
    *lock_devices() = None;
}

/// Held while this server sends through or removes its devices. Every
/// server's devices share one vendor and product id, so one settings path:
/// another server's reset must not land between this one's mapping check
/// and its events.
struct ProcessLock {
    /// The lock lasts as long as the open file.
    _file: std::fs::File,
}

fn process_lock(wait: Duration) -> std::result::Result<ProcessLock, PenError> {
    use std::os::fd::AsRawFd;
    let dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .unwrap_or_else(std::env::temp_dir);
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join("computer-use-linux-virtual-pen.lock"))
        .map_err(|error| PenError::NoRoute(format!("the virtual pen lock file: {error}")))?;
    let deadline = Instant::now() + wait;
    loop {
        // SAFETY: the descriptor belongs to file, which lives past the call.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(ProcessLock { _file: file });
        }
        if Instant::now() >= deadline {
            // A retry works once the other server is done: nothing was
            // sent, and normal input must not stand in for it.
            return Err(PenError::NotSent(
                "another computer-use-linux server is using the virtual pen; retry the call"
                    .to_string(),
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The area a device covers for point, writing its output setting when
/// mutter maps it elsewhere. touch_monitor is the monitor a touch must map
/// to when it cannot cover the whole layout.
fn covering_area(
    connection: &zbus::blocking::Connection,
    kind: Kind,
    node: &Path,
    wrote_output: &mut bool,
    point: (f64, f64),
    layout: &Layout,
) -> Result<Rect> {
    let current = wait_mapping(connection, node, |mapping| mapping != Mapping::Unknown)?;
    match (kind, current) {
        (_, Mapping::Layout) => return Ok(layout.bounds),
        // The pen covers the whole layout, where mutter's matrix is plain;
        // a monitor's would carry that monitor's rotation.
        (Kind::Touch, Mapping::Monitor(rect)) if rect.contains(point) => return Ok(rect),
        _ => {}
    }
    match kind {
        // An empty output setting turns mutter's heuristics off and leaves
        // the tablet on the whole layout.
        Kind::Pen => {
            set_output(kind, ["", "", "", ""])?;
            *wrote_output = true;
            wait_mapping(connection, node, |mapping| mapping == Mapping::Layout)?;
            Ok(layout.bounds)
        }
        // A touchscreen maps to one monitor (the builtin panel when nothing
        // else matches): name the one under the point.
        Kind::Touch => {
            let monitor = layout
                .monitor_at(point)
                .ok_or_else(|| anyhow!("no monitor holds the point"))?;
            let spec = &monitor.spec;
            set_output(
                kind,
                [&spec.vendor, &spec.product, &spec.serial, &spec.connector],
            )?;
            *wrote_output = true;
            match wait_mapping(connection, node, |mapping| match mapping {
                Mapping::Monitor(rect) => rect.contains(point),
                Mapping::Layout => true,
                Mapping::Unknown => false,
            })? {
                Mapping::Monitor(rect) => Ok(rect),
                _ => Ok(layout.bounds),
            }
        }
    }
}

/// Sends gesture through the pen or the touchscreen, creating them on
/// first use. Blocking: run it off the async runtime.
pub(crate) fn perform(gesture: &Gesture, layout: &Layout) -> std::result::Result<(), PenError> {
    let connection = zbus::blocking::Connection::session()
        .map_err(|error| PenError::NoRoute(format!("no session bus to reach mutter: {error}")))?;
    // A device node no device has: mutter answers "does not exist" when its
    // InputMapping service runs.
    mapping(
        &connection,
        Path::new("/dev/input/computer_use_linux_probe"),
    )
    .map_err(|error| PenError::NoRoute(format!("{error:#}")))?;
    let _process = process_lock(Duration::from_secs(5))?;
    let mut guard = lock_devices();
    let devices = guard.get_or_insert_with(|| Devices {
        pen: None,
        touch: None,
        last_use: Instant::now(),
    });
    devices.last_use = Instant::now();
    if !REAPER.swap(true, std::sync::atomic::Ordering::SeqCst) {
        start_reaper();
    }
    let result = match gesture {
        Gesture::Click { at, .. } => run_pen(&connection, devices, *at, gesture, layout),
        Gesture::Drag { path } => match path.first() {
            Some(first) => run_pen(&connection, devices, *first, gesture, layout),
            None => Err(PenError::NotSent("the drag has no points".to_string())),
        },
        Gesture::Pan { strokes } => match strokes.first() {
            Some((first, _)) => run_touch(&connection, devices, *first, strokes, layout),
            None => Err(PenError::NotSent("the pan has no strokes".to_string())),
        },
    };
    devices.last_use = Instant::now();
    // A device that failed mid-gesture could hold a button or a touch: drop
    // it, which lifts the pen and removes the device.
    if matches!(result, Err(PenError::Partial(_))) {
        devices.pen = None;
        devices.touch = None;
    }
    result
}

fn run_pen(
    connection: &zbus::blocking::Connection,
    devices: &mut Devices,
    first: (f64, f64),
    gesture: &Gesture,
    layout: &Layout,
) -> std::result::Result<(), PenError> {
    if devices.pen.is_none() {
        reset_output(Kind::Pen);
        let (device, node) = create(Kind::Pen).map_err(|error| {
            PenError::NoRoute(format!("the virtual pen could not be made: {error:#}"))
        })?;
        devices.pen = Some(Pen {
            events: PenEvents::new(device),
            node,
            wrote_output: false,
            primed: false,
        });
    }
    let pen = devices.pen.as_mut().expect("pen was just made");
    let area = covering_area(
        connection,
        Kind::Pen,
        &pen.node.clone(),
        &mut pen.wrote_output,
        first,
        layout,
    )
    .map_err(|error| PenError::NotSent(format!("{error:#}")))?;
    if let Gesture::Drag { path } = gesture {
        if let Some(outside) = path.iter().find(|point| !area.contains(**point)) {
            return Err(PenError::NotSent(format!(
                "the drag passes ({:.0}, {:.0}), outside the area the pen covers",
                outside.0, outside.1
            )));
        }
    }
    let started = |error: anyhow::Error| PenError::Partial(format!("{error:#}"));
    // libinput lifts a tablet out of proximity 50 ms after its last event
    // until the tablet sends a proximity out of its own. One in and out at
    // the first point, once mutter has the device, shows that it does, so
    // the pen then hovers until HOVER_LIFETIME lifts it.
    if !pen.primed {
        let value = device_value(first, &area);
        pen.events
            .hover(value, true)
            .and_then(|()| pen.events.leave())
            .map_err(|error| PenError::NotSent(format!("{error:#}")))?;
        pen.primed = true;
        std::thread::sleep(Duration::from_millis(30));
    }
    let events = &mut pen.events;
    match gesture {
        Gesture::Click { at, button, count } => {
            events
                .hover(device_value(*at, &area), true)
                .map_err(|error| PenError::NotSent(format!("{error:#}")))?;
            std::thread::sleep(Duration::from_millis(40));
            for _ in 0..(*count).max(1) {
                events.press(*button, true).map_err(started)?;
                std::thread::sleep(Duration::from_millis(40));
                events.press(*button, false).map_err(started)?;
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        Gesture::Drag { path } => {
            events
                .hover(device_value(path[0], &area), true)
                .map_err(|error| PenError::NotSent(format!("{error:#}")))?;
            std::thread::sleep(Duration::from_millis(40));
            events.press(PenButton::Tip, true).map_err(started)?;
            std::thread::sleep(Duration::from_millis(60));
            for point in &path[1..] {
                events
                    .hover(device_value(*point, &area), false)
                    .map_err(started)?;
                std::thread::sleep(crate::pointer_path::DRAG_STEP_DELAY);
            }
            let last = *path.last().expect("the drag has points");
            events.settle(device_value(last, &area)).map_err(started)?;
            std::thread::sleep(Duration::from_millis(60));
            events.press(PenButton::Tip, false).map_err(started)?;
        }
        Gesture::Pan { .. } => unreachable!("pans go through the touchscreen"),
    }
    Ok(())
}

fn run_touch(
    connection: &zbus::blocking::Connection,
    devices: &mut Devices,
    first: (f64, f64),
    strokes: &[Stroke],
    layout: &Layout,
) -> std::result::Result<(), PenError> {
    if devices.touch.is_none() {
        reset_output(Kind::Touch);
        let (device, node) = create(Kind::Touch).map_err(|error| {
            PenError::NoRoute(format!(
                "the virtual touchscreen could not be made: {error:#}"
            ))
        })?;
        devices.touch = Some(Touch {
            events: TouchEvents::new(device),
            node,
            wrote_output: false,
        });
    }
    let touch = devices.touch.as_mut().expect("touch was just made");
    let area = covering_area(
        connection,
        Kind::Touch,
        &touch.node.clone(),
        &mut touch.wrote_output,
        first,
        layout,
    )
    .map_err(|error| PenError::NotSent(format!("{error:#}")))?;
    if let Some((outside, _)) = strokes
        .iter()
        .flat_map(|(a, b)| [(*a, ()), (*b, ())])
        .find(|(point, _)| !area.contains(*point))
    {
        return Err(PenError::NotSent(format!(
            "the pan passes ({:.0}, {:.0}), outside the monitor the touchscreen covers",
            outside.0, outside.1
        )));
    }
    let events = &mut touch.events;
    for (index, (from, to)) in strokes.iter().enumerate() {
        let fail = |error: anyhow::Error| {
            if index == 0 {
                PenError::NotSent(format!("{error:#}"))
            } else {
                PenError::Partial(format!("{error:#}"))
            }
        };
        events.down(device_value(*from, &area)).map_err(fail)?;
        let started = |error: anyhow::Error| PenError::Partial(format!("{error:#}"));
        let length = ((to.0 - from.0).powi(2) + (to.1 - from.1).powi(2)).sqrt();
        let steps = ((length / 12.0).ceil() as usize).clamp(4, 60);
        for step in 1..=steps {
            let t = step as f64 / steps as f64;
            let point = (from.0 + (to.0 - from.0) * t, from.1 + (to.1 - from.1) * t);
            std::thread::sleep(STEP);
            events.motion(device_value(point, &area)).map_err(started)?;
        }
        // Rest before lifting, so the release carries no velocity and the
        // app does not fling past the distance.
        std::thread::sleep(Duration::from_millis(180));
        events.motion(device_value(*to, &area)).map_err(started)?;
        events.up().map_err(started)?;
        std::thread::sleep(Duration::from_millis(80));
    }
    Ok(())
}

/// Whether GNOME Shell's lock screen is up (org.gnome.ScreenSaver). The
/// window list cannot show it, and a tap there would reach the lock screen.
pub(crate) async fn screen_locked() -> bool {
    let Ok(connection) = zbus::Connection::session().await else {
        return false;
    };
    let reply = tokio::time::timeout(
        Duration::from_secs(2),
        connection.call_method(
            Some("org.gnome.ScreenSaver"),
            "/org/gnome/ScreenSaver",
            Some("org.gnome.ScreenSaver"),
            "GetActive",
            &(),
        ),
    )
    .await;
    matches!(reply, Ok(Ok(message)) if message.body().deserialize::<bool>().unwrap_or(false))
}

/// The logical layout from mutter's DisplayConfig.GetCurrentState.
pub(crate) async fn current_monitors() -> Result<Vec<Monitor>> {
    use std::collections::HashMap;
    use zbus::zvariant::OwnedValue;
    type Spec = (String, String, String, String);
    type Mode = (
        String,
        i32,
        i32,
        f64,
        f64,
        Vec<f64>,
        HashMap<String, OwnedValue>,
    );
    type MonitorEntry = (Spec, Vec<Mode>, HashMap<String, OwnedValue>);
    type LogicalEntry = (
        i32,
        i32,
        f64,
        u32,
        bool,
        Vec<Spec>,
        HashMap<String, OwnedValue>,
    );
    crate::diagnostics::hydrate_session_bus_env();
    let connection = zbus::Connection::session()
        .await
        .context("failed to connect to the session bus")?;
    let reply = tokio::time::timeout(
        Duration::from_secs(5),
        connection.call_method(
            Some("org.gnome.Mutter.DisplayConfig"),
            "/org/gnome/Mutter/DisplayConfig",
            Some("org.gnome.Mutter.DisplayConfig"),
            "GetCurrentState",
            &(),
        ),
    )
    .await
    .context("DisplayConfig.GetCurrentState timed out")?
    .context("DisplayConfig.GetCurrentState failed")?;
    let (_serial, monitors, logical, properties): (
        u32,
        Vec<MonitorEntry>,
        Vec<LogicalEntry>,
        HashMap<String, OwnedValue>,
    ) = reply
        .body()
        .deserialize()
        .context("DisplayConfig.GetCurrentState returned an unexpected reply")?;
    let is_true = |properties: &HashMap<String, OwnedValue>, key: &str| {
        properties
            .get(key)
            .and_then(|value| bool::try_from(value).ok())
            .unwrap_or(false)
    };
    let layout_logical = properties
        .get("layout-mode")
        .and_then(|value| u32::try_from(value).ok())
        .is_some_and(|mode| mode == 1);
    let monitors = monitors
        .into_iter()
        .map(|(spec, modes, _)| PhysicalMonitor {
            spec: MonitorSpec {
                connector: spec.0,
                vendor: spec.1,
                product: spec.2,
                serial: spec.3,
            },
            current_mode: modes
                .iter()
                .find(|mode| is_true(&mode.6, "is-current"))
                .map(|mode| (mode.1, mode.2)),
        })
        .collect::<Vec<_>>();
    let logical = logical
        .into_iter()
        .map(
            |(x, y, scale, transform, _primary, specs, _)| LogicalMonitorState {
                x,
                y,
                scale,
                transform,
                connectors: specs.into_iter().map(|spec| spec.0).collect(),
            },
        )
        .collect::<Vec<_>>();
    Ok(layout_from_state(&monitors, &logical, layout_logical))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windowing::types::{WindowBounds, WindowInfo};

    fn spec(connector: &str) -> MonitorSpec {
        MonitorSpec {
            connector: connector.to_string(),
            vendor: "DEL".to_string(),
            product: "U2720Q".to_string(),
            serial: "1".to_string(),
        }
    }

    #[test]
    fn layout_divides_modes_by_scale_and_swaps_rotated_sides() {
        let monitors = [
            PhysicalMonitor {
                spec: spec("eDP-1"),
                current_mode: Some((2560, 1600)),
            },
            PhysicalMonitor {
                spec: spec("DP-1"),
                current_mode: Some((3840, 2160)),
            },
        ];
        let logical = [
            LogicalMonitorState {
                x: 0,
                y: 0,
                scale: 1.6,
                transform: 0,
                connectors: vec!["eDP-1".to_string()],
            },
            LogicalMonitorState {
                x: 1600,
                y: 0,
                scale: 2.0,
                transform: 1,
                connectors: vec!["DP-1".to_string()],
            },
        ];
        let layout = layout_from_state(&monitors, &logical, true);
        assert_eq!(
            layout[0].rect,
            Rect {
                x: 0.0,
                y: 0.0,
                width: 1600.0,
                height: 1000.0
            }
        );
        assert_eq!(
            layout[1].rect,
            Rect {
                x: 1600.0,
                y: 0.0,
                width: 1080.0,
                height: 1920.0
            }
        );
        let physical = layout_from_state(&monitors, &logical, false);
        assert_eq!(physical[0].rect.width, 2560.0);
    }

    #[test]
    fn capture_pixels_map_into_the_layout_and_onto_the_device_range() {
        let monitors = vec![
            Monitor {
                rect: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 1920.0,
                    height: 1080.0,
                },
                spec: spec("DP-1"),
                transform: 0,
            },
            Monitor {
                rect: Rect {
                    x: 1920.0,
                    y: 0.0,
                    width: 1920.0,
                    height: 1080.0,
                },
                spec: spec("DP-2"),
                transform: 0,
            },
        ];
        // A 2x capture of a 3840x1080 layout.
        let layout = Layout::new(monitors.clone(), (7680, 2160)).unwrap();
        let point = layout.logical_point(4000, 1000);
        assert_eq!(point, (2000.25, 500.25));
        assert_eq!(layout.monitor_at(point).unwrap().spec.connector, "DP-2");
        // Unmapped: the device spans the layout; libinput's scaling of the
        // value lands back within one device unit of the point.
        let (x, y) = device_value(point, &layout.bounds);
        let back = |value: i32, size: f64| f64::from(value) * size / 65536.0;
        assert!((back(x, 3840.0) - 2000.25).abs() < 0.1);
        assert!((back(y, 1080.0) - 500.25).abs() < 0.1);
        // Mapped to the second monitor: the value is monitor-relative.
        let (x, _) = device_value(point, &monitors[1].rect);
        assert!((back(x, 1920.0) + 1920.0 - 2000.25).abs() < 0.1);
        assert!(Layout::new(monitors, (7680, 1080)).is_err());
    }

    fn window(id: u64, rect: (i32, i32, u32, u32), focused: bool) -> WindowInfo {
        WindowInfo {
            window_id: id,
            title: Some(format!("w{id}")),
            app_id: None,
            wm_class: None,
            pid: None,
            bounds: Some(WindowBounds {
                x: Some(rect.0),
                y: Some(rect.1),
                width: rect.2,
                height: rect.3,
            }),
            workspace: Some(0),
            focused,
            hidden: false,
            client_type: None,
            backend: "gnome-shell-extension".to_string(),
            terminal: None,
        }
    }

    #[test]
    fn the_point_must_be_on_the_target_and_not_under_a_window_above_it() {
        // Bottom to top: 1 (target), then 2 overlapping its right half.
        let mut windows = vec![
            window(1, (0, 0, 800, 600), false),
            window(2, (400, 0, 800, 600), true),
        ];
        assert!(check_point_on_target(&windows, 1, (100.0, 100.0)).is_ok());
        let covered = check_point_on_target(&windows, 1, (500.0, 100.0)).unwrap_err();
        assert!(covered.contains("window_id 2"), "{covered}");
        let outside = check_point_on_target(&windows, 1, (900.0, 100.0)).unwrap_err();
        assert!(outside.contains("outside window_id 1"), "{outside}");
        // The focused window is on another workspace: the target is not on
        // the one the user sees.
        windows[1].workspace = Some(1);
        let away = check_point_on_target(&windows, 1, (100.0, 100.0)).unwrap_err();
        assert!(
            away.contains("not on the workspace the user sees"),
            "{away}"
        );
        // With the focus on the target's workspace, a window elsewhere or a
        // minimized one does not cover the point.
        windows.push(window(3, (2000, 0, 100, 100), true));
        windows[1].focused = false;
        assert!(check_point_on_target(&windows, 1, (500.0, 100.0)).is_ok());
        windows[1].workspace = Some(0);
        windows[1].hidden = true;
        assert!(check_point_on_target(&windows, 1, (500.0, 100.0)).is_ok());
        // No focused window: the overview may be open.
        windows[2].focused = false;
        assert!(check_point_on_target(&windows, 1, (100.0, 100.0)).is_err());
        // The focused window is on every workspace: which one shows is unknown.
        windows[2].focused = true;
        windows[2].workspace = Some(-1);
        let sticky = check_point_on_target(&windows, 1, (100.0, 100.0)).unwrap_err();
        assert!(sticky.contains("every workspace"), "{sticky}");
        windows[2].workspace = Some(0);
        windows[0].hidden = true;
        assert!(check_point_on_target(&windows, 1, (100.0, 100.0)).is_err());
    }

    #[test]
    fn pans_split_into_strokes_inside_the_bounds() {
        let bounds = Rect {
            x: 100.0,
            y: 100.0,
            width: 400.0,
            height: 300.0,
        };
        // Scroll down 2 notches: the finger moves up from the point.
        let strokes = pan_strokes((300.0, 350.0), (0.0, -120.0), &bounds).unwrap();
        assert_eq!(strokes, vec![((300.0, 350.0), (300.0, 230.0))]);
        // Longer than the room above the point: every stroke starts at the
        // point again, so the same scroll area keeps panning.
        let strokes = pan_strokes((300.0, 350.0), (0.0, -500.0), &bounds).unwrap();
        assert_eq!(
            strokes,
            vec![
                ((300.0, 350.0), (300.0, 100.0)),
                ((300.0, 350.0), (300.0, 100.0)),
            ]
        );
        // Too little room above the point, or a point outside the bounds: no
        // stroke starts anywhere else.
        assert!(pan_strokes((300.0, 120.0), (0.0, -100.0), &bounds).is_err());
        assert!(pan_strokes((480.0, 50.0), (-60.0, 0.0), &bounds).is_err());
        // More than MAX_STROKES strokes: refused, not cut short.
        let refused = pan_strokes((300.0, 150.0), (0.0, -50.0 * 41.0), &bounds).unwrap_err();
        assert!(refused.contains("more than 40"), "{refused}");
        // Scroll right: the finger moves left.
        let strokes = pan_strokes((480.0, 150.0), (-60.0, 0.0), &bounds).unwrap();
        assert_eq!(strokes, vec![((480.0, 150.0), (420.0, 150.0))]);
        let tiny = Rect {
            x: 0.0,
            y: 0.0,
            width: 30.0,
            height: 30.0,
        };
        assert!(pan_strokes((10.0, 10.0), (0.0, 60.0), &tiny).is_err());
    }

    #[test]
    fn only_gnome_on_wayland_gets_the_pen() {
        let facts = |desktop: &str, wayland: bool, native_x11: bool| SessionFacts {
            native_x11,
            wayland,
            current_desktop: desktop.to_string(),
            ..SessionFacts::default()
        };
        assert!(classify(&facts("ubuntu:gnome", true, false)).is_ok());
        assert!(classify(&facts("gnome", false, true)).is_err());
        assert!(classify(&facts("kde", true, false))
            .unwrap_err()
            .contains("KWin"));
        assert!(classify(&facts("sway", true, false)).is_err());
    }

    #[derive(Clone, Default)]
    struct Recorded(std::sync::Arc<std::sync::Mutex<Vec<(u16, u16, i32)>>>);

    impl Events for Recorded {
        fn emit(&mut self, events: &[InputEvent]) -> std::io::Result<()> {
            let mut all = self.0.lock().unwrap();
            all.extend(
                events
                    .iter()
                    .map(|event| (event.event_type().0, event.code(), event.value())),
            );
            Ok(())
        }
    }

    #[test]
    fn a_right_click_is_the_upper_barrel_button_while_hovering() {
        let recorded = Recorded::default();
        let mut pen = PenEvents::new(recorded.clone());
        pen.hover((10, 20), true).unwrap();
        pen.press(PenButton::Upper, true).unwrap();
        pen.press(PenButton::Upper, false).unwrap();
        pen.leave().unwrap();
        let keys: Vec<(u16, i32)> = recorded
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|(kind, _, _)| *kind == EventType::KEY.0)
            .map(|(_, code, value)| (*code, *value))
            .collect();
        assert_eq!(
            keys[..3],
            [
                (KeyCode::BTN_TOOL_PEN.0, 1),
                (KeyCode::BTN_STYLUS2.0, 1),
                (KeyCode::BTN_STYLUS2.0, 0),
            ]
        );
        assert_eq!(keys.last(), Some(&(KeyCode::BTN_TOOL_PEN.0, 0)));
        assert!(!keys
            .iter()
            .any(|(code, value)| *code == KeyCode::BTN_TOUCH.0 && *value == 1));
    }
}

// SPDX-License-Identifier: MIT
//! A second input focus for the agent, on desktops that already ship one.
//!
//! Background delivery must not move the user's keyboard focus or pointer.
//! Two desktop families provide a separate focus without patches:
//!
//! - X11: XInput 2 multi-pointer (MPX). The server creates a master
//!   pointer/keyboard pair for the agent ("XIChangeHierarchy" AddMaster), each
//!   with its own XTEST slave. This connection names the agent pointer as its
//!   ClientPointer, so core XTEST events from it go to the agent pair
//!   ("PickPointer"/"PickKeyboard" in the X server's xtest.c), and
//!   "XISetFocus" moves only the agent keyboard's focus. The user's master
//!   keeps its own focus and cursor. Window managers do not know about the
//!   second master; see [X11_WM_NOTE].
//! - Sway 1.10 and later: an "ext-transient-seat-v1" seat. A virtual keyboard
//!   and a virtual pointer are created on that seat's "wl_seat", and
//!   "zwlr_foreign_toplevel_handle_v1.activate" with that seat focuses the
//!   target for the agent seat only (sway's "handle_foreign_activate_request"
//!   focuses the seat it is given). The compositor removes a transient seat
//!   when its client disconnects, so a crash cannot leave one behind.
//!
//! The seat exists only while background delivery is in use. The X11 master
//! is created on the first call that needs it and removed after
//! [IDLE_LIFETIME] without one, or when the server exits. The sway seat lives
//! for one call: clients that pick a wl_seat on their own (wtype) would bind
//! it, and some clients mishandle a second wl_seat (Zed,
//! zed-industries/zed#66735).
//!
//! Other desktops have no shipped multi-seat or per-window input path, and
//! [availability] says why; Hyprland's "sendkeystate" dispatcher is the one
//! per-window keyboard path and lives in "hyprland_input".

use crate::hyprland_input::KeyPress;
use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How long an unused agent seat stays. Matches the indicator, which also
/// treats ten idle minutes as the end of an agent's work.
pub(crate) const IDLE_LIFETIME: Duration = Duration::from_secs(600);
const CALL_TIMEOUT: Duration = Duration::from_secs(5);
/// Name prefix of the X11 master pair; the server pid follows.
pub(crate) const X11_MASTER_PREFIX: &str = "codex-computer-use-linux agent ";

/// Why the X11 agent pointer is refused under a window manager. Window
/// managers grab buttons on client frames for any master and answer with
/// XSetInputFocus, which moves the user's keyboard; with openbox an agent
/// click moved the user's focus. Keys reach the window manager only through
/// its grabs, and grabbed chords are refused, so keyboard input stays.
pub(crate) const X11_WM_NOTE: &str = "A window manager is running, and window managers act on the agent pointer's clicks with the user's keyboard focus (they focus the clicked window for the user), so X11 has no background click or scroll while one runs. Background keys still work, except chords the window manager grabs.";

pub(crate) const OTHER_ROUTES: &str = "An element target (element_index or a selector), a browser_tab, or a terminal running in tmux still works in the background.";

/// The seat route available in this session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SeatKind {
    /// XInput 2 master pointer/keyboard pair on a native X11 server.
    X11Master,
    /// ext-transient-seat-v1 seat on sway.
    SwayTransientSeat,
    /// Hyprland "sendkeystate": keys to a named window, no pointer.
    HyprlandSendKeyState,
}

/// The session facts [classify] reads, taken from the environment.
#[derive(Debug, Clone, Default)]
pub(crate) struct SessionFacts {
    pub native_x11: bool,
    pub wayland: bool,
    pub current_desktop: String,
    pub sway: bool,
    pub hyprland: bool,
    pub niri: bool,
}

impl SeatKind {
    pub(crate) fn name(self) -> &'static str {
        match self {
            SeatKind::X11Master => "x11-master",
            SeatKind::SwayTransientSeat => "sway-transient-seat",
            SeatKind::HyprlandSendKeyState => "hyprland-send-key-state",
        }
    }
}

/// Why a sway client cannot receive the agent seat, read from its process.
/// GTK binds the wl_seat globals it sees while opening the display and none
/// added later (gdk/wayland/gdkdisplay-wayland.c runs its seat closures only
/// in _gdk_wayland_display_open), and Chromium binds one wl_seat for its
/// lifetime (ui/ozone/platform/wayland/host/wayland_seat.cc returns when
/// "connection->seat_" is set). Firefox and Thunderbird use GTK.
pub(crate) fn seatless_client(pid: Option<u32>) -> Option<&'static str> {
    let pid = pid?;
    let maps = std::fs::read_to_string(format!("/proc/{pid}/maps")).unwrap_or_default();
    let chromium_pak = std::fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        .and_then(|exe| {
            exe.parent()
                .map(|dir| dir.join("chrome_100_percent.pak").exists())
        })
        .unwrap_or(false);
    seatless_toolkit(&maps, chromium_pak)
}

pub(crate) fn seatless_toolkit(maps: &str, chromium_pak: bool) -> Option<&'static str> {
    if chromium_pak || maps.contains("/libcef.so") {
        return Some("a Chromium or Electron app, and Chromium binds only the first wl_seat, so it never sees the agent seat.");
    }
    if maps.contains("/libgtk-4.so") {
        return Some("a GTK 4 app, and GTK binds only the wl_seats present when it started, so it never sees the agent seat.");
    }
    if maps.contains("/libgtk-3.so") {
        return Some("a GTK 3 app, and GTK binds only the wl_seats present when it started, so it never sees the agent seat.");
    }
    None
}

impl SessionFacts {
    pub(crate) fn from_env() -> Self {
        let var = |name: &str| {
            std::env::var(name)
                .ok()
                .filter(|value| !value.trim().is_empty())
        };
        let current_desktop = [
            var("XDG_CURRENT_DESKTOP"),
            var("XDG_SESSION_DESKTOP"),
            var("DESKTOP_SESSION"),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(":")
        .to_ascii_lowercase();
        Self {
            native_x11: crate::x11_display::is_native_x11_session(),
            wayland: var("WAYLAND_DISPLAY").is_some(),
            sway: var("SWAYSOCK").is_some() || desktop_has(&current_desktop, "sway"),
            hyprland: var("HYPRLAND_INSTANCE_SIGNATURE").is_some(),
            niri: var("NIRI_SOCKET").is_some() || desktop_has(&current_desktop, "niri"),
            current_desktop,
        }
    }
}

fn desktop_has(desktops: &str, name: &str) -> bool {
    desktops.split(':').any(|desktop| desktop.trim() == name)
}

/// Picks the seat route for a session, or says why it has none. Pure: the
/// facts come from [SessionFacts::from_env].
pub(crate) fn classify(facts: &SessionFacts) -> std::result::Result<SeatKind, String> {
    let desktop = facts.current_desktop.as_str();
    let refuse = |reason: &str| Err(format!("{reason} {OTHER_ROUTES}"));
    if desktop.contains("gnome") {
        return refuse("GNOME runs one seat and Mutter has no per-window input request, so the agent cannot get its own keyboard focus there.");
    }
    if facts.native_x11 {
        return Ok(SeatKind::X11Master);
    }
    if facts.hyprland {
        return Ok(SeatKind::HyprlandSendKeyState);
    }
    if facts.sway {
        return Ok(SeatKind::SwayTransientSeat);
    }
    if desktop_has(desktop, "kde") {
        return refuse("KWin runs one seat (one SeatInterface) and has no per-window input request, so the agent cannot get its own keyboard focus on KDE Plasma.");
    }
    if desktop_has(desktop, "cosmic") {
        return refuse("cosmic-comp creates one seat and has no transient-seat or per-window input request, so the agent cannot get its own keyboard focus on COSMIC.");
    }
    if facts.niri || desktop_has(desktop, "niri") {
        return refuse("niri runs one seat and has no transient-seat or per-window input request, so the agent cannot get its own keyboard focus on niri.");
    }
    if desktop_has(desktop, "labwc") {
        return refuse("labwc runs one seat and focuses foreign-toplevel requests on it, so the agent cannot get its own keyboard focus on labwc.");
    }
    if desktop_has(desktop, "river") {
        return refuse("river-classic runs one seat (multiple seats are a TODO there), so the agent cannot get its own keyboard focus on river.");
    }
    if facts.wayland {
        return refuse("This Wayland compositor is not one where the agent seat was checked to leave the user's focus alone (sway 1.10+ is).");
    }
    refuse("No X11 or Wayland session was found for the agent seat.")
}

/// The seat route here, or the refusal.
pub(crate) fn availability() -> std::result::Result<SeatKind, String> {
    classify(&SessionFacts::from_env())
}

/// One key with its modifiers, resolved to a keysym.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Stroke {
    pub keysym: u32,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
}

impl Stroke {
    fn plain(keysym: u32) -> Self {
        Self {
            keysym,
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
        }
    }

    fn modifier_keysyms(&self) -> Vec<u32> {
        let mut keysyms = Vec::new();
        for (on, keysym) in [
            (self.ctrl, KEYSYM_CONTROL_L),
            (self.alt, KEYSYM_ALT_L),
            (self.shift, KEYSYM_SHIFT_L),
            (self.meta, KEYSYM_SUPER_L),
        ] {
            if on && keysym != self.keysym {
                keysyms.push(keysym);
            }
        }
        keysyms
    }
}

const KEYSYM_SHIFT_L: u32 = 0xffe1;
const KEYSYM_CONTROL_L: u32 = 0xffe3;
const KEYSYM_ALT_L: u32 = 0xffe9;
const KEYSYM_SUPER_L: u32 = 0xffeb;
const KEYSYM_RETURN: u32 = 0xff0d;
const KEYSYM_TAB: u32 = 0xff09;

/// Keysym for an X keysym name such as "Return", "a" or "F5".
pub(crate) fn keysym_for_name(name: &str) -> Option<u32> {
    static NAMES: OnceLock<HashMap<&'static str, u32>> = OnceLock::new();
    let names = NAMES.get_or_init(|| {
        let mut names = HashMap::new();
        for raw in (0u32..=0xffff).chain(0x1008_ff00..=0x1008_ffff) {
            if let Some(full) = xkeysym::Keysym::new(raw).name() {
                if let Some(short) = full.strip_prefix("XK_") {
                    names.entry(short).or_insert(raw);
                }
            }
        }
        names
    });
    names.get(name).copied()
}

/// Keysym that types ch. Control characters other than newline and tab
/// have none.
pub(crate) fn keysym_for_char(ch: char) -> Option<u32> {
    match ch {
        '\n' => Some(KEYSYM_RETURN),
        '\t' => Some(KEYSYM_TAB),
        ch if ch.is_control() => None,
        ch => Some(xkeysym::Keysym::from_char(ch).raw()),
    }
}

/// Strokes for literal text; errors name the first character with no keysym.
pub(crate) fn text_strokes(text: &str) -> std::result::Result<Vec<Stroke>, String> {
    text.chars()
        .map(|ch| {
            keysym_for_char(ch)
                .map(Stroke::plain)
                .ok_or_else(|| format!("Literal text was not sent: {ch:?} has no key to type."))
        })
        .collect()
}

/// Stroke for a press_key chord parsed by "hyprland_input::chord_to_key_press".
pub(crate) fn chord_stroke(press: &KeyPress) -> std::result::Result<Stroke, String> {
    let keysym =
        keysym_for_name(&press.key).ok_or_else(|| format!("Key {:?} has no keysym.", press.key))?;
    let mut stroke = Stroke::plain(keysym);
    for modifier in press.mods.split_whitespace() {
        match modifier {
            "CTRL" => stroke.ctrl = true,
            "ALT" => stroke.alt = true,
            "SHIFT" => stroke.shift = true,
            "SUPER" => stroke.meta = true,
            other => return Err(format!("Unknown modifier {other}.")),
        }
    }
    Ok(stroke)
}

/// The window the agent seat focuses or clicks.
#[derive(Debug, Clone)]
pub(crate) struct SeatTarget {
    pub window_id: u64,
    pub app_id: Option<String>,
    pub wm_class: Option<String>,
    pub title: Option<String>,
    pub pid: Option<u32>,
    /// In sway's scratchpad: activating it would show it to the user.
    pub hidden: bool,
}

impl From<&crate::windowing::types::WindowInfo> for SeatTarget {
    fn from(window: &crate::windowing::types::WindowInfo) -> Self {
        Self {
            window_id: window.window_id,
            app_id: window.app_id.clone(),
            wm_class: window.wm_class.clone(),
            title: window.title.clone(),
            pid: window.pid,
            hidden: window.hidden,
        }
    }
}

/// Pointer input through the agent seat, in screenshot (capture) pixels.
#[derive(Debug, Clone, Copy)]
pub(crate) enum PointerInput {
    Click {
        x: f64,
        y: f64,
        button: PointerButton,
        count: u32,
    },
    Scroll {
        x: f64,
        y: f64,
        dx: i32,
        dy: i32,
    },
}

impl PointerInput {
    fn point(&self) -> (f64, f64) {
        match *self {
            PointerInput::Click { x, y, .. } | PointerInput::Scroll { x, y, .. } => (x, y),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PointerButton {
    Left,
    Middle,
    Right,
}

/// What a seat call did, for the tool result.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct SeatReport {
    pub route: SeatKind,
    /// The agent seat's name: the X11 master or the sway seat.
    pub seat: String,
    /// The user's keyboard focus before and after, when it can be read.
    pub user_focus_unchanged: Option<bool>,
}

/// An error after some input was already sent: the caller must not report
/// that nothing was sent, and must not retry blindly.
#[derive(Debug)]
pub(crate) struct PartialInput(pub String);

impl std::fmt::Display for PartialInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PartialInput {}

fn partial(error: anyhow::Error) -> anyhow::Error {
    if error.downcast_ref::<PartialInput>().is_some() {
        error
    } else {
        anyhow::Error::new(PartialInput(format!("{error:#}")))
    }
}

/// True when the error came after input started.
pub(crate) fn input_started(error: &anyhow::Error) -> bool {
    error.downcast_ref::<PartialInput>().is_some()
}

/// The seat cannot serve this target or key in this session, and nothing
/// was sent: the session, window manager or client lacks the route. The
/// caller may deliver the same input through the user's focus instead.
#[derive(Debug)]
pub(crate) struct NoRoute(pub String);

impl std::fmt::Display for NoRoute {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for NoRoute {}

fn no_route(message: impl Into<String>) -> anyhow::Error {
    anyhow::Error::new(NoRoute(message.into()))
}

/// True when the seat has no route for the call and sent nothing.
pub(crate) fn lacks_route(error: &anyhow::Error) -> bool {
    error.downcast_ref::<NoRoute>().is_some()
}

enum Seat {
    X11(Box<x11::X11Seat>),
    Sway(Box<sway::SwaySeat>),
}

impl Seat {
    fn kind(&self) -> SeatKind {
        match self {
            Seat::X11(_) => SeatKind::X11Master,
            Seat::Sway(_) => SeatKind::SwayTransientSeat,
        }
    }

    fn alive(&mut self) -> bool {
        match self {
            Seat::X11(seat) => seat.alive(),
            Seat::Sway(seat) => seat.alive(),
        }
    }
}

struct Active {
    seat: Seat,
    last_use: Instant,
}

static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);
static REAPER: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn lock_active() -> std::sync::MutexGuard<'static, Option<Active>> {
    ACTIVE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn with_seat<T>(kind: SeatKind, run: impl FnOnce(&mut Seat) -> Result<T>) -> Result<T> {
    let mut guard = lock_active();
    if guard
        .as_ref()
        .is_some_and(|active| active.seat.kind() != kind)
    {
        *guard = None;
    }
    if guard.is_none() {
        let seat = match kind {
            // A seat that cannot be made is a missing route: nothing was sent.
            SeatKind::X11Master => Seat::X11(Box::new(
                x11::X11Seat::create().map_err(|error| no_route(format!("{error:#}")))?,
            )),
            SeatKind::SwayTransientSeat => Seat::Sway(Box::new(
                sway::SwaySeat::create().map_err(|error| no_route(format!("{error:#}")))?,
            )),
            SeatKind::HyprlandSendKeyState => {
                bail!("Hyprland background keys go through sendkeystate, not an agent seat")
            }
        };
        *guard = Some(Active {
            seat,
            last_use: Instant::now(),
        });
        if !REAPER.swap(true, std::sync::atomic::Ordering::SeqCst) {
            start_reaper();
        }
    }
    let active = guard.as_mut().expect("seat was just created");
    active.last_use = Instant::now();
    let result = run(&mut active.seat);
    // A sway seat lives for one call: any other client that picks a
    // wl_seat on its own (wtype in a password or autotype helper, another
    // server) would otherwise bind it and type into the agent's focus.
    // After a failure mid-input, or on a broken connection, start over: a
    // fresh seat has no held keys, and removing an X11 master releases them.
    let failed = result
        .as_ref()
        .err()
        .is_some_and(|error| input_started(error) || !active.seat.alive());
    if failed || matches!(active.seat, Seat::Sway(_)) {
        *guard = None;
    }
    result
}

/// One reaper at a time: it exits when the seat is gone, clearing the flag
/// under the same lock that creates a seat.
fn start_reaper() {
    let spawned = std::thread::Builder::new()
        .name("cul-agent-seat-reaper".to_string())
        .spawn(|| loop {
            let wait = {
                let mut guard = lock_active();
                let idle = guard.as_ref().map(|active| active.last_use.elapsed());
                match idle {
                    None => {
                        REAPER.store(false, std::sync::atomic::Ordering::SeqCst);
                        return;
                    }
                    Some(idle) if idle >= IDLE_LIFETIME => {
                        *guard = None;
                        REAPER.store(false, std::sync::atomic::Ordering::SeqCst);
                        return;
                    }
                    Some(idle) => IDLE_LIFETIME - idle,
                }
            };
            std::thread::sleep(wait);
        });
    if spawned.is_err() {
        REAPER.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Removes the agent seat now. Called when the server exits.
pub(crate) fn shutdown() {
    *lock_active() = None;
}

/// Removes a sway agent seat before input from a tool that picks a wl_seat
/// on its own. wtype binds the last wl_seat the registry announces
/// (wtype main.c, handle_wl_event), which is the agent seat while it exists,
/// so its keys would go to the agent's focus instead of the user's. The
/// seat's drop waits for sway to take the seat away.
pub(crate) async fn release_before_seat_unaware_input() {
    let _ = tokio::task::spawn_blocking(|| {
        let mut guard = lock_active();
        if guard
            .as_ref()
            .is_some_and(|active| matches!(active.seat, Seat::Sway(_)))
        {
            *guard = None;
        }
    })
    .await;
}

/// Whether an agent seat exists, or None while a call holds it.
fn active() -> Option<bool> {
    match ACTIVE.try_lock() {
        Ok(guard) => Some(guard.is_some()),
        Err(std::sync::TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner().is_some()),
        Err(std::sync::TryLockError::WouldBlock) => None,
    }
}

async fn blocking<T: Send + 'static>(
    run: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(run)
        .await
        .map_err(|error| anyhow!("agent seat task failed: {error}"))?
}

/// Focuses target on the agent seat and types the strokes there.
///
/// hold (the server's input lock) moves into the blocking task, so a
/// cancelled call keeps it until the keys are out.
pub(crate) async fn send_keys<H: Send + 'static>(
    kind: SeatKind,
    target: SeatTarget,
    strokes: Vec<Stroke>,
    hold: H,
) -> Result<SeatReport> {
    blocking(move || {
        let _hold = hold;
        // Refusals come before the seat exists, so a refused call never
        // announces a wl_seat.
        if kind == SeatKind::SwayTransientSeat {
            sway::check_target(&target)?;
            sway::check_chords(&strokes)?;
        }
        with_seat(kind, |seat| match seat {
            Seat::X11(seat) => seat.send_keys(&target, &strokes),
            Seat::Sway(seat) => seat.send_keys(&target, &strokes),
        })
    })
    .await
}

/// Moves the agent pointer to a point on target and clicks or scrolls
/// there. The point must be over target, or nothing is pressed.
pub(crate) async fn send_pointer<H: Send + 'static>(
    kind: SeatKind,
    target: SeatTarget,
    input: PointerInput,
    hold: H,
) -> Result<SeatReport> {
    blocking(move || {
        let _hold = hold;
        if kind == SeatKind::SwayTransientSeat {
            sway::check_target(&target)?;
        }
        with_seat(kind, |seat| match seat {
            Seat::X11(seat) => seat.send_pointer(&target, input),
            Seat::Sway(seat) => seat.send_pointer(&target, input),
        })
    })
    .await
}

/// Doctor line for the seat route.
pub(crate) fn doctor_summary() -> serde_json::Value {
    match availability() {
        Ok(kind) => serde_json::json!({
            "available": true,
            "route": kind,
            "pointer": match kind {
                SeatKind::X11Master => "only while no window manager runs",
                SeatKind::SwayTransientSeat => "yes",
                SeatKind::HyprlandSendKeyState => "no",
            },
            "active": active(),
            "note": match kind {
                SeatKind::X11Master => "Chords the window manager or another program grabs on the root window have no agent-seat route; they go through normal focused input after a one-time notice.",
                SeatKind::SwayTransientSeat => "Needs sway 1.10 or later (ext-transient-seat-v1). Xwayland, GTK and Chromium windows have no agent-seat route: Xwayland follows the X focus, and GTK and Chromium never bind a seat added after they start. Neither do Alt and Super chords, chords the sway config binds, or keys outside the default binding mode. Those go through normal focused input after a one-time notice. Clients that mishandle a second wl_seat, such as Zed (zed-industries/zed#66735), may misbehave while the agent seat exists.",
                SeatKind::HyprlandSendKeyState => "Keys only, US layout; no agent pointer.",
            },
        }),
        Err(reason) => serde_json::json!({ "available": false, "reason": reason }),
    }
}

mod x11 {
    use super::*;
    use crate::x11_display::X11Display;
    use x11rb::connection::Connection as _;
    use x11rb::errors::ReplyError;
    use x11rb::protocol::xinput::{self, ConnectionExt as _};
    use x11rb::protocol::xproto::{self, ConnectionExt as _};
    use x11rb::protocol::xtest::ConnectionExt as _;
    use x11rb::protocol::ErrorKind;

    const BUTTON_PRESS: u8 = 4;
    const BUTTON_RELEASE: u8 = 5;
    const KEY_PRESS: u8 = 2;
    const KEY_RELEASE: u8 = 3;
    const MOTION_NOTIFY: u8 = 6;

    pub(super) struct X11Seat {
        /// Its ClientPointer is the agent master, so core XTEST, keyboard
        /// and pointer requests act on the agent pair.
        agent: X11Display,
        /// Default ClientPointer: reads the user's keymap and focus.
        user: X11Display,
        name: String,
        pointer: u16,
        keyboard: u16,
    }

    impl X11Seat {
        pub(super) fn create() -> Result<Self> {
            let agent = X11Display::connect()?;
            let user = X11Display::connect()?;
            agent
                .conn()
                .xinput_xi_query_version(2, 2)?
                .reply()
                .context("the X server has no XInput 2.2")?;
            sweep_stale_masters(&agent)?;
            // The master's name carries a window this connection owns. The
            // X server destroys it when the connection closes, so a later
            // server can tell a leftover master from a live one in any pid
            // namespace or on a remote display.
            let marker = agent.conn().generate_id()?;
            agent
                .conn()
                .create_window(
                    0,
                    marker,
                    agent.root(),
                    0,
                    0,
                    1,
                    1,
                    0,
                    xproto::WindowClass::INPUT_ONLY,
                    0,
                    &xproto::CreateWindowAux::new(),
                )?
                .check()
                .context("could not create the agent seat's marker window")?;
            let name = format!("{X11_MASTER_PREFIX}{marker:x}");
            agent
                .conn()
                .xinput_xi_change_hierarchy(&[xinput::HierarchyChange {
                    // In 4-byte units: type, len, name_len, send_core,
                    // enable, then the name padded to 4 bytes.
                    len: u16::try_from((8 + name.len().div_ceil(4) * 4) / 4)?,
                    data: xinput::HierarchyChangeData::AddMaster(
                        xinput::HierarchyChangeDataAddMaster {
                            send_core: true,
                            enable: true,
                            name: name.clone().into_bytes(),
                        },
                    ),
                }])?
                .check()
                .context("XIChangeHierarchy could not add the agent master")?;
            let (pointer, keyboard) = master_ids(&agent, &name)?
                .context("the agent master did not appear after XIChangeHierarchy")?;
            let seat = Self {
                agent,
                user,
                name,
                pointer,
                keyboard,
            };
            seat.agent
                .conn()
                .xinput_xi_set_client_pointer(x11rb::NONE, seat.pointer)?
                .check()
                .context("XISetClientPointer failed")?;
            Ok(seat)
        }

        fn refresh(&self) {
            self.agent.extend_deadline(CALL_TIMEOUT);
            self.user.extend_deadline(CALL_TIMEOUT);
        }

        pub(super) fn alive(&self) -> bool {
            self.refresh();
            let probe = |display: &X11Display| {
                display
                    .conn()
                    .get_input_focus()
                    .ok()
                    .and_then(|cookie| cookie.reply().ok())
                    .is_some()
            };
            probe(&self.agent) && probe(&self.user)
        }

        fn user_focus(&self) -> Result<u32> {
            Ok(self.user.conn().get_input_focus()?.reply()?.focus)
        }

        fn report(&self, before: Option<u32>) -> SeatReport {
            let after = self.user_focus().ok();
            SeatReport {
                route: SeatKind::X11Master,
                seat: self.name.clone(),
                user_focus_unchanged: before.zip(after).map(|(before, after)| before == after),
            }
        }

        pub(super) fn send_keys(
            &mut self,
            target: &SeatTarget,
            strokes: &[Stroke],
        ) -> Result<SeatReport> {
            self.refresh();
            let window = u32::try_from(target.window_id)
                .context("an X11 window id fits 32 bits; list windows again")?;
            let before = self.user_focus().ok();
            let user_map = KeyMap::read(&self.user)?;
            let agent_map = KeyMap::read(&self.agent)?;
            // Resolve everything before any input, so nothing is half typed.
            let mut plan = Vec::with_capacity(strokes.len());
            for stroke in strokes {
                plan.push(plan_stroke(stroke, &user_map, &agent_map)?);
            }
            refuse_grabbed(&self.user, &plan, &agent_map)?;
            self.agent
                .conn()
                .xinput_xi_set_focus(window, x11rb::CURRENT_TIME, self.keyboard)?
                .check()
                .context("XISetFocus could not focus the target for the agent keyboard")?;
            let focus = self
                .agent
                .conn()
                .xinput_xi_get_focus(self.keyboard)?
                .reply()?
                .focus;
            if focus != window {
                return Err(no_route(format!("the agent keyboard focus is 0x{focus:x}, not the target 0x{window:x}; no keys were sent")));
            }
            let conn = self.agent.conn();
            let root = self.agent.root();
            (|| -> Result<()> {
                for keycodes in &plan {
                    for keycode in keycodes {
                        conn.xtest_fake_input(
                            KEY_PRESS,
                            *keycode,
                            x11rb::CURRENT_TIME,
                            root,
                            0,
                            0,
                            0,
                        )?;
                    }
                    for keycode in keycodes.iter().rev() {
                        conn.xtest_fake_input(
                            KEY_RELEASE,
                            *keycode,
                            x11rb::CURRENT_TIME,
                            root,
                            0,
                            0,
                            0,
                        )?;
                    }
                }
                conn.get_input_focus()?
                    .reply()
                    .context("the X server did not confirm the keys")?;
                Ok(())
            })()
            .map_err(partial)?;
            Ok(self.report(before))
        }

        pub(super) fn send_pointer(
            &mut self,
            target: &SeatTarget,
            input: PointerInput,
        ) -> Result<SeatReport> {
            self.refresh();
            if window_manager_running(&self.user)? {
                return Err(no_route(X11_WM_NOTE));
            }
            let window = u32::try_from(target.window_id)
                .context("an X11 window id fits 32 bits; list windows again")?;
            let before = self.user_focus().ok();
            let conn = self.agent.conn();
            let root = self.agent.root();
            let (x, y) = input.point();
            let (x, y) = (to_i16(x)?, to_i16(y)?);
            conn.xtest_fake_input(MOTION_NOTIFY, 0, x11rb::CURRENT_TIME, root, x, y, 0)?;
            // QueryPointer reads this connection's ClientPointer, the agent
            // pointer: the top-level under it must be the target.
            let under = conn.query_pointer(root)?.reply()?.child;
            if under != window {
                bail!("the agent pointer is over window 0x{under:x}, not the target 0x{window:x}; it moved there but nothing was pressed");
            }
            let press = |button: u8, times: u32| -> Result<()> {
                for _ in 0..times {
                    conn.xtest_fake_input(
                        BUTTON_PRESS,
                        button,
                        x11rb::CURRENT_TIME,
                        root,
                        0,
                        0,
                        0,
                    )?;
                    conn.xtest_fake_input(
                        BUTTON_RELEASE,
                        button,
                        x11rb::CURRENT_TIME,
                        root,
                        0,
                        0,
                        0,
                    )?;
                }
                Ok(())
            };
            (|| -> Result<()> {
                match input {
                    PointerInput::Click { button, count, .. } => press(
                        match button {
                            PointerButton::Left => 1,
                            PointerButton::Middle => 2,
                            PointerButton::Right => 3,
                        },
                        count.max(1),
                    )?,
                    PointerInput::Scroll { dx, dy, .. } => {
                        press(if dy < 0 { 4 } else { 5 }, dy.unsigned_abs())?;
                        press(if dx < 0 { 6 } else { 7 }, dx.unsigned_abs())?;
                    }
                }
                conn.get_input_focus()?
                    .reply()
                    .context("the X server did not confirm the pointer input")?;
                Ok(())
            })()
            .map_err(partial)?;
            Ok(self.report(before))
        }
    }

    impl Drop for X11Seat {
        fn drop(&mut self) {
            self.refresh();
            let _ = remove_master(&self.agent, self.pointer);
            let _ = self.agent.conn().flush();
        }
    }

    /// True while a window manager runs: it holds SubstructureRedirect on
    /// the root, which only one client can select (any manager, EWMH or not).
    fn window_manager_running(display: &X11Display) -> Result<bool> {
        // A read of the root's combined event masks, so the probe never
        // holds the redirect itself.
        let masks = display
            .conn()
            .get_window_attributes(display.root())?
            .reply()?
            .all_event_masks;
        Ok(masks.contains(xproto::EventMask::SUBSTRUCTURE_REDIRECT))
    }

    /// Refuses keys another client grabs on the root window: the window
    /// manager's shortcuts fire for the agent keyboard too and act on the
    /// user's session. A grab of the same key and modifiers fails with
    /// BadAccess exactly when someone holds one.
    fn refuse_grabbed(display: &X11Display, plan: &[Vec<u8>], agent: &KeyMap) -> Result<()> {
        let conn = display.conn();
        let root = display.root();
        let mut seen = Vec::new();
        for keycodes in plan {
            let Some((key, held)) = keycodes.split_last() else {
                continue;
            };
            let mut mask = 0u16;
            for code in held {
                if let Some(index) = agent
                    .modifiers
                    .iter()
                    .position(|codes| codes.contains(code))
                {
                    mask |= 1 << index;
                }
            }
            if seen.contains(&(*key, mask)) {
                continue;
            }
            seen.push((*key, mask));
            let modifiers = xproto::ModMask::from(mask);
            // Grab and ungrab go out back to back before either reply is
            // read, so the probe's own grab lives for as short as the server
            // allows: a user key in that gap would go to this connection.
            let grab = conn.grab_key(
                false,
                root,
                modifiers,
                *key,
                xproto::GrabMode::ASYNC,
                xproto::GrabMode::ASYNC,
            )?;
            let ungrab = conn.ungrab_key(*key, root, modifiers)?;
            let grabbed = grab.check();
            ungrab.check()?;
            match grabbed {
                Ok(()) => {}
                Err(ReplyError::X11Error(error)) if error.error_kind == ErrorKind::Access => {
                    return Err(no_route(format!("keycode {key} with modifier mask 0x{mask:x} is grabbed on the root window (a window manager or global shortcut), so through the agent seat it would act on the user's session; no keys were sent")));
                }
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    fn to_i16(value: f64) -> Result<i16> {
        let rounded = value.round();
        if !(0.0..=f64::from(i16::MAX)).contains(&rounded) {
            bail!("pointer coordinate {value} is outside the X screen");
        }
        Ok(rounded as i16)
    }

    fn master_ids(display: &X11Display, name: &str) -> Result<Option<(u16, u16)>> {
        let infos = display
            .conn()
            .xinput_xi_query_device(xinput::Device::ALL_MASTER)?
            .reply()?
            .infos;
        let pointer_name = format!("{name} pointer");
        let pointer = infos.iter().find(|info| {
            info.type_ == xinput::DeviceType::MASTER_POINTER && info.name == pointer_name.as_bytes()
        });
        Ok(pointer.map(|pointer| (pointer.deviceid, pointer.attachment)))
    }

    fn remove_master(display: &X11Display, pointer: u16) -> Result<()> {
        display
            .conn()
            .xinput_xi_change_hierarchy(&[xinput::HierarchyChange {
                // 12 bytes, in 4-byte units.
                len: 3,
                data: xinput::HierarchyChangeData::RemoveMaster(
                    xinput::HierarchyChangeDataRemoveMaster {
                        deviceid: pointer,
                        return_mode: xinput::ChangeMode::FLOAT,
                        return_pointer: 0,
                        return_keyboard: 0,
                    },
                ),
            }])?
            .check()?;
        Ok(())
    }

    /// Removes agent masters whose marker window is gone: their server's
    /// X connection closed without removing them (a crash or SIGKILL).
    fn sweep_stale_masters(display: &X11Display) -> Result<()> {
        let infos = display
            .conn()
            .xinput_xi_query_device(xinput::Device::ALL_MASTER)?
            .reply()?
            .infos;
        for info in infos {
            if info.type_ != xinput::DeviceType::MASTER_POINTER {
                continue;
            }
            let name = String::from_utf8_lossy(&info.name);
            let Some(marker) = master_marker(&name) else {
                continue;
            };
            let alive = display
                .conn()
                .get_window_attributes(marker)?
                .reply()
                .is_ok();
            if !alive {
                remove_master(display, info.deviceid)
                    .with_context(|| format!("could not remove the stale agent master {name:?}"))?;
            }
        }
        Ok(())
    }

    /// The marker window id in an agent master pointer's name.
    pub(super) fn master_marker(pointer_name: &str) -> Option<u32> {
        let hex = pointer_name
            .strip_prefix(X11_MASTER_PREFIX)?
            .strip_suffix(" pointer")?;
        u32::from_str_radix(hex, 16).ok()
    }

    /// The core keyboard mapping of one connection's ClientPointer keyboard.
    pub(super) struct KeyMap {
        pub min_keycode: u8,
        pub per_keycode: usize,
        pub keysyms: Vec<u32>,
        /// Keycodes of each of the 8 modifiers.
        pub modifiers: Vec<Vec<u8>>,
    }

    impl KeyMap {
        fn read(display: &X11Display) -> Result<Self> {
            let conn = display.conn();
            let setup = conn.setup();
            let (min, max) = (setup.min_keycode, setup.max_keycode);
            let mapping = conn.get_keyboard_mapping(min, max - min + 1)?.reply()?;
            let modmap = conn.get_modifier_mapping()?.reply()?;
            let per = usize::from(modmap.keycodes_per_modifier());
            let modifiers = modmap
                .keycodes
                .chunks(per.max(1))
                .map(|codes| codes.iter().copied().filter(|code| *code != 0).collect())
                .collect();
            Ok(Self {
                min_keycode: min,
                per_keycode: usize::from(mapping.keysyms_per_keycode),
                keysyms: mapping.keysyms,
                modifiers,
            })
        }

        /// The keycode and column (0 plain, 1 shifted) typing keysym in
        /// group 1, preferring the plain column.
        pub(super) fn find(&self, keysym: u32) -> Option<(u8, usize)> {
            if self.per_keycode == 0 || keysym == 0 {
                return None;
            }
            for column in 0..self.per_keycode.min(2) {
                for (index, row) in self.keysyms.chunks(self.per_keycode).enumerate() {
                    let mut value = row[column];
                    // A one-column letter key types its capital with Shift.
                    if column == 1
                        && value == 0
                        && is_latin_lower(row[0])
                        && row[0] - 0x20 == keysym
                    {
                        value = keysym;
                    }
                    if value == keysym {
                        return Some((self.min_keycode + index as u8, column));
                    }
                }
            }
            None
        }
    }

    fn is_latin_lower(keysym: u32) -> bool {
        (0x61..=0x7a).contains(&keysym)
    }

    const SHIFT: usize = 0;
    const CONTROL: usize = 2;
    const MOD1: usize = 3;
    const MOD4: usize = 6;

    /// Keycodes to hold, in press order, for one stroke. The key comes from
    /// the user's map, because applications decode keycodes with their own
    /// client's keyboard; modifiers come from the agent keyboard's map,
    /// because the server derives the event state from the device that sent
    /// it.
    pub(super) fn plan_stroke(stroke: &Stroke, user: &KeyMap, agent: &KeyMap) -> Result<Vec<u8>> {
        // The X server's own XKB actions run for XTEST keys too: Ctrl+Alt+Fn
        // switches the VT and Ctrl+Alt+BackSpace can stop the server, and no
        // client grab shows them.
        let function_key = (0xffbe..=0xffe0).contains(&stroke.keysym);
        if stroke.ctrl && stroke.alt && (function_key || stroke.keysym == 0xff08) {
            bail!("Ctrl+Alt with a function key or BackSpace is the X server's own VT switch or exit chord; no keys were sent");
        }
        let (keycode, column) = user.find(stroke.keysym).ok_or_else(|| {
            no_route(format!(
                "keysym 0x{:x} is not on the first two levels of the user's keyboard layout; no keys were sent. Use an element target to set the text through accessibility instead.",
                stroke.keysym
            ))
        })?;
        let mut codes = Vec::new();
        let modifier = |index: usize, keysym: u32| -> Result<u8> {
            agent
                .find(keysym)
                .map(|(code, _)| code)
                .or_else(|| {
                    agent
                        .modifiers
                        .get(index)
                        .and_then(|codes| codes.first().copied())
                })
                .ok_or_else(|| {
                    no_route(format!(
                        "the agent keyboard has no key for modifier keysym 0x{keysym:x}"
                    ))
                })
        };
        if stroke.ctrl && stroke.keysym != KEYSYM_CONTROL_L {
            codes.push(modifier(CONTROL, KEYSYM_CONTROL_L)?);
        }
        if stroke.alt && stroke.keysym != KEYSYM_ALT_L {
            codes.push(modifier(MOD1, KEYSYM_ALT_L)?);
        }
        if stroke.meta && stroke.keysym != KEYSYM_SUPER_L {
            codes.push(modifier(MOD4, KEYSYM_SUPER_L)?);
        }
        if (stroke.shift || column == 1) && stroke.keysym != KEYSYM_SHIFT_L {
            codes.push(modifier(SHIFT, KEYSYM_SHIFT_L)?);
        }
        codes.push(keycode);
        Ok(codes)
    }
}

mod sway {
    use super::*;
    use crate::windowing::wayland_session::{self, bounded_sync, SyncState};
    use std::io::{Read, Write};
    use std::os::fd::{AsFd, FromRawFd, OwnedFd};
    use std::os::unix::net::UnixStream;
    use wayland_client::protocol::{wl_callback, wl_pointer, wl_registry, wl_seat};
    use wayland_client::{
        event_created_child, Connection, Dispatch, EventQueue, Proxy, QueueHandle,
    };
    use wayland_protocols::ext::transient_seat::v1::client::{
        ext_transient_seat_manager_v1 as transient_manager, ext_transient_seat_v1 as transient_seat,
    };
    use wayland_protocols_misc::zwp_virtual_keyboard_v1::client::{
        zwp_virtual_keyboard_manager_v1 as keyboard_manager,
        zwp_virtual_keyboard_v1 as virtual_keyboard,
    };
    use wayland_protocols_wlr::foreign_toplevel::v1::client::{
        zwlr_foreign_toplevel_handle_v1 as toplevel_handle,
        zwlr_foreign_toplevel_manager_v1 as toplevel_manager,
    };
    use wayland_protocols_wlr::virtual_pointer::v1::client::{
        zwlr_virtual_pointer_manager_v1 as pointer_manager,
        zwlr_virtual_pointer_v1 as virtual_pointer,
    };

    const ACTION: &str = "sway agent seat";
    const BTN_LEFT: u32 = 0x110;
    const BTN_RIGHT: u32 = 0x111;
    const BTN_MIDDLE: u32 = 0x112;
    const XKB_V1: u32 = 1;
    const DROP_TIMEOUT: Duration = Duration::from_secs(1);
    const CLIENT_BIND_SETTLE: Duration = Duration::from_millis(100);
    const SWAY_CONTAINER_ID_BASE: u64 = crate::windowing::backends::i3::SWAY_CONTAINER_ID_BASE;

    #[derive(Default)]
    pub(super) struct State {
        globals: Vec<(u32, String, u32)>,
        ready: Option<std::result::Result<u32, ()>>,
        seat_name: Option<String>,
        toplevels: Vec<(toplevel_handle::ZwlrForeignToplevelHandleV1, Toplevel)>,
        synced: bool,
    }

    #[derive(Default, Clone)]
    struct Toplevel {
        title: Option<String>,
        app_id: Option<String>,
        done: bool,
        closed: bool,
    }

    impl SyncState for State {
        fn synced(&mut self) -> &mut bool {
            &mut self.synced
        }
    }

    pub(super) struct SwaySeat {
        conn: Connection,
        queue: EventQueue<State>,
        state: State,
        registry: wl_registry::WlRegistry,
        transient: transient_seat::ExtTransientSeatV1,
        seat: wl_seat::WlSeat,
        name: String,
        keyboard: virtual_keyboard::ZwpVirtualKeyboardV1,
        pointer: Option<virtual_pointer::ZwlrVirtualPointerV1>,
        dead: bool,
    }

    fn find_global(state: &State, interface: &str, max: u32) -> Option<(u32, u32)> {
        state
            .globals
            .iter()
            .find(|(_, name, _)| name == interface)
            .map(|(global, _, version)| (*global, (*version).min(max)))
    }

    /// Refuses windows the agent seat cannot reach without touching the
    /// user's input.
    pub(super) fn check_target(target: &SeatTarget) -> Result<()> {
        if target.window_id < SWAY_CONTAINER_ID_BASE {
            return Err(no_route(format!("window_id {} is an Xwayland window, and Xwayland feeds every seat into one X keyboard that follows the X focus, so the agent seat could type into the user's X11 window. {OTHER_ROUTES}", target.window_id)));
        }
        if target.hidden {
            return Err(no_route(format!("window_id {} is in the sway scratchpad, and activating it shows it on the user's workspace. {OTHER_ROUTES}", target.window_id)));
        }
        if let Some(reason) = seatless_client(target.pid) {
            return Err(no_route(format!(
                "window_id {} is {reason} {OTHER_ROUTES}",
                target.window_id
            )));
        }
        Ok(())
    }

    /// Refuses chords sway could treat as its own shortcuts. Bindings run
    /// for the agent seat's keyboard too, and a workspace or exit binding
    /// acts on the whole session. Alt and Super carry sway's own modifier,
    /// so they are refused outright; other chords are checked against the
    /// loaded config.
    pub(super) fn check_chords(strokes: &[Stroke]) -> Result<()> {
        // Sway has one binding mode for the whole session; in another mode
        // plain keys are that mode's bindings (resize keys, Escape).
        let mode = sway_ipc::binding_mode()?;
        if mode != "default" {
            return Err(no_route(format!("sway is in binding mode {mode:?}, whose bindings would take the agent's keys; no keys were sent")));
        }
        // The modifier keys around a chord are key events too, and sway
        // runs bindings on them (bindsym --release Shift_L).
        let mut chords: Vec<Stroke> = Vec::new();
        for stroke in strokes {
            let modifiers = stroke.modifier_keysyms().into_iter().map(Stroke::plain);
            for each in std::iter::once(*stroke).chain(modifiers) {
                if !chords.contains(&each) {
                    chords.push(each);
                }
            }
        }
        if chords.iter().any(|stroke| stroke.alt || stroke.meta) {
            return Err(no_route("sway binds Alt and Super chords for the whole session, and its bindings fire for the agent seat too, so an Alt or Super chord has no agent seat route; no keys were sent"));
        }
        let config =
            sway_ipc::config_with_includes().map_err(|error| no_route(format!("{error:#}")))?;
        for stroke in &chords {
            if let Some(binding) = bound_chord(&config, stroke) {
                return Err(no_route(format!("the sway config binds {binding}, and sway bindings fire for the agent seat too; no keys were sent")));
            }
        }
        Ok(())
    }

    /// Real-modifier mask of a stroke in the uploaded keymap: Shift,
    /// Control, Mod1 (Alt) and Mod4 (Super) are bits 0, 2, 3 and 6.
    fn modifier_mask(stroke: &Stroke) -> u32 {
        let mut mask = 0;
        for (on, bit) in [
            (stroke.shift, 0),
            (stroke.ctrl, 2),
            (stroke.alt, 3),
            (stroke.meta, 6),
        ] {
            if on {
                mask |= 1 << bit;
            }
        }
        mask
    }

    /// The binding in config that matches stroke, if any. Pure: variables
    /// are expanded and modifier names normalized (Mod1 is Alt, Mod4 is
    /// Super). The caller expands include lines first.
    pub(super) fn bound_chord(config: &str, stroke: &Stroke) -> Option<String> {
        let key = xkeysym::Keysym::new(stroke.keysym)
            .name()
            .and_then(|name| name.strip_prefix("XK_"))
            .map(str::to_ascii_lowercase)?;
        let mut wanted = vec![key];
        for (on, name) in [
            (stroke.ctrl, "ctrl"),
            (stroke.alt, "alt"),
            (stroke.shift, "shift"),
            (stroke.meta, "super"),
        ] {
            if on {
                wanted.push(name.to_string());
            }
        }
        wanted.sort();
        let mut variables: Vec<(String, String)> = Vec::new();
        // Open blocks: "mode" (bindings of other modes, skipped), "bindsym"
        // (one binding per line) or anything else.
        let mut blocks: Vec<&str> = Vec::new();
        let mut previous = "";
        for raw in config.lines() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if line == "}" {
                blocks.pop();
                continue;
            }
            // A block opens on its own line ("{" under "mode ...") or at the
            // end of its header line.
            let header = if line == "{" { previous } else { line };
            previous = line;
            let first = header.split_whitespace().next().unwrap_or_default();
            if line.ends_with('{') {
                let default_mode = header
                    .split_whitespace()
                    .nth(1)
                    .is_some_and(|name| name.trim_matches('"') == "default");
                blocks.push(match first {
                    "mode" if !default_mode => "mode",
                    "bindsym" => "bindsym",
                    _ => "other",
                });
                continue;
            }
            if blocks.contains(&"mode") {
                continue;
            }
            if first == "set" {
                let mut words = line.split_whitespace().skip(1);
                if let (Some(name), Some(value)) = (words.next(), words.next()) {
                    variables.push((name.to_string(), value.to_string()));
                    variables.sort_by_key(|(name, _)| std::cmp::Reverse(name.len()));
                }
                continue;
            }
            let combo = if blocks.last() == Some(&"bindsym") {
                Some(first)
            } else if first == "bindsym" {
                line.split_whitespace()
                    .skip(1)
                    .find(|word| !word.starts_with("--"))
            } else {
                None
            };
            let Some(combo) = combo else {
                continue;
            };
            let mut expanded = combo.to_string();
            for (name, value) in &variables {
                expanded = expanded.replace(name.as_str(), value);
            }
            let mut parts = expanded
                .split('+')
                .map(|part| match part.to_ascii_lowercase().as_str() {
                    "mod1" | "alt" => "alt".to_string(),
                    "mod4" | "super" | "logo" => "super".to_string(),
                    "control" | "ctrl" => "ctrl".to_string(),
                    other => other.to_string(),
                })
                .collect::<Vec<_>>();
            parts.sort();
            if parts == wanted {
                return Some(combo.to_string());
            }
        }
        None
    }

    impl SwaySeat {
        pub(super) fn create() -> Result<Self> {
            let deadline = Instant::now() + CALL_TIMEOUT;
            let path =
                wayland_session::display_path().context("the agent seat needs WAYLAND_DISPLAY")?;
            let socket = UnixStream::from(
                wayland_session::connect_nonblocking(&path)
                    .with_context(|| format!("could not connect to {}", path.display()))?,
            );
            let conn = Connection::from_socket(socket).context("no Wayland display")?;
            let mut queue = conn.new_event_queue::<State>();
            let mut state = State::default();
            let qh = queue.handle();
            let registry = conn.display().get_registry(&qh, ());
            bounded_sync(&conn, &mut queue, &mut state, deadline, ACTION)?;
            let (global, version) = find_global(&state, "ext_transient_seat_manager_v1", 1).context(
                "sway does not offer ext_transient_seat_manager_v1 (sway 1.10 or later has it); no agent seat",
            )?;
            let transient_manager: transient_manager::ExtTransientSeatManagerV1 =
                registry.bind(global, version, &qh, ());
            let (global, version) = find_global(&state, "zwp_virtual_keyboard_manager_v1", 1)
                .context("sway does not offer zwp_virtual_keyboard_manager_v1")?;
            let keyboard_manager: keyboard_manager::ZwpVirtualKeyboardManagerV1 =
                registry.bind(global, version, &qh, ());
            let pointer_manager: Option<pointer_manager::ZwlrVirtualPointerManagerV1> =
                find_global(&state, "zwlr_virtual_pointer_manager_v1", 2)
                    .map(|(global, version)| registry.bind(global, version, &qh, ()));
            let transient = transient_manager.create(&qh, ());
            while state.ready.is_none() {
                bounded_sync(&conn, &mut queue, &mut state, deadline, ACTION)?;
            }
            let seat_global = match state.ready {
                Some(Ok(global)) => global,
                _ => return Err(no_route("sway denied the transient seat")),
            };
            while !state
                .globals
                .iter()
                .any(|(global, _, _)| *global == seat_global)
            {
                bounded_sync(&conn, &mut queue, &mut state, deadline, ACTION)?;
            }
            let seat_version = state
                .globals
                .iter()
                .find(|(global, _, _)| *global == seat_global)
                .map(|(_, _, version)| (*version).min(7))
                .unwrap_or(2);
            let seat: wl_seat::WlSeat = registry.bind(seat_global, seat_version, &qh, ());
            while state.seat_name.is_none() {
                bounded_sync(&conn, &mut queue, &mut state, deadline, ACTION)?;
            }
            let name = state.seat_name.clone().expect("checked above");
            let keyboard = keyboard_manager.create_virtual_keyboard(&seat, &qh, ());
            let pointer = pointer_manager
                .as_ref()
                .map(|manager| manager.create_virtual_pointer(Some(&seat), &qh, ()));
            // The managers are not needed again; the devices and the seat stay.
            transient_manager.destroy();
            if let Some(manager) = pointer_manager {
                manager.destroy();
            }
            bounded_sync(&conn, &mut queue, &mut state, deadline, ACTION)?;
            // Clients learn about the new seat from its global and bind it,
            // then create its keyboard and pointer, on their next dispatch.
            // Input sent before that never reaches them: wlroots sends no
            // pointer enter to a pointer created later. foot binds within
            // 6 ms here; the wait covers a few frames of a busy client.
            std::thread::sleep(CLIENT_BIND_SETTLE);
            Ok(Self {
                conn,
                queue,
                state,
                registry,
                transient,
                seat,
                name,
                keyboard,
                pointer,
                dead: false,
            })
        }

        pub(super) fn alive(&self) -> bool {
            !self.dead
        }

        fn sync(&mut self, deadline: Instant) -> Result<()> {
            let result = bounded_sync(
                &self.conn,
                &mut self.queue,
                &mut self.state,
                deadline,
                ACTION,
            );
            if result.is_err() {
                self.dead = true;
            }
            result
        }

        fn destroy_toplevels(&mut self) {
            for (handle, _) in self.state.toplevels.drain(..) {
                handle.destroy();
            }
        }

        fn focus(&mut self, target: &SeatTarget, deadline: Instant) -> Result<()> {
            let (global, version) = find_global(&self.state, "zwlr_foreign_toplevel_manager_v1", 3)
                .context("sway does not offer zwlr_foreign_toplevel_manager_v1, which focuses a window on the agent seat")?;
            let qh = self.queue.handle();
            self.destroy_toplevels();
            let manager: toplevel_manager::ZwlrForeignToplevelManagerV1 =
                self.registry.bind(global, version, &qh, ());
            let mut described = false;
            for _ in 0..3 {
                self.sync(deadline)?;
                if self
                    .state
                    .toplevels
                    .iter()
                    .all(|(_, toplevel)| toplevel.done || toplevel.closed)
                {
                    described = true;
                    break;
                }
            }
            let result = if described {
                self.activate_match(target)
            } else {
                Err(anyhow!("wlr toplevel descriptions did not complete"))
            };
            manager.stop();
            self.destroy_toplevels();
            self.sync(deadline)?;
            // Toplevels announced before sway handled stop.
            self.destroy_toplevels();
            result
        }

        fn activate_match(&self, target: &SeatTarget) -> Result<()> {
            let app_id = target.app_id.as_deref().or(target.wm_class.as_deref());
            let matches = self
                .state
                .toplevels
                .iter()
                .filter(|(_, toplevel)| {
                    !toplevel.closed
                        && toplevel.title.as_deref() == target.title.as_deref()
                        && (app_id.is_none() || toplevel.app_id.as_deref() == app_id)
                })
                .collect::<Vec<_>>();
            match matches.as_slice() {
                [(handle, _)] => {
                    handle.activate(&self.seat);
                    Ok(())
                }
                [] => bail!("the target window is not among sway's toplevels; list windows again"),
                _ => Err(no_route(format!(
                    "{} windows share the target's app id and title, so the agent seat cannot tell them apart; no input was sent",
                    matches.len()
                ))),
            }
        }

        fn upload_keymap(&mut self, keysyms: &[u32]) -> Result<HashMap<u32, u32>> {
            let (keymap, codes) = xkb_keymap(keysyms);
            let fd = keymap_fd(&keymap)?;
            self.keyboard
                .keymap(XKB_V1, fd.as_fd(), keymap.len() as u32 + 1);
            Ok(codes)
        }

        fn report(&self, before: Option<u64>) -> SeatReport {
            SeatReport {
                route: SeatKind::SwayTransientSeat,
                seat: self.name.clone(),
                user_focus_unchanged: before.zip(sway_ipc::seat_focus().ok()).map(|(a, b)| a == b),
            }
        }

        pub(super) fn send_keys(
            &mut self,
            target: &SeatTarget,
            strokes: &[Stroke],
        ) -> Result<SeatReport> {
            let deadline = Instant::now() + CALL_TIMEOUT;
            let before = sway_ipc::seat_focus().ok();
            self.focus(target, deadline)?;
            if before.is_some() && sway_ipc::seat_focus().ok() != before {
                return Err(no_route("sway moved the user's focus when the agent seat focused the target; no keys were sent"));
            }
            let con_id = sway_ipc::container_id(target.window_id)?;
            let seats = sway_ipc::seats()?;
            let agent_focus = seats
                .iter()
                .find(|(name, _)| *name == self.name)
                .map(|(_, focus)| *focus);
            if agent_focus != Some(con_id) {
                return Err(no_route(format!(
                    "sway did not focus the target on the agent seat {}; no keys were sent",
                    self.name
                )));
            }
            let mut keysyms = Vec::new();
            for stroke in strokes {
                keysyms.extend(stroke.modifier_keysyms());
                keysyms.push(stroke.keysym);
            }
            let codes = self.upload_keymap(&keysyms)?;
            let mut time = 0u32;
            for stroke in strokes {
                let mut held = stroke
                    .modifier_keysyms()
                    .into_iter()
                    .map(|keysym| codes[&keysym])
                    .collect::<Vec<_>>();
                held.push(codes[&stroke.keysym]);
                // wlroots does not derive modifier state from a virtual
                // keyboard's keys; clients read it from wl_keyboard.modifiers.
                let mask = modifier_mask(stroke);
                let (key, modifiers) = held.split_last().expect("held ends with the key");
                for code in modifiers {
                    time += 1;
                    self.keyboard.key(time, *code, 1);
                }
                if mask != 0 {
                    self.keyboard.modifiers(mask, 0, 0, 0);
                }
                time += 1;
                self.keyboard.key(time, *key, 1);
                time += 1;
                self.keyboard.key(time, *key, 0);
                if mask != 0 {
                    self.keyboard.modifiers(0, 0, 0, 0);
                }
                for code in modifiers.iter().rev() {
                    time += 1;
                    self.keyboard.key(time, *code, 0);
                }
            }
            self.sync(deadline).map_err(partial)?;
            Ok(self.report(before))
        }

        pub(super) fn send_pointer(
            &mut self,
            target: &SeatTarget,
            input: PointerInput,
        ) -> Result<SeatReport> {
            let deadline = Instant::now() + CALL_TIMEOUT;
            let before = sway_ipc::seat_focus().ok();
            let pointer = self
                .pointer
                .clone()
                .ok_or_else(|| no_route("sway does not offer zwlr_virtual_pointer_manager_v1, so the agent seat has no pointer"))?;
            let layout = sway_ipc::layout().map_err(|error| no_route(format!("{error:#}")))?;
            let (x, y) = input.point();
            if !(0.0..f64::from(layout.width)).contains(&x)
                || !(0.0..f64::from(layout.height)).contains(&y)
            {
                bail!(
                    "pointer point ({x}, {y}) is outside the {}x{} desktop; nothing was sent",
                    layout.width,
                    layout.height
                );
            }
            let con_id = sway_ipc::container_id(target.window_id)?;
            let (lx, ly) = layout.logical(x, y);
            let under = sway_ipc::view_at(lx, ly)?;
            if under != Some(con_id) {
                bail!("the point ({x}, {y}) is not over the target window_id {} on a visible workspace; nothing was sent", target.window_id);
            }
            let mut time = 0u32;
            pointer.motion_absolute(
                time,
                x.round() as u32,
                y.round() as u32,
                layout.width,
                layout.height,
            );
            pointer.frame();
            match input {
                PointerInput::Click { button, count, .. } => {
                    let code = match button {
                        PointerButton::Left => BTN_LEFT,
                        PointerButton::Middle => BTN_MIDDLE,
                        PointerButton::Right => BTN_RIGHT,
                    };
                    for _ in 0..count.max(1) {
                        time += 1;
                        pointer.button(time, code, wl_pointer::ButtonState::Pressed);
                        pointer.frame();
                        time += 1;
                        pointer.button(time, code, wl_pointer::ButtonState::Released);
                        pointer.frame();
                    }
                }
                PointerInput::Scroll { dx, dy, .. } => {
                    for (axis, steps) in [
                        (wl_pointer::Axis::VerticalScroll, dy),
                        (wl_pointer::Axis::HorizontalScroll, dx),
                    ] {
                        if steps == 0 {
                            continue;
                        }
                        time += 1;
                        pointer.axis_source(wl_pointer::AxisSource::Wheel);
                        pointer.axis_discrete(time, axis, f64::from(steps) * 15.0, steps);
                        pointer.frame();
                    }
                }
            }
            self.sync(deadline).map_err(partial)?;
            Ok(self.report(before))
        }
    }

    impl Drop for SwaySeat {
        fn drop(&mut self) {
            self.destroy_toplevels();
            if let Some(pointer) = self.pointer.take() {
                pointer.destroy();
            }
            self.keyboard.destroy();
            self.seat.release();
            self.transient.destroy();
            // Wait until sway has handled the destroy, so a client started
            // next (wtype) no longer sees the seat.
            if !self.dead {
                let _ = bounded_sync(
                    &self.conn,
                    &mut self.queue,
                    &mut self.state,
                    Instant::now() + DROP_TIMEOUT,
                    ACTION,
                );
            }
        }
    }

    fn keymap_fd(keymap: &str) -> Result<OwnedFd> {
        // SAFETY: memfd_create takes a NUL-terminated name and returns a new fd.
        let raw = unsafe { libc::memfd_create(c"cul-agent-keymap".as_ptr(), libc::MFD_CLOEXEC) };
        if raw < 0 {
            return Err(std::io::Error::last_os_error()).context("memfd_create failed");
        }
        // SAFETY: raw is a fresh descriptor this function owns.
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };
        let mut file = std::fs::File::from(fd);
        file.write_all(keymap.as_bytes())?;
        file.write_all(&[0])?;
        Ok(file.into())
    }

    /// An XKB keymap with one keycode per keysym (plus the modifier keys it
    /// names), and each keysym's evdev code. Clients decode the agent seat's
    /// keys with this keymap, so the user's layout does not matter.
    /// First XKB keycode of the agent keymap. It sits above every keycode a
    /// real keyboard sends (evdev KEY_MAX is 0x2ff, XKB adds 8), so sway's
    /// bindcode and bindsym --to-code bindings, which match keycodes, never
    /// match an agent key.
    pub(super) const KEYCODE_BASE: u32 = 0x400;

    pub(super) fn xkb_keymap(keysyms: &[u32]) -> (String, HashMap<u32, u32>) {
        let mut unique = Vec::new();
        for keysym in keysyms {
            if !unique.contains(keysym) {
                unique.push(*keysym);
            }
        }
        let mut keycodes = String::new();
        let mut symbols = String::new();
        let mut codes = HashMap::new();
        for (index, keysym) in unique.iter().enumerate() {
            let keycode = KEYCODE_BASE + index as u32;
            keycodes.push_str(&format!("    <K{keycode}> = {keycode};\n"));
            let name = xkeysym::Keysym::new(*keysym)
                .name()
                .and_then(|name| name.strip_prefix("XK_"))
                .map(str::to_string)
                .unwrap_or_else(|| format!("0x{keysym:08x}"));
            symbols.push_str(&format!("    key <K{keycode}> {{ [ {name} ] }};\n"));
            let modifier = match *keysym {
                KEYSYM_SHIFT_L => Some("Shift"),
                KEYSYM_CONTROL_L => Some("Control"),
                KEYSYM_ALT_L => Some("Mod1"),
                KEYSYM_SUPER_L => Some("Mod4"),
                _ => None,
            };
            if let Some(modifier) = modifier {
                symbols.push_str(&format!(
                    "    modifier_map {modifier} {{ <K{keycode}> }};\n"
                ));
            }
            codes.insert(*keysym, keycode - 8);
        }
        let maximum = KEYCODE_BASE + unique.len().max(1) as u32;
        let keymap = format!(
            "xkb_keymap {{\nxkb_keycodes \"cul\" {{\n    minimum = {KEYCODE_BASE};\n    maximum = {maximum};\n{keycodes}}};\nxkb_types \"cul\" {{ include \"complete\" }};\nxkb_compatibility \"cul\" {{ include \"complete\" }};\nxkb_symbols \"cul\" {{\n{symbols}}};\n}};\n"
        );
        (keymap, codes)
    }

    /// The few sway IPC requests the seat route needs, over SWAYSOCK.
    pub(super) mod sway_ipc {
        use super::*;
        const GET_OUTPUTS: u32 = 3;
        const GET_TREE: u32 = 4;
        const GET_VERSION: u32 = 7;
        const GET_CONFIG: u32 = 9;
        const GET_BINDING_STATE: u32 = 12;
        const GET_SEATS: u32 = 101;

        fn request(kind: u32) -> Result<serde_json::Value> {
            let path = std::env::var("SWAYSOCK")
                .context("the agent seat needs SWAYSOCK to verify focus")?;
            let mut stream = UnixStream::connect(&path)
                .with_context(|| format!("could not connect to {path}"))?;
            stream.set_read_timeout(Some(CALL_TIMEOUT))?;
            stream.set_write_timeout(Some(CALL_TIMEOUT))?;
            let mut message = b"i3-ipc".to_vec();
            message.extend(0u32.to_ne_bytes());
            message.extend(kind.to_ne_bytes());
            stream.write_all(&message)?;
            let mut header = [0u8; 14];
            stream.read_exact(&mut header)?;
            let length = u32::from_ne_bytes(header[6..10].try_into().expect("4 bytes")) as usize;
            let mut payload = vec![0u8; length];
            stream.read_exact(&mut payload)?;
            serde_json::from_slice(&payload).context("sway IPC reply was not JSON")
        }

        /// The loaded config's text.
        fn config() -> Result<String> {
            request(GET_CONFIG)?
                .get("config")
                .and_then(|config| config.as_str())
                .map(str::to_string)
                .context("sway sent no config")
        }

        /// The loaded config with its include lines replaced by the files
        /// they name, read the way sway resolves them: relative to the
        /// config's directory, with ~ and environment variables expanded and
        /// a * pattern in the file name. GET_CONFIG returns only the main file.
        pub(in super::super) fn config_with_includes() -> Result<String> {
            let main = request(GET_VERSION)?
                .get("loaded_config_file_name")
                .and_then(|name| name.as_str())
                .map(std::path::PathBuf::from)
                .unwrap_or_default();
            let dir = main
                .parent()
                .map(std::path::Path::to_path_buf)
                .unwrap_or_default();
            let mut state = Includes::default();
            state.seen.insert(main.clone());
            expand_includes(
                &config()?,
                &dir,
                &|path| std::fs::read_to_string(path).ok(),
                &|dir| {
                    std::fs::read_dir(dir)
                        .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
                        .unwrap_or_default()
                },
                &mut state,
            )
        }

        type ReadFile<'a> = &'a dyn Fn(&std::path::Path) -> Option<String>;
        type ListDir<'a> = &'a dyn Fn(&std::path::Path) -> Vec<std::path::PathBuf>;

        /// What include expansion carries between files: the files already
        /// read (sway reads each once, so a glob matching its own file does
        /// not loop) and the config's variables, which include arguments use.
        #[derive(Default)]
        pub(in super::super) struct Includes {
            pub seen: std::collections::HashSet<std::path::PathBuf>,
            pub variables: Vec<(String, String)>,
        }

        pub(in super::super) fn expand_includes(
            text: &str,
            dir: &std::path::Path,
            read: ReadFile,
            list: ListDir,
            state: &mut Includes,
        ) -> Result<String> {
            let mut out = String::new();
            for line in text.lines() {
                let trimmed = line.trim();
                let mut words = trimmed.split_whitespace();
                if words.next() == Some("set") {
                    if let (Some(name), Some(value)) = (words.next(), words.next()) {
                        state.variables.push((name.to_string(), value.to_string()));
                        state
                            .variables
                            .sort_by_key(|(name, _)| std::cmp::Reverse(name.len()));
                    }
                }
                let Some(path) = trimmed.strip_prefix("include ") else {
                    out.push_str(line);
                    out.push('\n');
                    continue;
                };
                let raw = path.trim().trim_matches('"').trim_matches('\'');
                for file in include_paths(raw, dir, list, &state.variables)? {
                    if !state.seen.insert(file.clone()) {
                        continue;
                    }
                    if let Some(contents) = read(&file) {
                        let parent = file
                            .parent()
                            .map(std::path::Path::to_path_buf)
                            .unwrap_or_default();
                        out.push_str(&expand_includes(&contents, &parent, read, list, state)?);
                    }
                }
            }
            Ok(out)
        }

        fn include_paths(
            raw: &str,
            dir: &std::path::Path,
            list: ListDir,
            variables: &[(String, String)],
        ) -> Result<Vec<std::path::PathBuf>> {
            let mut text = raw.to_string();
            for (name, value) in variables {
                text = text.replace(name.as_str(), value);
            }
            let mut expanded = String::new();
            let mut rest = text.as_str();
            if let Some(tail) = rest.strip_prefix('~') {
                expanded.push_str(&std::env::var("HOME").unwrap_or_default());
                rest = tail;
            }
            let mut chars = rest.chars().peekable();
            while let Some(ch) = chars.next() {
                if ch != '$' {
                    expanded.push(ch);
                    continue;
                }
                let braced = chars.peek() == Some(&'{');
                if braced {
                    chars.next();
                }
                let mut name = String::new();
                while let Some(next) = chars
                    .peek()
                    .copied()
                    .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
                {
                    name.push(next);
                    chars.next();
                }
                if braced && chars.next() != Some('}') {
                    bail!("cannot read the sway include {raw:?}, so its bindings cannot be checked; no keys were sent");
                }
                expanded.push_str(&std::env::var(&name).unwrap_or_default());
            }
            if !expanded.starts_with('/') && dir.as_os_str().is_empty() {
                bail!("cannot resolve the relative sway include {raw:?}, so its bindings cannot be checked; no keys were sent");
            }
            let path = dir.join(&expanded);
            let wild = |part: &str| part.contains(['*', '?', '[']);
            let parent = path
                .parent()
                .map(std::path::Path::to_path_buf)
                .unwrap_or_default();
            if parent
                .components()
                .any(|part| wild(&part.as_os_str().to_string_lossy()))
            {
                bail!("cannot expand the sway include {raw:?} (a pattern in a directory), so its bindings cannot be checked; no keys were sent");
            }
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            if !wild(&name) {
                return Ok(vec![path]);
            }
            if name.contains('[') {
                bail!("cannot expand the sway include {raw:?} (a [..] pattern), so its bindings cannot be checked; no keys were sent");
            }
            let mut files = list(&parent)
                .into_iter()
                .filter(|file| {
                    file.file_name()
                        .is_some_and(|file| wildcard(&name, &file.to_string_lossy()))
                })
                .collect::<Vec<_>>();
            files.sort();
            Ok(files)
        }

        /// Shell-style match of * and ? (no character classes).
        pub(in super::super) fn wildcard(pattern: &str, text: &str) -> bool {
            let pattern: Vec<char> = pattern.chars().collect();
            let text: Vec<char> = text.chars().collect();
            let (mut p, mut t, mut star, mut mark) = (0, 0, None, 0);
            while t < text.len() {
                if p < pattern.len() && (pattern[p] == '?' || pattern[p] == text[t]) {
                    p += 1;
                    t += 1;
                } else if p < pattern.len() && pattern[p] == '*' {
                    star = Some(p);
                    mark = t;
                    p += 1;
                } else if let Some(at) = star {
                    p = at + 1;
                    mark += 1;
                    t = mark;
                } else {
                    return false;
                }
            }
            pattern[p..].iter().all(|ch| *ch == '*')
        }

        /// The active binding mode's name.
        pub(in super::super) fn binding_mode() -> Result<String> {
            request(GET_BINDING_STATE)?
                .get("name")
                .and_then(|name| name.as_str())
                .map(str::to_string)
                .context("sway sent no binding mode")
        }

        /// (seat name, focused container id) for every seat.
        pub(in super::super) fn seats() -> Result<Vec<(String, u64)>> {
            Ok(parse_seats(&request(GET_SEATS)?))
        }

        pub(in super::super) fn parse_seats(value: &serde_json::Value) -> Vec<(String, u64)> {
            value
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|seat| {
                    Some((
                        seat.get("name")?.as_str()?.to_string(),
                        seat.get("focus")?.as_u64().unwrap_or(0),
                    ))
                })
                .collect()
        }

        /// Focus of the user's seat (seat0, or the first other seat).
        pub(in super::super) fn seat_focus() -> Result<u64> {
            let seats = seats()?;
            seats
                .iter()
                .find(|(name, _)| name == "seat0")
                .or_else(|| {
                    seats
                        .iter()
                        .find(|(name, _)| !name.starts_with("transient-"))
                })
                .map(|(_, focus)| *focus)
                .context("sway reported no user seat")
        }

        /// Sway container id for a window id: native windows carry it
        /// above 2^32.
        pub(in super::super) fn container_id(window_id: u64) -> Result<u64> {
            window_id
                .checked_sub(SWAY_CONTAINER_ID_BASE)
                .context("not a native Wayland window on sway")
        }

        /// The view drawn at a layout point: floating views first, then
        /// tiled, both on visible workspaces only.
        pub(in super::super) fn view_at(x: f64, y: f64) -> Result<Option<u64>> {
            Ok(view_at_in(&request(GET_TREE)?, x, y))
        }

        pub(in super::super) fn view_at_in(
            tree: &serde_json::Value,
            x: f64,
            y: f64,
        ) -> Option<u64> {
            fn views<'a>(
                node: &'a serde_json::Value,
                floating: bool,
                out: &mut Vec<(&'a serde_json::Value, bool)>,
            ) {
                let is_view = node.get("pid").is_some_and(|pid| !pid.is_null())
                    && node
                        .get("nodes")
                        .and_then(|nodes| nodes.as_array())
                        .is_none_or(|nodes| nodes.is_empty());
                if is_view {
                    out.push((node, floating));
                }
                for (key, child_floating) in [("nodes", floating), ("floating_nodes", true)] {
                    for child in node
                        .get(key)
                        .and_then(|nodes| nodes.as_array())
                        .into_iter()
                        .flatten()
                    {
                        views(child, child_floating, out);
                    }
                }
            }
            let mut all = Vec::new();
            views(tree, false, &mut all);
            let contains = |node: &serde_json::Value| {
                let Some(rect) = node.get("rect") else {
                    return false;
                };
                let field = |name: &str| {
                    rect.get(name)
                        .and_then(|value| value.as_f64())
                        .unwrap_or(0.0)
                };
                node.get("visible").and_then(|value| value.as_bool()) == Some(true)
                    && x >= field("x")
                    && x < field("x") + field("width")
                    && y >= field("y")
                    && y < field("y") + field("height")
            };
            // floating_nodes runs bottom to top, so the topmost comes last.
            all.iter()
                .rev()
                .filter(|(_, floating)| *floating)
                .chain(all.iter().filter(|(_, floating)| !*floating))
                .find(|(node, _)| contains(node))
                .and_then(|(node, _)| node.get("id").and_then(|id| id.as_u64()))
        }

        /// The output layout in capture pixels, which absolute pointer
        /// motion spans. Needs one scale on every active output.
        pub(in super::super) struct Layout {
            pub left: f64,
            pub top: f64,
            pub scale: f64,
            pub width: u32,
            pub height: u32,
        }

        impl Layout {
            /// Layout coordinates of a capture-pixel point.
            pub(in super::super) fn logical(&self, x: f64, y: f64) -> (f64, f64) {
                (self.left + x / self.scale, self.top + y / self.scale)
            }
        }

        pub(in super::super) fn layout() -> Result<Layout> {
            layout_of(&request(GET_OUTPUTS)?)
        }

        pub(in super::super) fn layout_of(outputs: &serde_json::Value) -> Result<Layout> {
            let mut scale: Option<f64> = None;
            let (mut left, mut top, mut right, mut bottom) =
                (i64::MAX, i64::MAX, i64::MIN, i64::MIN);
            for output in outputs.as_array().into_iter().flatten() {
                if output.get("active").and_then(|value| value.as_bool()) != Some(true) {
                    continue;
                }
                let rect = output.get("rect").context("sway output without rect")?;
                let field =
                    |name: &str| rect.get(name).and_then(|value| value.as_i64()).unwrap_or(0);
                let output_scale = output
                    .get("scale")
                    .and_then(|value| value.as_f64())
                    .unwrap_or(1.0);
                if !output_scale.is_finite() || output_scale <= 0.0 {
                    bail!("sway reported an invalid output scale {output_scale}");
                }
                // Screenshots on sway come from grim, which never captures
                // below scale 1 (as in the i3 backend's capture mapping).
                let output_scale = output_scale.max(1.0);
                match scale {
                    Some(seen) if (seen - output_scale).abs() > f64::EPSILON => {
                        bail!("sway outputs use different scales, so a screenshot point cannot be mapped to the agent pointer")
                    }
                    _ => scale = Some(output_scale),
                }
                left = left.min(field("x"));
                top = top.min(field("y"));
                right = right.max(field("x") + field("width"));
                bottom = bottom.max(field("y") + field("height"));
            }
            let scale = scale.context("sway reported no active output")?;
            Ok(Layout {
                left: left as f64,
                top: top as f64,
                scale,
                width: ((right - left) as f64 * scale).round() as u32,
                height: ((bottom - top) as f64 * scale).round() as u32,
            })
        }
    }

    impl Dispatch<wl_registry::WlRegistry, ()> for State {
        fn event(
            state: &mut Self,
            _: &wl_registry::WlRegistry,
            event: wl_registry::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            match event {
                wl_registry::Event::Global {
                    name,
                    interface,
                    version,
                } => {
                    if !state.globals.iter().any(|(global, _, _)| *global == name) {
                        state.globals.push((name, interface, version));
                    }
                }
                wl_registry::Event::GlobalRemove { name } => {
                    state.globals.retain(|(global, _, _)| *global != name);
                }
                _ => {}
            }
        }
    }

    impl Dispatch<wl_callback::WlCallback, ()> for State {
        fn event(
            state: &mut Self,
            _: &wl_callback::WlCallback,
            event: wl_callback::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            if let wl_callback::Event::Done { .. } = event {
                state.synced = true;
            }
        }
    }

    impl Dispatch<transient_seat::ExtTransientSeatV1, ()> for State {
        fn event(
            state: &mut Self,
            _: &transient_seat::ExtTransientSeatV1,
            event: transient_seat::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            match event {
                transient_seat::Event::Ready { global_name } => state.ready = Some(Ok(global_name)),
                transient_seat::Event::Denied => state.ready = Some(Err(())),
                _ => {}
            }
        }
    }

    impl Dispatch<wl_seat::WlSeat, ()> for State {
        fn event(
            state: &mut Self,
            _: &wl_seat::WlSeat,
            event: wl_seat::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            if let wl_seat::Event::Name { name } = event {
                state.seat_name = Some(name);
            }
        }
    }

    impl Dispatch<toplevel_manager::ZwlrForeignToplevelManagerV1, ()> for State {
        fn event(
            state: &mut Self,
            _: &toplevel_manager::ZwlrForeignToplevelManagerV1,
            event: toplevel_manager::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            if let toplevel_manager::Event::Toplevel { toplevel } = event {
                state.toplevels.push((toplevel, Toplevel::default()));
            }
        }

        event_created_child!(State, toplevel_manager::ZwlrForeignToplevelManagerV1, [
            toplevel_manager::EVT_TOPLEVEL_OPCODE => (toplevel_handle::ZwlrForeignToplevelHandleV1, ()),
        ]);
    }

    impl Dispatch<toplevel_handle::ZwlrForeignToplevelHandleV1, ()> for State {
        fn event(
            state: &mut Self,
            handle: &toplevel_handle::ZwlrForeignToplevelHandleV1,
            event: toplevel_handle::Event,
            _: &(),
            _: &Connection,
            _: &QueueHandle<Self>,
        ) {
            let Some((_, toplevel)) = state
                .toplevels
                .iter_mut()
                .find(|(known, _)| known.id() == handle.id())
            else {
                return;
            };
            match event {
                toplevel_handle::Event::Title { title } => toplevel.title = Some(title),
                toplevel_handle::Event::AppId { app_id } => toplevel.app_id = Some(app_id),
                toplevel_handle::Event::Done => toplevel.done = true,
                toplevel_handle::Event::Closed => toplevel.closed = true,
                _ => {}
            }
        }
    }

    wayland_client::delegate_noop!(State: ignore transient_manager::ExtTransientSeatManagerV1);
    wayland_client::delegate_noop!(State: ignore keyboard_manager::ZwpVirtualKeyboardManagerV1);
    wayland_client::delegate_noop!(State: ignore virtual_keyboard::ZwpVirtualKeyboardV1);
    wayland_client::delegate_noop!(State: ignore pointer_manager::ZwlrVirtualPointerManagerV1);
    wayland_client::delegate_noop!(State: ignore virtual_pointer::ZwlrVirtualPointerV1);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(desktop: &str) -> SessionFacts {
        SessionFacts {
            wayland: true,
            current_desktop: desktop.to_string(),
            ..SessionFacts::default()
        }
    }

    #[test]
    fn classify_names_each_desktop() {
        let x11 = SessionFacts {
            native_x11: true,
            current_desktop: "xfce".into(),
            ..SessionFacts::default()
        };
        assert_eq!(classify(&x11), Ok(SeatKind::X11Master));
        let sway = SessionFacts {
            sway: true,
            ..facts("sway")
        };
        assert_eq!(classify(&sway), Ok(SeatKind::SwayTransientSeat));
        let hypr = SessionFacts {
            hyprland: true,
            ..facts("hyprland")
        };
        assert_eq!(classify(&hypr), Ok(SeatKind::HyprlandSendKeyState));
        for (desktop, word) in [
            ("kde", "KWin"),
            ("cosmic", "cosmic-comp"),
            ("niri", "niri"),
            ("labwc:wlroots", "labwc"),
            ("gnome", "GNOME"),
            ("ubuntu:gnome", "GNOME"),
            ("river", "river"),
        ] {
            let refusal = classify(&facts(desktop)).unwrap_err();
            assert!(refusal.contains(word), "{desktop}: {refusal}");
            assert!(refusal.contains(OTHER_ROUTES), "{refusal}");
        }
        let gnome_x11 = SessionFacts {
            native_x11: true,
            current_desktop: "ubuntu:gnome".into(),
            ..SessionFacts::default()
        };
        assert!(classify(&gnome_x11).is_err());
    }

    #[test]
    fn strokes_cover_text_and_chords() {
        assert_eq!(keysym_for_name("Return"), Some(0xff0d));
        assert_eq!(keysym_for_name("F5"), Some(0xffc2));
        assert_eq!(keysym_for_name("a"), Some(0x61));
        assert!(text_strokes("a\u{7}").is_err());
        let strokes = text_strokes("H\u{e9}\n").unwrap();
        assert_eq!(
            strokes
                .iter()
                .map(|stroke| stroke.keysym)
                .collect::<Vec<_>>(),
            vec![0x48, 0xe9, 0xff0d]
        );
        let press = KeyPress {
            mods: "CTRL SHIFT".into(),
            key: "Tab".into(),
        };
        let stroke = chord_stroke(&press).unwrap();
        assert!(stroke.ctrl && stroke.shift && !stroke.alt);
        assert_eq!(
            stroke.modifier_keysyms(),
            vec![KEYSYM_CONTROL_L, KEYSYM_SHIFT_L]
        );
    }

    #[test]
    fn x11_plan_uses_user_keys_and_agent_modifiers() {
        // User map: keycode 10 = a/A, 11 = 1/exclam. Agent map: Shift_L on 50.
        let user = x11::KeyMap {
            min_keycode: 10,
            per_keycode: 2,
            keysyms: vec![0x61, 0x41, 0x31, 0x21],
            modifiers: vec![vec![]; 8],
        };
        let mut agent_keysyms = vec![0; 2 * 41];
        agent_keysyms[2 * 40] = KEYSYM_SHIFT_L;
        let agent = x11::KeyMap {
            min_keycode: 10,
            per_keycode: 2,
            keysyms: agent_keysyms,
            modifiers: vec![vec![]; 8],
        };
        assert_eq!(
            x11::plan_stroke(&Stroke::plain(0x61), &user, &agent).unwrap(),
            vec![10]
        );
        assert_eq!(
            x11::plan_stroke(&Stroke::plain(0x21), &user, &agent).unwrap(),
            vec![50, 11]
        );
        assert!(x11::plan_stroke(&Stroke::plain(0xe9), &user, &agent).is_err());
        let vt = Stroke {
            keysym: 0xffbe,
            ctrl: true,
            alt: true,
            shift: false,
            meta: false,
        };
        assert!(x11::plan_stroke(&vt, &user, &agent).is_err());
        assert_eq!(
            x11::master_marker("codex-computer-use-linux agent 3a00001 pointer"),
            Some(0x3a00001)
        );
        assert_eq!(x11::master_marker("Virtual core pointer"), None);
    }

    #[test]
    fn sway_keymap_gives_each_keysym_a_key() {
        let (keymap, codes) = sway::xkb_keymap(&[0x61, KEYSYM_SHIFT_L, 0x61, 0x1001_f600]);
        assert_eq!(codes.len(), 3);
        assert_eq!(codes[&0x61], sway::KEYCODE_BASE - 8);
        assert!(keymap.contains("key <K1024> { [ a ] };"));
        assert!(keymap.contains("modifier_map Shift { <K1025> };"));
        assert!(keymap.contains("0x1001f600"));
    }

    #[test]
    fn sway_refuses_clients_that_never_bind_a_new_seat() {
        assert!(
            seatless_toolkit("7f00 r-xp /usr/lib/libgtk-3.so.0.2400.41\n", false)
                .unwrap()
                .contains("GTK 3")
        );
        assert!(
            seatless_toolkit("7f00 r-xp /usr/lib/libgtk-4.so.1.1800.0\n", false)
                .unwrap()
                .contains("GTK 4")
        );
        assert!(seatless_toolkit("", true).unwrap().contains("Chromium"));
        assert_eq!(
            seatless_toolkit("7f00 r-xp /usr/lib/libQt6Gui.so.6\n", false),
            None
        );
    }

    #[test]
    fn sway_config_bindings_match_chords() {
        let config = "set $mod Mod4\nset $term foot\nbindsym $mod+Return exec $term\nbindsym --to-code Ctrl+q kill\nbindsym {\n    Ctrl+Shift+e exit\n}\nbindsym Print exec grim\n";
        let chord = |ctrl, shift, meta, key: u32| Stroke {
            keysym: key,
            ctrl,
            alt: false,
            shift,
            meta,
        };
        assert_eq!(
            sway::bound_chord(config, &chord(true, false, false, 0x71)),
            Some("Ctrl+q".to_string())
        );
        assert_eq!(
            sway::bound_chord(config, &chord(true, true, false, 0x65)),
            Some("Ctrl+Shift+e".to_string())
        );
        assert_eq!(
            sway::bound_chord(config, &chord(false, false, true, 0xff0d)),
            Some("$mod+Return".to_string())
        );
        assert_eq!(
            sway::bound_chord(config, &chord(false, false, false, 0xff61)),
            Some("Print".to_string())
        );
        assert_eq!(
            sway::bound_chord(config, &chord(true, false, false, 0x6c)),
            None
        );
        let modes = "mode \"resize\" {\n    bindsym h resize shrink width 10px\n    bindsym Escape mode default\n}\nbindsym Pause exec true\n";
        assert_eq!(
            sway::bound_chord(modes, &chord(false, false, false, 0x68)),
            None
        );
        assert_eq!(
            sway::bound_chord(modes, &chord(false, false, false, 0xff13)),
            Some("Pause".to_string())
        );
        let next_line = "mode \"resize\"\n{\n    bindsym h resize shrink width 10px\n}\nmode \"default\" {\n    bindsym Pause exec true\n}\n";
        assert_eq!(
            sway::bound_chord(next_line, &chord(false, false, false, 0x68)),
            None
        );
        assert_eq!(
            sway::bound_chord(next_line, &chord(false, false, false, 0xff13)),
            Some("Pause".to_string())
        );
    }

    #[test]
    fn sway_config_includes_are_read() {
        use std::path::{Path, PathBuf};
        let read = |path: &Path| match path.to_str()? {
            "/etc/sway/config.d/50-keys.conf" => {
                Some("bindsym Ctrl+e exec true\ninclude nested.conf\n".to_string())
            }
            "/etc/sway/config.d/nested.conf" => {
                Some("bindsym Ctrl+n exec true\ninclude /etc/sway/config.d/*\n".to_string())
            }
            "/home/u/.config/sway/local" => Some("bindsym Ctrl+k exec true\n".to_string()),
            _ => None,
        };
        let list = |dir: &Path| {
            if dir == Path::new("/etc/sway/config.d") {
                vec![
                    PathBuf::from("/etc/sway/config.d/50-keys.conf"),
                    PathBuf::from("/etc/sway/config.d/nested.conf"),
                    PathBuf::from("/etc/sway/config.d/README"),
                ]
            } else {
                Vec::new()
            }
        };
        let main = "set $mod Mod4\nset $dir /etc/sway\ninclude $dir/config.d/*.conf\ninclude /etc/sway/config.d/*\ninclude local\n";
        let mut state = sway::sway_ipc::Includes::default();
        let text = sway::sway_ipc::expand_includes(
            main,
            Path::new("/home/u/.config/sway"),
            &read,
            &list,
            &mut state,
        )
        .unwrap();
        let ctrl = |key: u32| Stroke {
            keysym: key,
            ctrl: true,
            alt: false,
            shift: false,
            meta: false,
        };
        assert!(sway::bound_chord(&text, &ctrl(0x65)).is_some());
        assert!(sway::bound_chord(&text, &ctrl(0x6e)).is_some());
        assert!(sway::bound_chord(&text, &ctrl(0x6b)).is_some());
        assert!(sway::bound_chord(&text, &ctrl(0x6c)).is_none());
        assert_eq!(
            text.matches("bindsym Ctrl+n").count(),
            1,
            "each file is read once"
        );
        assert!(sway::sway_ipc::wildcard("*.c?nf", "keys.conf"));
        assert!(!sway::sway_ipc::wildcard("*.conf", "README"));
        let mut state = sway::sway_ipc::Includes::default();
        assert!(sway::sway_ipc::expand_includes(
            "include relative",
            Path::new(""),
            &read,
            &list,
            &mut state
        )
        .is_err());
    }

    #[test]
    fn sway_ipc_parsing() {
        let seats =
            serde_json::json!([{"name": "seat0", "focus": 7}, {"name": "transient-0", "focus": 9}]);
        assert_eq!(
            sway::sway_ipc::parse_seats(&seats),
            vec![("seat0".to_string(), 7), ("transient-0".to_string(), 9)]
        );
        let tree = serde_json::json!({"id": 1, "nodes": [{"id": 2, "visible": true, "nodes": [
            {"id": 10, "pid": 5, "visible": true, "rect": {"x": 0, "y": 0, "width": 640, "height": 800}, "nodes": []},
            {"id": 11, "pid": 6, "visible": true, "rect": {"x": 640, "y": 0, "width": 640, "height": 800}, "nodes": []}
        ], "floating_nodes": [
            {"id": 12, "pid": 7, "visible": true, "rect": {"x": 600, "y": 100, "width": 100, "height": 100}, "nodes": []},
            {"id": 14, "pid": 9, "visible": true, "rect": {"x": 650, "y": 150, "width": 100, "height": 100}, "nodes": []}
        ]}, {"id": 3, "nodes": [
            {"id": 13, "pid": 8, "visible": false, "rect": {"x": 0, "y": 0, "width": 1280, "height": 800}, "nodes": []}
        ]}]});
        assert_eq!(sway::sway_ipc::view_at_in(&tree, 10.0, 10.0), Some(10));
        assert_eq!(sway::sway_ipc::view_at_in(&tree, 620.0, 120.0), Some(12));
        // The later floating node is drawn on top where they overlap.
        assert_eq!(sway::sway_ipc::view_at_in(&tree, 680.0, 180.0), Some(14));
        assert_eq!(sway::sway_ipc::view_at_in(&tree, 900.0, 500.0), Some(11));
        let outputs = serde_json::json!([
            {"active": true, "scale": 2.0, "rect": {"x": 0, "y": 0, "width": 1280, "height": 720}},
            {"active": true, "scale": 2.0, "rect": {"x": 1280, "y": 0, "width": 640, "height": 480}},
            {"active": false, "scale": 1.0, "rect": {"x": 0, "y": 0, "width": 1, "height": 1}}
        ]);
        let layout = sway::sway_ipc::layout_of(&outputs).unwrap();
        assert_eq!((layout.width, layout.height), (3840, 1440));
        assert_eq!(layout.logical(200.0, 100.0), (100.0, 50.0));
    }
}

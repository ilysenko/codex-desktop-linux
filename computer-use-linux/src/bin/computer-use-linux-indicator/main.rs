//! `codex-computer-use-indicator`: a click-through overlay that shows when an
//! agent drives the desktop through `codex-computer-use-linux`.
//!
//! The MCP server sends one JSON datagram per action (see
//! `codex_computer_use_linux::indicator`). While actions arrive this draws, on
//! `wlr-layer-shell` overlay surfaces:
//!
//! - a software cursor that glides along an arc to each target and ripples on
//!   click (moving it only changes surface margins, nothing is redrawn);
//! - keycaps or a typing line next to the cursor for keyboard input;
//! - a glow along every screen edge and a status pill.
//!
//! Surfaces exist only while the agent is active and fade out after a few idle
//! seconds. The process exits after ten idle minutes; the server restarts it
//! on demand.

mod draw;
mod font;
mod gnome;

use std::{
    collections::hash_map::DefaultHasher,
    f32::consts::PI,
    fs::{File, OpenOptions, TryLockError},
    hash::{Hash, Hasher},
    os::unix::net::UnixDatagram,
    process::ExitCode,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

use codex_computer_use_linux::indicator::{
    capture_lock_path, socket_path, Capture, IndicatorEvent, CAPTURE_REPLY_EMPTY,
    CAPTURE_REPLY_SHOWN, GLIDE, HIDE_SETTLE,
};
use smithay_client_toolkit::{
    compositor::{CompositorHandler, CompositorState, Region},
    delegate_registry,
    dispatch2::Dispatch2,
    output::{OutputHandler, OutputState},
    reexports::{
        calloop::{
            generic::Generic,
            timer::{TimeoutAction, Timer},
            EventLoop, Interest, LoopHandle, Mode, PostAction,
        },
        calloop_wayland_source::WaylandSource,
    },
    registry::{ProvidesRegistryState, RegistryState},
    registry_handlers,
    shell::{
        wlr_layer::{
            Anchor, KeyboardInteractivity, Layer, LayerShell, LayerShellHandler, LayerSurface,
            LayerSurfaceConfigure,
        },
        WaylandSurface,
    },
    shm::{slot::SlotPool, Shm, ShmHandler},
};
use tiny_skia::{Color, Pixmap};
use wayland_client::{
    globals::registry_queue_init,
    protocol::{wl_output::WlOutput, wl_shm, wl_surface::WlSurface},
    Connection, QueueHandle,
};
use wayland_protocols::wp::{
    fractional_scale::v1::client::{
        wp_fractional_scale_manager_v1::WpFractionalScaleManagerV1,
        wp_fractional_scale_v1::{self, WpFractionalScaleV1},
    },
    viewporter::client::{wp_viewport::WpViewport, wp_viewporter::WpViewporter},
};

use draw::{Edge, CURSOR_SIZE};

/// Idle time before fading out.
const IDLE_BEFORE_FADE: Duration = Duration::from_secs(8);
const FADE_IN: f32 = 0.2;
const FADE_OUT: f32 = 0.35;
const PULSE: f32 = 0.45;
/// Sway and breathing stop this long after an action, so a resting overlay
/// stops redrawing.
const SETTLE: f32 = 2.0;
const KEYS_SHOWN: f32 = 2.2;
const EXIT_AFTER_IDLE: Duration = Duration::from_secs(600);
const EDGE: u32 = 26;
const PILL_SIZE: (u32, u32) = (560, 56);
const PILL_TOP: i32 = 34;
const BUBBLE_SIZE: (u32, u32) = (460, 48);
const FRAME: Duration = Duration::from_millis(16);
const RESTING_FRAME: Duration = Duration::from_millis(250);
/// How often to look for the end of a capture that holds the overlay back.
const HOLD_POLL: Duration = Duration::from_millis(40);

fn agent_color(agent: &str) -> Color {
    let rgb = match agent.to_ascii_lowercase().as_str() {
        "claude" => (0xE0, 0x8A, 0x67),
        "codex" => (0x4C, 0x9D, 0xFF),
        "opencode" => (0x8B, 0xD4, 0x7E),
        "gemini" | "antigravity" => (0x8A, 0xB4, 0xF8),
        "hermes" => (0xF2, 0xC1, 0x4E),
        "pi" => (0xC0, 0x8A, 0xF0),
        _ => (0x9B, 0x8C, 0xFF),
    };
    Color::from_rgba8(rgb.0, rgb.1, rgb.2, 255)
}

fn tool_label(tool: &str) -> &str {
    match tool {
        "click" => "click",
        "drag" => "drag",
        "scroll" => "scroll",
        "type_text" => "typing",
        "press_key" => "key press",
        "set_value" => "entering a value",
        "perform_action" => "action",
        "activate_window" => "switching window",
        "move_window" => "moving window",
        "resize_window" => "resizing window",
        "screenshot" | "get_app_state" => "looking at the screen",
        other => other,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Kind {
    Cursor,
    Pill,
    Bubble,
    Edge(EdgeKind),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum EdgeKind {
    Top,
    Bottom,
    Left,
    Right,
}

impl EdgeKind {
    const ALL: [Self; 4] = [Self::Top, Self::Bottom, Self::Left, Self::Right];

    fn edge(self) -> Edge {
        match self {
            Self::Top => Edge::Top,
            Self::Bottom => Edge::Bottom,
            Self::Left => Edge::Left,
            Self::Right => Edge::Right,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Rect {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

impl Rect {
    fn contains(&self, (x, y): (f32, f32)) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }

    fn distance(&self, (x, y): (f32, f32)) -> f32 {
        let dx = (self.x - x).max(0.0).max(x - (self.x + self.w));
        let dy = (self.y - y).max(0.0).max(y - (self.y + self.h));
        dx.hypot(dy)
    }
}

struct Panel {
    kind: Kind,
    output: WlOutput,
    layer: LayerSurface,
    viewport: Option<WpViewport>,
    fractional: Option<WpFractionalScaleV1>,
    /// Logical size, as configured.
    size: (u32, u32),
    /// Buffer scale: fractional when the compositor reports one.
    scale: f32,
    configured: bool,
    margin: (i32, i32),
    /// Signature of the last drawn frame; redraw only when it changes.
    drawn: Option<u64>,
}

impl Drop for Panel {
    fn drop(&mut self) {
        if let Some(viewport) = self.viewport.take() {
            viewport.destroy();
        }
        if let Some(fractional) = self.fractional.take() {
            fractional.destroy();
        }
    }
}

struct Glide {
    from: (f32, f32),
    ctrl: (f32, f32),
    to: (f32, f32),
    start: Instant,
    duration: f32,
    press: bool,
}

impl Glide {
    fn new(from: (f32, f32), to: (f32, f32), press: bool) -> Self {
        let (dx, dy) = (to.0 - from.0, to.1 - from.1);
        let dist = dx.hypot(dy);
        // A gentle arc, like a hand moving a mouse, rather than a straight slide.
        let bend = 0.16 * dist;
        let (nx, ny) = if dist > 0.0 {
            (-dy / dist, dx / dist)
        } else {
            (0.0, 0.0)
        };
        Self {
            from,
            ctrl: (
                (from.0 + to.0) / 2.0 + nx * bend,
                (from.1 + to.1) / 2.0 + ny * bend,
            ),
            to,
            start: Instant::now(),
            // Never longer than the server waits before the real input.
            duration: (0.16 + dist / 4000.0).clamp(0.2, GLIDE.as_secs_f32() - 0.03),
            press,
        }
    }

    fn progress(&self) -> f32 {
        (self.start.elapsed().as_secs_f32() / self.duration).min(1.0)
    }

    fn position(&self) -> (f32, f32) {
        // Critically damped spring shape, normalised to land exactly at t = 1.
        let spring = |t: f32| 1.0 - (1.0 + 6.0 * t) * (-6.0 * t).exp();
        let e = spring(self.progress()) / spring(1.0);
        let u = 1.0 - e;
        let bezier = |a: f32, c: f32, b: f32| u * u * a + 2.0 * u * e * c + e * e * b;
        (
            bezier(self.from.0, self.ctrl.0, self.to.0),
            bezier(self.from.1, self.ctrl.1, self.to.1),
        )
    }
}

enum Keyboard {
    Keys(Vec<String>),
    Text(String),
}

struct App {
    registry: RegistryState,
    outputs: OutputState,
    compositor: CompositorState,
    layer_shell: LayerShell,
    shm: Shm,
    pool: SlotPool,
    viewporter: Option<WpViewporter>,
    fractional: Option<WpFractionalScaleManagerV1>,
    /// Loaded on a worker thread: scanning system fonts can take a second.
    fonts: Arc<OnceLock<font::Fonts>>,
    active: bool,
    handle: LoopHandle<'static, App>,
    qh: QueueHandle<App>,
    panels: Vec<Panel>,
    agent: String,
    tool: String,
    cursor: Option<(f32, f32)>,
    glide: Option<Glide>,
    pulse: Option<(Instant, (f32, f32))>,
    keyboard: Option<(Instant, Keyboard)>,
    last_action: Instant,
    shown_at: Instant,
    fading: Option<Instant>,
    /// When surfaces were last removed; the compositor may still show them.
    removed_at: Option<Instant>,
    /// Held shared by servers while they capture the screen.
    capture_lock: File,
    watching_hold: bool,
    sprite: Option<(u64, Pixmap)>,
    animating: bool,
    exit: bool,
}

impl App {
    fn output_rects(&self) -> Vec<(WlOutput, Rect)> {
        self.outputs
            .outputs()
            .filter_map(|output| {
                let info = self.outputs.info(&output)?;
                let (x, y) = info.logical_position?;
                let (w, h) = info.logical_size?;
                Some((
                    output,
                    Rect {
                        x: x as f32,
                        y: y as f32,
                        w: w as f32,
                        h: h as f32,
                    },
                ))
            })
            .collect()
    }

    /// Maps an event point to logical desktop coordinates. Points come in
    /// screenshot pixels with the capture size; the capture covers the
    /// bounding box of all outputs, like the server's absolute pointer.
    fn logical_point(&self, point: (i32, i32), space: Option<(u32, u32)>) -> (f32, f32) {
        let rects: Vec<Rect> = self
            .output_rects()
            .into_iter()
            .map(|(_, rect)| rect)
            .collect();
        spread(point, space, bounding_box(&rects))
    }

    fn output_for(&self, point: (f32, f32)) -> Option<(WlOutput, Rect)> {
        let rects = self.output_rects();
        rects
            .iter()
            .find(|(_, rect)| rect.contains(point))
            .or_else(|| {
                rects.iter().min_by(|a, b| {
                    a.1.distance(point)
                        .partial_cmp(&b.1.distance(point))
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
            })
            .cloned()
    }

    fn rect_of(&self, output: &WlOutput) -> Option<Rect> {
        self.output_rects()
            .into_iter()
            .find(|(candidate, _)| candidate == output)
            .map(|(_, rect)| rect)
    }

    fn visible(&self) -> bool {
        self.active
    }

    /// Whether a capture taken now could contain the overlay: it is shown, or
    /// its surfaces were removed too recently for the compositor to drop them.
    fn on_screen(&self) -> bool {
        !self.panels.is_empty() || self.removed_at.is_some_and(|at| at.elapsed() < HIDE_SETTLE)
    }

    fn capture_held(&self) -> bool {
        lock_held(&self.capture_lock)
    }

    /// Takes every surface off the screen until no capture holds the overlay
    /// back. State keeps updating meanwhile, so it reappears up to date.
    fn suspend(&mut self) {
        if !self.panels.is_empty() {
            self.removed_at = Some(Instant::now());
        }
        self.panels.clear();
        if self.watching_hold {
            return;
        }
        self.watching_hold = true;
        let started = self
            .handle
            .insert_source(Timer::from_duration(HOLD_POLL), |_, _, app| {
                if app.capture_held() {
                    return TimeoutAction::ToDuration(HOLD_POLL);
                }
                app.watching_hold = false;
                let qh = app.qh();
                app.resume(&qh);
                TimeoutAction::Drop
            });
        if started.is_err() {
            self.watching_hold = false;
        }
    }

    fn resume(&mut self, qh: &QueueHandle<Self>) {
        if self.visible() {
            self.sync_panels(qh);
            self.render_all(qh);
            self.ensure_animation();
        }
    }

    fn cursor_position(&self) -> Option<(f32, f32)> {
        self.glide.as_ref().map(Glide::position).or(self.cursor)
    }

    fn settling(&self) -> bool {
        self.last_action.elapsed().as_secs_f32() < SETTLE + GLIDE.as_secs_f32()
    }

    fn busy(&self) -> bool {
        self.glide.is_some()
            || self.pulse.is_some()
            || self.fading.is_some()
            || self.settling()
            || self.shown_at.elapsed().as_secs_f32() < FADE_IN
            || self.keyboard.is_some()
    }

    /// 0..1 envelope: fade in on show, fade out after idling.
    fn opacity(&self) -> f32 {
        let fade_in = (self.shown_at.elapsed().as_secs_f32() / FADE_IN).min(1.0);
        let fade_out = self.fading.map_or(1.0, |at| {
            1.0 - (at.elapsed().as_secs_f32() / FADE_OUT).min(1.0)
        });
        fade_in * fade_out
    }

    fn on_event(&mut self, event: IndicatorEvent, qh: &QueueHandle<Self>) {
        self.agent = event.agent;
        self.tool = event.tool;
        self.last_action = Instant::now();
        self.fading = None;
        self.keyboard = if !event.keys.is_empty() {
            Some((Instant::now(), Keyboard::Keys(event.keys)))
        } else {
            event
                .text
                .map(|text| (Instant::now(), Keyboard::Text(text)))
        };
        if let (Some(x), Some(y)) = (event.x, event.y) {
            let to = self.logical_point((x, y), event.space);
            // First appearance glides in from a short distance away.
            let from = self
                .cursor_position()
                .unwrap_or((to.0 + 90.0, to.1 + 120.0));
            let press = matches!(self.tool.as_str(), "click" | "drag");
            self.glide = Some(Glide::new(from, to, press));
        }
        if !self.visible() {
            self.show(qh);
        }
        self.sync_panels(qh);
        self.render_all(qh);
        self.ensure_animation();
    }

    fn show(&mut self, _qh: &QueueHandle<Self>) {
        self.active = true;
        self.shown_at = Instant::now();
    }

    /// Gives every known output its four edge strips, including outputs that
    /// appear while the agent is active.
    fn ensure_edges(&mut self, qh: &QueueHandle<Self>) {
        for (output, _) in self.output_rects() {
            if self
                .panels
                .iter()
                .any(|panel| panel.output == output && matches!(panel.kind, Kind::Edge(_)))
            {
                continue;
            }
            for edge in EdgeKind::ALL {
                let (anchor, size) = match edge {
                    EdgeKind::Top => (Anchor::TOP | Anchor::LEFT | Anchor::RIGHT, (0, EDGE)),
                    EdgeKind::Bottom => (Anchor::BOTTOM | Anchor::LEFT | Anchor::RIGHT, (0, EDGE)),
                    EdgeKind::Left => (Anchor::LEFT | Anchor::TOP | Anchor::BOTTOM, (EDGE, 0)),
                    EdgeKind::Right => (Anchor::RIGHT | Anchor::TOP | Anchor::BOTTOM, (EDGE, 0)),
                };
                self.create_panel(qh, Kind::Edge(edge), &output, anchor, size, (0, 0));
            }
        }
    }

    fn hide(&mut self) {
        // A hidden cursor reappears where it was, like a resting hand.
        if let Some(glide) = self.glide.take() {
            self.cursor = Some(glide.to);
        }
        self.pulse = None;
        self.keyboard = None;
        self.fading = None;
        self.active = false;
        if !self.panels.is_empty() {
            self.removed_at = Some(Instant::now());
        }
        self.panels.clear();
    }

    fn create_panel(
        &mut self,
        qh: &QueueHandle<Self>,
        kind: Kind,
        output: &WlOutput,
        anchor: Anchor,
        size: (u32, u32),
        margin: (i32, i32),
    ) {
        let surface = self.compositor.create_surface(qh);
        // Click-through: an empty input region.
        if let Ok(region) = Region::new(&self.compositor) {
            surface.set_input_region(Some(region.wl_region()));
        }
        let layer = self.layer_shell.create_layer_surface(
            qh,
            surface,
            Layer::Overlay,
            Some("codex-computer-use-indicator"),
            Some(output),
        );
        layer.set_anchor(anchor);
        layer.set_size(size.0, size.1);
        layer.set_exclusive_zone(-1);
        layer.set_keyboard_interactivity(KeyboardInteractivity::None);
        layer.set_margin(margin.0, 0, 0, margin.1);
        let viewport = self
            .viewporter
            .as_ref()
            .map(|viewporter| viewporter.get_viewport(layer.wl_surface(), qh, Quiet));
        let fractional = self.fractional.as_ref().map(|manager| {
            manager.get_fractional_scale(
                layer.wl_surface(),
                qh,
                ScaleOf(layer.wl_surface().clone()),
            )
        });
        let scale = self
            .outputs
            .info(output)
            .map_or(1, |info| info.scale_factor.max(1)) as f32;
        layer.commit();
        self.panels.push(Panel {
            kind,
            output: output.clone(),
            layer,
            viewport,
            fractional,
            size,
            scale,
            configured: false,
            margin,
            drawn: None,
        });
    }

    /// Places a fixed-size panel with its top-left at a desktop point,
    /// clamped to the output under `on`, and returns the offset of `point`
    /// inside it. `on` is separate because a sprite's top-left can lie on a
    /// neighbouring output, which would clip the sprite away.
    fn place(
        &mut self,
        qh: &QueueHandle<Self>,
        kind: Kind,
        size: (u32, u32),
        top_left: (f32, f32),
        on: (f32, f32),
    ) -> Option<(f32, f32)> {
        let (output, rect) = self.output_for(on)?;
        let left = (top_left.0 - rect.x)
            .clamp(0.0, (rect.w - size.0 as f32).max(0.0))
            .round();
        let top = (top_left.1 - rect.y)
            .clamp(0.0, (rect.h - size.1 as f32).max(0.0))
            .round();
        let margin = (top as i32, left as i32);
        match self.panels.iter().position(|panel| panel.kind == kind) {
            Some(index) if self.panels[index].output != output => {
                self.panels.remove(index);
                self.create_panel(qh, kind, &output, Anchor::TOP | Anchor::LEFT, size, margin);
            }
            Some(index) => {
                let panel = &mut self.panels[index];
                if panel.margin != margin {
                    panel.margin = margin;
                    panel.layer.set_margin(margin.0, 0, 0, margin.1);
                    if panel.configured {
                        // Margins are double-buffered: a bare commit moves the
                        // surface without redrawing it.
                        panel.layer.commit();
                    }
                }
            }
            None => self.create_panel(qh, kind, &output, Anchor::TOP | Anchor::LEFT, size, margin),
        }
        Some((top_left.0 - (rect.x + left), top_left.1 - (rect.y + top)))
    }

    /// Creates, moves or removes the cursor, pill and bubble panels.
    fn sync_panels(&mut self, qh: &QueueHandle<Self>) {
        if !self.visible() {
            return;
        }
        // Covers captures that began before this overlay started, too.
        if self.capture_held() {
            self.suspend();
            return;
        }
        self.ensure_edges(qh);
        let half = CURSOR_SIZE / 2.0;
        let cursor = self.cursor_position();
        match cursor {
            Some((x, y)) => {
                let size = (CURSOR_SIZE as u32, CURSOR_SIZE as u32);
                self.place(qh, Kind::Cursor, size, (x - half, y - half), (x, y));
            }
            None => self.panels.retain(|panel| panel.kind != Kind::Cursor),
        }

        // The pill sits at the top of the screen the agent is working on.
        let pill_output = cursor
            .and_then(|point| self.output_for(point))
            .or_else(|| self.output_rects().into_iter().next());
        if let Some((_, rect)) = pill_output {
            let left = rect.x + (rect.w - PILL_SIZE.0 as f32) / 2.0;
            let top_left = (left, rect.y + PILL_TOP as f32);
            self.place(qh, Kind::Pill, PILL_SIZE, top_left, top_left);
        }

        match (&self.keyboard, cursor, pill_output) {
            // Keystrokes go to the focused field, usually where the cursor last clicked.
            (Some(_), Some((x, y)), _) => {
                self.place(qh, Kind::Bubble, BUBBLE_SIZE, (x + 18.0, y + 22.0), (x, y));
            }
            (Some(_), None, Some((_, rect))) => {
                let left = rect.x + (rect.w - BUBBLE_SIZE.0 as f32) / 2.0;
                let top = rect.y + (PILL_TOP + PILL_SIZE.1 as i32) as f32;
                self.place(qh, Kind::Bubble, BUBBLE_SIZE, (left, top), (left, top));
            }
            _ => self.panels.retain(|panel| panel.kind != Kind::Bubble),
        }
    }

    fn tick(&mut self, qh: &QueueHandle<Self>) {
        if let Some(glide) = &self.glide {
            if glide.progress() >= 1.0 {
                if glide.press {
                    self.pulse = Some((Instant::now(), glide.to));
                }
                self.cursor = Some(glide.to);
                self.glide = None;
            }
        }
        if self
            .pulse
            .is_some_and(|(at, _)| at.elapsed().as_secs_f32() > PULSE)
        {
            self.pulse = None;
        }
        if self
            .keyboard
            .as_ref()
            .is_some_and(|(at, _)| at.elapsed().as_secs_f32() > KEYS_SHOWN)
        {
            self.keyboard = None;
        }
        match self.fading {
            Some(at) if at.elapsed().as_secs_f32() > FADE_OUT => {
                self.hide();
                return;
            }
            None if self.visible() && self.last_action.elapsed() > IDLE_BEFORE_FADE => {
                self.fading = Some(Instant::now());
            }
            _ => {}
        }
        self.sync_panels(qh);
        self.render_all(qh);
    }

    fn ensure_animation(&mut self) {
        if self.animating {
            return;
        }
        self.animating = true;
        let started = self
            .handle
            .insert_source(Timer::from_duration(FRAME), |_, _, app| {
                let qh = app.qh();
                app.tick(&qh);
                if !app.visible() {
                    app.animating = false;
                    return TimeoutAction::Drop;
                }
                TimeoutAction::ToDuration(if app.busy() { FRAME } else { RESTING_FRAME })
            });
        if started.is_err() {
            self.animating = false;
        }
    }

    fn qh(&self) -> QueueHandle<Self> {
        self.qh.clone()
    }

    fn render_all(&mut self, _qh: &QueueHandle<Self>) {
        for index in 0..self.panels.len() {
            self.render(index);
        }
    }

    fn sprite(&mut self, scale: f32) -> Option<&Pixmap> {
        let color = agent_color(&self.agent);
        let mut hasher = DefaultHasher::new();
        (
            color.to_color_u8().red(),
            color.to_color_u8().green(),
            color.to_color_u8().blue(),
        )
            .hash(&mut hasher);
        ((scale * 120.0).round() as u32).hash(&mut hasher);
        let key = hasher.finish();
        if self.sprite.as_ref().map(|(k, _)| *k) != Some(key) {
            self.sprite = draw::cursor_sprite(color, scale).map(|pixmap| (key, pixmap));
        }
        self.sprite.as_ref().map(|(_, pixmap)| pixmap)
    }

    /// Draws one panel if its visual state changed since the last frame.
    fn render(&mut self, index: usize) {
        let Some(panel) = self.panels.get(index) else {
            return;
        };
        if !panel.configured || panel.size.0 == 0 || panel.size.1 == 0 {
            return;
        }
        let (kind, size, scale, margin) = (panel.kind, panel.size, panel.scale, panel.margin);
        let Some(rect) = self.rect_of(&panel.output) else {
            return;
        };
        let alpha = self.opacity();
        let color = agent_color(&self.agent);
        let now = self.last_action.elapsed().as_secs_f32();

        // Everything that changes the picture goes into the signature.
        let mut signature = DefaultHasher::new();
        kind.hash(&mut signature);
        size.hash(&mut signature);
        ((scale * 120.0).round() as u32).hash(&mut signature);
        ((alpha * 100.0).round() as u32).hash(&mut signature);
        self.agent.hash(&mut signature);

        let panel_origin = (rect.x + margin.1 as f32, rect.y + margin.0 as f32);
        let cursor = self.cursor_position();
        let sway = if self.glide.is_none() && self.settling() {
            // Damped pendulum around the tip after landing.
            4.0 * (now * 5.0).sin() * (-now / 0.7).exp()
        } else {
            0.0
        };
        let pressed = self
            .pulse
            .is_some_and(|(at, _)| at.elapsed().as_secs_f32() < 0.12);
        let pulse = self.pulse.map(|(at, point)| {
            (
                (at.elapsed().as_secs_f32() / PULSE).min(1.0),
                (point.0 - panel_origin.0, point.1 - panel_origin.1),
            )
        });
        let breath = if self.settling() {
            0.65 + 0.35 * (now * PI).sin().abs()
        } else {
            1.0
        };
        let blink = self
            .keyboard
            .as_ref()
            .is_some_and(|(at, _)| ((at.elapsed().as_secs_f32() * 2.5) as u32).is_multiple_of(2));
        let keyboard_alpha = self.keyboard.as_ref().map_or(0.0, |(at, _)| {
            let age = at.elapsed().as_secs_f32();
            (age / 0.12).min(1.0) * ((KEYS_SHOWN - age) / 0.3).clamp(0.0, 1.0)
        });

        match kind {
            Kind::Cursor => {
                let Some(point) = cursor else { return };
                let tip = (point.0 - panel_origin.0, point.1 - panel_origin.1);
                ((tip.0 * 4.0) as i32, (tip.1 * 4.0) as i32).hash(&mut signature);
                ((sway * 10.0) as i32, pressed).hash(&mut signature);
                pulse.map(|(t, _)| (t * 60.0) as u32).hash(&mut signature);
            }
            Kind::Pill => {
                (self.tool.as_str(), (breath * 20.0) as u32).hash(&mut signature);
                self.fonts.get().is_some().hash(&mut signature);
            }
            Kind::Bubble => {
                ((keyboard_alpha * 50.0) as u32, blink).hash(&mut signature);
                self.fonts.get().is_some().hash(&mut signature);
                match self.keyboard.as_ref().map(|(_, keyboard)| keyboard) {
                    Some(Keyboard::Keys(keys)) => keys.hash(&mut signature),
                    Some(Keyboard::Text(text)) => text.hash(&mut signature),
                    None => {}
                }
            }
            Kind::Edge(_) => {}
        }
        let signature = signature.finish();
        if self.panels[index].drawn == Some(signature) {
            return;
        }

        let (pw, ph) = (
            (size.0 as f32 * scale).round().max(1.0) as u32,
            (size.1 as f32 * scale).round().max(1.0) as u32,
        );
        let Some(mut pixmap) = Pixmap::new(pw, ph) else {
            return;
        };
        match kind {
            Kind::Cursor => {
                if let Some((t, center)) = pulse {
                    let radius = 10.0 + 30.0 * (1.0 - (1.0 - t).powi(3));
                    draw::ring(
                        &mut pixmap,
                        scale,
                        center,
                        radius,
                        2.5,
                        draw::with_alpha(color, 0.9 * (1.0 - t) * alpha),
                    );
                }
                if let Some(point) = cursor {
                    let tip = (point.0 - panel_origin.0, point.1 - panel_origin.1);
                    let factor = if pressed { 0.88 } else { 1.0 };
                    if let Some(sprite) = self.sprite(scale) {
                        let sprite = sprite.clone();
                        draw::draw_sprite(&mut pixmap, &sprite, scale, tip, sway, factor, alpha);
                    }
                }
            }
            Kind::Edge(edge) => draw::edge_glow(&mut pixmap, edge.edge(), color, alpha),
            Kind::Pill => self.draw_pill(&mut pixmap, scale, size, color, alpha, breath),
            Kind::Bubble => {
                self.draw_bubble(&mut pixmap, scale, color, alpha * keyboard_alpha, blink)
            }
        }

        let panel = &mut self.panels[index];
        let Ok((buffer, canvas)) = self.pool.create_buffer(
            pw as i32,
            ph as i32,
            pw as i32 * 4,
            wl_shm::Format::Argb8888,
        ) else {
            return;
        };
        draw::to_argb8888(&pixmap, canvas);
        let surface = panel.layer.wl_surface();
        match &panel.viewport {
            Some(viewport) => viewport.set_destination(size.0 as i32, size.1 as i32),
            None => surface.set_buffer_scale(scale.round().max(1.0) as i32),
        }
        surface.damage_buffer(0, 0, pw as i32, ph as i32);
        if buffer.attach_to(surface).is_ok() {
            panel.layer.commit();
            panel.drawn = Some(signature);
        }
    }

    fn draw_pill(
        &self,
        pixmap: &mut Pixmap,
        scale: f32,
        size: (u32, u32),
        color: Color,
        alpha: f32,
        breath: f32,
    ) {
        let Some(fonts) = self.fonts.get() else {
            return;
        };
        let title = format!("{} is using your computer", self.agent);
        let label = tool_label(&self.tool);
        let text_size = 14.0;
        let title_w = font::measure(&fonts.semibold, text_size, &title);
        let label_w = font::measure(&fonts.regular, text_size, label);
        let (ascent, line) = font::line_metrics(&fonts.regular, text_size);
        let (pad_x, pad_y, dot, gap) = (18.0, 9.0, 8.0, 10.0);
        let w = pad_x * 2.0 + dot + gap + title_w + gap + label_w;
        let h = pad_y * 2.0 + line;
        let x = ((size.0 as f32 - w) / 2.0).max(0.0);
        let y = 6.0;
        draw::panel(
            pixmap,
            scale,
            (x, y, w, h),
            h / 2.0,
            Color::from_rgba(0.09, 0.09, 0.11, 0.86 * alpha).unwrap_or(Color::BLACK),
            Color::from_rgba(1.0, 1.0, 1.0, 0.12 * alpha).unwrap_or(Color::WHITE),
            0.35 * alpha,
        );
        let cy = y + h / 2.0;
        draw::circle(
            pixmap,
            scale,
            (x + pad_x + dot / 2.0, cy),
            dot,
            draw::with_alpha(color, 0.25 * breath * alpha),
        );
        draw::circle(
            pixmap,
            scale,
            (x + pad_x + dot / 2.0, cy),
            dot / 2.0,
            draw::with_alpha(color, breath * alpha),
        );
        let baseline = y + pad_y + ascent;
        let text_x = x + pad_x + dot + gap;
        font::draw(
            pixmap,
            &fonts.semibold,
            text_size * scale,
            (text_x * scale, baseline * scale),
            &title,
            white(0.95 * alpha),
        );
        font::draw(
            pixmap,
            &fonts.regular,
            text_size * scale,
            ((text_x + title_w + gap) * scale, baseline * scale),
            label,
            white(0.6 * alpha),
        );
    }

    fn draw_bubble(&self, pixmap: &mut Pixmap, scale: f32, color: Color, alpha: f32, blink: bool) {
        let (Some(fonts), Some((_, keyboard))) = (self.fonts.get(), &self.keyboard) else {
            return;
        };
        if alpha <= 0.0 {
            return;
        }
        let (x, y, pad) = (8.0, 6.0, 8.0);
        let (ascent, line) = font::line_metrics(&fonts.regular, 13.0);
        let h = line + 2.0 * pad;
        match keyboard {
            Keyboard::Keys(keys) => {
                let cap_pad = 9.0;
                let plus_w = font::measure(&fonts.regular, 12.0, "+");
                let widths: Vec<f32> = keys
                    .iter()
                    .map(|key| font::measure(&fonts.semibold, 13.0, key) + 2.0 * cap_pad)
                    .collect();
                let inner = widths.iter().sum::<f32>()
                    + (keys.len().saturating_sub(1)) as f32 * (plus_w + 10.0);
                let w = inner + 2.0 * pad;
                self.bubble_frame(pixmap, scale, (x, y, w, h), color, alpha);
                let mut cx = x + pad;
                let cap_h = line + 4.0;
                let cap_y = y + (h - cap_h) / 2.0;
                for (i, (key, width)) in keys.iter().zip(&widths).enumerate() {
                    if i > 0 {
                        cx += 5.0;
                        font::draw(
                            pixmap,
                            &fonts.regular,
                            12.0 * scale,
                            (cx * scale, (cap_y + 2.0 + ascent) * scale),
                            "+",
                            white(0.5 * alpha),
                        );
                        cx += plus_w + 5.0;
                    }
                    draw::fill_rounded(
                        pixmap,
                        scale,
                        (cx, cap_y + 2.0, *width, cap_h),
                        6.0,
                        Color::from_rgba(0.0, 0.0, 0.0, 0.5 * alpha).unwrap_or(Color::BLACK),
                    );
                    draw::fill_rounded(
                        pixmap,
                        scale,
                        (cx, cap_y, *width, cap_h),
                        6.0,
                        Color::from_rgba(1.0, 1.0, 1.0, 0.10 * alpha).unwrap_or(Color::WHITE),
                    );
                    draw::stroke_rounded(
                        pixmap,
                        scale,
                        (cx, cap_y, *width, cap_h),
                        6.0,
                        1.0,
                        Color::from_rgba(1.0, 1.0, 1.0, 0.30 * alpha).unwrap_or(Color::WHITE),
                    );
                    font::draw(
                        pixmap,
                        &fonts.semibold,
                        13.0 * scale,
                        ((cx + cap_pad) * scale, (cap_y + 2.0 + ascent) * scale),
                        key,
                        white(0.95 * alpha),
                    );
                    cx += width;
                }
            }
            Keyboard::Text(text) => {
                let shown: String = {
                    let chars: Vec<char> = text.chars().collect();
                    if chars.len() > 40 {
                        std::iter::once('…')
                            .chain(chars[chars.len() - 40..].iter().copied())
                            .collect()
                    } else {
                        text.clone()
                    }
                };
                let text_w = font::measure(&fonts.regular, 13.0, &shown);
                let w = pad + text_w + 4.0 + 2.0 + pad;
                self.bubble_frame(pixmap, scale, (x, y, w, h), color, alpha);
                let baseline = y + pad + ascent;
                let tx = x + pad;
                font::draw(
                    pixmap,
                    &fonts.regular,
                    13.0 * scale,
                    (tx * scale, baseline * scale),
                    &shown,
                    white(0.95 * alpha),
                );
                if blink {
                    draw::fill_rounded(
                        pixmap,
                        scale,
                        (tx + text_w + 3.0, y + pad, 2.0, line),
                        1.0,
                        draw::with_alpha(color, alpha),
                    );
                }
            }
        }
    }

    fn bubble_frame(
        &self,
        pixmap: &mut Pixmap,
        scale: f32,
        rect: (f32, f32, f32, f32),
        color: Color,
        alpha: f32,
    ) {
        draw::panel(
            pixmap,
            scale,
            rect,
            10.0,
            Color::from_rgba(0.09, 0.09, 0.11, 0.88 * alpha).unwrap_or(Color::BLACK),
            draw::with_alpha(color, 0.55 * alpha),
            0.35 * alpha,
        );
    }

    fn panel_for_surface(&mut self, surface: &WlSurface) -> Option<usize> {
        self.panels
            .iter()
            .position(|panel| panel.layer.wl_surface() == surface)
    }
}

fn bounding_box(rects: &[Rect]) -> Option<Rect> {
    let first = rects.first()?;
    let (mut left, mut top) = (first.x, first.y);
    let (mut right, mut bottom) = (first.x + first.w, first.y + first.h);
    for rect in &rects[1..] {
        left = left.min(rect.x);
        top = top.min(rect.y);
        right = right.max(rect.x + rect.w);
        bottom = bottom.max(rect.y + rect.h);
    }
    Some(Rect {
        x: left,
        y: top,
        w: right - left,
        h: bottom - top,
    })
}

/// Spreads a point in a `space`-sized capture over the logical `layout`; a
/// point without a capture size is already logical.
fn spread((x, y): (i32, i32), space: Option<(u32, u32)>, layout: Option<Rect>) -> (f32, f32) {
    match (space, layout) {
        (Some((width, height)), Some(layout)) if width > 0 && height > 0 => (
            layout.x + x as f32 * layout.w / width as f32,
            layout.y + y as f32 * layout.h / height as f32,
        ),
        _ => (x as f32, y as f32),
    }
}

/// Whether a server holds the capture lock. Probing takes it exclusively for
/// an instant; servers retry past that.
fn lock_held(lock: &File) -> bool {
    match lock.try_lock() {
        Ok(()) => {
            let _ = lock.unlock();
            false
        }
        Err(TryLockError::WouldBlock) => true,
        // A failed probe cannot authorize drawing into an in-progress capture.
        Err(TryLockError::Error(_)) => true,
    }
}

fn white(alpha: f32) -> Color {
    Color::from_rgba(1.0, 1.0, 1.0, alpha.clamp(0.0, 1.0)).unwrap_or(Color::WHITE)
}

impl CompositorHandler for App {
    fn scale_factor_changed(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        surface: &WlSurface,
        factor: i32,
    ) {
        // Integer fallback when the compositor lacks fractional scaling.
        if self.fractional.is_some() {
            return;
        }
        if let Some(index) = self.panel_for_surface(surface) {
            self.panels[index].scale = factor.max(1) as f32;
            self.panels[index].drawn = None;
            self.render(index);
        }
    }

    fn transform_changed(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &WlSurface,
        _: wayland_client::protocol::wl_output::Transform,
    ) {
    }

    fn frame(&mut self, _: &Connection, _: &QueueHandle<Self>, _: &WlSurface, _: u32) {}

    fn surface_enter(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &WlSurface,
        _: &WlOutput,
    ) {
    }

    fn surface_leave(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: &WlSurface,
        _: &WlOutput,
    ) {
    }
}

impl OutputHandler for App {
    fn output_state(&mut self) -> &mut OutputState {
        &mut self.outputs
    }

    fn new_output(&mut self, _: &Connection, _: &QueueHandle<Self>, _: WlOutput) {}

    fn update_output(&mut self, _: &Connection, _: &QueueHandle<Self>, _: WlOutput) {}

    fn output_destroyed(&mut self, _: &Connection, _: &QueueHandle<Self>, output: WlOutput) {
        self.panels.retain(|panel| panel.output != output);
    }
}

impl LayerShellHandler for App {
    fn closed(&mut self, _: &Connection, _: &QueueHandle<Self>, layer: &LayerSurface) {
        self.panels.retain(|panel| &panel.layer != layer);
    }

    fn configure(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        layer: &LayerSurface,
        configure: LayerSurfaceConfigure,
        _: u32,
    ) {
        let Some(index) = self.panels.iter().position(|panel| &panel.layer == layer) else {
            return;
        };
        let panel = &mut self.panels[index];
        let (w, h) = configure.new_size;
        if w > 0 {
            panel.size.0 = w;
        }
        if h > 0 {
            panel.size.1 = h;
        }
        panel.configured = true;
        panel.drawn = None;
        self.render(index);
    }
}

impl ShmHandler for App {
    fn shm_state(&mut self) -> &mut Shm {
        &mut self.shm
    }
}

impl ProvidesRegistryState for App {
    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry
    }
    registry_handlers![OutputState];
}

/// User data for protocol objects that send no events we use.
struct Quiet;

impl Dispatch2<WpViewporter, App> for Quiet {
    fn event(
        &self,
        _: &mut App,
        _: &WpViewporter,
        _: <WpViewporter as wayland_client::Proxy>::Event,
        _: &Connection,
        _: &QueueHandle<App>,
    ) {
    }
}

impl Dispatch2<WpViewport, App> for Quiet {
    fn event(
        &self,
        _: &mut App,
        _: &WpViewport,
        _: <WpViewport as wayland_client::Proxy>::Event,
        _: &Connection,
        _: &QueueHandle<App>,
    ) {
    }
}

impl Dispatch2<WpFractionalScaleManagerV1, App> for Quiet {
    fn event(
        &self,
        _: &mut App,
        _: &WpFractionalScaleManagerV1,
        _: <WpFractionalScaleManagerV1 as wayland_client::Proxy>::Event,
        _: &Connection,
        _: &QueueHandle<App>,
    ) {
    }
}

/// Fractional scale object user data: the surface it scales.
struct ScaleOf(WlSurface);

impl Dispatch2<WpFractionalScaleV1, App> for ScaleOf {
    fn event(
        &self,
        app: &mut App,
        _: &WpFractionalScaleV1,
        event: wp_fractional_scale_v1::Event,
        _: &Connection,
        _: &QueueHandle<App>,
    ) {
        if let wp_fractional_scale_v1::Event::PreferredScale { scale } = event {
            if let Some(index) = app.panel_for_surface(&self.0) {
                app.panels[index].scale = scale as f32 / 120.0;
                app.panels[index].drawn = None;
                app.render(index);
            }
        }
    }
}

delegate_registry!(App);
smithay_client_toolkit::delegate_dispatch2!(App);

fn run() -> Result<(), String> {
    if std::env::var_os("WAYLAND_DISPLAY").is_none()
        && codex_computer_use_linux::indicator::is_gnome_session()
    {
        return gnome::run().map_err(|error| format!("{error:#}"));
    }
    match run_layer_shell() {
        Err(error) if error == "the compositor has no wlr-layer-shell" => {
            gnome::run().map_err(|error| format!("{error:#}"))
        }
        result => result,
    }
}

fn run_layer_shell() -> Result<(), String> {
    let path = socket_path().ok_or("XDG_RUNTIME_DIR is not set")?;
    // One overlay per session. Agents may start it at the same moment, so a
    // lock, not a probe of the socket, decides which instance stays. The lock
    // lives as long as the process.
    let lock = std::fs::File::create(path.with_extension("lock"))
        .map_err(|error| format!("lock file: {error}"))?;
    if lock.try_lock().is_err() {
        return Ok(());
    }
    let capture_lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(capture_lock_path(&path))
        .map_err(|error| format!("capture lock file: {error}"))?;

    let conn =
        Connection::connect_to_env().map_err(|error| format!("no Wayland session: {error}"))?;
    let (globals, queue) = registry_queue_init(&conn).map_err(|error| error.to_string())?;
    let qh = queue.handle();
    let compositor = CompositorState::bind(&globals, &qh).map_err(|error| error.to_string())?;
    // GNOME has no layer-shell; exiting before the socket exists tells the
    // server not to retry.
    let layer_shell =
        LayerShell::bind(&globals, &qh).map_err(|_| "the compositor has no wlr-layer-shell")?;
    let shm = Shm::bind(&globals, &qh).map_err(|error| error.to_string())?;
    let pool = SlotPool::new(256 * 256 * 4, &shm).map_err(|error| error.to_string())?;
    let viewporter = globals.bind::<WpViewporter, _, _>(&qh, 1..=1, Quiet).ok();
    let fractional = viewporter.as_ref().and_then(|_| {
        globals
            .bind::<WpFractionalScaleManagerV1, _, _>(&qh, 1..=1, Quiet)
            .ok()
    });

    let mut event_loop: EventLoop<'static, App> =
        EventLoop::try_new().map_err(|error| error.to_string())?;
    let handle = event_loop.handle();
    let fonts = Arc::new(OnceLock::new());
    {
        let fonts = Arc::clone(&fonts);
        std::thread::spawn(move || {
            if let Some(loaded) = font::Fonts::load() {
                let _ = fonts.set(loaded);
            }
        });
    }
    let mut app = App {
        registry: RegistryState::new(&globals),
        outputs: OutputState::new(&globals, &qh),
        compositor,
        layer_shell,
        shm,
        pool,
        viewporter,
        fractional,
        fonts,
        active: false,
        handle: handle.clone(),
        qh: qh.clone(),
        panels: Vec::new(),
        agent: String::new(),
        tool: String::new(),
        cursor: None,
        glide: None,
        pulse: None,
        keyboard: None,
        last_action: Instant::now(),
        shown_at: Instant::now(),
        fading: None,
        removed_at: None,
        capture_lock,
        watching_hold: false,
        sprite: None,
        animating: false,
        exit: false,
    };
    // Learn the output layout (wl_output, then xdg-output) before accepting
    // events, so the first action already knows where to draw.
    let mut queue = queue;
    for _ in 0..2 {
        queue
            .roundtrip(&mut app)
            .map_err(|error| error.to_string())?;
    }
    WaylandSource::new(conn, queue)
        .insert(handle.clone())
        .map_err(|error| error.to_string())?;

    let _ = std::fs::remove_file(&path);
    let socket =
        UnixDatagram::bind(&path).map_err(|error| format!("bind {}: {error}", path.display()))?;
    socket
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    handle
        .insert_source(
            Generic::new(socket, Interest::READ, Mode::Level),
            |_, socket, app| {
                let mut buf = [0u8; 4096];
                let qh = app.qh();
                while let Ok((len, sender)) = socket.recv_from(&mut buf) {
                    let Ok(event) = serde_json::from_slice::<IndicatorEvent>(&buf[..len]) else {
                        continue;
                    };
                    match event.capture {
                        Some(Capture::Begin) => {
                            // Tell the capturing server whether it has to wait
                            // for the compositor to drop our surfaces.
                            let shown = app.on_screen();
                            app.suspend();
                            let reply = if shown {
                                CAPTURE_REPLY_SHOWN
                            } else {
                                CAPTURE_REPLY_EMPTY
                            };
                            let _ = socket.send_to_addr(reply, &sender);
                        }
                        Some(Capture::End) if !app.capture_held() => app.resume(&qh),
                        Some(Capture::End) => {}
                        // Every action names its tool; anything else is noise.
                        None if !event.tool.is_empty() => app.on_event(event, &qh),
                        None => {}
                    }
                }
                Ok(PostAction::Continue)
            },
        )
        .map_err(|error| error.to_string())?;
    // Leave nothing resident when no agent has used the desktop for a while.
    handle
        .insert_source(Timer::from_duration(EXIT_AFTER_IDLE), |_, _, app| {
            if !app.visible() && app.last_action.elapsed() >= EXIT_AFTER_IDLE {
                app.exit = true;
                return TimeoutAction::Drop;
            }
            // Check again when the latest action turns ten minutes old.
            TimeoutAction::ToDuration(
                EXIT_AFTER_IDLE
                    .saturating_sub(app.last_action.elapsed())
                    .max(Duration::from_secs(1)),
            )
        })
        .map_err(|error| error.to_string())?;

    while !app.exit {
        if let Err(error) = event_loop.dispatch(None, &mut app) {
            let _ = std::fs::remove_file(&path);
            return Err(error.to_string());
        }
    }
    let _ = std::fs::remove_file(&path);
    Ok(())
}

const BIN: &str = "codex-computer-use-indicator";
/// Exit status for a command line with any argument. Nothing runs before the
/// line is validated.
const USAGE_EXIT: u8 = 2;
const HELP: &str = "codex-computer-use-indicator: the on-screen overlay that shows an agent's actions.

Usage:
  codex-computer-use-indicator

The codex-computer-use-linux server starts it on the first desktop action and sends it one event per action. It shows nothing until an event arrives and exits after ten idle minutes. One instance runs per session. It takes no arguments.

Options:
  -h, --help  Print this help and exit.
";

#[derive(Debug, PartialEq)]
enum Invocation {
    Run,
    Help,
}

/// The indicator takes no arguments. As in the main CLI, `-h` or `--help`
/// before `--` prints help, and any other argument is refused, before the
/// overlay takes its locks or connects to the compositor.
fn parse_invocation(arguments: &[String]) -> Result<Invocation, String> {
    let options_end = arguments
        .iter()
        .position(|argument| argument == "--")
        .unwrap_or(arguments.len());
    let options = &arguments[..options_end];
    if options
        .iter()
        .any(|argument| matches!(argument.as_str(), "-h" | "--help"))
    {
        return Ok(Invocation::Help);
    }
    if let Some(option) = options
        .iter()
        .find(|argument| argument.len() > 1 && argument.starts_with('-'))
    {
        return Err(format!("unknown option '{option}'"));
    }
    match options
        .iter()
        .chain(arguments.iter().skip(options_end + 1))
        .next()
    {
        Some(argument) => Err(format!("unexpected argument '{argument}'")),
        None => Ok(Invocation::Run),
    }
}

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|argument| argument.to_string_lossy().into_owned())
        .collect();
    match parse_invocation(&arguments) {
        Ok(Invocation::Run) => {}
        Ok(Invocation::Help) => {
            print!("{HELP}");
            return ExitCode::SUCCESS;
        }
        Err(message) => {
            eprint!("{BIN}: {message}\nUsage: {BIN}\nRun '{BIN} --help' for details.\n");
            return ExitCode::from(USAGE_EXIT);
        }
    }
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("[{BIN}] {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f32, y: f32, w: f32, h: f32) -> Rect {
        Rect { x, y, w, h }
    }

    #[test]
    fn only_an_empty_command_line_runs_the_overlay() {
        let parse = |arguments: &[&str]| {
            let arguments: Vec<String> = arguments.iter().map(|value| value.to_string()).collect();
            parse_invocation(&arguments)
        };
        // The server spawns the overlay with no arguments.
        assert_eq!(parse(&[]), Ok(Invocation::Run));
        assert_eq!(parse(&["--"]), Ok(Invocation::Run));
        assert_eq!(parse(&["--help"]), Ok(Invocation::Help));
        assert_eq!(parse(&["x", "-h"]), Ok(Invocation::Help));
        assert_eq!(
            parse(&["--", "--help"]),
            Err("unexpected argument '--help'".to_string())
        );
        assert_eq!(
            parse(&["--version"]),
            Err("unknown option '--version'".to_string())
        );
        assert_eq!(parse(&["-"]), Err("unexpected argument '-'".to_string()));
    }

    #[test]
    fn capture_points_spread_over_the_logical_layout() {
        // A 2x output: a 3840x2160 capture over a 1920x1080 logical desktop.
        let layout = bounding_box(&[rect(0.0, 0.0, 1920.0, 1080.0)]);
        assert_eq!(
            spread((3000, 1500), Some((3840, 2160)), layout),
            (1500.0, 750.0)
        );
        // Without a capture size the point is already logical.
        assert_eq!(spread((300, 150), None, layout), (300.0, 150.0));
    }

    #[test]
    fn any_capturing_server_holds_the_overlay_back() {
        let path =
            std::env::temp_dir().join(format!("cul-overlay-hold-{}.capture", std::process::id()));
        let open = || {
            OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(&path)
                .unwrap()
        };
        let overlay = open();
        assert!(!lock_held(&overlay));
        let (first, second) = (open(), open());
        first.try_lock_shared().unwrap();
        second.try_lock_shared().unwrap();
        assert!(lock_held(&overlay));
        drop(first);
        assert!(lock_held(&overlay), "one capture still runs");
        drop(second);
        assert!(!lock_held(&overlay));
        // Probing must not leave the lock taken.
        let third = open();
        third.try_lock_shared().unwrap();
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn layouts_span_every_output() {
        let layout = bounding_box(&[
            rect(1920.0, 0.0, 1280.0, 720.0),
            rect(0.0, 0.0, 1920.0, 1080.0),
        ]);
        assert_eq!(layout, Some(rect(0.0, 0.0, 3200.0, 1080.0)));
        assert_eq!(spread((4800, 0), Some((6400, 2160)), layout), (2400.0, 0.0));
        assert_eq!(bounding_box(&[]), None);
    }
}

use anyhow::{anyhow, bail, Context, Result};
use cosmic_protocols::{
    toplevel_info::v1::client::{zcosmic_toplevel_handle_v1, zcosmic_toplevel_info_v1},
    toplevel_management::v1::client::zcosmic_toplevel_manager_v1,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use wayland_client::{
    event_created_child,
    globals::{registry_queue_init, GlobalListContents},
    protocol::{wl_output, wl_registry, wl_seat},
    Connection, Dispatch, Proxy, QueueHandle, WEnum,
};
use wayland_protocols::ext::foreign_toplevel_list::v1::client::{
    ext_foreign_toplevel_handle_v1, ext_foreign_toplevel_list_v1,
};
use wayland_protocols::xdg::xdg_output::zv1::client::{zxdg_output_manager_v1, zxdg_output_v1};
use wayland_protocols_wlr::output_management::v1::client::{
    zwlr_output_head_v1, zwlr_output_manager_v1, zwlr_output_mode_v1,
};

const HELP: &str = "codex-computer-use-cosmic\n\nUsage:\n  codex-computer-use-cosmic probe\n  codex-computer-use-cosmic list-windows\n  codex-computer-use-cosmic focused-window\n  codex-computer-use-cosmic monitor-layout\n  codex-computer-use-cosmic activate-window --window-id <id>";
const BACKEND: &str = "cosmic-wayland";
const ACTIVATION_STATE_TTL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WindowInfo {
    window_id: u64,
    title: Option<String>,
    app_id: Option<String>,
    wm_class: Option<String>,
    pid: Option<u32>,
    bounds: Option<WindowBounds>,
    workspace: Option<i32>,
    focused: bool,
    hidden: bool,
    client_type: Option<String>,
    backend: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct WindowBounds {
    x: Option<i32>,
    y: Option<i32>,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProbeOutput {
    ok: bool,
    can_list_windows: bool,
    can_activate_windows: bool,
    detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ActivationOutput {
    ok: bool,
    detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ActivationState {
    window_id: u64,
    timestamp_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct MonitorInfo {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    scale: f64,
}

#[derive(Debug, Default)]
struct OutputHeadState {
    enabled: bool,
    finished: bool,
    position: Option<(i32, i32)>,
    transform: Option<u32>,
    scale: Option<f64>,
    current_mode: Option<u32>,
}

#[derive(Debug, Default)]
struct OutputModeState {
    finished: bool,
    size: Option<(i32, i32)>,
}

#[derive(Debug, Default)]
struct LogicalOutput {
    position: Option<(i32, i32)>,
    done: bool,
}

type RelativeGeometry = (i32, i32, i32, i32);

#[derive(Debug, Clone, Default)]
struct ToplevelRecord {
    foreign: Option<ext_foreign_toplevel_handle_v1::ExtForeignToplevelHandleV1>,
    cosmic: Option<zcosmic_toplevel_handle_v1::ZcosmicToplevelHandleV1>,
    identifier: Option<String>,
    title: Option<String>,
    app_id: Option<String>,
    focused: bool,
    hidden: bool,
    geometries: HashMap<u32, RelativeGeometry>,
    received_state: bool,
}

impl ToplevelRecord {
    fn to_window(&self, outputs: &HashMap<u32, LogicalOutput>) -> Option<WindowInfo> {
        self.foreign.as_ref()?;
        let identifier = self.identifier.as_deref()?;
        Some(WindowInfo {
            window_id: stable_window_id(identifier),
            title: self.title.clone().filter(|value| !value.trim().is_empty()),
            app_id: self.app_id.clone().filter(|value| !value.trim().is_empty()),
            wm_class: None,
            pid: None,
            bounds: global_window_bounds(&self.geometries, outputs),
            workspace: None,
            focused: self.focused,
            hidden: self.hidden,
            client_type: Some("wayland".to_string()),
            backend: BACKEND.to_string(),
        })
    }
}

#[derive(Default)]
struct AppData {
    toplevel_info: Option<zcosmic_toplevel_info_v1::ZcosmicToplevelInfoV1>,
    toplevel_manager: Option<zcosmic_toplevel_manager_v1::ZcosmicToplevelManagerV1>,
    seats: Vec<wl_seat::WlSeat>,
    capabilities:
        Vec<WEnum<zcosmic_toplevel_manager_v1::ZcosmicToplelevelManagementCapabilitiesV1>>,
    records: Vec<ToplevelRecord>,
    by_foreign_id: HashMap<u32, usize>,
    by_cosmic_id: HashMap<u32, usize>,
    logical_output_manager: Option<zxdg_output_manager_v1::ZxdgOutputManagerV1>,
    output_proxies: HashMap<u32, wl_output::WlOutput>,
    logical_outputs: HashMap<u32, LogicalOutput>,
    toplevel_info_done: bool,
    output_manager: Option<zwlr_output_manager_v1::ZwlrOutputManagerV1>,
    output_layout_ready: bool,
    output_manager_finished: bool,
    output_heads: HashMap<u32, OutputHeadState>,
    output_modes: HashMap<u32, OutputModeState>,
}

fn main() -> Result<()> {
    match Command::parse(std::env::args().skip(1).collect())? {
        Command::Probe => print_json(&probe()?),
        Command::ListWindows => print_json(&collect_windows()?),
        Command::FocusedWindow => print_json(&focused_window()?),
        Command::MonitorLayout => print_json(&monitor_layout()?),
        Command::ActivateWindow { window_id } => print_json(&activate_window(window_id)?),
    }
}

#[derive(Debug)]
enum Command {
    Probe,
    ListWindows,
    FocusedWindow,
    MonitorLayout,
    ActivateWindow { window_id: u64 },
}

impl Command {
    fn parse(args: Vec<String>) -> Result<Self> {
        match args.as_slice() {
            [command] if command == "probe" => Ok(Self::Probe),
            [command] if command == "list-windows" => Ok(Self::ListWindows),
            [command] if command == "focused-window" => Ok(Self::FocusedWindow),
            [command] if command == "monitor-layout" => Ok(Self::MonitorLayout),
            [command, flag, value] if command == "activate-window" && flag == "--window-id" => {
                Ok(Self::ActivateWindow {
                    window_id: value
                        .parse::<u64>()
                        .with_context(|| format!("invalid window id {value}"))?,
                })
            }
            [command] if command == "--help" || command == "-h" => {
                println!("{HELP}");
                std::process::exit(0);
            }
            [] => {
                println!("{HELP}");
                std::process::exit(0);
            }
            _ => bail!("unknown arguments. Expected one of: probe, list-windows, focused-window, monitor-layout, activate-window --window-id <id>"),
        }
    }
}

fn probe() -> Result<ProbeOutput> {
    let snapshot = Snapshot::collect()?;
    let windows = snapshot.windows();
    let can_activate = snapshot.can_activate_windows();
    Ok(ProbeOutput {
        ok: !windows.is_empty(),
        can_list_windows: !windows.is_empty(),
        can_activate_windows: can_activate,
        detail: if !windows.is_empty() {
            if can_activate {
                format!(
                    "COSMIC foreign toplevel listing is available and activation is supported for {} window(s).",
                    windows.len()
                )
            } else {
                format!(
                    "COSMIC foreign toplevel listing is available for {} window(s), but activation support is incomplete.",
                    windows.len()
                )
            }
        } else {
            "COSMIC foreign toplevel listing is unavailable in this session.".to_string()
        },
    })
}

fn collect_windows() -> Result<Vec<WindowInfo>> {
    Ok(Snapshot::collect()?.windows())
}

fn focused_window() -> Result<Option<WindowInfo>> {
    let snapshot = Snapshot::collect()?;
    if let Some(window) = snapshot.windows().into_iter().find(|window| window.focused) {
        clear_activation_state();
        return Ok(Some(window));
    }

    let Some(state) = read_activation_state() else {
        return Ok(None);
    };

    if state_is_stale(&state) {
        clear_activation_state();
        return Ok(None);
    }

    let mut window = snapshot
        .windows()
        .into_iter()
        .find(|window| window.window_id == state.window_id);
    if let Some(window) = window.as_mut() {
        window.focused = true;
    }
    Ok(window)
}

fn monitor_layout() -> Result<Vec<MonitorInfo>> {
    Snapshot::collect()?.monitor_layout()
}

fn activate_window(window_id: u64) -> Result<ActivationOutput> {
    let mut snapshot = Snapshot::collect()?;
    snapshot.activate(window_id)?;
    write_activation_state(window_id)?;
    Ok(ActivationOutput {
        ok: true,
        detail: format!("Requested COSMIC activation for window_id {window_id}."),
    })
}

struct Snapshot {
    event_queue: wayland_client::EventQueue<AppData>,
    app_data: AppData,
}

impl Snapshot {
    fn collect() -> Result<Self> {
        let conn = Connection::connect_to_env().context("failed to connect to Wayland display")?;
        let (globals, event_queue) =
            registry_queue_init(&conn).context("failed to initialize Wayland registry queue")?;
        let mut snapshot = Self {
            event_queue,
            app_data: AppData::default(),
        };
        let qh = snapshot.event_queue.handle();
        snapshot.app_data.toplevel_info = globals
            .bind::<zcosmic_toplevel_info_v1::ZcosmicToplevelInfoV1, _, _>(&qh, 1..=3, ())
            .ok();
        snapshot.app_data.toplevel_manager = globals
            .bind::<zcosmic_toplevel_manager_v1::ZcosmicToplevelManagerV1, _, _>(&qh, 1..=4, ())
            .ok();
        snapshot.app_data.output_manager = globals
            .bind::<zwlr_output_manager_v1::ZwlrOutputManagerV1, _, _>(&qh, 1..=4, ())
            .ok();
        snapshot.app_data.logical_output_manager = globals
            .bind::<zxdg_output_manager_v1::ZxdgOutputManagerV1, _, _>(&qh, 1..=3, ())
            .ok();
        globals.contents().with_list(|entries| {
            for global in entries {
                if global.interface == "wl_output" {
                    snapshot.app_data.bind_output(
                        globals.registry(),
                        global.name,
                        global.version,
                        &qh,
                    );
                }
                if global.interface == "wl_seat" {
                    snapshot
                        .app_data
                        .seats
                        .push(globals.registry().bind::<wl_seat::WlSeat, _, _>(
                            global.name,
                            global.version.min(9),
                            &qh,
                            (),
                        ));
                }
            }
        });
        if snapshot.app_data.toplevel_info.is_some() {
            let _ = globals
                .bind::<ext_foreign_toplevel_list_v1::ExtForeignToplevelListV1, _, _>(
                    &qh,
                    1..=1,
                    (),
                )
                .ok();
        }
        snapshot.prime()?;
        Ok(snapshot)
    }

    fn prime(&mut self) -> Result<()> {
        for _ in 0..4 {
            self.event_queue
                .roundtrip(&mut self.app_data)
                .context("Wayland roundtrip failed")?;
        }
        // COSMIC publishes extension properties from its refresh cycle, not
        // necessarily before wl_display.sync. Four fast roundtrips can finish
        // before any state/geometry arrives. Wait for the protocol's snapshot
        // boundary, bounded below the parent's helper timeout.
        let deadline = Instant::now() + Duration::from_millis(500);
        while !self.app_data.toplevel_snapshot_ready() {
            if Instant::now() >= deadline {
                bail!("COSMIC toplevel properties did not complete a snapshot");
            }
            std::thread::sleep(Duration::from_millis(10));
            self.event_queue
                .roundtrip(&mut self.app_data)
                .context("Wayland roundtrip waiting for toplevel properties failed")?;
        }
        Ok(())
    }

    fn windows(&self) -> Vec<WindowInfo> {
        self.app_data
            .records
            .iter()
            .filter_map(|record| record.to_window(&self.app_data.logical_outputs))
            .collect()
    }

    fn can_activate_windows(&self) -> bool {
        !self.app_data.seats.is_empty()
            && self.app_data.toplevel_manager.is_some()
            && self.app_data.records.iter().any(|record| record.cosmic.is_some())
            && self.app_data.capabilities.iter().any(|capability| {
                matches!(
                    capability,
                    WEnum::Value(
                        zcosmic_toplevel_manager_v1::ZcosmicToplelevelManagementCapabilitiesV1::Activate
                    )
                )
            })
    }

    fn monitor_layout(&self) -> Result<Vec<MonitorInfo>> {
        if self.app_data.output_manager.is_none() {
            bail!("COSMIC output management protocol is unavailable");
        }
        if self.app_data.output_manager_finished || !self.app_data.output_layout_ready {
            bail!("COSMIC output management did not finish an atomic layout snapshot");
        }
        monitor_layout_from_state(&self.app_data.output_heads, &self.app_data.output_modes)
            .ok_or_else(|| anyhow!("COSMIC output management returned an incomplete layout"))
    }

    fn activate(&mut self, window_id: u64) -> Result<()> {
        if !self.can_activate_windows() {
            bail!("COSMIC activation capability is unavailable");
        }
        let seat = self
            .app_data
            .seats
            .first()
            .cloned()
            .ok_or_else(|| anyhow!("no wl_seat available for activation"))?;
        let record = self
            .app_data
            .records
            .iter()
            .find(|record| {
                record
                    .identifier
                    .as_deref()
                    .is_some_and(|id| stable_window_id(id) == window_id)
            })
            .ok_or_else(|| anyhow!("no COSMIC toplevel matched window_id {window_id}"))?;
        let cosmic = record
            .cosmic
            .as_ref()
            .ok_or_else(|| anyhow!("matched window has no COSMIC activation handle"))?;
        let manager = self
            .app_data
            .toplevel_manager
            .as_ref()
            .ok_or_else(|| anyhow!("COSMIC toplevel management protocol not advertised"))?;
        manager.activate(cosmic, &seat);
        self.event_queue
            .roundtrip(&mut self.app_data)
            .context("Wayland roundtrip after activation failed")?;
        Ok(())
    }
}

// COSMIC geometry is output-relative in logical pixels. Never guess an origin
// from wl_output's physical geometry or select an arbitrary spanning output.
fn global_window_bounds(
    geometries: &HashMap<u32, RelativeGeometry>,
    outputs: &HashMap<u32, LogicalOutput>,
) -> Option<WindowBounds> {
    let mut result = None;
    for (output_id, &(x, y, width, height)) in geometries {
        let output = outputs.get(output_id)?;
        if !output.done || width <= 0 || height <= 0 {
            return None;
        }
        let (output_x, output_y) = output.position?;
        let bounds = WindowBounds {
            x: Some(output_x.checked_add(x)?),
            y: Some(output_y.checked_add(y)?),
            width: u32::try_from(width).ok()?,
            height: u32::try_from(height).ok()?,
        };
        if result.as_ref().is_some_and(|previous| previous != &bounds) {
            return None;
        }
        result = Some(bounds);
    }
    result
}

fn toplevel_properties_ready(info_done: bool, states: impl IntoIterator<Item = bool>) -> bool {
    let mut states = states.into_iter().peekable();
    states.peek().is_none() || (info_done && states.all(|received| received))
}

impl AppData {
    fn toplevel_snapshot_ready(&self) -> bool {
        toplevel_properties_ready(
            self.toplevel_info_done,
            self.records
                .iter()
                .filter(|record| record.foreign.is_some())
                .map(|record| record.received_state),
        )
    }

    fn bind_output(
        &mut self,
        registry: &wl_registry::WlRegistry,
        name: u32,
        version: u32,
        qh: &QueueHandle<Self>,
    ) {
        if self.output_proxies.contains_key(&name) {
            return;
        }
        let output = registry.bind::<wl_output::WlOutput, _, _>(name, version.min(4), qh, ());
        let id = output.id().protocol_id();
        self.logical_outputs.insert(id, LogicalOutput::default());
        if let Some(manager) = &self.logical_output_manager {
            manager.get_xdg_output(&output, qh, id);
        }
        self.output_proxies.insert(name, output);
    }
}

impl Dispatch<wl_output::WlOutput, ()> for AppData {
    fn event(
        state: &mut Self,
        output: &wl_output::WlOutput,
        event: wl_output::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_output::Event::Done = event {
            if let Some(logical) = state.logical_outputs.get_mut(&output.id().protocol_id()) {
                logical.done = true;
            }
        }
    }
}

impl Dispatch<zxdg_output_manager_v1::ZxdgOutputManagerV1, ()> for AppData {
    fn event(
        _: &mut Self,
        _: &zxdg_output_manager_v1::ZxdgOutputManagerV1,
        _: zxdg_output_manager_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<zxdg_output_v1::ZxdgOutputV1, u32> for AppData {
    fn event(
        state: &mut Self,
        _: &zxdg_output_v1::ZxdgOutputV1,
        event: zxdg_output_v1::Event,
        id: &u32,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let Some(output) = state.logical_outputs.get_mut(id) else {
            return;
        };
        match event {
            zxdg_output_v1::Event::LogicalPosition { x, y } => {
                output.position = Some((x, y));
                output.done = false;
            }
            zxdg_output_v1::Event::Done => output.done = true,
            _ => {}
        }
    }
}

fn monitor_layout_from_state(
    heads: &HashMap<u32, OutputHeadState>,
    modes: &HashMap<u32, OutputModeState>,
) -> Option<Vec<MonitorInfo>> {
    let mut layout = heads
        .values()
        .filter(|head| head.enabled && !head.finished)
        .map(|head| {
            let (x, y) = head.position?;
            let scale = head.scale?;
            let mode = modes.get(&head.current_mode?)?;
            if mode.finished || !scale.is_finite() || scale <= 0.0 {
                return None;
            }
            let (mut width, mut height) = mode.size?;
            if head.transform? % 2 == 1 {
                std::mem::swap(&mut width, &mut height);
            }
            if width <= 0 || height <= 0 {
                return None;
            }
            let width = (f64::from(width) / scale).round() as i32;
            let height = (f64::from(height) / scale).round() as i32;
            (width > 0 && height > 0).then_some(MonitorInfo {
                x,
                y,
                width,
                height,
                scale,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    layout.sort_by_key(|monitor| (monitor.x, monitor.y, monitor.width, monitor.height));
    (!layout.is_empty()).then_some(layout)
}

impl Dispatch<zwlr_output_manager_v1::ZwlrOutputManagerV1, ()> for AppData {
    fn event(
        app_data: &mut Self,
        _manager: &zwlr_output_manager_v1::ZwlrOutputManagerV1,
        event: zwlr_output_manager_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            zwlr_output_manager_v1::Event::Head { head } => {
                app_data.output_layout_ready = false;
                app_data
                    .output_heads
                    .entry(head.id().protocol_id())
                    .or_default();
            }
            zwlr_output_manager_v1::Event::Done { .. } => {
                app_data.output_layout_ready = true;
            }
            zwlr_output_manager_v1::Event::Finished => {
                app_data.output_layout_ready = false;
                app_data.output_manager_finished = true;
            }
            _ => unreachable!(),
        }
    }

    event_created_child!(
        AppData,
        zwlr_output_manager_v1::ZwlrOutputManagerV1,
        [
            zwlr_output_manager_v1::EVT_HEAD_OPCODE => (zwlr_output_head_v1::ZwlrOutputHeadV1, ()),
        ]
    );
}

impl Dispatch<zwlr_output_head_v1::ZwlrOutputHeadV1, ()> for AppData {
    fn event(
        app_data: &mut Self,
        head: &zwlr_output_head_v1::ZwlrOutputHeadV1,
        event: zwlr_output_head_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        app_data.output_layout_ready = false;
        let head_id = head.id().protocol_id();
        let state = app_data.output_heads.entry(head_id).or_default();
        match event {
            zwlr_output_head_v1::Event::Mode { mode } => {
                app_data
                    .output_modes
                    .entry(mode.id().protocol_id())
                    .or_default();
            }
            zwlr_output_head_v1::Event::Enabled { enabled } => state.enabled = enabled != 0,
            zwlr_output_head_v1::Event::CurrentMode { mode } => {
                state.current_mode = Some(mode.id().protocol_id());
            }
            zwlr_output_head_v1::Event::Position { x, y } => state.position = Some((x, y)),
            zwlr_output_head_v1::Event::Transform { transform } => {
                state.transform = Some(transform.into());
            }
            zwlr_output_head_v1::Event::Scale { scale } => state.scale = Some(scale),
            zwlr_output_head_v1::Event::Finished => state.finished = true,
            _ => {}
        }
    }

    event_created_child!(
        AppData,
        zwlr_output_head_v1::ZwlrOutputHeadV1,
        [
            zwlr_output_head_v1::EVT_MODE_OPCODE => (zwlr_output_mode_v1::ZwlrOutputModeV1, ()),
        ]
    );
}

impl Dispatch<zwlr_output_mode_v1::ZwlrOutputModeV1, ()> for AppData {
    fn event(
        app_data: &mut Self,
        mode: &zwlr_output_mode_v1::ZwlrOutputModeV1,
        event: zwlr_output_mode_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        app_data.output_layout_ready = false;
        let state = app_data
            .output_modes
            .entry(mode.id().protocol_id())
            .or_default();
        match event {
            zwlr_output_mode_v1::Event::Size { width, height } => {
                state.size = Some((width, height));
            }
            zwlr_output_mode_v1::Event::Finished => state.finished = true,
            _ => {}
        }
    }
}

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for AppData {
    fn event(
        app_data: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if let wl_registry::Event::Global {
            name,
            interface,
            version,
        } = event
        {
            match interface.as_str() {
                "ext_foreign_toplevel_list_v1" => {
                    registry.bind::<ext_foreign_toplevel_list_v1::ExtForeignToplevelListV1, _, _>(
                        name,
                        1,
                        qh,
                        (),
                    );
                }
                "zcosmic_toplevel_info_v1" => {
                    app_data.toplevel_info = Some(
                        registry.bind::<zcosmic_toplevel_info_v1::ZcosmicToplevelInfoV1, _, _>(
                            name,
                            3,
                            qh,
                            (),
                        ),
                    );
                }
                "zcosmic_toplevel_manager_v1" => {
                    app_data.toplevel_manager = Some(
                        registry
                            .bind::<zcosmic_toplevel_manager_v1::ZcosmicToplevelManagerV1, _, _>(
                                name,
                                4,
                                qh,
                                (),
                            ),
                    );
                }
                "wl_output" => app_data.bind_output(registry, name, version, qh),
                "wl_seat" => {
                    app_data
                        .seats
                        .push(registry.bind::<wl_seat::WlSeat, _, _>(name, 9, qh, ()));
                }
                _ => {}
            }
        } else if let wl_registry::Event::GlobalRemove { name } = event {
            if let Some(output) = app_data.output_proxies.remove(&name) {
                app_data.logical_outputs.remove(&output.id().protocol_id());
            }
        }
    }
}

impl Dispatch<ext_foreign_toplevel_list_v1::ExtForeignToplevelListV1, ()> for AppData {
    fn event(
        app_data: &mut Self,
        _list: &ext_foreign_toplevel_list_v1::ExtForeignToplevelListV1,
        event: ext_foreign_toplevel_list_v1::Event,
        _: &(),
        _conn: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        match event {
            ext_foreign_toplevel_list_v1::Event::Toplevel { toplevel } => {
                let foreign_id = toplevel.id().protocol_id();
                let mut record = ToplevelRecord {
                    foreign: Some(toplevel.clone()),
                    ..Default::default()
                };
                if let Some(info) = app_data.toplevel_info.as_ref() {
                    app_data.toplevel_info_done = false;
                    let cosmic = info.get_cosmic_toplevel(&toplevel, qh, ());
                    app_data
                        .by_cosmic_id
                        .insert(cosmic.id().protocol_id(), app_data.records.len());
                    record.cosmic = Some(cosmic);
                }
                app_data
                    .by_foreign_id
                    .insert(foreign_id, app_data.records.len());
                app_data.records.push(record);
            }
            ext_foreign_toplevel_list_v1::Event::Finished => {}
            _ => unreachable!(),
        }
    }

    event_created_child!(
        AppData,
        ext_foreign_toplevel_list_v1::ExtForeignToplevelListV1,
        [
            ext_foreign_toplevel_list_v1::EVT_TOPLEVEL_OPCODE => (ext_foreign_toplevel_handle_v1::ExtForeignToplevelHandleV1, ()),
        ]
    );
}

impl Dispatch<ext_foreign_toplevel_handle_v1::ExtForeignToplevelHandleV1, ()> for AppData {
    fn event(
        app_data: &mut Self,
        handle: &ext_foreign_toplevel_handle_v1::ExtForeignToplevelHandleV1,
        event: ext_foreign_toplevel_handle_v1::Event,
        _: &(),
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        let Some(index) = app_data
            .by_foreign_id
            .get(&handle.id().protocol_id())
            .copied()
        else {
            return;
        };
        let record = &mut app_data.records[index];
        match event {
            ext_foreign_toplevel_handle_v1::Event::Identifier { identifier } => {
                record.identifier = Some(identifier);
            }
            ext_foreign_toplevel_handle_v1::Event::Title { title } => {
                record.title = Some(title);
            }
            ext_foreign_toplevel_handle_v1::Event::AppId { app_id } => {
                record.app_id = Some(app_id);
            }
            ext_foreign_toplevel_handle_v1::Event::Done => {}
            ext_foreign_toplevel_handle_v1::Event::Closed => {
                app_data.records[index].foreign = None;
                app_data.records[index].cosmic = None;
            }
            _ => unreachable!(),
        }
    }
}

impl Dispatch<zcosmic_toplevel_info_v1::ZcosmicToplevelInfoV1, ()> for AppData {
    fn event(
        app_data: &mut Self,
        _info: &zcosmic_toplevel_info_v1::ZcosmicToplevelInfoV1,
        event: zcosmic_toplevel_info_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let zcosmic_toplevel_info_v1::Event::Done = event {
            app_data.toplevel_info_done = true;
        }
    }

    event_created_child!(
        AppData,
        zcosmic_toplevel_info_v1::ZcosmicToplevelInfoV1,
        [
            zcosmic_toplevel_info_v1::EVT_TOPLEVEL_OPCODE => (zcosmic_toplevel_handle_v1::ZcosmicToplevelHandleV1, ()),
        ]
    );
}

impl Dispatch<zcosmic_toplevel_handle_v1::ZcosmicToplevelHandleV1, ()> for AppData {
    fn event(
        app_data: &mut Self,
        handle: &zcosmic_toplevel_handle_v1::ZcosmicToplevelHandleV1,
        event: zcosmic_toplevel_handle_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let Some(index) = app_data
            .by_cosmic_id
            .get(&handle.id().protocol_id())
            .copied()
        else {
            return;
        };
        let record = &mut app_data.records[index];
        match event {
            zcosmic_toplevel_handle_v1::Event::State { state } => {
                record.received_state = true;
                record.focused = false;
                record.hidden = false;
                for value in state.as_chunks::<4>().0 {
                    if let Ok(parsed) =
                        zcosmic_toplevel_handle_v1::State::try_from(u32::from_ne_bytes(*value))
                    {
                        if parsed == zcosmic_toplevel_handle_v1::State::Activated {
                            record.focused = true;
                        }
                        if parsed == zcosmic_toplevel_handle_v1::State::Minimized {
                            record.hidden = true;
                        }
                    }
                }
            }
            zcosmic_toplevel_handle_v1::Event::Geometry {
                output,
                x,
                y,
                width,
                height,
            } => {
                record
                    .geometries
                    .insert(output.id().protocol_id(), (x, y, width, height));
            }
            zcosmic_toplevel_handle_v1::Event::OutputLeave { output } => {
                record.geometries.remove(&output.id().protocol_id());
            }
            zcosmic_toplevel_handle_v1::Event::OutputEnter { .. }
            | zcosmic_toplevel_handle_v1::Event::WorkspaceEnter { .. }
            | zcosmic_toplevel_handle_v1::Event::WorkspaceLeave { .. }
            | zcosmic_toplevel_handle_v1::Event::ExtWorkspaceEnter { .. }
            | zcosmic_toplevel_handle_v1::Event::ExtWorkspaceLeave { .. }
            | zcosmic_toplevel_handle_v1::Event::Title { .. }
            | zcosmic_toplevel_handle_v1::Event::AppId { .. }
            | zcosmic_toplevel_handle_v1::Event::Done
            | zcosmic_toplevel_handle_v1::Event::Closed => {}
            _ => unreachable!(),
        }
    }
}

impl Dispatch<zcosmic_toplevel_manager_v1::ZcosmicToplevelManagerV1, ()> for AppData {
    fn event(
        app_data: &mut Self,
        _manager: &zcosmic_toplevel_manager_v1::ZcosmicToplevelManagerV1,
        event: zcosmic_toplevel_manager_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            zcosmic_toplevel_manager_v1::Event::Capabilities { capabilities } => {
                app_data.capabilities = capabilities
                    .chunks(4)
                    .map(|chunk| WEnum::from(u32::from_ne_bytes(chunk.try_into().unwrap())))
                    .collect();
            }
            _ => unreachable!(),
        }
    }
}

impl Dispatch<wl_seat::WlSeat, ()> for AppData {
    fn event(
        _app_data: &mut Self,
        _seat: &wl_seat::WlSeat,
        _event: wl_seat::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

fn stable_window_id(identifier: &str) -> u64 {
    fnv1a_64(identifier.as_bytes())
}

fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn print_json<T: Serialize>(value: &T) -> Result<()> {
    println!(
        "{}",
        serde_json::to_string_pretty(value).context("failed to serialize JSON output")?
    );
    Ok(())
}

fn activation_state_path() -> PathBuf {
    if let Some(runtime_dir) = std::env::var_os("XDG_RUNTIME_DIR") {
        PathBuf::from(runtime_dir).join("codex-computer-use-cosmic-last-activation.json")
    } else {
        std::env::temp_dir().join("codex-computer-use-cosmic-last-activation.json")
    }
}

fn write_activation_state(window_id: u64) -> Result<()> {
    let state = ActivationState {
        window_id,
        timestamp_ms: now_timestamp_ms()?,
    };
    let path = activation_state_path();
    let json = serde_json::to_vec(&state).context("failed to serialize activation state")?;
    std::fs::write(&path, json)
        .with_context(|| format!("failed to write activation state to {}", path.display()))
}

fn read_activation_state() -> Option<ActivationState> {
    let path = activation_state_path();
    let contents = std::fs::read(&path).ok()?;
    serde_json::from_slice(&contents).ok()
}

fn clear_activation_state() {
    let _ = std::fs::remove_file(activation_state_path());
}

fn state_is_stale(state: &ActivationState) -> bool {
    let Ok(now_ms) = now_timestamp_ms() else {
        return false;
    };
    now_ms.saturating_sub(state.timestamp_ms) > ACTIVATION_STATE_TTL.as_millis() as u64
}

fn now_timestamp_ms() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before UNIX_EPOCH")?
        .as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_activate_window_args_requires_numeric_id() {
        let error = Command::parse(vec![
            "activate-window".to_string(),
            "--window-id".to_string(),
            "nope".to_string(),
        ])
        .unwrap_err()
        .to_string();

        assert!(error.contains("invalid window id"));
    }

    #[test]
    fn parses_monitor_layout_command() {
        assert!(matches!(
            Command::parse(vec!["monitor-layout".to_string()]).unwrap(),
            Command::MonitorLayout
        ));
    }

    #[test]
    fn monitor_layout_uses_fractional_scale_and_transform() {
        let heads = HashMap::from([
            (
                1,
                OutputHeadState {
                    enabled: true,
                    position: Some((-1080, 0)),
                    transform: Some(1),
                    scale: Some(2.0),
                    current_mode: Some(11),
                    ..Default::default()
                },
            ),
            (
                2,
                OutputHeadState {
                    enabled: true,
                    position: Some((0, 0)),
                    transform: Some(0),
                    scale: Some(1.25),
                    current_mode: Some(22),
                    ..Default::default()
                },
            ),
        ]);
        let modes = HashMap::from([
            (
                11,
                OutputModeState {
                    size: Some((3840, 2160)),
                    ..Default::default()
                },
            ),
            (
                22,
                OutputModeState {
                    size: Some((2560, 1440)),
                    ..Default::default()
                },
            ),
        ]);

        assert_eq!(
            monitor_layout_from_state(&heads, &modes).unwrap(),
            vec![
                MonitorInfo {
                    x: -1080,
                    y: 0,
                    width: 1080,
                    height: 1920,
                    scale: 2.0,
                },
                MonitorInfo {
                    x: 0,
                    y: 0,
                    width: 2048,
                    height: 1152,
                    scale: 1.25,
                },
            ]
        );
    }

    #[test]
    fn monitor_layout_rejects_an_incomplete_enabled_head() {
        let heads = HashMap::from([
            (
                1,
                OutputHeadState {
                    enabled: true,
                    position: Some((0, 0)),
                    transform: Some(0),
                    scale: Some(1.0),
                    current_mode: Some(11),
                    ..Default::default()
                },
            ),
            (
                2,
                OutputHeadState {
                    enabled: true,
                    ..Default::default()
                },
            ),
        ]);
        let modes = HashMap::from([(
            11,
            OutputModeState {
                size: Some((1920, 1080)),
                ..Default::default()
            },
        )]);

        assert!(monitor_layout_from_state(&heads, &modes).is_none());
    }

    fn logical_output(x: i32, y: i32) -> LogicalOutput {
        LogicalOutput {
            position: Some((x, y)),
            done: true,
        }
    }

    #[test]
    fn window_geometry_is_translated_from_output_to_desktop() {
        let outputs = HashMap::from([(1, logical_output(-1920, 120))]);
        let geometry = HashMap::from([(1, (100, 30, 800, 600))]);
        assert_eq!(
            global_window_bounds(&geometry, &outputs),
            Some(WindowBounds {
                x: Some(-1820),
                y: Some(150),
                width: 800,
                height: 600,
            })
        );
    }

    #[test]
    fn spanning_window_requires_consistent_global_geometry() {
        let outputs = HashMap::from([(1, logical_output(-1920, 0)), (2, logical_output(0, 0))]);
        let mut geometry = HashMap::from([(1, (1800, 50, 800, 600)), (2, (-120, 50, 800, 600))]);
        assert_eq!(
            global_window_bounds(&geometry, &outputs).unwrap().x,
            Some(-120)
        );
        geometry.insert(2, (-100, 50, 800, 600));
        assert!(global_window_bounds(&geometry, &outputs).is_none());
    }

    #[test]
    fn window_geometry_rejects_missing_unfinished_invalid_and_overflowing_outputs() {
        let geometry = HashMap::from([(1, (100, 30, 800, 600))]);
        assert!(global_window_bounds(&geometry, &HashMap::new()).is_none());
        let mut outputs = HashMap::from([(1, LogicalOutput::default())]);
        assert!(global_window_bounds(&geometry, &outputs).is_none());
        outputs.insert(
            1,
            LogicalOutput {
                position: Some((0, 0)),
                done: false,
            },
        );
        assert!(global_window_bounds(&geometry, &outputs).is_none());
        outputs.insert(1, logical_output(i32::MAX, 0));
        assert!(global_window_bounds(&geometry, &outputs).is_none());
        outputs.insert(1, logical_output(0, 0));
        for size in [(0, 600), (-1, 600), (800, 0), (800, -1)] {
            assert!(
                global_window_bounds(&HashMap::from([(1, (0, 0, size.0, size.1))]), &outputs)
                    .is_none()
            );
        }
        assert!(global_window_bounds(&HashMap::new(), &outputs).is_none());
    }

    #[test]
    fn snapshot_waits_for_refresh_properties_and_protocol_done() {
        assert!(!toplevel_properties_ready(false, [false, false]));
        assert!(!toplevel_properties_ready(true, [true, false]));
        assert!(!toplevel_properties_ready(false, [true, true]));
        assert!(toplevel_properties_ready(true, [true, true]));
        assert!(toplevel_properties_ready(false, []));
    }

    #[test]
    fn stable_window_id_is_stable() {
        assert_eq!(stable_window_id("window-1"), stable_window_id("window-1"));
    }

    #[test]
    fn activation_state_expires_after_ttl() {
        let state = ActivationState {
            window_id: 7,
            timestamp_ms: now_timestamp_ms().unwrap()
                - (ACTIVATION_STATE_TTL.as_millis() as u64 + 1),
        };

        assert!(state_is_stale(&state));
    }

    #[test]
    fn activation_state_is_fresh_within_ttl() {
        let state = ActivationState {
            window_id: 7,
            timestamp_ms: now_timestamp_ms().unwrap(),
        };

        assert!(!state_is_stale(&state));
    }
}

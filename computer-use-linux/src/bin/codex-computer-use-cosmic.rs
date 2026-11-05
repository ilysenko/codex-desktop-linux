use anyhow::{anyhow, bail, Context, Result};
use cosmic_protocols::{
    toplevel_info::v1::client::{zcosmic_toplevel_handle_v1, zcosmic_toplevel_info_v1},
    toplevel_management::v1::client::zcosmic_toplevel_manager_v1,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::os::unix::io::{AsFd, AsRawFd};
use std::time::{Duration, Instant};
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

const BIN: &str = "codex-computer-use-cosmic";
/// Exit status for a command line that names an unknown command, flag or
/// argument. Nothing runs before the line is validated.
const USAGE_EXIT: i32 = 2;
const BACKEND: &str = "cosmic-wayland";
/// Bounded waits keep the helper inside the main crate's 2s command timeout:
/// ~0.8s for initial cosmic state + ~0.8s for post-activation verification.
const INIT_STATE_TIMEOUT: Duration = Duration::from_millis(800);
const ACTIVATE_VERIFY_TIMEOUT: Duration = Duration::from_millis(800);

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Default)]
struct ToplevelRecord {
    foreign: Option<ext_foreign_toplevel_handle_v1::ExtForeignToplevelHandleV1>,
    cosmic: Option<zcosmic_toplevel_handle_v1::ZcosmicToplevelHandleV1>,
    identifier: Option<String>,
    title: Option<String>,
    app_id: Option<String>,
    focused: bool,
    hidden: bool,
    geometries: HashMap<u32, WindowBounds>,
}

impl ToplevelRecord {
    fn to_window(&self, outputs: &HashMap<u32, OutputPosition>) -> Option<WindowInfo> {
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

#[derive(Debug, Default)]
struct OutputPosition {
    // wl_output geometry is not a logical coordinate contract. Only xdg-output
    // logical_position can translate COSMIC's output-relative window geometry.
    logical: Option<(i32, i32)>,
    done: bool,
}

fn global_window_bounds(
    geometries: &HashMap<u32, WindowBounds>,
    outputs: &HashMap<u32, OutputPosition>,
) -> Option<WindowBounds> {
    let mut bounds = None;
    for (output_id, relative) in geometries {
        let Some(output) = outputs.get(output_id).filter(|output| output.done) else {
            continue;
        };
        let Some((x, y)) = output.logical else {
            continue;
        };
        let global = WindowBounds {
            x: Some(x.checked_add(relative.x?)?),
            y: Some(y.checked_add(relative.y?)?),
            width: relative.width,
            height: relative.height,
        };
        if bounds.as_ref().is_some_and(|bounds| bounds != &global) {
            return None;
        }
        bounds = Some(global);
    }
    bounds
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
    /// Cosmic protocol ids that have delivered at least one initial `State`
    /// event. cosmic-comp answers `get_cosmic_toplevel` asynchronously, so a
    /// fixed number of roundtrips can finish before the state arrives and the
    /// snapshot would report every window as unfocused.
    cosmic_state_seen: HashSet<u32>,
    output_manager: Option<zwlr_output_manager_v1::ZwlrOutputManagerV1>,
    output_layout_ready: bool,
    output_manager_finished: bool,
    xdg_output_manager: Option<zxdg_output_manager_v1::ZxdgOutputManagerV1>,
    outputs: HashMap<u32, OutputPosition>,
    toplevel_done: bool,
    output_heads: HashMap<u32, OutputHeadState>,
    output_modes: HashMap<u32, OutputModeState>,
}

fn main() -> Result<()> {
    let arguments: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|argument| argument.to_string_lossy().into_owned())
        .collect();
    let command = match parse_invocation(&arguments) {
        Ok(Invocation::Run(command)) => command,
        Ok(Invocation::Help(subcommand)) => {
            print!("{}", help_text(subcommand));
            return Ok(());
        }
        Err(error) => {
            eprint!("{}", usage_error_text(&error));
            std::process::exit(USAGE_EXIT);
        }
    };
    match command {
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

struct Subcommand {
    name: &'static str,
    /// Arguments after the subcommand name, as shown in its usage line.
    arguments: &'static str,
    summary: &'static str,
    details: &'static str,
    /// Option lines for the help, before `-h, --help`.
    options: &'static [(&'static str, &'static str)],
}

const SUBCOMMANDS: &[Subcommand] = &[
    Subcommand {
        name: "probe",
        arguments: "",
        summary: "Report whether COSMIC window listing and activation work, as JSON.",
        details: "Connects to the Wayland display and reads COSMIC's toplevel protocols. Reads state only.",
        options: &[],
    },
    Subcommand {
        name: "list-windows",
        arguments: "",
        summary: "List COSMIC windows as JSON.",
        details: "Reads COSMIC's toplevel protocols. Bounds are global logical coordinates when xdg-output gives the output position. Reads state only.",
        options: &[],
    },
    Subcommand {
        name: "focused-window",
        arguments: "",
        summary: "Print the focused COSMIC window as JSON, or null.",
        details: "Reads COSMIC's toplevel protocols. Reads state only.",
        options: &[],
    },
    Subcommand {
        name: "monitor-layout",
        arguments: "",
        summary: "Print the logical position, size and scale of each enabled output as JSON.",
        details: "Reads wlr-output-management. Reads state only.",
        options: &[],
    },
    Subcommand {
        name: "activate-window",
        arguments: "--window-id ID",
        summary: "Activate a COSMIC window and print whether it took focus, as JSON.",
        details: "ID is a window_id from list-windows. The helper waits up to 0.8 seconds for the window to report focus.",
        options: &[("--window-id ID", "Window id from list-windows.")],
    },
];

enum Invocation {
    Help(Option<&'static Subcommand>),
    Run(Command),
}

struct UsageError {
    message: String,
    subcommand: Option<&'static Subcommand>,
}

fn is_help_flag(argument: &str) -> bool {
    matches!(argument, "-h" | "--help")
}

/// Validates the whole command line before anything runs, with the main
/// CLI's rules: `-h` or `--help` anywhere before `--` prints help, any other
/// flag the command does not take is an error, and so is any argument.
fn parse_invocation(arguments: &[String]) -> std::result::Result<Invocation, UsageError> {
    let Some(name) = arguments.first() else {
        return Ok(Invocation::Help(None));
    };
    if is_help_flag(name) {
        return Ok(Invocation::Help(None));
    }
    let Some(subcommand) = SUBCOMMANDS
        .iter()
        .find(|subcommand| subcommand.name == name)
    else {
        let message = if name.starts_with('-') {
            format!("unknown option '{name}'")
        } else {
            format!("unknown command '{name}'")
        };
        return Err(UsageError {
            message,
            subcommand: None,
        });
    };
    let rest = &arguments[1..];
    let options_end = rest
        .iter()
        .position(|argument| argument == "--")
        .unwrap_or(rest.len());
    let options = &rest[..options_end];
    if options.iter().any(|argument| is_help_flag(argument)) {
        return Ok(Invocation::Help(Some(subcommand)));
    }
    let error = |message: String| UsageError {
        message,
        subcommand: Some(subcommand),
    };
    let takes_window_id = subcommand.name == "activate-window";
    let mut window_id = None;
    let mut index = 0;
    while index < options.len() {
        let argument = &options[index];
        index += 1;
        let value = if takes_window_id && argument == "--window-id" {
            let Some(value) = options.get(index) else {
                return Err(error("'--window-id' needs a value".to_string()));
            };
            index += 1;
            value.as_str()
        } else if let Some(value) = argument
            .strip_prefix("--window-id=")
            .filter(|_| takes_window_id)
        {
            value
        } else if argument.len() > 1 && argument.starts_with('-') {
            return Err(error(format!(
                "unknown option '{argument}' for '{}'",
                subcommand.name
            )));
        } else {
            return Err(error(format!(
                "unexpected argument '{argument}' for '{}'",
                subcommand.name
            )));
        };
        if window_id.is_some() {
            return Err(error("'--window-id' given more than once".to_string()));
        }
        window_id = Some(
            value
                .parse::<u64>()
                .map_err(|_| error(format!("'{value}' is not a window id")))?,
        );
    }
    if let Some(argument) = rest.get(options_end + 1) {
        return Err(error(format!(
            "unexpected argument '{argument}' for '{}'",
            subcommand.name
        )));
    }
    let command = match subcommand.name {
        "probe" => Command::Probe,
        "list-windows" => Command::ListWindows,
        "focused-window" => Command::FocusedWindow,
        "monitor-layout" => Command::MonitorLayout,
        _ => Command::ActivateWindow {
            window_id: window_id.ok_or_else(|| {
                error(format!(
                    "'{}' needs {}",
                    subcommand.name, subcommand.arguments
                ))
            })?,
        },
    };
    Ok(Invocation::Run(command))
}

fn usage_line(subcommand: &Subcommand) -> String {
    if subcommand.arguments.is_empty() {
        format!("{BIN} {}", subcommand.name)
    } else {
        format!("{BIN} {} {}", subcommand.name, subcommand.arguments)
    }
}

fn help_text(subcommand: Option<&Subcommand>) -> String {
    match subcommand {
        Some(subcommand) => {
            let mut options = subcommand.options.to_vec();
            options.push(("-h, --help", "Print this help and exit."));
            let width = options
                .iter()
                .map(|(flag, _)| flag.len())
                .max()
                .unwrap_or(0);
            let options: String = options
                .iter()
                .map(|(flag, text)| format!("  {flag:width$}  {text}\n"))
                .collect();
            format!(
                "{}\n\nUsage:\n  {}\n\n{}\n\nOptions:\n{options}",
                subcommand.summary,
                usage_line(subcommand),
                subcommand.details
            )
        }
        None => {
            let width = SUBCOMMANDS
                .iter()
                .map(|subcommand| usage_line(subcommand).len())
                .max()
                .unwrap_or(0);
            let mut text =
                format!("{BIN}: COSMIC window helper for codex-computer-use-linux.\n\nUsage:\n");
            for subcommand in SUBCOMMANDS {
                text.push_str(&format!(
                    "  {:width$}  {}\n",
                    usage_line(subcommand),
                    subcommand.summary
                ));
            }
            text.push_str(&format!(
                "\nThe codex-computer-use-linux server runs these commands on COSMIC. Run '{BIN} COMMAND --help' for what a command does. Every command takes -h and --help.\n"
            ));
            text
        }
    }
}

fn usage_error_text(error: &UsageError) -> String {
    match error.subcommand {
        Some(subcommand) => format!(
            "{BIN}: {}\nUsage: {}\nRun '{BIN} {} --help' for details.\n",
            error.message,
            usage_line(subcommand),
            subcommand.name
        ),
        None => {
            let names: Vec<&str> = SUBCOMMANDS
                .iter()
                .map(|subcommand| subcommand.name)
                .collect();
            format!(
                "{BIN}: {}. Expected one of: {}\nRun '{BIN} --help' for usage.\n",
                error.message,
                names.join(", ")
            )
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
    Ok(protocol_focused_window(Snapshot::collect()?.windows()))
}

fn protocol_focused_window(windows: Vec<WindowInfo>) -> Option<WindowInfo> {
    windows.into_iter().find(|window| window.focused)
}

fn monitor_layout() -> Result<Vec<MonitorInfo>> {
    Snapshot::collect()?.monitor_layout()
}

fn activate_window(window_id: u64) -> Result<ActivationOutput> {
    let mut snapshot = Snapshot::collect()?;
    let verified = snapshot.activate(window_id)?;
    Ok(ActivationOutput {
        ok: verified,
        detail: if verified {
            format!("COSMIC activation verified focused for window_id {window_id}.")
        } else {
            format!(
                "Requested COSMIC activation for window_id {window_id}, but focus was not observed before the verification deadline."
            )
        },
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
        snapshot.app_data.xdg_output_manager = globals
            .bind::<zxdg_output_manager_v1::ZxdgOutputManagerV1, _, _>(&qh, 1..=3, ())
            .ok();
        globals.contents().with_list(|entries| {
            for global in entries {
                if global.interface == "wl_output" {
                    let output = globals.registry().bind::<wl_output::WlOutput, _, _>(
                        global.name,
                        global.version.min(4),
                        &qh,
                        (),
                    );
                    snapshot
                        .app_data
                        .outputs
                        .insert(output.id().protocol_id(), OutputPosition::default());
                    if let Some(manager) = snapshot.app_data.xdg_output_manager.as_ref() {
                        manager.get_xdg_output(&output, &qh, output.id().protocol_id());
                    }
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
        // `get_cosmic_toplevel` handles are answered asynchronously: the
        // roundtrips above can complete before cosmic-comp delivers the
        // initial `State` events. Wait (bounded) for every known cosmic
        // handle to report state so `focused` reflects the compositor.
        let ready = self.wait_for_condition(INIT_STATE_TIMEOUT, |app_data| {
            (app_data
                .records
                .iter()
                .all(|record| record.foreign.is_none())
                || app_data
                    .toplevel_info
                    .as_ref()
                    .is_none_or(|info| info.version() < 2)
                || app_data.toplevel_done)
                // xdg-output and COSMIC use independent atomic batches. A
                // toplevel done does not mean its output origin has arrived.
                && (app_data.xdg_output_manager.is_none()
                    || app_data.records.iter().filter(|record| record.foreign.is_some())
                        .flat_map(|record| record.geometries.keys())
                        .all(|output_id| app_data.outputs.get(output_id)
                            .is_some_and(|output| output.logical.is_some() && output.done)))
                && app_data.records.iter().all(|record| {
                    record.foreign.is_none()
                        || (record.identifier.is_some()
                            && (record.cosmic.is_none()
                                || record.cosmic.as_ref().is_some_and(|handle| {
                                    app_data
                                        .cosmic_state_seen
                                        .contains(&handle.id().protocol_id())
                                })))
                })
        })?;
        if !ready {
            bail!("COSMIC initial toplevel state did not arrive before the snapshot deadline");
        }
        Ok(())
    }

    /// Dispatch Wayland events until `condition` holds or `budget` expires.
    /// Uses `poll(2)` on the queue fd so a silent compositor cannot hang us;
    /// returns `Ok(true)` when the condition held before the deadline.
    fn wait_for_condition(
        &mut self,
        budget: Duration,
        mut condition: impl FnMut(&AppData) -> bool,
    ) -> Result<bool> {
        let deadline = Instant::now() + budget;
        loop {
            self.event_queue
                .dispatch_pending(&mut self.app_data)
                .context("Wayland dispatch failed")?;
            if condition(&self.app_data) {
                return Ok(true);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(false);
            }
            self.event_queue.flush().context("Wayland flush failed")?;
            if let Some(guard) = self.event_queue.prepare_read() {
                let fd = self.event_queue.as_fd();
                let mut poll_fd = libc::pollfd {
                    fd: fd.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                };
                let timeout_ms = remaining.as_millis().min(i32::MAX as u128) as i32;
                // SAFETY: `poll_fd` is a valid single-element array; `poll`
                // only reads it and writes `revents`.
                let ready = unsafe { libc::poll(&mut poll_fd, 1, timeout_ms) };
                if ready < 0 {
                    let errno = std::io::Error::last_os_error();
                    if errno.kind() == std::io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(anyhow!("Wayland socket poll failed: {errno}"));
                }
                if ready == 0 {
                    return Ok(false);
                }
                match guard.read() {
                    Ok(_) => {}
                    Err(wayland_client::backend::WaylandError::Io(error))
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                        ) => {}
                    Err(error) => return Err(error).context("Wayland read failed"),
                }
            }
        }
    }

    fn windows(&self) -> Vec<WindowInfo> {
        self.app_data
            .records
            .iter()
            .filter_map(|record| record.to_window(&self.app_data.outputs))
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

    fn monitor_layout(&mut self) -> Result<Vec<MonitorInfo>> {
        if self.app_data.output_manager.is_none() {
            bail!("COSMIC output management protocol is unavailable");
        }
        self.wait_for_condition(INIT_STATE_TIMEOUT, |app_data| {
            app_data.output_layout_ready || app_data.output_manager_finished
        })?;
        if self.app_data.output_manager_finished || !self.app_data.output_layout_ready {
            bail!("COSMIC output management did not finish an atomic layout snapshot");
        }
        monitor_layout_from_state(&self.app_data.output_heads, &self.app_data.output_modes)
            .ok_or_else(|| anyhow!("COSMIC output management returned an incomplete layout"))
    }

    fn activate(&mut self, window_id: u64) -> Result<bool> {
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
            .flush()
            .context("Wayland flush after activation failed")?;
        // Verify on the same connection instead of trusting the fire-and-
        // forget request: the compositor emits a fresh `State` with
        // `Activated` for the target once focus actually moves.
        let target_id = stable_window_id(
            record
                .identifier
                .as_deref()
                .ok_or_else(|| anyhow!("matched window has no identifier"))?,
        );
        let verified = self.wait_for_condition(ACTIVATE_VERIFY_TIMEOUT, |app_data| {
            app_data.records.iter().any(|record| {
                record.foreign.is_some()
                    && record
                        .identifier
                        .as_deref()
                        .is_some_and(|id| stable_window_id(id) == target_id)
                    && record.focused
            })
        })?;
        Ok(verified)
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
            version: _,
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
                "wl_seat" => {
                    app_data
                        .seats
                        .push(registry.bind::<wl_seat::WlSeat, _, _>(name, 9, qh, ()));
                }
                _ => {}
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
                    app_data.toplevel_done = false;
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
        if matches!(event, zcosmic_toplevel_info_v1::Event::Done) {
            app_data.toplevel_done = true;
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
                app_data.cosmic_state_seen.insert(handle.id().protocol_id());
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
                if width > 0 && height > 0 {
                    record.geometries.insert(
                        output.id().protocol_id(),
                        WindowBounds {
                            x: Some(x),
                            y: Some(y),
                            width: width as u32,
                            height: height as u32,
                        },
                    );
                } else {
                    record.geometries.remove(&output.id().protocol_id());
                }
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

impl Dispatch<wl_output::WlOutput, ()> for AppData {
    fn event(
        app_data: &mut Self,
        output: &wl_output::WlOutput,
        event: wl_output::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        // xdg-output v3 uses wl_output.done as its atomic state boundary.
        if matches!(event, wl_output::Event::Done) {
            if let Some(position) = app_data.outputs.get_mut(&output.id().protocol_id()) {
                position.done = true;
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
        app_data: &mut Self,
        _: &zxdg_output_v1::ZxdgOutputV1,
        event: zxdg_output_v1::Event,
        output_id: &u32,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let Some(position) = app_data.outputs.get_mut(output_id) else {
            return;
        };
        match event {
            zxdg_output_v1::Event::LogicalPosition { x, y } => {
                position.logical = Some((x, y));
                position.done = false;
            }
            zxdg_output_v1::Event::Done => position.done = true,
            _ => {}
        }
    }
}

fn stable_window_id(identifier: &str) -> u64 {
    // Opaque numeric IDs must survive JSON clients that use IEEE-754 doubles.
    (fnv1a_64(identifier.as_bytes()) & ((1u64 << 53) - 1)).max(1)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(arguments: &[&str]) -> String {
        let arguments: Vec<String> = arguments.iter().map(|value| value.to_string()).collect();
        match parse_invocation(&arguments) {
            Ok(Invocation::Help(None)) => "help".to_string(),
            Ok(Invocation::Help(Some(subcommand))) => format!("help {}", subcommand.name),
            Ok(Invocation::Run(command)) => format!("run {command:?}"),
            Err(error) => format!("error: {}", error.message),
        }
    }

    #[test]
    fn command_lines_follow_the_main_cli_rules() {
        assert_eq!(parse(&[]), "help");
        assert_eq!(parse(&["-h"]), "help");
        assert_eq!(parse(&["monitor-layout"]), "run MonitorLayout");
        assert_eq!(parse(&["probe", "--help"]), "help probe");
        assert_eq!(
            parse(&["probe", "--", "--help"]),
            "error: unexpected argument '--help' for 'probe'"
        );
        assert_eq!(
            parse(&["activate-window", "--window-id", "7"]),
            "run ActivateWindow { window_id: 7 }"
        );
        assert_eq!(
            parse(&["activate-window", "--window-id=7", "--"]),
            "run ActivateWindow { window_id: 7 }"
        );
        assert_eq!(
            parse(&["activate-window", "--window-id", "-h"]),
            "help activate-window"
        );
        assert_eq!(
            parse(&["activate-window", "--window-id", "nope"]),
            "error: 'nope' is not a window id"
        );
        assert_eq!(
            parse(&["activate-window", "--window-id", "--", "7"]),
            "error: '--window-id' needs a value"
        );
        assert_eq!(
            parse(&["activate-window", "--window-id", "1", "--window-id", "2"]),
            "error: '--window-id' given more than once"
        );
        assert_eq!(
            parse(&["activate-window"]),
            "error: 'activate-window' needs --window-id ID"
        );
        assert_eq!(
            parse(&["probe", "--window-id", "7"]),
            "error: unknown option '--window-id' for 'probe'"
        );
        assert_eq!(
            parse(&["probe", "-"]),
            "error: unexpected argument '-' for 'probe'"
        );
        assert_eq!(parse(&["--version"]), "error: unknown option '--version'");
        assert_eq!(parse(&["windows"]), "error: unknown command 'windows'");
    }

    #[test]
    fn helper_calls_from_the_server_parse() {
        // The argument lists src/cosmic_helper.rs passes.
        assert_eq!(parse(&["probe"]), "run Probe");
        assert_eq!(parse(&["list-windows"]), "run ListWindows");
        assert_eq!(parse(&["focused-window"]), "run FocusedWindow");
        assert_eq!(parse(&["monitor-layout"]), "run MonitorLayout");
        assert_eq!(
            parse(&["activate-window", "--window-id", &u64::MAX.to_string()]),
            format!("run ActivateWindow {{ window_id: {} }}", u64::MAX)
        );
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

    #[test]
    fn stable_window_id_is_stable() {
        assert_eq!(stable_window_id("window-1"), stable_window_id("window-1"));
    }

    #[test]
    fn focus_selection_requires_compositor_activated_state() {
        let windows = vec![test_window(7, false), test_window(9, false)];

        assert!(protocol_focused_window(windows).is_none());
    }

    #[test]
    fn focus_selection_returns_compositor_activated_window() {
        let windows = vec![test_window(7, false), test_window(9, true)];

        assert_eq!(protocol_focused_window(windows).unwrap().window_id, 9);
    }

    fn test_window(window_id: u64, focused: bool) -> WindowInfo {
        WindowInfo {
            window_id,
            title: None,
            app_id: None,
            wm_class: None,
            pid: None,
            bounds: None,
            workspace: None,
            focused,
            hidden: false,
            client_type: Some("wayland".to_string()),
            backend: BACKEND.to_string(),
        }
    }
}

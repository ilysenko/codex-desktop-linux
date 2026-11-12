use crate::http_listen::{self, ListenConfig};
use crate::{abs_pointer, atspi_tree, diagnostics, gnome_extension, screenshot, server, windows};
use anyhow::{Context, Result};

const BIN: &str = "codex-computer-use-linux";

/// Exit status for a command line that names an unknown command, flag or
/// argument. Nothing runs before the line is validated.
const USAGE_EXIT: i32 = 2;

struct Subcommand {
    name: &'static str,
    /// Arguments after the subcommand name, as shown in its usage line.
    arguments: &'static str,
    /// Positional arguments: how many are required and how many are allowed.
    required: usize,
    allowed: usize,
    summary: &'static str,
    details: &'static str,
    /// Development probes are left out of the top-level usage.
    hidden: bool,
}

const SUBCOMMANDS: &[Subcommand] = &[
    Subcommand {
        name: "mcp",
        arguments: "[--listen ADDR:PORT [--allowed-host NAME]...]",
        required: 0,
        allowed: 0,
        summary: "Serve the MCP tools over stdio, or over HTTP with --listen.",
        details: "Reads MCP JSON-RPC requests on stdin and writes responses on stdout until stdin closes. MCP hosts start this command. With --listen ADDR:PORT it serves streamable HTTP at /mcp instead, and requires a bearer token from the file named by CODEX_COMPUTER_USE_MCP_TOKEN_FILE or from CODEX_COMPUTER_USE_MCP_TOKEN (or their COMPUTER_USE_LINUX_ aliases). The port is plain HTTP: bind loopback or a private address; a non-loopback bind needs each hostname clients use as --allowed-host NAME. It refuses to start while CODEX_COMPUTER_USE_ENABLE_SHELL=1, or COMPUTER_USE_LINUX_ENABLE_SHELL=1 with the Codex variable unset.",
        hidden: false,
    },
    Subcommand {
        name: "doctor",
        arguments: "",
        required: 0,
        allowed: 0,
        summary: "Print a JSON readiness report for this desktop session.",
        details: "Checks accessibility, screenshots, window targeting and input routes. Reads state only.",
        hidden: false,
    },
    Subcommand {
        name: "setup",
        arguments: "",
        required: 0,
        allowed: 0,
        summary: "Turn on desktop accessibility, then print a JSON report.",
        details: "Sets the GNOME toolkit-accessibility key to true through gsettings when it is not already true, and reads it back. It requests org.a11y.Status IsEnabled at runtime only when the key does not read back true or the accessibility tree could not be built. It never turns accessibility off. Restart running apps whose accessibility tree stays empty.",
        hidden: false,
    },
    Subcommand {
        name: "guard-accessibility",
        arguments: "",
        required: 0,
        allowed: 0,
        summary: "Keep GNOME toolkit-accessibility on while it runs.",
        details: "Runs in the foreground and sets the key back to true when something turns it off. It does not exit on its own: stop it with Ctrl-C or SIGTERM before you turn accessibility off. Stopping it leaves the setting as it is. MCP and setup never start it.",
        hidden: false,
    },
    Subcommand {
        name: "setup-window-targeting",
        arguments: "",
        required: 0,
        allowed: 0,
        summary: "Install the GNOME Shell extension for window targeting.",
        details: "Writes the extension into $XDG_DATA_HOME/gnome-shell/extensions (default ~/.local/share), where GNOME Shell loads user extensions, or into the user copy GNOME Shell reports it loaded, unless a system copy is installed, enables it, and prints a JSON report. GNOME may need a new login before it loads the extension. The report's requires_shell_reload says when GNOME Shell needs a new login. That is when the Shell does not serve the window API yet, or a system copy replaces the copy it loaded. It is also when extension.js, or a metadata field the Shell acts on, changed while the extension was enabled or its state was unknown. A change to the name, description, url, version-name or donations alone needs no new login.",
        hidden: false,
    },
    Subcommand {
        name: "apps",
        arguments: "",
        required: 0,
        allowed: 0,
        summary: "List accessible apps as JSON.",
        details: "Lists up to 50 apps registered on the AT-SPI bus. Reads state only.",
        hidden: false,
    },
    Subcommand {
        name: "state",
        arguments: "[APP_NAME]",
        required: 0,
        allowed: 1,
        summary: "Print an app's accessibility tree as JSON.",
        details: "Reads the AT-SPI tree of APP_NAME, matched by name or bundle identifier. Without APP_NAME it reads every accessible app, up to the default node and depth limits. Reads state only.",
        hidden: false,
    },
    Subcommand {
        name: "screenshot",
        arguments: "",
        required: 0,
        allowed: 0,
        summary: "Capture the screen and print the capture's metadata as JSON.",
        details: "Prints the size, scale, format and byte counts of a full-screen capture. The image itself is not printed or saved.",
        hidden: false,
    },
    Subcommand {
        name: "windows",
        arguments: "",
        required: 0,
        allowed: 0,
        summary: "List compositor windows as JSON.",
        details: "Uses the first window backend that works in this session. Reads state only.",
        hidden: false,
    },
    Subcommand {
        name: "abs-test",
        arguments: "X Y",
        required: 2,
        allowed: 2,
        summary: "Click at X,Y with a uinput pointer sized to the screen.",
        details: "Development probe for absolute pointer mapping. It clicks the left button on the live desktop.",
        hidden: true,
    },
];

enum Invocation {
    Help(Option<&'static Subcommand>),
    Run(&'static Subcommand, Vec<String>),
}

struct UsageError {
    message: String,
    subcommand: Option<&'static Subcommand>,
}

fn subcommand(name: &str) -> Option<&'static Subcommand> {
    SUBCOMMANDS
        .iter()
        .find(|subcommand| subcommand.name == name)
}

fn is_help_flag(argument: &str) -> bool {
    matches!(argument, "-h" | "--help")
}

/// Validates the whole command line before anything runs. `-h` or `--help`
/// anywhere before `--` prints help; any other flag is an error.
fn parse_invocation(arguments: &[String]) -> Result<Invocation, UsageError> {
    let Some(name) = arguments.first() else {
        return Ok(Invocation::Help(None));
    };
    if is_help_flag(name) {
        return Ok(Invocation::Help(None));
    }
    let Some(subcommand) = subcommand(name) else {
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
    let mut rest = arguments[1..].to_vec();
    let mut options_end = rest
        .iter()
        .position(|argument| argument == "--")
        .unwrap_or(rest.len());
    if rest[..options_end]
        .iter()
        .any(|argument| is_help_flag(argument))
    {
        return Ok(Invocation::Help(Some(subcommand)));
    }
    let error = |message: String| UsageError {
        message,
        subcommand: Some(subcommand),
    };
    // `mcp --listen ADDR:PORT` and `--allowed-host NAME` are the only options that take a value.
    let mut listen = None;
    let mut allowed_hosts = Vec::new();
    if subcommand.name == "mcp" {
        if let Some(at) = rest[..options_end]
            .iter()
            .position(|argument| argument == "--listen")
        {
            if at + 1 >= options_end {
                return Err(error("'--listen' needs ADDR:PORT".to_string()));
            }
            listen = Some(rest.remove(at + 1));
            rest.remove(at);
            options_end -= 2;
        }
        while let Some(at) = rest[..options_end]
            .iter()
            .position(|argument| argument == "--allowed-host")
        {
            if at + 1 >= options_end {
                return Err(error("'--allowed-host' needs NAME".to_string()));
            }
            allowed_hosts.push(rest.remove(at + 1));
            rest.remove(at);
            options_end -= 2;
        }
        if listen.is_none() && !allowed_hosts.is_empty() {
            return Err(error("'--allowed-host' needs --listen".to_string()));
        }
    }
    if let Some(option) = rest[..options_end]
        .iter()
        .find(|argument| argument.len() > 1 && argument.starts_with('-'))
    {
        return Err(error(format!(
            "unknown option '{option}' for '{}'",
            subcommand.name
        )));
    }
    let mut positionals: Vec<String> = rest[..options_end]
        .iter()
        .chain(rest.iter().skip(options_end + 1))
        .cloned()
        .collect();
    if positionals.len() > subcommand.allowed {
        return Err(error(format!(
            "unexpected argument '{}' for '{}'",
            positionals[subcommand.allowed], subcommand.name
        )));
    }
    if positionals.len() < subcommand.required {
        return Err(error(format!(
            "'{}' needs {}",
            subcommand.name, subcommand.arguments
        )));
    }
    if subcommand.name == "abs-test" {
        if let Some(value) = positionals
            .iter()
            .find(|value| value.parse::<i32>().is_err())
        {
            return Err(error(format!("'{value}' is not an integer coordinate")));
        }
    }
    // After the count check, so a bare address without --listen stays an error.
    positionals.extend(listen);
    positionals.extend(allowed_hosts);
    Ok(Invocation::Run(subcommand, positionals))
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
        Some(subcommand) => format!(
            "{}\n\nUsage:\n  {}\n\n{}\n\nOptions:\n  -h, --help  Print this help and exit.\n",
            subcommand.summary,
            usage_line(subcommand),
            subcommand.details
        ),
        None => {
            let visible: Vec<&Subcommand> = SUBCOMMANDS
                .iter()
                .filter(|subcommand| !subcommand.hidden)
                .collect();
            let width = visible
                .iter()
                .map(|subcommand| usage_line(subcommand).len())
                .max()
                .unwrap_or(0);
            let mut text =
                format!("{BIN}: Linux desktop control over MCP and the command line.\n\nUsage:\n");
            for subcommand in visible {
                text.push_str(&format!(
                    "  {:width$}  {}\n",
                    usage_line(subcommand),
                    subcommand.summary
                ));
            }
            text.push_str(&format!(
                "\nRun '{BIN} COMMAND --help' for what a command does. Every command takes -h and --help.\n"
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
                .filter(|subcommand| !subcommand.hidden)
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

pub(crate) async fn run_from_env() -> Result<()> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let invocation = match parse_invocation(&arguments) {
        Ok(invocation) => invocation,
        Err(error) => {
            eprint!("{}", usage_error_text(&error));
            std::process::exit(USAGE_EXIT);
        }
    };
    let (subcommand, positionals) = match invocation {
        Invocation::Help(subcommand) => {
            print!("{}", help_text(subcommand));
            return Ok(());
        }
        Invocation::Run(subcommand, positionals) => (subcommand, positionals),
    };
    // Before any thread or child exists, so removing the token variables is sound.
    let listen = if subcommand.name == "mcp" {
        mcp_listen_config(&positionals)?
    } else {
        None
    };
    diagnostics::hydrate_session_bus_env();

    match subcommand.name {
        "mcp" => server::serve_mcp(listen).await,
        "guard-accessibility" => crate::accessibility_guard::run().await,
        "doctor" => {
            let report = diagnostics::doctor_report();
            println!(
                "{}",
                serde_json::to_string_pretty(&report)
                    .context("failed to serialize doctor report")?
            );
            Ok(())
        }
        "setup" => {
            let report = diagnostics::setup_accessibility_report();
            println!(
                "{}",
                serde_json::to_string_pretty(&report)
                    .context("failed to serialize setup report")?
            );
            Ok(())
        }
        "apps" => {
            let apps = atspi_tree::list_accessible_apps(50).await?;
            println!(
                "{}",
                serde_json::to_string_pretty(&apps)
                    .context("failed to serialize accessible apps")?
            );
            Ok(())
        }
        "state" => {
            let app_name_or_bundle_identifier = positionals.first().cloned();
            let (max_nodes, max_depth) = atspi_tree::snapshot_limits(None, None);
            let nodes = atspi_tree::snapshot_tree(
                app_name_or_bundle_identifier.as_deref(),
                None,
                max_nodes,
                max_depth,
            )
            .await?;
            println!(
                "{}",
                serde_json::to_string_pretty(&nodes)
                    .context("failed to serialize accessibility tree")?
            );
            Ok(())
        }
        "abs-test" => {
            let x: i32 = positionals[0].parse()?;
            let y: i32 = positionals[1].parse()?;
            let cap = screenshot::capture_screenshot_raw().await?;
            eprintln!("desktop logical size: {}x{}", cap.width, cap.height);
            let mut p = abs_pointer::AbsPointer::create(cap.width as i32, cap.height as i32)?;
            let landing = p.click(x, y, abs_pointer::PointerButton::Left, 1)?;
            println!("{}", abs_test_report(landing, (cap.width, cap.height)));
            Ok(())
        }
        "screenshot" => {
            let capture = screenshot::capture_screenshot().await?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "mime_type": capture.mime_type,
                    "source": capture.source,
                    "width": capture.width,
                    "height": capture.height,
                    "coordinate_width": capture.coordinate_width,
                    "coordinate_height": capture.coordinate_height,
                    "scale": capture.scale,
                    "resized": capture.resized,
                    "bytes": capture.bytes,
                    "original_bytes": capture.original_bytes,
                    "max_bytes": capture.max_bytes,
                    "format": capture.format,
                    "quality": capture.quality,
                    "data_url_length": capture.data_url.len()
                }))
                .context("failed to serialize screenshot report")?
            );
            Ok(())
        }
        "windows" => {
            let report = match windows::list_windows().await {
                Ok(windows) => {
                    let backend = windows
                        .first()
                        .map(|window| window.backend.as_str())
                        .unwrap_or(windows::UNAVAILABLE_BACKEND);
                    serde_json::json!({
                        "backend": backend,
                        "windows": windows,
                        "error": null,
                        "permissions_hint": null,
                    })
                }
                Err(error) => {
                    let error = format!("{error:#}");
                    serde_json::json!({
                        "backend": windows::UNAVAILABLE_BACKEND,
                        "windows": [],
                        "error": error,
                        "permissions_hint": windows::window_permission_hint(&error),
                    })
                }
            };
            println!("{}", serde_json::to_string_pretty(&report)?);
            Ok(())
        }
        "setup-window-targeting" => {
            let report = gnome_extension::setup_window_targeting_report().await;
            println!(
                "{}",
                serde_json::to_string_pretty(&report)
                    .context("failed to serialize window targeting setup report")?
            );
            Ok(())
        }
        name => anyhow::bail!("subcommand '{name}' has no handler"),
    }
}

fn abs_test_report(
    landing: abs_pointer::PointerLanding,
    dimensions: (u32, u32),
) -> serde_json::Value {
    serde_json::json!({
        "ok": true,
        "requested_x": landing.requested.0,
        "requested_y": landing.requested.1,
        "x": landing.emitted.0,
        "y": landing.emitted.1,
        "w": dimensions.0,
        "h": dimensions.1
    })
}

/// `parse_invocation` leaves `mcp` positionals as `[ADDR, NAME...]` when `--listen` is given.
fn mcp_listen_config(positionals: &[String]) -> Result<Option<ListenConfig>> {
    let Some((value, allowed_hosts)) = positionals.split_first() else {
        return Ok(None);
    };
    let addr = value
        .parse()
        .with_context(|| format!("invalid listen address {value}"))?;
    let config = ListenConfig {
        addr,
        allowed_hosts: allowed_hosts.to_vec(),
        token: http_listen::load_listen_token()?,
    };
    http_listen::validate_listen(&config, server::shell_execution_enabled())?;
    Ok(Some(config))
}

#[cfg(test)]
mod tests {
    use super::{abs_pointer, abs_test_report, parse_invocation, Invocation};

    fn parse(arguments: &[&str]) -> String {
        let arguments: Vec<String> = arguments.iter().map(|value| value.to_string()).collect();
        match parse_invocation(&arguments) {
            Ok(Invocation::Help(None)) => "help".to_string(),
            Ok(Invocation::Help(Some(subcommand))) => format!("help {}", subcommand.name),
            Ok(Invocation::Run(subcommand, positionals)) => {
                format!("run {} {positionals:?}", subcommand.name)
            }
            Err(error) => format!("error: {}", error.message),
        }
    }

    #[test]
    fn setup_help_names_every_display_only_metadata_field() {
        let details = super::subcommand("setup-window-targeting").unwrap().details;
        // Whole words, so version-name does not count for name.
        let words: Vec<&str> = details
            .split(|c: char| !(c.is_ascii_alphanumeric() || c == '-'))
            .collect();
        for field in super::gnome_extension::DISPLAY_ONLY_METADATA {
            assert!(
                words.contains(field),
                "setup-window-targeting help leaves out {field}"
            );
        }
    }

    #[test]
    fn double_dash_ends_options() {
        assert_eq!(parse(&["state", "--", "--help"]), r#"run state ["--help"]"#);
        assert_eq!(
            parse(&["abs-test", "--", "-5", "7"]),
            r#"run abs-test ["-5", "7"]"#
        );
        assert_eq!(
            parse(&["state", "--", "one", "two"]),
            "error: unexpected argument 'two' for 'state'"
        );
        assert_eq!(parse(&["state", "-h", "--", "x"]), "help state");
        assert_eq!(parse(&["state", "-"]), r#"run state ["-"]"#);
    }

    #[test]
    fn mcp_listen_takes_one_address() {
        assert_eq!(parse(&["mcp"]), "run mcp []");
        assert_eq!(
            parse(&["mcp", "--listen", "127.0.0.1:5200"]),
            r#"run mcp ["127.0.0.1:5200"]"#
        );
        assert_eq!(
            parse(&["mcp", "--listen"]),
            "error: '--listen' needs ADDR:PORT"
        );
        assert_eq!(
            parse(&["mcp", "127.0.0.1:5200"]),
            "error: unexpected argument '127.0.0.1:5200' for 'mcp'"
        );
        assert_eq!(
            parse(&["state", "--listen", "x"]),
            "error: unknown option '--listen' for 'state'"
        );
        assert_eq!(
            parse(&[
                "mcp",
                "--listen",
                "0.0.0.0:5200",
                "--allowed-host",
                "a.svc",
                "--allowed-host",
                "b.svc"
            ]),
            r#"run mcp ["0.0.0.0:5200", "a.svc", "b.svc"]"#
        );
        assert_eq!(
            parse(&["mcp", "--allowed-host", "a.svc"]),
            "error: '--allowed-host' needs --listen"
        );
        assert_eq!(
            parse(&["mcp", "--listen", "127.0.0.1:5200", "--allowed-host"]),
            "error: '--allowed-host' needs NAME"
        );
    }

    #[test]
    fn abs_test_report_distinguishes_requested_and_emitted_coordinates() {
        assert_eq!(
            abs_test_report(
                abs_pointer::PointerLanding {
                    requested: (1920, 1080),
                    emitted: (1919, 1079),
                },
                (1920, 1080)
            ),
            serde_json::json!({
                "ok": true,
                "requested_x": 1920,
                "requested_y": 1080,
                "x": 1919,
                "y": 1079,
                "w": 1920,
                "h": 1080
            })
        );
    }
}

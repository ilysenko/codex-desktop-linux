use crate::server::ComputerUseLinux;
use anyhow::{anyhow, Context, Result};
use rmcp::model::{CallToolResult, ContentBlock};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;
use tokio::time::{sleep, timeout_at, Instant as TokioInstant};

const REPL_WORKER_SCRIPT: &str = include_str!("repl_worker.mjs");
const NODE_BIN_ENV: &str = "CODEX_COMPUTER_USE_NODE_BIN";
const NODE_BIN_ENV_STANDALONE: &str = "COMPUTER_USE_LINUX_NODE_BIN";
const REPL_ENABLE_ENV: &str = "CODEX_COMPUTER_USE_ENABLE_REPL";
const REPL_ENABLE_ENV_STANDALONE: &str = "COMPUTER_USE_LINUX_ENABLE_REPL";
const REPL_ONLY_ENV: &str = "CODEX_COMPUTER_USE_REPL_ONLY";
const REPL_ONLY_ENV_STANDALONE: &str = "COMPUTER_USE_LINUX_REPL_ONLY";
const DEFAULT_JS_TIMEOUT_MS: u64 = 30_000;
const MAX_JS_TIMEOUT_MS: u64 = 120_000;
const MAX_BATCH_STEPS: usize = 100;
const MAX_BATCH_DELAY_MS: u64 = 5_000;
const MAX_SLEEP_MS: u64 = 30_000;
const MAX_ATTACHED_IMAGES: usize = 2;

/// Reads a Codex-named variable, falling back to the standalone name when the
/// Codex name is unset.
fn codex_env(primary: &str, standalone: &str) -> Option<String> {
    codex_first(env::var(primary).ok(), env::var(standalone).ok())
}

fn codex_first(primary: Option<String>, standalone: Option<String>) -> Option<String> {
    primary.or(standalone)
}

/// JavaScript REPL is opt-in (like `run_shell`) via `CODEX_COMPUTER_USE_ENABLE_REPL=1`
/// or `CODEX_COMPUTER_USE_REPL_ONLY=1` on stdio (standalone `COMPUTER_USE_LINUX_*`
/// names are accepted when the Codex name is unset), and is always refused over HTTP.
pub(crate) fn repl_enabled_for_transport(http_transport: bool) -> bool {
    if http_transport {
        return false;
    }
    codex_env(REPL_ENABLE_ENV, REPL_ENABLE_ENV_STANDALONE).as_deref() == Some("1")
        || repl_only_env_set()
}

fn repl_only_env_set() -> bool {
    codex_env(REPL_ONLY_ENV, REPL_ONLY_ENV_STANDALONE).as_deref() == Some("1")
}

pub(crate) fn repl_only_enabled(http_transport: bool) -> bool {
    !http_transport && repl_only_env_set()
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub(crate) struct BatchStep {
    /// Name of a computer-use-linux tool to invoke (e.g. click, type_text, press_key, set_value, scroll, get_app_state, screenshot).
    /// Omit when using `sleep_ms`.
    #[serde(default)]
    pub tool: Option<String>,
    /// JSON object of arguments for `tool`.
    #[serde(default)]
    pub args: Option<Value>,
    /// Pause for this many milliseconds (0 to 30000) instead of calling a tool.
    #[serde(default)]
    pub sleep_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub(crate) struct RunBatchParams {
    /// Ordered list of desktop steps (1 to 100) executed strictly sequentially.
    pub steps: Vec<BatchStep>,
    /// Optional delay in milliseconds inserted between steps (default 0, max 5000).
    #[serde(default)]
    pub delay_ms: Option<u64>,
    /// Stop immediately on the first failed step (default true).
    #[serde(default)]
    pub stop_on_error: Option<bool>,
    /// Automatically pass the latest `snapshot_id` returned by `get_app_state` or `include_tree` to subsequent element-targeted steps that omit `snapshot_id` (default true).
    #[serde(default)]
    pub auto_snapshot_id: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub(crate) struct JsEvalParams {
    /// JavaScript code executed in the persistent desktop REPL worker (opt-in; supports top-level `await`, `return`, `console.log`, `sleep(ms)`, `viewImage(shot)`, and the `desktop` / `cua` handle DSL: `desktop.window(query)`, `win.focus()`, `win.state()`, `win.summary()`, `win.find(matcher)`, `win.waitFor(matcher)`, `win.click(...)`, `win.clickAll(...)`, `win.fillForm(...)`, `win.type(...)`, `win.press(...)`, `win.hotkey(...)`, `win.screenshot()`, plus top-level `desktop.getState()`, `desktop.windows()`, `desktop.focused()`, `desktop.click(x, y)`, `desktop.drag(x1, y1, x2, y2)`, `desktop.screenshot()`, `desktop.help()`).
    pub code: String,
    /// Execution timeout in milliseconds applied across the entire evaluation and its RPCs (default 30000, max 120000).
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize, JsonSchema)]
pub(crate) struct JsResetOutput {
    pub ok: bool,
    pub reset: bool,
    pub worker_was_running: bool,
}

#[derive(Debug, Serialize)]
struct BatchStepSummary {
    step: usize,
    action: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
}

struct ReplWorker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_eval_id: u64,
}

impl Drop for ReplWorker {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

#[derive(Default)]
struct ReplState {
    worker: Option<ReplWorker>,
    had_worker_before: bool,
    restarted_pending: bool,
}

#[derive(Default)]
pub(crate) struct ReplSession {
    state: Mutex<ReplState>,
}

impl ReplSession {
    pub(crate) async fn reset(&self) -> bool {
        let mut guard = self.state.lock().await;
        if let Some(mut worker) = guard.worker.take() {
            let _ = worker.child.kill().await;
            guard.restarted_pending = true;
            return true;
        }
        false
    }

    pub(crate) async fn eval(
        &self,
        server: &ComputerUseLinux,
        params: JsEvalParams,
    ) -> CallToolResult {
        #[cfg(not(test))]
        if !repl_enabled_for_transport(server.is_http_transport()) {
            return CallToolResult::error(vec![ContentBlock::text(
                "js REPL is disabled (opt-in on stdio via CODEX_COMPUTER_USE_ENABLE_REPL=1 or CODEX_COMPUTER_USE_REPL_ONLY=1; always disabled over HTTP).",
            )]);
        }
        #[cfg(test)]
        if server.is_http_transport() {
            return CallToolResult::error(vec![ContentBlock::text(
                "js REPL is disabled over HTTP.",
            )]);
        }

        let code = params.code;
        if code.trim().is_empty() {
            return CallToolResult::error(vec![ContentBlock::text("js requires non-empty code")]);
        }
        let timeout_ms = params
            .timeout_ms
            .unwrap_or(DEFAULT_JS_TIMEOUT_MS)
            .clamp(1_000, MAX_JS_TIMEOUT_MS);

        let mut guard = self.state.lock().await;
        if let Some(existing) = guard.worker.as_mut() {
            if existing.child.try_wait().ok().flatten().is_some() {
                guard.worker = None;
                guard.restarted_pending = true;
            }
        }
        let worker_restarted = if guard.worker.is_none() {
            match spawn_repl_worker() {
                Ok(worker) => {
                    let was_restarted = guard.had_worker_before || guard.restarted_pending;
                    guard.worker = Some(worker);
                    guard.had_worker_before = true;
                    guard.restarted_pending = false;
                    was_restarted
                }
                Err(error) => {
                    return CallToolResult::error(vec![ContentBlock::text(format!(
                        "Failed to start JavaScript REPL worker: {error:#}"
                    ))]);
                }
            }
        } else {
            false
        };

        // Take ownership of the worker before awaiting so cancelling/dropping this future kills
        // the Node process via Drop/kill_on_drop instead of leaving a mid-eval worker reusable.
        let mut worker = guard.worker.take().expect("worker just initialized");
        guard.restarted_pending = true;
        worker.next_eval_id += 1;
        let eval_id = worker.next_eval_id;

        // Enforce the caller's exact deadline across the entire evaluation and all async RPC calls.
        let deadline = TokioInstant::now() + Duration::from_millis(timeout_ms);
        let eval_future = run_eval_loop(
            &mut worker,
            server,
            eval_id,
            &code,
            timeout_ms,
            deadline,
            worker_restarted,
        );
        match timeout_at(deadline, eval_future).await {
            Ok(Ok((result, vm_timed_out))) => {
                if vm_timed_out {
                    let _ = worker.child.kill().await;
                } else {
                    guard.worker = Some(worker);
                    guard.restarted_pending = false;
                }
                result
            }
            Ok(Err(error)) => {
                let _ = worker.child.kill().await;
                CallToolResult::error(vec![ContentBlock::text(format!(
                    "JavaScript REPL worker failed and was reset: {error:#}"
                ))])
            }
            Err(_) => {
                let _ = worker.child.kill().await;
                CallToolResult::error(vec![ContentBlock::text(format!(
                    "JavaScript REPL execution timed out after {timeout_ms}ms; worker was reset."
                ))])
            }
        }
    }
}

fn resolve_node_binary() -> PathBuf {
    if let Some(explicit) = codex_env(NODE_BIN_ENV, NODE_BIN_ENV_STANDALONE) {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    let candidates = [
        env::var("HOME")
            .ok()
            .map(|h| PathBuf::from(h).join(".local/bin/node")),
        Some(PathBuf::from("/home/linuxbrew/.linuxbrew/bin/node")),
        Some(PathBuf::from("/usr/local/bin/node")),
        Some(PathBuf::from("/usr/bin/node")),
    ];
    if let Ok(path_var) = env::var("PATH") {
        for dir in env::split_paths(&path_var) {
            let candidate = dir.join("node");
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    for candidate in candidates.into_iter().flatten() {
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from("node")
}

/// The flag that turns on Node's permission model: `--permission` on Node 22.13+,
/// `--experimental-permission` on Node 20 and early 22, none before that.
fn node_permission_flag(node_bin: &Path) -> Option<&'static str> {
    static CACHED: OnceLock<Option<&'static str>> = OnceLock::new();
    // Only cache for the default lookup; explicit overrides are probed directly.
    let probe = || {
        ["--permission", "--experimental-permission"]
            .into_iter()
            .find(|flag| {
                std::process::Command::new(node_bin)
                    .env_clear()
                    .arg(flag)
                    .arg("-e")
                    .arg("")
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .is_ok_and(|s| s.success())
            })
    };
    if codex_env(NODE_BIN_ENV, NODE_BIN_ENV_STANDALONE).is_some() {
        probe()
    } else {
        *CACHED.get_or_init(probe)
    }
}

fn spawn_repl_worker() -> Result<ReplWorker> {
    let node_bin = resolve_node_binary();
    let mut cmd = Command::new(&node_bin);
    // Clear the ambient environment so REPL scripts never inherit host secrets or NODE_OPTIONS.
    cmd.env_clear();
    // Node's permission model (Node 20+) refuses fs, child_process and workers. Like the flag
    // below, it is a seatbelt against mistakes, not a sandbox for hostile code.
    if let Some(flag) = node_permission_flag(&node_bin) {
        cmd.arg(flag);
    }
    // Defence in depth, not a boundary: js is host code execution at run_shell's trust level.
    // Every host object handed to the vm context (desktop, console, timers, RPC results) exposes
    // the host Function constructor through `.constructor`. This flag makes that constructor throw
    // EvalError, which closes the plain route from a script to `process`.
    cmd.arg("--disallow-code-generation-from-strings");
    let mut child = cmd
        .arg("--input-type=module")
        .arg("-e")
        .arg(REPL_WORKER_SCRIPT)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| {
            format!(
                "could not spawn Node.js binary {:?}; install Node.js 18+ or set {NODE_BIN_ENV}",
                node_bin
            )
        })?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("failed to capture REPL worker stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("failed to capture REPL worker stdout"))?;

    Ok(ReplWorker {
        child,
        stdin,
        stdout: BufReader::new(stdout),
        next_eval_id: 0,
    })
}

async fn write_worker_line(stdin: &mut ChildStdin, payload: &Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(payload)?;
    bytes.push(b'\n');
    stdin.write_all(&bytes).await?;
    stdin.flush().await?;
    Ok(())
}

/// Largest protocol line the worker may send. The worker caps a result's value at 32 KiB and its
/// logs at 128 KiB, and tool arguments are bounded by the tools themselves (type_text takes at most
/// 131071 bytes), so a well-formed line stays far below this. A longer line means the worker is
/// broken; it is reset instead of buffered without bound.
const MAX_WORKER_LINE_BYTES: usize = 4 * 1024 * 1024;

async fn read_worker_line(stdout: &mut BufReader<ChildStdout>, line: &mut Vec<u8>) -> Result<()> {
    line.clear();
    loop {
        let available = stdout.fill_buf().await?;
        if available.is_empty() {
            return Err(anyhow!("REPL worker closed stdout unexpectedly"));
        }
        let (chunk, done) = match available.iter().position(|&b| b == b'\n') {
            Some(pos) => (&available[..pos], Some(pos + 1)),
            None => (available, None),
        };
        if line.len() + chunk.len() > MAX_WORKER_LINE_BYTES {
            return Err(anyhow!(
                "REPL worker sent a line over {MAX_WORKER_LINE_BYTES} bytes"
            ));
        }
        line.extend_from_slice(chunk);
        let consumed = done.unwrap_or(chunk.len());
        stdout.consume(consumed);
        if done.is_some() {
            return Ok(());
        }
    }
}

async fn run_eval_loop(
    worker: &mut ReplWorker,
    server: &ComputerUseLinux,
    eval_id: u64,
    code: &str,
    timeout_ms: u64,
    deadline: TokioInstant,
    worker_restarted: bool,
) -> Result<(CallToolResult, bool)> {
    write_worker_line(
        &mut worker.stdin,
        &json!({
            "type": "eval",
            "id": eval_id,
            "code": code,
            "timeoutMs": timeout_ms,
        }),
    )
    .await?;

    let mut captured_images: Vec<ContentBlock> = Vec::new();
    let mut line = Vec::new();

    loop {
        read_worker_line(&mut worker.stdout, &mut line).await?;
        let msg: Value = serde_json::from_slice(&line)
            .with_context(|| "invalid JSON message from REPL worker")?;
        match msg.get("type").and_then(Value::as_str) {
            Some("rpc") => {
                let rpc_id = msg.get("id").and_then(Value::as_u64).unwrap_or(0);
                let rpc_eval_id = msg.get("eval_id").and_then(Value::as_u64).unwrap_or(0);
                if rpc_eval_id != eval_id {
                    write_worker_line(
                        &mut worker.stdin,
                        &json!({
                            "type": "rpc_result",
                            "id": rpc_id,
                            "ok": false,
                            "error": "stale RPC from a previous evaluation was ignored",
                            "data": {},
                            "image_indices": [],
                        }),
                    )
                    .await?;
                    continue;
                }
                if TokioInstant::now() >= deadline {
                    return Err(anyhow!(
                        "evaluation deadline exceeded before dispatching RPC"
                    ));
                }

                let tool_name = msg.get("tool").and_then(Value::as_str).unwrap_or_default();
                let args = msg.get("args").cloned().unwrap_or_else(|| json!({}));

                let tool_result = server.dispatch_internal_tool(tool_name, args).await;
                let (ok, data, error_text, images) = unpack_tool_result(tool_result);
                let mut image_indices = Vec::with_capacity(images.len());
                for image in images {
                    let idx = captured_images.len();
                    captured_images.push(image);
                    image_indices.push(idx);
                }

                let response = if ok {
                    json!({
                        "type": "rpc_result",
                        "id": rpc_id,
                        "ok": true,
                        "data": data,
                        "image_indices": image_indices,
                    })
                } else {
                    json!({
                        "type": "rpc_result",
                        "id": rpc_id,
                        "ok": false,
                        "error": error_text.unwrap_or_else(|| data.to_string()),
                        "data": data,
                        "image_indices": image_indices,
                    })
                };
                write_worker_line(&mut worker.stdin, &response).await?;
            }
            Some("eval_result") => {
                if msg.get("id").and_then(Value::as_u64) != Some(eval_id) {
                    continue;
                }
                let ok = msg.get("ok").and_then(Value::as_bool).unwrap_or(false);
                let vm_timed_out = msg
                    .get("timed_out")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let attached_indices: Vec<usize> = msg
                    .get("attached_images")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(Value::as_u64)
                            .map(|n| n as usize)
                            .collect()
                    })
                    .unwrap_or_default();

                let mut blocks: Vec<ContentBlock> = Vec::new();
                let keep_start = attached_indices.len().saturating_sub(MAX_ATTACHED_IMAGES);
                let mut attached_count = 0usize;
                for &idx in &attached_indices[keep_start..] {
                    if let Some(img) = captured_images.get(idx) {
                        blocks.push(img.clone());
                        attached_count += 1;
                    }
                }

                let error_value = if vm_timed_out {
                    let base = msg
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("Script execution timed out");
                    Value::String(format!("{base} (worker was reset)"))
                } else {
                    msg.get("error").cloned().unwrap_or(Value::Null)
                };

                let summary = json!({
                    "ok": ok,
                    "value": msg.get("value").cloned().unwrap_or(Value::Null),
                    "error": error_value,
                    "logs": msg.get("logs").cloned().unwrap_or_else(|| json!([])),
                    "calls": msg.get("calls").and_then(Value::as_u64).unwrap_or(0),
                    "snapshot_id": msg.get("snapshot_id").cloned().unwrap_or(Value::Null),
                    "elapsed_ms": msg.get("elapsed_ms").and_then(Value::as_u64).unwrap_or(0),
                    "attached_images": attached_count,
                    "worker_restarted": worker_restarted,
                });
                blocks.push(ContentBlock::text(summary.to_string()));

                let mut result = if ok {
                    CallToolResult::success(blocks)
                } else {
                    CallToolResult::error(blocks)
                };
                result.is_error = Some(!ok);
                return Ok((result, vm_timed_out));
            }
            _ => {}
        }
    }
}

pub(crate) async fn execute_batch(
    server: &ComputerUseLinux,
    params: RunBatchParams,
) -> CallToolResult {
    if params.steps.is_empty() {
        return CallToolResult::error(vec![ContentBlock::text(
            "run_batch requires at least 1 step",
        )]);
    }
    if params.steps.len() > MAX_BATCH_STEPS {
        return CallToolResult::error(vec![ContentBlock::text(format!(
            "run_batch supports at most {MAX_BATCH_STEPS} steps (got {})",
            params.steps.len()
        ))]);
    }
    let delay_ms = params.delay_ms.unwrap_or(0).min(MAX_BATCH_DELAY_MS);
    let stop_on_error = params.stop_on_error.unwrap_or(true);
    let auto_snapshot_id = params.auto_snapshot_id.unwrap_or(true);

    let started = Instant::now();
    let total_steps = params.steps.len();
    let mut results = Vec::with_capacity(total_steps);
    let mut captured_images: Vec<ContentBlock> = Vec::new();
    let mut latest_snapshot_id: Option<String> = None;
    let mut all_ok = true;

    for (idx, step) in params.steps.into_iter().enumerate() {
        let has_tool = step
            .tool
            .as_deref()
            .map(str::trim)
            .is_some_and(|s| !s.is_empty());
        if has_tool && step.sleep_ms.is_some() {
            all_ok = false;
            results.push(BatchStepSummary {
                step: idx,
                action: "invalid".to_string(),
                ok: false,
                error: Some(
                    "step cannot set both `tool` and `sleep_ms`; put `sleep_ms` in a separate step"
                        .to_string(),
                ),
                result: None,
            });
            if stop_on_error {
                break;
            }
            continue;
        }

        if let Some(ms) = step.sleep_ms {
            let clamped = ms.min(MAX_SLEEP_MS);
            sleep(Duration::from_millis(clamped)).await;
            results.push(BatchStepSummary {
                step: idx,
                action: format!("sleep({clamped}ms)"),
                ok: true,
                error: None,
                result: None,
            });
            continue;
        }

        let Some(tool_name) = step
            .tool
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            all_ok = false;
            results.push(BatchStepSummary {
                step: idx,
                action: "invalid".to_string(),
                ok: false,
                error: Some("step must set either `tool` or `sleep_ms`".to_string()),
                result: None,
            });
            if stop_on_error {
                break;
            }
            continue;
        };

        let mut args = step.args.unwrap_or_else(|| json!({}));
        if auto_snapshot_id {
            if tool_name == "get_tree_page" {
                // A page always reads a snapshot, and over HTTP it must name one; the batch's
                // own snapshot cannot be named by the caller in advance.
                if let (Some(obj), Some(snapshot_id)) =
                    (args.as_object_mut(), latest_snapshot_id.as_deref())
                {
                    obj.entry("snapshot_id")
                        .or_insert_with(|| Value::String(snapshot_id.to_string()));
                }
            } else {
                inject_snapshot_id(&mut args, latest_snapshot_id.as_deref());
            }
        }

        let call_result = server.dispatch_internal_tool(tool_name, args).await;
        let (mut ok, data, mut error_text, images) = unpack_tool_result(call_result);
        // A refused or empty page carries no snapshot_id and no ok=false.
        if ok && tool_name == "get_tree_page" && data.get("snapshot_id").is_none_or(Value::is_null)
        {
            ok = false;
            error_text = data
                .get("message")
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .or_else(|| Some("get_tree_page returned no snapshot".to_string()));
        }

        if let Some(snap) = data
            .get("snapshot_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            latest_snapshot_id = Some(snap.to_string());
        }
        captured_images.extend(images);

        let compact_result = compact_step_data(tool_name, &data);
        results.push(BatchStepSummary {
            step: idx,
            action: tool_name.to_string(),
            ok,
            error: if ok { None } else { error_text },
            result: Some(compact_result),
        });

        if !ok {
            all_ok = false;
            if stop_on_error {
                break;
            }
        }

        if delay_ms > 0 && idx + 1 < total_steps {
            sleep(Duration::from_millis(delay_ms)).await;
        }
    }

    fit_batch_results(&mut results, latest_snapshot_id.as_deref());

    let mut blocks: Vec<ContentBlock> = Vec::new();
    let keep_start = captured_images.len().saturating_sub(MAX_ATTACHED_IMAGES);
    for img in captured_images.into_iter().skip(keep_start) {
        blocks.push(img);
    }

    let summary = json!({
        "ok": all_ok,
        "completed_steps": results.len(),
        "total_steps": total_steps,
        "elapsed_ms": started.elapsed().as_millis() as u64,
        "snapshot_id": latest_snapshot_id,
        "results": results,
    });
    blocks.push(ContentBlock::text(summary.to_string()));

    let mut out = if all_ok {
        CallToolResult::success(blocks)
    } else {
        CallToolResult::error(blocks)
    };
    out.is_error = Some(!all_ok);
    out
}

fn inject_snapshot_id(args: &mut Value, snapshot_id: Option<&str>) {
    let Some(snapshot_id) = snapshot_id else {
        return;
    };
    let Some(obj) = args.as_object_mut() else {
        return;
    };
    if obj.contains_key("snapshot_id") {
        return;
    }
    let has_element_target = obj.contains_key("element_index")
        || obj.contains_key("element_identifier")
        || obj.contains_key("role")
        || obj.contains_key("name")
        || obj.contains_key("text")
        || obj
            .get("states")
            .and_then(Value::as_array)
            .is_some_and(|a| !a.is_empty());
    if has_element_target {
        obj.insert(
            "snapshot_id".to_string(),
            Value::String(snapshot_id.to_string()),
        );
    }
}

/// Tree fields a step result can carry: get_app_state and include_tree use
/// `accessibility_tree`, get_tree_page uses `nodes`.
const BATCH_TREE_KEYS: [&str; 2] = ["accessibility_tree", "nodes"];

/// Replace a step's tree with its node count. Returns whether it had one.
fn omit_step_tree(result: &mut Value) -> bool {
    let Some(obj) = result.as_object_mut() else {
        return false;
    };
    let mut omitted = false;
    for key in BATCH_TREE_KEYS {
        if let Some(tree) = obj.remove(key) {
            let count = tree.as_array().map_or(0, Vec::len);
            obj.insert(format!("{key}_omitted_nodes"), json!(count));
            omitted = true;
        }
    }
    omitted
}

/// Fit the step results to the inline budget every other tool result is held
/// to. A tree whose snapshot a later step replaced cannot be acted on any
/// more, so it becomes a node count. Trees of the final snapshot (the last
/// get_app_state and its get_tree_page pages) stay while they fit; past the
/// budget they go oldest first (the snapshot_id stays, so get_tree_page can
/// page them again), and then the oldest step results shrink to their byte
/// count, keeping each step's ok and error.
fn fit_batch_results(results: &mut [BatchStepSummary], final_snapshot: Option<&str>) {
    let fits = |results: &[BatchStepSummary]| {
        serde_json::to_vec(results).map_or(true, |bytes| {
            // Room for the summary's own fields around the results.
            bytes.len() + 512 <= crate::tree_spill::INLINE_RESULT_BYTES
        })
    };
    let has_tree = |result: &Value| {
        result
            .as_object()
            .is_some_and(|obj| BATCH_TREE_KEYS.iter().any(|key| obj.contains_key(*key)))
    };
    for step in results.iter_mut() {
        if let Some(result) = step.result.as_mut() {
            let snapshot = result.get("snapshot_id").and_then(Value::as_str);
            if has_tree(result) && (final_snapshot.is_none() || snapshot != final_snapshot) {
                omit_step_tree(result);
            }
        }
    }
    for idx in 0..results.len() {
        if fits(results) {
            return;
        }
        if let Some(result) = results[idx].result.as_mut() {
            omit_step_tree(result);
        }
    }
    for idx in 0..results.len() {
        if fits(results) {
            return;
        }
        if let Some(result) = results[idx].result.take() {
            let bytes = serde_json::to_vec(&result).map_or(0, |bytes| bytes.len());
            results[idx].result = Some(json!({ "omitted_bytes": bytes }));
        }
    }
}

fn compact_step_data(tool: &str, data: &Value) -> Value {
    let Some(obj) = data.as_object() else {
        return data.clone();
    };
    if matches!(
        tool,
        "get_app_state"
            | "list_windows"
            | "focused_window"
            | "list_apps"
            | "screenshot"
            | "get_tree_page"
            | "doctor"
    ) {
        return data.clone();
    }
    let mut slim = serde_json::Map::new();
    for key in [
        "ok",
        "action",
        "message",
        "error",
        "verified",
        "snapshot_id",
        "screenshot",
        "screenshot_error",
        "accessibility_tree",
        "accessibility_tree_raw_count",
        "accessibility_tree_truncated",
        "accessibility_tree_spill",
        "accessibility_tree_partial",
        "tree_scoped",
        "accessibility_error",
        "focused_element",
        "background",
        "focus",
        "window",
    ] {
        if let Some(val) = obj.get(key) {
            if !val.is_null() {
                slim.insert(key.to_string(), val.clone());
            }
        }
    }
    if slim.is_empty() {
        data.clone()
    } else {
        Value::Object(slim)
    }
}

/// Unpack a tool result for composed execution (`run_batch` / `js`).
/// Any `ok == false` (including the one-time background `retry_to_continue` notice, where no input
/// was actually dispatched) is treated as unsuccessful so sequences stop instead of continuing on
/// unsent input.
pub(crate) fn unpack_tool_result(
    result: CallToolResult,
) -> (bool, Value, Option<String>, Vec<ContentBlock>) {
    let mut images = Vec::new();
    let mut text_parts = Vec::new();

    for block in &result.content {
        match block {
            ContentBlock::Image(_) => images.push(block.clone()),
            ContentBlock::Text(text) => text_parts.push(text.text.clone()),
            _ => {}
        }
    }

    let data = if let Some(structured) = result.structured_content {
        structured
    } else if text_parts.len() == 1 {
        serde_json::from_str::<Value>(&text_parts[0])
            .unwrap_or_else(|_| Value::String(text_parts[0].clone()))
    } else if text_parts.is_empty() {
        json!({})
    } else {
        let joined = text_parts.join("\n");
        serde_json::from_str::<Value>(&joined).unwrap_or(Value::String(joined))
    };

    let explicit_error = result.is_error == Some(true);
    let data_ok_false = data.get("ok").and_then(Value::as_bool) == Some(false);
    let ok = !explicit_error && !data_ok_false;
    let error_text = if ok {
        None
    } else {
        data.get("error")
            .and_then(Value::as_str)
            .or_else(|| data.get("message").and_then(Value::as_str))
            .map(ToString::to_string)
            .or_else(|| (!text_parts.is_empty()).then(|| text_parts.join("\n")))
    };

    (ok, data, error_text, images)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repl_env_prefers_codex_names_and_accepts_standalone_aliases() {
        let some = |value: &str| Some(value.to_string());
        assert_eq!(codex_first(some("1"), None), some("1"));
        assert_eq!(codex_first(None, some("1")), some("1"));
        // A Codex name that is set wins, even when it turns the REPL off.
        assert_eq!(codex_first(some("0"), some("1")), some("0"));
        assert_eq!(codex_first(None, None), None);
        assert_eq!(REPL_ENABLE_ENV, "CODEX_COMPUTER_USE_ENABLE_REPL");
        assert_eq!(REPL_ONLY_ENV, "CODEX_COMPUTER_USE_REPL_ONLY");
        assert_eq!(NODE_BIN_ENV, "CODEX_COMPUTER_USE_NODE_BIN");
    }

    #[tokio::test]
    async fn run_batch_rejects_empty_and_disallowed_tools() {
        let server = ComputerUseLinux::default();
        let empty = execute_batch(
            &server,
            RunBatchParams {
                steps: vec![],
                delay_ms: None,
                stop_on_error: None,
                auto_snapshot_id: None,
            },
        )
        .await;
        assert_eq!(empty.is_error, Some(true));

        let disallowed = execute_batch(
            &server,
            RunBatchParams {
                steps: vec![BatchStep {
                    tool: Some("run_shell".to_string()),
                    args: Some(json!({"command": "echo hi"})),
                    sleep_ms: None,
                }],
                delay_ms: None,
                stop_on_error: Some(true),
                auto_snapshot_id: Some(true),
            },
        )
        .await;
        assert_eq!(disallowed.is_error, Some(true));
        let (ok, data, _, _) = unpack_tool_result(disallowed);
        assert!(!ok);
        assert!(data["results"][0]["error"]
            .as_str()
            .unwrap_or_default()
            .contains("not callable"));
    }

    #[tokio::test]
    async fn run_batch_cannot_reach_js_run_shell_or_itself() {
        let server = ComputerUseLinux::default();
        for tool in [
            "js",
            "js_reset",
            "run_shell",
            "run_batch",
            "complete_interaction",
        ] {
            let res = execute_batch(
                &server,
                RunBatchParams {
                    steps: vec![BatchStep {
                        tool: Some(tool.to_string()),
                        args: Some(json!({ "code": "1", "command": "true", "steps": [] })),
                        sleep_ms: None,
                    }],
                    delay_ms: None,
                    stop_on_error: Some(true),
                    auto_snapshot_id: Some(true),
                },
            )
            .await;
            let (ok, data, _, _) = unpack_tool_result(res);
            assert!(!ok, "run_batch ran {tool}: {data}");
            assert!(
                data["results"][0]["error"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("not callable from run_batch or js"),
                "{tool}: {data}"
            );
        }
    }

    #[test]
    fn batch_results_drop_replaced_trees_and_fit_the_inline_budget() {
        let tree = |n: usize, snapshot: &str| {
            json!({
                "snapshot_id": snapshot,
                "accessibility_tree": (0..n)
                    .map(|i| json!({ "index": i, "role": "push button", "name": format!("Button {i:05}") }))
                    .collect::<Vec<_>>()
            })
        };
        let step = |step: usize, result: Value| BatchStepSummary {
            step,
            action: "get_app_state".to_string(),
            ok: true,
            error: None,
            result: Some(result),
        };
        // A tree whose snapshot was replaced becomes a count; trees of the final
        // snapshot (a get_app_state and its page) stay whole while they fit.
        let mut results = vec![
            step(0, tree(3, "old")),
            step(1, tree(2, "new")),
            step(
                2,
                json!({ "snapshot_id": "new", "nodes": [{ "index": 9 }] }),
            ),
            step(3, json!({ "ok": true })),
        ];
        fit_batch_results(&mut results, Some("new"));
        let first = results[0].result.as_ref().unwrap();
        assert!(first.get("accessibility_tree").is_none());
        assert_eq!(first["accessibility_tree_omitted_nodes"], 3);
        assert_eq!(
            results[1].result.as_ref().unwrap()["accessibility_tree"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(results[2].result.as_ref().unwrap()["nodes"][0]["index"], 9);
        // Many near-budget trees of one snapshot: the whole result fits the inline budget.
        let mut results: Vec<_> = (0..100).map(|i| step(i, tree(500, "same"))).collect();
        fit_batch_results(&mut results, Some("same"));
        let bytes = serde_json::to_vec(&results).unwrap().len();
        assert!(
            bytes + 512 <= crate::tree_spill::INLINE_RESULT_BYTES,
            "batch result is {bytes} bytes"
        );
        assert_eq!(results.len(), 100);
        assert!(results.iter().all(|step| step.ok));
    }

    #[tokio::test]
    async fn run_batch_executes_sleep_steps_in_order() {
        let server = ComputerUseLinux::default();
        let res = execute_batch(
            &server,
            RunBatchParams {
                steps: vec![
                    BatchStep {
                        tool: None,
                        args: None,
                        sleep_ms: Some(10),
                    },
                    BatchStep {
                        tool: None,
                        args: None,
                        sleep_ms: Some(10),
                    },
                ],
                delay_ms: Some(0),
                stop_on_error: Some(true),
                auto_snapshot_id: Some(true),
            },
        )
        .await;
        let (ok, data, _, _) = unpack_tool_result(res);
        assert!(ok, "unexpected batch failure: {data}");
        assert_eq!(data["completed_steps"], 2);
        assert_eq!(data["total_steps"], 2);
    }

    #[test]
    fn unpack_treats_background_retry_notice_as_failure_and_compact_preserves_post_action_tree() {
        let notice = CallToolResult::structured(json!({
            "ok": false,
            "message": "Not sent: no background route. Repeat the call to use focused input.",
            "background": { "used": false, "retry_to_continue": true }
        }));
        let (ok, _, error_text, _) = unpack_tool_result(notice);
        assert!(!ok);
        assert!(error_text.unwrap_or_default().contains("Not sent"));

        let with_tree = json!({
            "ok": true,
            "action": "click",
            "snapshot_id": "abc-2",
            "accessibility_tree": [{"index": 1, "role": "push button", "name": "OK"}],
            "accessibility_tree_raw_count": 1,
            "accessibility_tree_truncated": false,
            "tree_scoped": true,
            "received": {"x": 10, "y": 10}
        });
        let compacted = compact_step_data("click", &with_tree);
        assert!(compacted.get("accessibility_tree").is_some());
        assert_eq!(compacted["accessibility_tree_raw_count"], 1);
        assert_eq!(compacted["tree_scoped"], true);
        assert!(compacted.get("received").is_none());
    }

    #[tokio::test]
    async fn js_repl_persists_multiple_and_destructured_bindings_and_handles_one_line_statements() {
        let server = ComputerUseLinux::default();
        let session = ReplSession::default();

        // One-line multi-statement without trailing semicolon, multiple declarators, and destructuring.
        let first = session
            .eval(
                &server,
                JsEvalParams {
                    code: "const a = 10, b = 20; const { c } = { c: 12 }; console.log('sum', a + b + c)".to_string(),
                    timeout_ms: Some(5_000),
                },
            )
            .await;
        let (ok, data, _, _) = unpack_tool_result(first);
        assert!(ok, "first js eval failed: {data}");
        assert_eq!(data["logs"][0], "sum 42");
        assert_eq!(data["worker_restarted"], false);

        // Template string with `const fake = 1` at column 0 must not be rewritten.
        let second = session
            .eval(
                &server,
                JsEvalParams {
                    code: "const msg = `line1\nconst fake = 1`;\nreturn { sum: a + b + c, msg };"
                        .to_string(),
                    timeout_ms: Some(5_000),
                },
            )
            .await;
        let (ok, data, _, _) = unpack_tool_result(second);
        assert!(ok, "second js eval failed: {data}");
        assert_eq!(data["value"]["sum"], 42);
        assert_eq!(data["value"]["msg"], "line1\nconst fake = 1");

        // Reset clears state and marks next eval with worker_restarted=true.
        assert!(session.reset().await);
        let third = session
            .eval(
                &server,
                JsEvalParams {
                    code: "return typeof a;".to_string(),
                    timeout_ms: Some(5_000),
                },
            )
            .await;
        let (ok, data, _, _) = unpack_tool_result(third);
        assert!(ok, "third js eval failed: {data}");
        assert_eq!(data["value"], "undefined");
        assert_eq!(data["worker_restarted"], true);
    }

    #[tokio::test]
    async fn js_repl_resets_worker_on_sync_timeout_and_enforces_async_deadline() {
        let server = ComputerUseLinux::default();
        let session = ReplSession::default();

        // Mutate state then hit synchronous VM timeout: worker MUST reset so `dirty` is cleared.
        let sync_timeout = session
            .eval(
                &server,
                JsEvalParams {
                    code: "globalThis.dirty = 123; while (true) {}".to_string(),
                    timeout_ms: Some(1_000),
                },
            )
            .await;
        assert_eq!(sync_timeout.is_error, Some(true));

        let after_sync = session
            .eval(
                &server,
                JsEvalParams {
                    code: "return { dirtyType: typeof dirty };".to_string(),
                    timeout_ms: Some(5_000),
                },
            )
            .await;
        let (ok, data, _, _) = unpack_tool_result(after_sync);
        assert!(ok, "post-sync-timeout recovery failed: {data}");
        assert_eq!(data["value"]["dirtyType"], "undefined");
        assert_eq!(data["worker_restarted"], true);

        // Async sleep exceeding timeout_ms must time out at the exact deadline (not +2s).
        let started = Instant::now();
        let async_timeout = session
            .eval(
                &server,
                JsEvalParams {
                    code: "await sleep(2500); return 'too-late';".to_string(),
                    timeout_ms: Some(1_000),
                },
            )
            .await;
        assert_eq!(async_timeout.is_error, Some(true));
        assert!(
            started.elapsed() < Duration::from_millis(2_000),
            "async deadline was not enforced promptly: {:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn js_repl_cancels_surviving_timers_and_survives_unhandled_rejections() {
        let server = ComputerUseLinux::default();
        let session = ReplSession::default();

        // Schedule a timer in eval 1 and leave an un-awaited rejected RPC promise; neither may crash
        // the worker or fire during eval 2.
        let eval1 = session
            .eval(
                &server,
                JsEvalParams {
                    code: r#"
globalThis.timerFired = false;
setTimeout(() => { globalThis.timerFired = true; }, 80);
desktop.call("run_shell", { command: "echo nope" });
return "done1";
"#
                    .to_string(),
                    timeout_ms: Some(5_000),
                },
            )
            .await;
        let (ok, data, _, _) = unpack_tool_result(eval1);
        assert!(ok, "eval1 failed: {data}");

        let eval2 = session
            .eval(
                &server,
                JsEvalParams {
                    code: "await sleep(160); return { timerFired: globalThis.timerFired };"
                        .to_string(),
                    timeout_ms: Some(5_000),
                },
            )
            .await;
        let (ok, data, _, _) = unpack_tool_result(eval2);
        assert!(ok, "eval2 failed: {data}");
        assert_eq!(data["value"]["timerFired"], false);
        assert_eq!(data["worker_restarted"], false);
    }

    #[tokio::test]
    async fn js_repl_cannot_reach_host_realm_through_injected_objects() {
        let server = ComputerUseLinux::default();
        let session = ReplSession::default();

        // Every injected host object exposes the host Function constructor through
        // `.constructor`. The worker runs with --disallow-code-generation-from-strings, so
        // each route must throw EvalError instead of returning the host `process`.
        let eval = session
            .eval(
                &server,
                JsEvalParams {
                    code: r#"
const routes = {
  consoleLog: () => console.log.constructor("return process")(),
  method: () => desktop.help.constructor("return process")(),
  asyncCtor: () => desktop.doctor.constructor("return process"),
  timer: () => setTimeout.constructor("return process")(),
  hostClass: () => URL.constructor("return process")(),
  objectProto: () => desktop.constructor.constructor("return process")(),
};
const out = {};
for (const [name, route] of Object.entries(routes)) {
  try {
    const value = route();
    out[name] = typeof value === "object" && value !== null && "env" in value ? "process" : typeof value;
  } catch (e) {
    out[name] = e && e.name;
  }
}
return out;
"#
                    .to_string(),
                    timeout_ms: Some(5_000),
                },
            )
            .await;
        let (ok, data, _, _) = unpack_tool_result(eval);
        assert!(ok, "host-realm probe failed: {data}");
        for route in [
            "consoleLog",
            "method",
            "asyncCtor",
            "timer",
            "hostClass",
            "objectProto",
        ] {
            assert_eq!(
                data["value"][route], "EvalError",
                "route {route} reached the host realm: {data}"
            );
        }
    }

    #[tokio::test]
    async fn js_repl_click_all_and_fill_form_honor_stop_on_error_false_and_reject_ambiguous_strings(
    ) {
        let server = ComputerUseLinux::default();
        let session = ReplSession::default();

        // clickAll with stopOnError: false records failures and continues across all targets.
        let eval = session
            .eval(
                &server,
                JsEvalParams {
                    code: r#"
const res = await desktop.clickAll(
  [{ element_index: 999999 }, { element_index: 999998 }],
  { stopOnError: false }
);
const formRes = await desktop.fillForm(
  [
    { mode: "type", element_index: 999999, value: "a" },
    { mode: "set_value", element_index: 999998, value: "b" }
  ],
  { stopOnError: false }
);
return {
  clickOk: res.ok,
  clickCompleted: res.completed,
  clickResultsLen: res.results.length,
  formOk: formRes.ok,
  formCompleted: formRes.completed,
  formResultsLen: formRes.results.length,
};
"#
                    .to_string(),
                    timeout_ms: Some(5_000),
                },
            )
            .await;
        let (ok, data, _, _) = unpack_tool_result(eval);
        assert!(ok, "stopOnError test failed: {data}");
        assert_eq!(data["value"]["clickOk"], false);
        assert_eq!(data["value"]["clickCompleted"], 2);
        assert_eq!(data["value"]["clickResultsLen"], 2);
        assert_eq!(data["value"]["formOk"], false);
        assert_eq!(data["value"]["formCompleted"], 2);
        assert_eq!(data["value"]["formResultsLen"], 2);
    }

    #[tokio::test]
    async fn js_repl_rpc_blocks_run_shell_and_exposes_desktop_handle_dsl() {
        let server = ComputerUseLinux::default();
        let session = ReplSession::default();

        let eval = session
            .eval(
                &server,
                JsEvalParams {
                    code: r#"
let blockedErr = null;
try {
  await desktop.call("run_shell", { command: "echo nope" });
} catch (err) {
  blockedErr = String(err.message || err);
}
const tree = {
  snapshot_id: "snap-1",
  accessibility_tree: [
    { index: 4, role: "push button", name: "Submit", actions: ["click"] },
    { index: 5, role: "text", name: "Email", actions: [] },
  ]
};
const btn = desktop.find(tree, { exactName: "Submit", exactRole: "push button" });
return {
  blockedErr,
  sameAlias: desktop === cua,
  hasWindowHelper: typeof desktop.window === "function",
  hasGetState: typeof desktop.getState === "function",
  hasHotkey: typeof desktop.hotkey === "function",
  hasViewImage: typeof viewImage === "function",
  btnIndex: btn?.index,
  btnCanClick: typeof btn?.click === "function",
  btnCanSetValue: typeof btn?.setValue === "function",
  btnJsonName: JSON.parse(JSON.stringify(btn)).name,
};
"#
                    .to_string(),
                    timeout_ms: Some(5_000),
                },
            )
            .await;
        let (ok, data, _, _) = unpack_tool_result(eval);
        assert!(ok, "handle DSL test failed: {data}");
        assert!(data["value"]["blockedErr"]
            .as_str()
            .unwrap_or_default()
            .contains("not callable"));
        assert_eq!(data["value"]["sameAlias"], true);
        assert_eq!(data["value"]["hasWindowHelper"], true);
        assert_eq!(data["value"]["hasGetState"], true);
        assert_eq!(data["value"]["hasHotkey"], true);
        assert_eq!(data["value"]["hasViewImage"], true);
        assert_eq!(data["value"]["btnIndex"], 4);
        assert_eq!(data["value"]["btnCanClick"], true);
        assert_eq!(data["value"]["btnCanSetValue"], true);
        assert_eq!(data["value"]["btnJsonName"], "Submit");
    }

    #[tokio::test]
    async fn run_batch_stops_on_error_and_respects_stop_on_error_false() {
        let server = ComputerUseLinux::default();
        let stopped = execute_batch(
            &server,
            RunBatchParams {
                steps: vec![
                    BatchStep {
                        tool: Some("run_shell".to_string()),
                        args: Some(json!({})),
                        sleep_ms: None,
                    },
                    BatchStep {
                        tool: None,
                        args: None,
                        sleep_ms: Some(5),
                    },
                ],
                delay_ms: Some(0),
                stop_on_error: Some(true),
                auto_snapshot_id: Some(true),
            },
        )
        .await;
        let (ok, data, _, _) = unpack_tool_result(stopped);
        assert!(!ok);
        assert_eq!(data["completed_steps"], 1);
        assert_eq!(data["total_steps"], 2);

        let continued = execute_batch(
            &server,
            RunBatchParams {
                steps: vec![
                    BatchStep {
                        tool: Some("run_shell".to_string()),
                        args: Some(json!({})),
                        sleep_ms: None,
                    },
                    BatchStep {
                        tool: None,
                        args: None,
                        sleep_ms: Some(5),
                    },
                ],
                delay_ms: Some(0),
                stop_on_error: Some(false),
                auto_snapshot_id: Some(true),
            },
        )
        .await;
        let (ok, data, _, _) = unpack_tool_result(continued);
        assert!(!ok);
        assert_eq!(data["completed_steps"], 2);
        assert_eq!(data["results"][1]["ok"], true);
    }

    #[tokio::test]
    async fn http_transport_blocks_screenshot_file_path_inside_batch_and_never_exposes_repl() {
        let mut server = ComputerUseLinux::default();
        server.set_http_transport_for_test(true);

        // Over HTTP, js/js_reset are never exposed, and instructions do not advertise `js`.
        let tools = server.mcp_tool_router_for_test().list_all();
        assert!(!tools.iter().any(|t| t.name == "js"));
        assert!(!tools.iter().any(|t| t.name == "js_reset"));
        assert!(tools.iter().any(|t| t.name == "run_batch"));
        let info = rmcp::ServerHandler::get_info(&server);
        assert!(!info
            .instructions
            .as_deref()
            .unwrap_or_default()
            .contains("prefer `js`"));

        let refused = execute_batch(
            &server,
            RunBatchParams {
                steps: vec![BatchStep {
                    tool: Some("screenshot".to_string()),
                    args: Some(json!({ "screenshot_file_path": "/tmp/should-not-write.png" })),
                    sleep_ms: None,
                }],
                delay_ms: None,
                stop_on_error: Some(true),
                auto_snapshot_id: Some(true),
            },
        )
        .await;
        let (ok, data, _, _) = unpack_tool_result(refused);
        assert!(!ok);
        assert!(data["results"][0]["error"]
            .as_str()
            .unwrap_or_default()
            .contains("was not run"));
    }

    #[tokio::test]
    async fn repl_only_mode_exposes_only_js_and_js_reset_and_supports_summary_and_help() {
        let server = ComputerUseLinux::default();
        let router = server.router_for_test(false, true, true);
        let mut names: Vec<String> = router
            .list_all()
            .into_iter()
            .map(|t| t.name.to_string())
            .collect();
        names.sort();
        assert_eq!(names, vec!["js".to_string(), "js_reset".to_string()]);

        let session = ReplSession::default();
        let eval = session
            .eval(
                &server,
                JsEvalParams {
                    code: r#"
const helpText = desktop.help();
const tree = {
  accessibility_tree: [
    { index: 2, role: "push button", name: "7", actions: ["click"] },
    { index: 5, role: "text", name: "Display", text: { character_count: 5, content: "Saved", truncated: false }, states: ["editable"] },
    { index: 6, role: "label", name: "Empty", text: { character_count: 0 } },
  ]
};
const lines = desktop.summary(tree);
const byString = desktop.find(tree, "Saved");
const byText = desktop.find(tree, { text: "Saved" });
const bogusObjectMatch = desktop.find(tree, "object");
return {
  hasHelp: helpText.includes("desktop.window") && helpText.includes("setupAccessibility") && helpText.includes("setupWindowTargeting"),
  hasSetupHelpers: typeof desktop.setupAccessibility === "function" && typeof desktop.setupWindowTargeting === "function",
  lines,
  byStringIndex: byString?.index ?? null,
  byTextIndex: byText?.index ?? null,
  bogusObjectMatch: bogusObjectMatch?.index ?? null,
};
"#
                    .to_string(),
                    timeout_ms: Some(5_000),
                },
            )
            .await;
        let (ok, data, _, _) = unpack_tool_result(eval);
        assert!(ok, "repl_only helper eval failed: {data}");
        assert_eq!(data["value"]["hasHelp"], true);
        assert_eq!(data["value"]["hasSetupHelpers"], true);
        assert_eq!(data["value"]["lines"][0], "[2] push button \"7\" [click]");
        assert_eq!(
            data["value"]["lines"][1],
            "[5] text \"Display\" text=\"Saved\" (editable)"
        );
        assert_eq!(data["value"]["lines"][2], "[6] label \"Empty\"");
        assert_eq!(data["value"]["byStringIndex"], 5);
        assert_eq!(data["value"]["byTextIndex"], 5);
        assert_eq!(data["value"]["bogusObjectMatch"], Value::Null);
    }

    #[tokio::test]
    async fn js_repl_persists_lone_function_class_and_bindings_after_regex_literals() {
        let server = ComputerUseLinux::default();
        let session = ReplSession::default();

        // Lone function declaration (no trailing semicolon) must persist across turns.
        let r1 = session
            .eval(
                &server,
                JsEvalParams {
                    code: "function add(a, b) { return a + b }".to_string(),
                    timeout_ms: Some(5_000),
                },
            )
            .await;
        assert!(unpack_tool_result(r1).0);

        // Lone async function and generator declarations must persist across turns.
        let r2 = session
            .eval(
                &server,
                JsEvalParams {
                    code: "async function mul(a, b) { return a * b }".to_string(),
                    timeout_ms: Some(5_000),
                },
            )
            .await;
        assert!(unpack_tool_result(r2).0);

        let r2b = session
            .eval(
                &server,
                JsEvalParams {
                    code: "function* seq() { yield 10; yield 20; }".to_string(),
                    timeout_ms: Some(5_000),
                },
            )
            .await;
        assert!(unpack_tool_result(r2b).0);

        // Lone class declaration must persist across turns.
        let r3 = session
            .eval(
                &server,
                JsEvalParams {
                    code: "class Box { constructor(v) { this.v = v; } }".to_string(),
                    timeout_ms: Some(5_000),
                },
            )
            .await;
        assert!(unpack_tool_result(r3).0);

        // Regex literals containing `//` and quotes must not break depth tracking for later bindings.
        let r4 = session
            .eval(
                &server,
                JsEvalParams {
                    code: r#"
const urls = ["https://example.com", "plain"].filter((u) => /^https?:\/\//.test(u));
const quoteRe = /["'`]/;
const ratio = (10 + 2) / 3;
const afterRegex = urls.length + (quoteRe.test("'") ? 1 : 0) + ratio;
"#
                    .to_string(),
                    timeout_ms: Some(5_000),
                },
            )
            .await;
        assert!(unpack_tool_result(r4).0);

        let verify = session
            .eval(
                &server,
                JsEvalParams {
                    code: "return { sum: add(2, 3), prod: await mul(4, 5), gen: [...seq()], boxed: new Box(7).v, afterRegex };"
                        .to_string(),
                    timeout_ms: Some(5_000),
                },
            )
            .await;
        let (ok, data, _, _) = unpack_tool_result(verify);
        assert!(ok, "verification eval failed: {data}");
        assert_eq!(data["value"]["sum"], 5);
        assert_eq!(data["value"]["prod"], 20);
        assert_eq!(data["value"]["gen"], json!([10, 20]));
        assert_eq!(data["value"]["boxed"], 7);
        assert_eq!(data["value"]["afterRegex"], 6);
    }

    #[tokio::test]
    async fn run_batch_rejects_step_setting_both_tool_and_sleep_ms() {
        let server = ComputerUseLinux::default();
        let res = execute_batch(
            &server,
            RunBatchParams {
                steps: vec![
                    BatchStep {
                        tool: Some("doctor".to_string()),
                        args: Some(json!({})),
                        sleep_ms: Some(0),
                    },
                    BatchStep {
                        tool: None,
                        args: None,
                        sleep_ms: Some(5),
                    },
                ],
                delay_ms: Some(0),
                stop_on_error: Some(true),
                auto_snapshot_id: Some(true),
            },
        )
        .await;
        assert_eq!(res.is_error, Some(true));
        let (ok, data, _, _) = unpack_tool_result(res);
        assert!(!ok);
        assert_eq!(data["completed_steps"], 1);
        assert!(data["results"][0]["error"]
            .as_str()
            .unwrap_or_default()
            .contains("cannot set both"));
    }

    #[tokio::test]
    async fn js_repl_string_click_rejects_ambiguity_and_scopes_tree_cache_by_window() {
        let mut worker = spawn_repl_worker().expect("spawn repl worker");
        let eval_req = json!({
            "type": "eval",
            "id": 1,
            "code": r#"
await desktop.getAppState({ window_id: 10 });
let ambigErr = null;
try {
  await desktop.click("Close", { window_id: 10 });
} catch (err) {
  ambigErr = String(err.message || err);
}
const uniqueClick = await desktop.click("Save", { window_id: 10 });
const otherWinClick = await desktop.click("Save", { window_id: 20 });
return { ambigErr, uniqueClick, otherWinClick };
"#,
            "timeoutMs": 5000
        });
        let mut payload = serde_json::to_string(&eval_req).unwrap();
        payload.push('\n');
        worker.stdin.write_all(payload.as_bytes()).await.unwrap();
        worker.stdin.flush().await.unwrap();

        let mut click_calls: Vec<Value> = Vec::new();
        let final_msg: Value = loop {
            let mut line = String::new();
            let n = worker.stdout.read_line(&mut line).await.unwrap();
            assert!(n > 0, "worker exited unexpectedly");
            let msg: Value = serde_json::from_str(line.trim()).unwrap();
            match msg["type"].as_str() {
                Some("rpc") => {
                    let rpc_id = msg["id"].as_u64().unwrap();
                    let tool = msg["tool"].as_str().unwrap();
                    let args = msg["args"].clone();
                    let reply_data = if tool == "get_app_state" {
                        json!({
                            "ok": true,
                            "snapshot_id": "snap-w10",
                            "window_context": { "window_id": 10 },
                            "accessibility_tree": [
                                { "index": 1, "role": "push button", "name": "Close" },
                                { "index": 2, "role": "push button", "name": "Close" },
                                { "index": 3, "role": "push button", "name": "Save" }
                            ]
                        })
                    } else {
                        click_calls.push(args.clone());
                        json!({ "ok": true, "received": args })
                    };
                    let mut reply = serde_json::to_string(&json!({
                        "type": "rpc_result",
                        "id": rpc_id,
                        "ok": true,
                        "data": reply_data,
                        "image_indices": []
                    }))
                    .unwrap();
                    reply.push('\n');
                    worker.stdin.write_all(reply.as_bytes()).await.unwrap();
                    worker.stdin.flush().await.unwrap();
                }
                Some("eval_result") => break msg,
                other => panic!("unexpected worker message: {other:?}"),
            }
        };

        assert_eq!(final_msg["ok"], true, "eval failed: {final_msg}");
        let ambig = final_msg["value"]["ambigErr"].as_str().unwrap_or_default();
        assert!(
            ambig.contains("Ambiguous exact-name click target"),
            "expected ambiguity error, got: {ambig}"
        );
        // Same window unique exact match resolved to element_index: 3.
        assert_eq!(click_calls.len(), 2);
        assert_eq!(click_calls[0]["window_id"], 10);
        assert_eq!(click_calls[0]["element_index"], 3);
        assert!(click_calls[0].get("name").is_none());
        // Different window (window_id: 20) MUST NOT reuse window 10's cached element_index.
        assert_eq!(click_calls[1]["window_id"], 20);
        assert_eq!(click_calls[1]["name"], "Save");
        assert!(click_calls[1].get("element_index").is_none());
    }

    #[tokio::test]
    async fn js_repl_cancelling_eval_future_resets_worker_and_handles_named_async_fn_expr() {
        let server = ComputerUseLinux::default();
        let session = ReplSession::default();

        // Warm the worker and verify named `async function` expressions do not throw ReferenceError.
        let warm = session
            .eval(
                &server,
                JsEvalParams {
                    code: r#"
const handler = async function retry() { return 7; };
globalThis.assignExpr = async function inner() { return 8; };
return { a: await handler(), b: await globalThis.assignExpr() };
"#
                    .to_string(),
                    timeout_ms: Some(5_000),
                },
            )
            .await;
        let (ok, data, _, _) = unpack_tool_result(warm);
        assert!(ok, "named async function expression failed: {data}");
        assert_eq!(data["value"]["a"], 7);
        assert_eq!(data["value"]["b"], 8);

        // Start a slow eval and drop/cancel its future mid-flight.
        let cancelled = tokio::time::timeout(
            Duration::from_millis(80),
            session.eval(
                &server,
                JsEvalParams {
                    code:
                        "globalThis.leakedFromCancelled = true; await sleep(5000); return 'late';"
                            .to_string(),
                    timeout_ms: Some(5_000),
                },
            ),
        )
        .await;
        assert!(cancelled.is_err(), "expected outer timeout to cancel eval");

        // Next eval must get a fresh worker (worker_restarted=true) with no leaked globals.
        let next = session
            .eval(
                &server,
                JsEvalParams {
                    code: "return { leaked: typeof leakedFromCancelled, handler: typeof handler };"
                        .to_string(),
                    timeout_ms: Some(5_000),
                },
            )
            .await;
        let (ok, data, _, _) = unpack_tool_result(next);
        assert!(ok, "post-cancellation eval failed: {data}");
        assert_eq!(data["worker_restarted"], true);
        assert_eq!(data["value"]["leaked"], "undefined");
        assert_eq!(data["value"]["handler"], "undefined");
    }

    /// Runs one eval on a fresh worker, answering its RPCs with `reply(tool, args)`.
    /// Returns the eval_result message and every RPC the worker sent, in order.
    async fn eval_with_mock_rpcs(
        code: &str,
        mut reply: impl FnMut(&str, &Value) -> Value,
    ) -> (Value, Vec<(String, Value)>) {
        let mut worker = spawn_repl_worker().expect("spawn repl worker");
        let mut payload = serde_json::to_string(
            &json!({ "type": "eval", "id": 1, "code": code, "timeoutMs": 5000 }),
        )
        .unwrap();
        payload.push('\n');
        worker.stdin.write_all(payload.as_bytes()).await.unwrap();
        worker.stdin.flush().await.unwrap();
        let mut calls = Vec::new();
        let mut line = Vec::new();
        loop {
            read_worker_line(&mut worker.stdout, &mut line)
                .await
                .unwrap();
            let msg: Value = serde_json::from_slice(&line).unwrap();
            match msg["type"].as_str() {
                Some("rpc") => {
                    let tool = msg["tool"].as_str().unwrap().to_string();
                    let args = msg["args"].clone();
                    let data = reply(&tool, &args);
                    calls.push((tool, args));
                    let mut out = serde_json::to_string(&json!({
                        "type": "rpc_result",
                        "id": msg["id"],
                        "ok": true,
                        "data": data,
                        "image_indices": []
                    }))
                    .unwrap();
                    out.push('\n');
                    worker.stdin.write_all(out.as_bytes()).await.unwrap();
                    worker.stdin.flush().await.unwrap();
                }
                Some("eval_result") => return (msg, calls),
                other => panic!("unexpected worker message: {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn js_repl_spill_paging_ignores_replaced_snapshot_and_refuses_partial_trees() {
        // Alpha's tree spills and has "Save" twice; Beta has no "Save". Paging Alpha after Beta
        // replaced the server's snapshot is refused, which must not mark Alpha complete or let
        // Alpha's indices resolve a string click aimed at Beta.
        let mut current_snapshot = String::new();
        let (result, calls) = eval_with_mock_rpcs(
            r#"
const a = await desktop.window("Alpha");
const b = await desktop.window("Beta");
await Promise.all([a.state(), b.state()]);
await b.click("Save");
const partial = await desktop.getAppState({ window_id: 1, hydrateSpill: false });
let findErr = null;
try { desktop.find(partial, { exactName: "Save" }); } catch (e) { findErr = String(e.message || e); }
let summaryErr = null;
try { desktop.summary(partial); } catch (e) { summaryErr = String(e.message || e); }
return { findErr, summaryErr };
"#,
            |tool, args| match tool {
                "list_windows" => json!({
                    "windows": [
                        { "window_id": 1, "title": "Alpha" },
                        { "window_id": 2, "title": "Beta" }
                    ]
                }),
                "get_app_state" if args["window_id"] == 1 => {
                    current_snapshot = "p-1".to_string();
                    json!({
                        "snapshot_id": "p-1",
                        "window_context": { "window_id": 1 },
                        "accessibility_tree": [{ "index": 3, "role": "push button", "name": "Save" }],
                        "accessibility_tree_spill": { "path": "spill.json" }
                    })
                }
                "get_app_state" => {
                    current_snapshot = "p-2".to_string();
                    json!({
                        "snapshot_id": "p-2",
                        "window_context": { "window_id": 2 },
                        "accessibility_tree": [{ "index": 3, "role": "push button", "name": "Delete" }]
                    })
                }
                "get_tree_page" if args["snapshot_id"] == current_snapshot.as_str() => json!({
                    "snapshot_id": current_snapshot,
                    "nodes": [{ "index": 40, "role": "push button", "name": "Save" }],
                    "offset": 1,
                    "next_offset": null,
                    "node_count": 2
                }),
                // The server's refusal: no snapshot_id, no nodes, no next page.
                "get_tree_page" => json!({ "nodes": [], "offset": 1, "next_offset": null, "node_count": 0 }),
                _ => json!({ "ok": true }),
            },
        )
        .await;
        assert_eq!(result["ok"], true, "eval failed: {result}");
        let clicks: Vec<&Value> = calls
            .iter()
            .filter(|(tool, _)| tool == "click")
            .map(|(_, args)| args)
            .collect();
        assert_eq!(clicks.len(), 1);
        assert_eq!(clicks[0]["window_id"], 2);
        assert_eq!(clicks[0]["name"], "Save");
        assert!(
            clicks[0].get("element_index").is_none(),
            "Beta's click reused Alpha's cached index: {}",
            clicks[0]
        );
        for key in ["findErr", "summaryErr"] {
            assert!(
                result["value"][key]
                    .as_str()
                    .unwrap_or_default()
                    .contains("accessibility_tree_spill"),
                "{key} did not refuse a partial tree: {result}"
            );
        }
    }

    #[tokio::test]
    async fn js_repl_refuses_and_hydrates_a_partial_tree_without_a_spill_file() {
        // The spill write failed: the server returns the leading nodes with
        // accessibility_tree_partial and no accessibility_tree_spill. The
        // worker must not take the prefix for the whole tree.
        let (result, calls) = eval_with_mock_rpcs(
            r#"
const partial = await desktop.getAppState({ window_id: 1, hydrateSpill: false });
const errs = {};
for (const [name, fn] of [
  ["find", () => desktop.find(partial, { exactName: "DeepSave" })],
  ["findAll", () => desktop.findAll(partial, { role: "push button" })],
  ["summary", () => desktop.summary(partial)],
]) {
  try { fn(); errs[name] = null; } catch (e) { errs[name] = String(e.message || e); }
}
await desktop.click("Close", { window_id: 1 });
const whole = await desktop.getAppState({ window_id: 1 });
const found = desktop.find(whole, { exactName: "DeepSave" });
const waited = await desktop.waitFor({ window_id: 1, exactName: "DeepSave", timeoutMs: 500 });
return {
  errs,
  hydratedPartial: whole.accessibility_tree_partial,
  hydratedCount: whole.accessibility_tree.length,
  foundIndex: found ? found.index : null,
  waitedOk: waited.ok,
};
"#,
            |tool, _args| match tool {
                "get_app_state" => json!({
                    "snapshot_id": "np-1",
                    "window_context": { "window_id": 1 },
                    "accessibility_tree": [{ "index": 1, "role": "push button", "name": "Close" }],
                    "accessibility_tree_partial": true
                }),
                "get_tree_page" => json!({
                    "snapshot_id": "np-1",
                    "offset": 1,
                    "next_offset": null,
                    "node_count": 3,
                    "nodes": [
                        { "index": 2, "role": "push button", "name": "Close" },
                        { "index": 3, "role": "push button", "name": "DeepSave" }
                    ]
                }),
                _ => json!({ "ok": true }),
            },
        )
        .await;
        assert_eq!(result["ok"], true, "eval failed: {result}");
        let value = &result["value"];
        for key in ["find", "findAll", "summary"] {
            assert!(
                value["errs"][key]
                    .as_str()
                    .unwrap_or_default()
                    .contains("accessibility_tree_partial"),
                "{key} did not refuse a partial tree: {result}"
            );
        }
        // "Close" appears twice in the whole tree, so the prefix must not
        // resolve it to one cached index.
        let clicks: Vec<&Value> = calls
            .iter()
            .filter(|(tool, _)| tool == "click")
            .map(|(_, args)| args)
            .collect();
        assert_eq!(clicks.len(), 1);
        assert!(
            clicks[0].get("element_index").is_none(),
            "a click resolved against the partial prefix: {}",
            clicks[0]
        );
        assert_eq!(value["hydratedPartial"], false, "{result}");
        assert_eq!(value["hydratedCount"], 3, "{result}");
        assert_eq!(value["foundIndex"], 3, "{result}");
        assert_eq!(value["waitedOk"], true, "{result}");
    }

    #[tokio::test]
    async fn js_repl_fill_form_type_mode_does_not_click_by_typed_text() {
        let (result, calls) = eval_with_mock_rpcs(
            r#"
return await desktop.fillForm([
  { name: "Email", text: "bob", mode: "type" },
  { text: "Phone", value: "555", mode: "type" }
]);
"#,
            |_, _| json!({ "ok": true }),
        )
        .await;
        assert_eq!(result["ok"], true, "eval failed: {result}");
        let tools: Vec<&str> = calls.iter().map(|(tool, _)| tool.as_str()).collect();
        assert_eq!(tools, ["click", "type_text", "click", "type_text"]);
        assert_eq!(calls[0].1["name"], "Email");
        assert!(
            calls[0].1.get("text").is_none(),
            "typed text used as selector: {}",
            calls[0].1
        );
        assert_eq!(calls[1].1["text"], "bob");
        // With an explicit value, `text` stays a selector.
        assert_eq!(calls[2].1["text"], "Phone");
        assert_eq!(calls[3].1["text"], "555");
    }

    #[tokio::test]
    async fn js_repl_caps_log_output() {
        let server = ComputerUseLinux::default();
        let session = ReplSession::default();
        let eval = session
            .eval(
                &server,
                JsEvalParams {
                    code:
                        r#"for (let i = 0; i < 20; i++) console.log("x".repeat(100000)); return 1;"#
                            .to_string(),
                    timeout_ms: Some(5_000),
                },
            )
            .await;
        let (ok, data, _, _) = unpack_tool_result(eval);
        assert!(ok, "log cap eval failed");
        let logs = data["logs"].as_array().expect("logs array");
        let total: usize = logs
            .iter()
            .map(|l| l.as_str().unwrap_or_default().len())
            .sum();
        assert!(total < 200_000, "logs not capped: {total} chars");
        assert!(logs[0]
            .as_str()
            .unwrap_or_default()
            .contains("line truncated"));
        assert!(logs
            .last()
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains("logs truncated"));
    }

    #[tokio::test]
    async fn js_repl_truncation_keeps_emoji_whole() {
        let server = ComputerUseLinux::default();
        let session = ReplSession::default();
        // Odd prefixes put a cap inside a surrogate pair. A lone half would make serde_json
        // reject the line and reset the worker.
        for code in [
            r#"console.log("a" + "\u{1F600}".repeat(40000)); return 1;"#,
            r#"return "ab" + "\u{1F600}".repeat(40000);"#,
            r#"throw new Error("ab" + "\u{1F600}".repeat(40000));"#,
        ] {
            let res = session
                .eval(
                    &server,
                    JsEvalParams {
                        code: code.to_string(),
                        timeout_ms: Some(5_000),
                    },
                )
                .await;
            let (_, data, _, _) = unpack_tool_result(res);
            assert!(
                data.get("worker_restarted").is_some(),
                "{code}: worker failed instead of returning a result: {data}"
            );
        }
        let after = session
            .eval(
                &server,
                JsEvalParams {
                    code: "return 1".to_string(),
                    timeout_ms: Some(5_000),
                },
            )
            .await;
        let (ok, data, _, _) = unpack_tool_result(after);
        assert!(ok);
        assert_eq!(data["worker_restarted"], false, "worker was reset: {data}");
    }

    #[tokio::test]
    async fn js_repl_class_rewrite_keeps_statement_break_and_unicode_names_persist() {
        let server = ComputerUseLinux::default();
        let session = ReplSession::default();
        let define = session
            .eval(
                &server,
                JsEvalParams {
                    code: "class A5 { m() { return 1 } }\n[1, 2].forEach((x) => x)\nclass B5 extends Object {}\n(function () {})()\nconst café = 1\nconst π = 3"
                        .to_string(),
                    timeout_ms: Some(5_000),
                },
            )
            .await;
        let (ok, data, _, _) = unpack_tool_result(define);
        assert!(ok, "class rewrite broke the next statement: {data}");
        let read = session
            .eval(
                &server,
                JsEvalParams {
                    code: "return [new A5().m(), typeof B5, café, π];".to_string(),
                    timeout_ms: Some(5_000),
                },
            )
            .await;
        let (ok, data, _, _) = unpack_tool_result(read);
        assert!(ok, "bindings did not persist: {data}");
        assert_eq!(data["value"], json!([1, "function", 1, 3]));
    }

    #[tokio::test]
    async fn js_repl_persisted_function_shares_top_level_bindings_with_later_calls() {
        let server = ComputerUseLinux::default();
        let session = ReplSession::default();
        let run = |code: &'static str| {
            let session = &session;
            let server = &server;
            async move {
                let res = session
                    .eval(
                        server,
                        JsEvalParams {
                            code: code.to_string(),
                            timeout_ms: Some(5_000),
                        },
                    )
                    .await;
                let (ok, data, _, _) = unpack_tool_result(res);
                assert!(ok, "{code}: {data}");
                data["value"].clone()
            }
        };
        run("let count = 0; function inc() { count++; return count; }").await;
        assert_eq!(run("inc(); inc(); return count;").await, 2);
        assert_eq!(run("count = 100; return inc();").await, 101);
        run("const { p, q: [r] } = { p: 1, q: [2] }, z = 3\nlet un").await;
        assert_eq!(
            run("return [p, r, z, typeof un];").await,
            json!([1, 2, 3, "undefined"])
        );
    }

    #[tokio::test]
    async fn js_repl_window_targets_are_relative_and_coordinates_are_integers() {
        let (result, calls) = eval_with_mock_rpcs(
            r#"
const win = await desktop.window("Demo");
await win.clickAll([{ x: 40, y: 50 }, { x: 1, y: 2, relative: false }]);
await win.fillForm([{ x: 10, y: 20, mode: "type", value: "hi" }]);
await desktop.click(100 / 0.75, 7.4);
await desktop.drag(1.6, 2.2, 3.5, 4.4);
return true;
"#,
            |tool, _| match tool {
                "list_windows" => json!({ "windows": [{ "window_id": 7, "title": "Demo" }] }),
                _ => json!({ "ok": true }),
            },
        )
        .await;
        assert_eq!(result["ok"], true, "eval failed: {result}");
        let args: Vec<&Value> = calls
            .iter()
            .filter(|(tool, _)| tool == "click" || tool == "drag")
            .map(|(_, args)| args)
            .collect();
        assert_eq!(args.len(), 5);
        assert_eq!(args[0]["relative"], true);
        assert_eq!(args[0]["window_id"], 7);
        assert_eq!(args[1]["relative"], false);
        assert_eq!(args[2]["relative"], true);
        assert_eq!(args[3]["x"], 133);
        assert_eq!(args[3]["y"], 7);
        assert_eq!(
            (args[4]["start_x"].clone(), args[4]["end_x"].clone()),
            (json!(2), json!(4))
        );
    }

    #[tokio::test]
    async fn js_repl_surfaces_listing_errors_and_replaces_lone_surrogates() {
        let failed = json!({
            "windows": [],
            "error": "window backend unavailable",
            "permissions_hint": "install the GNOME Shell extension"
        });
        let (result, _) = eval_with_mock_rpcs(
            r#"
let windowErr = null;
try { await desktop.window("Firefox"); } catch (e) { windowErr = String(e.message || e); }
const state = await desktop.getState();
return { windowErr, errors: state.errors, hint: state.permissions_hint, cut: "a\u{1F600}".slice(0, 2), keys: { ["\u{1F600}".slice(0, 1)]: 1 } };
"#,
            |tool, _| match tool {
                "list_windows" => failed.clone(),
                "focused_window" => json!({ "focused_window": null, "error": "no focus backend" }),
                "list_apps" => json!({ "apps": [], "accessibility_error": "AT-SPI bus missing" }),
                _ => json!({ "ok": true }),
            },
        )
        .await;
        assert_eq!(result["ok"], true, "eval failed: {result}");
        let value = &result["value"];
        let window_err = value["windowErr"].as_str().unwrap_or_default();
        assert!(window_err.contains("window backend unavailable"), "{value}");
        assert!(
            window_err.contains("install the GNOME Shell extension"),
            "{value}"
        );
        assert_eq!(
            value["errors"]["list_windows"],
            "window backend unavailable"
        );
        assert_eq!(value["errors"]["focused_window"], "no focus backend");
        assert_eq!(value["errors"]["list_apps"], "AT-SPI bus missing");
        assert_eq!(value["hint"], "install the GNOME Shell extension");
        // The lone high surrogate became U+FFFD instead of breaking the protocol line.
        assert_eq!(value["cut"], "a\u{FFFD}");
        assert_eq!(value["keys"]["\u{FFFD}"], 1);
    }

    #[tokio::test]
    async fn run_batch_counts_a_page_without_snapshot_as_failed() {
        let server = ComputerUseLinux::default();
        let res = execute_batch(
            &server,
            RunBatchParams {
                steps: vec![BatchStep {
                    tool: Some("get_tree_page".to_string()),
                    args: Some(json!({ "query": "Total" })),
                    sleep_ms: None,
                }],
                delay_ms: None,
                stop_on_error: Some(true),
                auto_snapshot_id: Some(true),
            },
        )
        .await;
        let (ok, data, _, _) = unpack_tool_result(res);
        assert!(!ok, "a page with no snapshot counted as success: {data}");
        assert_eq!(data["results"][0]["ok"], false);
    }

    #[tokio::test]
    async fn read_worker_line_refuses_an_oversized_line() {
        let mut child = Command::new(resolve_node_binary())
            .arg("-e")
            .arg("process.stdout.write('ok\\n' + 'x'.repeat(5 * 1024 * 1024) + '\\n')")
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn node");
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let mut line = Vec::new();
        read_worker_line(&mut reader, &mut line).await.unwrap();
        assert_eq!(line, b"ok");
        let err = read_worker_line(&mut reader, &mut line).await.unwrap_err();
        assert!(err.to_string().contains("bytes"), "{err:#}");
    }

    #[tokio::test]
    async fn js_repl_persists_every_declarator_and_asi_declarations() {
        let server = ComputerUseLinux::default();
        let session = ReplSession::default();
        let define = session
            .eval(
                &server,
                JsEvalParams {
                    code: "const fa = async () => 1, fb = 2\nlet ga = function () {}, gb = 3\nvar ha = class {}, hb = 4\nconst half = ({ in: 4 }).in / 2; const after3 = \"a/b\"; const after4 = 5\nMath.max(1)\nfunction later() { return 6 }\nconst nl = 1\nclass NL {}\nx = async function notGlobal() {}"
                        .to_string(),
                    timeout_ms: Some(5_000),
                },
            )
            .await;
        let (ok, data, _, _) = unpack_tool_result(define);
        assert!(ok, "declarations failed: {data}");
        let read = session
            .eval(
                &server,
                JsEvalParams {
                    code: "return [fb, gb, hb, half, after3, after4, later(), typeof NL, typeof notGlobal];"
                        .to_string(),
                    timeout_ms: Some(5_000),
                },
            )
            .await;
        let (ok, data, _, _) = unpack_tool_result(read);
        assert!(ok, "bindings did not persist: {data}");
        assert_eq!(
            data["value"],
            json!([2, 3, 4, 2, "a/b", 5, 6, "function", "undefined"])
        );
    }

    #[tokio::test]
    async fn js_repl_hydrates_spilled_trees_and_defaults_window_handle_coords_to_relative() {
        let mut worker = spawn_repl_worker().expect("spawn repl worker");
        let eval_req = json!({
            "type": "eval",
            "id": 1,
            "code": r#"
const win = await desktop.window("Demo");
// 1) Spilled tree auto-hydrates via get_tree_page so elements past the inline prefix are found
//    and ambiguity across pages is detected.
const deepBtn = await win.find({ exactName: "DeepSave" });
let ambigAcrossPages = null;
try {
  await win.click("Close");
} catch (err) {
  ambigAcrossPages = String(err.message || err);
}
// 2) WindowHandle explicit coordinates default to relative=true (and honor relative=false).
await win.click(40, 50);
await win.click(40, 50, { relative: false });
await win.scroll({ direction: "down", x: 100, y: 120 });
// 3) When spill hydration is disabled/incomplete, string clicks skip local element_index resolution.
await desktop.getAppState({ window_id: 42, hydrateSpill: false });
await desktop.click("Close", { window_id: 42 });
return { deepIndex: deepBtn?.index ?? null, ambigAcrossPages };
"#,
            "timeoutMs": 5000
        });
        let mut payload = serde_json::to_string(&eval_req).unwrap();
        payload.push('\n');
        worker.stdin.write_all(payload.as_bytes()).await.unwrap();
        worker.stdin.flush().await.unwrap();

        let mut click_calls: Vec<Value> = Vec::new();
        let mut scroll_calls: Vec<Value> = Vec::new();
        let mut page_calls: usize = 0;

        let final_msg: Value = loop {
            let mut line = String::new();
            let n = worker.stdout.read_line(&mut line).await.unwrap();
            assert!(n > 0, "worker exited unexpectedly");
            let msg: Value = serde_json::from_str(line.trim()).unwrap();
            match msg["type"].as_str() {
                Some("rpc") => {
                    let rpc_id = msg["id"].as_u64().unwrap();
                    let tool = msg["tool"].as_str().unwrap();
                    let args = msg["args"].clone();
                    let reply_data = match tool {
                        "list_windows" => json!({
                            "ok": true,
                            "windows": [{ "window_id": 42, "title": "Demo App", "app_id": "demo" }]
                        }),
                        "get_app_state" => json!({
                            "ok": true,
                            "snapshot_id": "snap-spill-1",
                            "window_context": { "window_id": 42 },
                            "accessibility_tree": [
                                { "index": 1, "role": "push button", "name": "Close" }
                            ],
                            "accessibility_tree_spill": { "path": "/tmp/spill.json", "total_nodes": 3 }
                        }),
                        "get_tree_page" => {
                            page_calls += 1;
                            json!({
                                "snapshot_id": "snap-spill-1",
                                "offset": 1,
                                "next_offset": null,
                                "node_count": 3,
                                "nodes": [
                                    { "index": 2, "role": "push button", "name": "Close" },
                                    { "index": 3, "role": "push button", "name": "DeepSave" }
                                ]
                            })
                        }
                        "click" => {
                            click_calls.push(args.clone());
                            json!({ "ok": true })
                        }
                        "scroll" => {
                            scroll_calls.push(args.clone());
                            json!({ "ok": true })
                        }
                        other => panic!("unexpected rpc tool {other}"),
                    };
                    let mut reply = serde_json::to_string(&json!({
                        "type": "rpc_result",
                        "id": rpc_id,
                        "ok": true,
                        "data": reply_data,
                        "image_indices": []
                    }))
                    .unwrap();
                    reply.push('\n');
                    worker.stdin.write_all(reply.as_bytes()).await.unwrap();
                    worker.stdin.flush().await.unwrap();
                }
                Some("eval_result") => break msg,
                other => panic!("unexpected worker message: {other:?}"),
            }
        };

        assert_eq!(final_msg["ok"], true, "eval failed: {final_msg}");
        assert!(
            page_calls >= 1,
            "expected get_tree_page to hydrate spilled tree"
        );
        assert_eq!(final_msg["value"]["deepIndex"], 3);
        assert!(final_msg["value"]["ambigAcrossPages"]
            .as_str()
            .unwrap_or_default()
            .contains("Ambiguous exact-name click target"));

        assert_eq!(click_calls.len(), 3);
        // WindowHandle win.click(40, 50) defaults to relative=true.
        assert_eq!(click_calls[0]["window_id"], 42);
        assert_eq!(click_calls[0]["x"], 40);
        assert_eq!(click_calls[0]["y"], 50);
        assert_eq!(click_calls[0]["relative"], true);
        // Explicit relative=false is respected.
        assert_eq!(click_calls[1]["relative"], false);
        // Unhydrated spilled tree skips local element_index resolution and sends name to server.
        assert_eq!(click_calls[2]["name"], "Close");
        assert!(click_calls[2].get("element_index").is_none());

        assert_eq!(scroll_calls.len(), 1);
        assert_eq!(scroll_calls[0]["window_id"], 42);
        assert_eq!(scroll_calls[0]["relative"], true);
    }
}

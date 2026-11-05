use anyhow::{anyhow, Context, Result};
use std::{
    io::{self, Read},
    os::{
        fd::{AsRawFd, RawFd},
        unix::process::CommandExt as _,
    },
    process::{Command as StdCommand, ExitStatus, Output, Stdio},
    thread,
    time::Instant as StdInstant,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    sync::oneshot,
    task::JoinHandle,
    time::{Duration, Instant},
};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
const REAP_TIMEOUT: Duration = Duration::from_secs(1);
const MAX_COMMAND_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const EXIT_POLL_INITIAL_INTERVAL: Duration = Duration::from_micros(100);
const EXIT_POLL_MAX_INTERVAL: Duration = Duration::from_millis(10);
const MAX_BLOCKING_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_BLOCKING_DRAIN_BYTES: usize = 64 * 1024;
/// `exec` fails with ETXTBSY while any process holds a write handle on the
/// program file. That happens when a helper binary is being replaced, and in
/// tests when another thread forks while a fake script is still open for
/// writing: the child inherits the O_CLOEXEC handle until its own exec. The
/// window is short, so retry a few times with a growing pause (75 ms total).
const TEXT_FILE_BUSY_RETRIES: u32 = 5;
const TEXT_FILE_BUSY_BACKOFF: Duration = Duration::from_millis(5);

fn is_text_file_busy(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::ETXTBSY)
}

/// `StdCommand::spawn` that retries a transient ETXTBSY.
pub(crate) fn spawn_std_retrying_busy(command: &mut StdCommand) -> io::Result<std::process::Child> {
    let mut attempt = 0;
    loop {
        match command.spawn() {
            Err(error) if is_text_file_busy(&error) && attempt < TEXT_FILE_BUSY_RETRIES => {
                attempt += 1;
                thread::sleep(TEXT_FILE_BUSY_BACKOFF * attempt);
            }
            result => return result,
        }
    }
}

/// Tokio `Command::spawn` that retries a transient ETXTBSY.
pub(crate) async fn spawn_retrying_busy(command: &mut Command) -> io::Result<Child> {
    let mut attempt = 0;
    loop {
        match command.spawn() {
            Err(error) if is_text_file_busy(&error) && attempt < TEXT_FILE_BUSY_RETRIES => {
                attempt += 1;
                tokio::time::sleep(TEXT_FILE_BUSY_BACKOFF * attempt).await;
            }
            result => return result,
        }
    }
}

pub(crate) async fn output(command: Command, action: &str) -> Result<Output> {
    output_with_timeout(command, action, COMMAND_TIMEOUT).await
}

pub(crate) async fn output_with_timeout(
    command: Command,
    action: &str,
    timeout: Duration,
) -> Result<Output> {
    output_with_input(command, action, timeout, None).await
}

pub(crate) async fn output_with_stdin(
    command: Command,
    action: &str,
    timeout: Duration,
    input: Vec<u8>,
) -> Result<Output> {
    output_with_input(command, action, timeout, Some(input)).await
}

pub(crate) fn output_blocking(command: &mut StdCommand, action: &str) -> Result<Output> {
    output_blocking_with_timeout(command, action, COMMAND_TIMEOUT)
}

pub(crate) fn output_blocking_with_timeout(
    command: &mut StdCommand,
    action: &str,
    timeout: Duration,
) -> Result<Output> {
    command
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child =
        spawn_std_retrying_busy(command).with_context(|| format!("failed to {action}"))?;
    let pgid = i32::try_from(child.id()).context("child process id did not fit in i32")?;
    let mut stdout = child
        .stdout
        .take()
        .context("command stdout was not piped")?;
    let mut stderr = child
        .stderr
        .take()
        .context("command stderr was not piped")?;
    if let Err(error) =
        set_nonblocking(stdout.as_raw_fd()).and_then(|()| set_nonblocking(stderr.as_raw_fd()))
    {
        terminate_blocking_process(&mut child, pgid);
        return Err(error).with_context(|| format!("failed to configure {action} output pipes"));
    }

    let deadline = StdInstant::now() + timeout;
    let mut stdout_bytes = Vec::new();
    let mut stderr_bytes = Vec::new();
    let mut stdout_eof = false;
    let mut stderr_eof = false;
    loop {
        let previous_bytes = stdout_bytes.len() + stderr_bytes.len();
        if !stdout_eof {
            match drain_nonblocking(&mut stdout, &mut stdout_bytes) {
                Ok(eof) => stdout_eof = eof,
                Err(error) => {
                    terminate_blocking_process(&mut child, pgid);
                    return Err(error)
                        .with_context(|| format!("failed to collect {action} stdout"));
                }
            }
        }
        if !stderr_eof {
            match drain_nonblocking(&mut stderr, &mut stderr_bytes) {
                Ok(eof) => stderr_eof = eof,
                Err(error) => {
                    terminate_blocking_process(&mut child, pgid);
                    return Err(error)
                        .with_context(|| format!("failed to collect {action} stderr"));
                }
            }
        }
        if stdout_eof && stderr_eof {
            return match wait_for_exit(&mut child, deadline) {
                Ok(Some(status)) => Ok(Output {
                    status,
                    stdout: stdout_bytes,
                    stderr: stderr_bytes,
                }),
                Ok(None) => {
                    terminate_blocking_process(&mut child, pgid);
                    Err(timeout_error(action, timeout))
                }
                Err(error) => {
                    terminate_blocking_process(&mut child, pgid);
                    Err(error).with_context(|| format!("failed to wait for {action}"))
                }
            };
        }
        let now = StdInstant::now();
        if now >= deadline {
            terminate_blocking_process(&mut child, pgid);
            return Err(timeout_error(action, timeout));
        }
        // Continue draining a busy producer without waiting after every
        // chunk. Each drain is still capped and the deadline is checked above,
        // so continuous output cannot starve stderr or bypass the output limit.
        if stdout_bytes.len() + stderr_bytes.len() == previous_bytes {
            let open_pipes = [
                (!stdout_eof).then(|| stdout.as_raw_fd()),
                (!stderr_eof).then(|| stderr.as_raw_fd()),
            ];
            if let Err(error) = wait_for_output(open_pipes, deadline - now) {
                terminate_blocking_process(&mut child, pgid);
                return Err(error).with_context(|| format!("failed to wait for {action} output"));
            }
        }
    }
}

async fn output_with_input(
    mut command: Command,
    action: &str,
    timeout: Duration,
    input: Option<Vec<u8>>,
) -> Result<Output> {
    command
        .kill_on_drop(true)
        .process_group(0)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = spawn_retrying_busy(&mut command)
        .await
        .with_context(|| format!("failed to {action}"))?;
    supervise_child(child, action, timeout, input).await
}

pub(crate) async fn output_child(child: Child, action: &str, timeout: Duration) -> Result<Output> {
    supervise_child(child, action, timeout, None).await
}

async fn supervise_child(
    mut child: Child,
    action: &str,
    timeout: Duration,
    input: Option<Vec<u8>>,
) -> Result<Output> {
    let pid = child
        .id()
        .and_then(|pid| i32::try_from(pid).ok())
        .context("spawned command did not have a usable process id")?;
    let mut process_group = ProcessGroupGuard::new(pid);
    let stdout = child
        .stdout
        .take()
        .context("command stdout was not piped")?;
    let stderr = child
        .stderr
        .take()
        .context("command stderr was not piped")?;
    let stdout_reader = tokio::spawn(read_pipe(stdout));
    let stderr_reader = tokio::spawn(read_pipe(stderr));
    let stdin_writer = match input {
        Some(input) => {
            let mut stdin = child.stdin.take().context("command stdin was not piped")?;
            Some(tokio::spawn(async move { stdin.write_all(&input).await }))
        }
        None => None,
    };

    let (cancel_tx, cancel_rx) = oneshot::channel();
    let (result_tx, result_rx) = oneshot::channel();
    let deadline = Instant::now() + timeout;
    let action = action.to_string();
    tokio::spawn(async move {
        supervise_command(
            child,
            &mut process_group,
            stdout_reader,
            stderr_reader,
            stdin_writer,
            cancel_rx,
            deadline,
            timeout,
            &action,
            result_tx,
        )
        .await;
    });

    let mut cancellation = CancelOnDrop(Some(cancel_tx));
    let result = result_rx
        .await
        .context("command supervisor stopped before returning a result")?;
    cancellation.0 = None;
    result
}

#[allow(clippy::too_many_arguments)]
async fn supervise_command(
    mut child: Child,
    process_group: &mut ProcessGroupGuard,
    mut stdout_reader: JoinHandle<std::io::Result<Vec<u8>>>,
    mut stderr_reader: JoinHandle<std::io::Result<Vec<u8>>>,
    mut stdin_writer: Option<JoinHandle<std::io::Result<()>>>,
    mut cancel_rx: oneshot::Receiver<()>,
    deadline: Instant,
    timeout: Duration,
    action: &str,
    result_tx: oneshot::Sender<Result<Output>>,
) {
    enum Completion {
        Finished(Result<Output>),
        Timeout,
        Cancelled,
    }

    let completion = {
        // Keep the leader waitable until every inherited output descriptor is
        // closed, so its process-group id cannot be reused during cleanup.
        let command_completion = async {
            let stdin = async {
                match stdin_writer.as_mut() {
                    Some(writer) => writer
                        .await
                        .context("command stdin writer task failed")?
                        .context("failed to write command stdin"),
                    None => Ok(()),
                }
            };
            let stdout = async {
                (&mut stdout_reader)
                    .await
                    .context("command stdout reader task failed")?
                    .context("failed to read command stdout")
            };
            let stderr = async {
                (&mut stderr_reader)
                    .await
                    .context("command stderr reader task failed")?
                    .context("failed to read command stderr")
            };
            let ((), stdout, stderr) = tokio::try_join!(stdin, stdout, stderr)?;
            let status = child.wait().await.context("failed to wait for command")?;
            Ok(Output {
                status,
                stdout,
                stderr,
            })
        };
        tokio::pin!(command_completion);
        tokio::select! {
            result = &mut command_completion => Completion::Finished(result),
            _ = tokio::time::sleep_until(deadline) => Completion::Timeout,
            _ = &mut cancel_rx => Completion::Cancelled,
        }
    };

    let result = match completion {
        Completion::Finished(Ok(output)) => {
            process_group.disarm();
            Ok(output)
        }
        Completion::Finished(Err(error)) => {
            terminate_command(
                &mut child,
                process_group,
                &mut stdout_reader,
                &mut stderr_reader,
                stdin_writer.as_mut(),
            )
            .await;
            Err(error).with_context(|| format!("failed to {action}"))
        }
        Completion::Timeout => {
            terminate_command(
                &mut child,
                process_group,
                &mut stdout_reader,
                &mut stderr_reader,
                stdin_writer.as_mut(),
            )
            .await;
            Err(timeout_error(action, timeout))
        }
        Completion::Cancelled => {
            terminate_command(
                &mut child,
                process_group,
                &mut stdout_reader,
                &mut stderr_reader,
                stdin_writer.as_mut(),
            )
            .await;
            Err(anyhow!("cancelled while trying to {action}"))
        }
    };
    let _ = result_tx.send(result);
}

async fn read_pipe(mut pipe: impl AsyncRead + Unpin) -> std::io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8192];
    loop {
        let length = pipe.read(&mut buffer).await?;
        if length == 0 {
            break;
        }
        if output.len().saturating_add(length) > MAX_COMMAND_OUTPUT_BYTES {
            return Err(std::io::Error::other(format!(
                "command output exceeded {MAX_COMMAND_OUTPUT_BYTES} bytes"
            )));
        }
        output.extend_from_slice(&buffer[..length]);
    }
    Ok(output)
}

fn set_nonblocking(fd: std::os::fd::RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn drain_nonblocking(reader: &mut impl Read, output: &mut Vec<u8>) -> io::Result<bool> {
    let mut buffer = [0_u8; 8192];
    let mut drained = 0;
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => return Ok(true),
            Ok(length) => {
                if output.len().saturating_add(length) > MAX_BLOCKING_OUTPUT_BYTES {
                    return Err(io::Error::other(format!(
                        "command output exceeded {MAX_BLOCKING_OUTPUT_BYTES} bytes"
                    )));
                }
                output.extend_from_slice(&buffer[..length]);
                drained += length;
                if drained >= MAX_BLOCKING_DRAIN_BYTES {
                    return Ok(false);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(false),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
}

/// Blocks until an open pipe has data or hangs up, a signal arrives, or
/// `timeout` passes. Pipes at EOF are left out because they stay readable.
fn wait_for_output(open_pipes: [Option<RawFd>; 2], timeout: Duration) -> io::Result<()> {
    // poll skips a negative descriptor.
    let mut pollfds = open_pipes.map(|fd| libc::pollfd {
        fd: fd.unwrap_or(-1),
        events: libc::POLLIN,
        revents: 0,
    });
    // Round up so a sub-millisecond remainder does not spin at a zero timeout.
    let timeout_ms = i32::try_from(timeout.as_nanos().div_ceil(1_000_000)).unwrap_or(i32::MAX);
    if unsafe { libc::poll(pollfds.as_mut_ptr(), 2, timeout_ms) } < 0 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
    Ok(())
}

/// Returns `None` if the process is still running at `deadline`. The exit
/// status usually trails pipe EOF by microseconds, but a process can close its
/// pipes long before it exits, so start with a short pause and back off.
fn wait_for_exit(
    child: &mut std::process::Child,
    deadline: StdInstant,
) -> io::Result<Option<ExitStatus>> {
    let mut pause = EXIT_POLL_INITIAL_INTERVAL;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        let now = StdInstant::now();
        if now >= deadline {
            return Ok(None);
        }
        thread::sleep(pause.min(deadline - now));
        pause = (pause * 2).min(EXIT_POLL_MAX_INTERVAL);
    }
}

fn terminate_blocking_process(child: &mut std::process::Child, pgid: i32) {
    unsafe {
        libc::kill(-pgid, libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = wait_for_exit(child, StdInstant::now() + REAP_TIMEOUT);
}

async fn terminate_command(
    child: &mut Child,
    process_group: &mut ProcessGroupGuard,
    stdout_reader: &mut JoinHandle<std::io::Result<Vec<u8>>>,
    stderr_reader: &mut JoinHandle<std::io::Result<Vec<u8>>>,
    stdin_writer: Option<&mut JoinHandle<std::io::Result<()>>>,
) {
    process_group.kill();
    let _ = child.start_kill();
    let _ = tokio::time::timeout(REAP_TIMEOUT, child.wait()).await;
    stdout_reader.abort();
    stderr_reader.abort();
    if let Some(stdin_writer) = stdin_writer {
        stdin_writer.abort();
    }
    process_group.disarm();
}

fn timeout_error(action: &str, timeout: Duration) -> anyhow::Error {
    anyhow!(
        "timed out after {} ms while trying to {action}",
        timeout.as_millis()
    )
}

struct ProcessGroupGuard {
    pgid: i32,
    armed: bool,
}

impl ProcessGroupGuard {
    fn new(pgid: i32) -> Self {
        Self { pgid, armed: true }
    }

    fn kill(&self) {
        if self.armed {
            unsafe {
                libc::kill(-self.pgid, libc::SIGKILL);
            }
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for ProcessGroupGuard {
    fn drop(&mut self) {
        self.kill();
    }
}

struct CancelOnDrop(Option<oneshot::Sender<()>>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(cancel) = self.0.take() {
            let _ = cancel.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf, time::Instant};

    /// Removes the script when dropped, also when the test fails.
    struct Script(PathBuf);

    impl Drop for Script {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    /// A script whose own write handle is still open: `exec` must fail with
    /// ETXTBSY until the handle closes.
    fn busy_script(label: &str) -> (Script, std::fs::File) {
        use std::io::Write as _;
        use std::os::unix::fs::PermissionsExt as _;
        let path = std::env::temp_dir().join(format!(
            "computer-use-linux-busy-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(b"#!/bin/sh\nexit 0\n").unwrap();
        file.flush().unwrap();
        let script = Script(path);
        std::fs::set_permissions(&script.0, std::fs::Permissions::from_mode(0o700)).unwrap();
        (script, file)
    }

    #[test]
    fn blocking_spawn_waits_out_a_transient_text_file_busy() {
        let (script, writer) = busy_script("std");
        let direct = StdCommand::new(&script.0).spawn();
        assert!(
            direct.as_ref().err().is_some_and(is_text_file_busy),
            "an open write handle must make exec fail with ETXTBSY: {direct:?}"
        );
        let release = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            drop(writer);
        });

        let mut child = spawn_std_retrying_busy(&mut StdCommand::new(&script.0))
            .expect("retry must outlast a 20 ms busy window");
        assert!(child.wait().unwrap().success());
        release.join().unwrap();
    }

    #[tokio::test]
    async fn async_spawn_waits_out_a_transient_text_file_busy() {
        let (script, writer) = busy_script("tokio");
        let release = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            drop(writer);
        });

        let mut child = spawn_retrying_busy(&mut Command::new(&script.0))
            .await
            .expect("retry must outlast a 20 ms busy window");
        assert!(child.wait().await.unwrap().success());
        release.join().unwrap();
    }

    #[test]
    fn persistent_text_file_busy_is_still_reported() {
        let (script, writer) = busy_script("persistent");
        let started = Instant::now();

        let error = spawn_std_retrying_busy(&mut StdCommand::new(&script.0)).unwrap_err();

        assert!(is_text_file_busy(&error));
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "the retry budget must stay short"
        );
        drop(writer);
    }

    #[tokio::test]
    async fn timeout_kills_the_child_process() {
        let pid_path = temporary_pid_path("leader");
        let mut command = Command::new("sh");
        command.args([
            "-c",
            &format!("printf %s $$ > '{}'; exec sleep 60", pid_path.display()),
        ]);
        let started = Instant::now();

        let error = output_with_timeout(command, "run test child", Duration::from_millis(20))
            .await
            .unwrap_err();

        assert!(error.to_string().contains("timed out"));
        assert!(started.elapsed() < Duration::from_millis(500));
        let pid = wait_for_pid(&pid_path).await;
        wait_for_process_exit(pid).await;
        let _ = fs::remove_file(pid_path);
    }

    #[tokio::test]
    async fn timeout_kills_descendants_that_hold_output_pipes() {
        let leader_path = temporary_pid_path("group-leader");
        let descendant_path = temporary_pid_path("group-descendant");
        let mut command = Command::new("sh");
        command.args([
            "-c",
            &format!(
                "printf %s $$ > '{}'; sleep 60 & printf %s $! > '{}'; wait",
                leader_path.display(),
                descendant_path.display()
            ),
        ]);

        let error = output_with_timeout(command, "run process tree", Duration::from_millis(100))
            .await
            .unwrap_err();

        assert!(error.to_string().contains("timed out"));
        let leader = wait_for_pid(&leader_path).await;
        let descendant = wait_for_pid(&descendant_path).await;
        wait_for_process_exit(leader).await;
        wait_for_process_exit(descendant).await;
        let _ = fs::remove_file(leader_path);
        let _ = fs::remove_file(descendant_path);
    }

    #[tokio::test]
    async fn caller_cancellation_kills_the_process_group() {
        let leader_path = temporary_pid_path("cancel-leader");
        let descendant_path = temporary_pid_path("cancel-descendant");
        let mut command = Command::new("sh");
        command.args([
            "-c",
            &format!(
                "printf %s $$ > '{}'; sleep 60 & printf %s $! > '{}'; wait",
                leader_path.display(),
                descendant_path.display()
            ),
        ]);
        let task = tokio::spawn(output_with_timeout(
            command,
            "run cancellable process tree",
            Duration::from_secs(60),
        ));
        let leader = wait_for_pid(&leader_path).await;
        let descendant = wait_for_pid(&descendant_path).await;

        task.abort();
        let _ = task.await;

        wait_for_process_exit(leader).await;
        wait_for_process_exit(descendant).await;
        let _ = fs::remove_file(leader_path);
        let _ = fs::remove_file(descendant_path);
    }

    #[tokio::test]
    async fn cancellation_after_leader_exit_kills_pipe_holding_descendant() {
        let descendant_path = temporary_pid_path("post-exit-descendant");
        let mut command = Command::new("sh");
        command.args([
            "-c",
            &format!(
                "sleep 60 & printf %s $! > '{}'; exit 0",
                descendant_path.display()
            ),
        ]);
        let task = tokio::spawn(output_with_timeout(
            command,
            "collect descendant output",
            Duration::from_secs(60),
        ));
        let descendant = wait_for_pid(&descendant_path).await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(
            !task.is_finished(),
            "descendant should still hold output pipes"
        );

        task.abort();
        let _ = task.await;

        wait_for_process_exit(descendant).await;
        let _ = fs::remove_file(descendant_path);
    }

    #[tokio::test]
    async fn output_with_stdin_writes_and_closes_input() {
        let mut command = Command::new("sh");
        command.args(["-c", "cat"]);

        let output = output_with_stdin(
            command,
            "echo stdin",
            Duration::from_secs(1),
            b"portal input".to_vec(),
        )
        .await
        .expect("stdin command should complete");

        assert!(output.status.success());
        assert_eq!(output.stdout, b"portal input");
    }

    #[tokio::test]
    async fn command_output_is_bounded() {
        let mut command = Command::new("sh");
        command.args(["-c", "head -c 9000000 /dev/zero"]);

        let error =
            output_with_timeout(command, "capture excessive output", Duration::from_secs(5))
                .await
                .unwrap_err();

        assert!(format!("{error:#}").contains("output exceeded"));
    }

    #[tokio::test]
    async fn command_output_drains_large_stdout_and_stderr() {
        let mut command = Command::new("sh");
        command.args([
            "-c",
            "yes stdout | head -c 200000; yes stderr | head -c 200000 >&2",
        ]);

        let output = output_with_timeout(command, "collect noisy output", Duration::from_secs(5))
            .await
            .expect("noisy command should complete");

        assert!(output.status.success());
        assert!(output.stdout.len() >= 200_000);
        assert!(output.stderr.len() >= 200_000);
    }

    #[tokio::test]
    async fn default_blocking_timeout_kills_the_process_group() {
        let leader_path = temporary_pid_path("blocking-default-leader");
        let descendant_path = temporary_pid_path("blocking-default-descendant");
        let mut command = StdCommand::new("sh");
        command.args([
            "-c",
            &format!(
                "printf %s $$ > '{}'; sleep 60 & printf %s $! > '{}'; wait",
                leader_path.display(),
                descendant_path.display()
            ),
        ]);
        let started = Instant::now();

        let error = output_blocking(&mut command, "run blocking process tree").unwrap_err();

        assert!(error
            .to_string()
            .contains("timed out after 2000 ms while trying to run blocking process tree"));
        assert!(started.elapsed() < Duration::from_secs(4));
        let leader = fs::read_to_string(&leader_path)
            .expect("leader should record its pid")
            .parse()
            .expect("leader pid should be numeric");
        let descendant = fs::read_to_string(&descendant_path)
            .expect("descendant should record its pid")
            .parse()
            .expect("descendant pid should be numeric");
        wait_for_process_exit(leader).await;
        wait_for_process_exit(descendant).await;
        let _ = fs::remove_file(leader_path);
        let _ = fs::remove_file(descendant_path);
    }

    #[test]
    fn blocking_output_returns_when_a_fast_command_exits() {
        const RUNS: u32 = 100;
        let started = Instant::now();
        for _ in 0..RUNS {
            let output = StdCommand::new("true").output().unwrap();
            assert!(output.status.success());
        }
        let direct = started.elapsed();

        let started = Instant::now();
        for _ in 0..RUNS {
            let output = output_blocking(&mut StdCommand::new("true"), "run true").unwrap();
            assert!(output.status.success());
        }
        let blocking = started.elapsed();

        // Both loops pay the same spawn cost, so compare only what the runner
        // adds. Pausing 10 ms whenever a pass reads nothing would add over 1 s.
        assert!(
            blocking.saturating_sub(direct) < Duration::from_millis(500),
            "{RUNS} runs of true took {blocking:?} through output_blocking and {direct:?} directly"
        );
    }

    #[test]
    fn blocking_output_drains_large_stdout_and_stderr() {
        let mut command = StdCommand::new("sh");
        command.args([
            "-c",
            "yes stdout | head -c 200000; yes stderr | head -c 200000 >&2",
        ]);

        let output = output_blocking_with_timeout(
            &mut command,
            "collect noisy output",
            Duration::from_secs(5),
        )
        .expect("noisy command should complete");

        assert!(output.status.success());
        assert_eq!(output.stdout.len(), 200_000);
        assert_eq!(output.stderr.len(), 200_000);
    }

    #[test]
    fn blocking_output_sleeps_while_one_pipe_stays_open() {
        let mut command = StdCommand::new("sh");
        command.args(["-c", "exec >&-; sleep 0.2"]);
        let cpu_before = thread_cpu_time();

        output_blocking(&mut command, "wait on stderr").unwrap();

        let cpu = thread_cpu_time() - cpu_before;
        assert!(
            cpu < Duration::from_millis(50),
            "waiting 200 ms used {cpu:?} of CPU"
        );
    }

    #[test]
    fn blocking_output_waits_for_a_leader_that_closed_its_pipes() {
        let mut command = StdCommand::new("sh");
        command.args(["-c", "exec >&- 2>&-; sleep 0.2; exit 3"]);
        let started = Instant::now();

        let output = output_blocking_with_timeout(
            &mut command,
            "wait for quiet leader",
            Duration::from_secs(5),
        )
        .expect("leader should exit before the timeout");

        assert_eq!(output.status.code(), Some(3));
        assert!(started.elapsed() >= Duration::from_millis(200));
    }

    #[tokio::test]
    async fn blocking_timeout_kills_a_leader_that_closed_its_pipes() {
        let leader_path = temporary_pid_path("closed-pipes-leader");
        let mut command = StdCommand::new("sh");
        command.args([
            "-c",
            &format!(
                "exec >&- 2>&-; printf %s $$ > '{}'; exec sleep 60",
                leader_path.display()
            ),
        ]);
        let started = Instant::now();

        let error = output_blocking_with_timeout(
            &mut command,
            "run quiet leader",
            Duration::from_millis(100),
        )
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("timed out after 100 ms while trying to run quiet leader"));
        assert!(started.elapsed() >= Duration::from_millis(100));
        assert!(started.elapsed() < Duration::from_secs(4));
        let leader = wait_for_pid(&leader_path).await;
        wait_for_process_exit(leader).await;
        let _ = fs::remove_file(leader_path);
    }

    fn thread_cpu_time() -> Duration {
        let mut time = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        assert_eq!(
            unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut time) },
            0
        );
        Duration::new(time.tv_sec as u64, time.tv_nsec as u32)
    }

    fn temporary_pid_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "computer-use-linux-command-runner-{label}-{}-{}.pid",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    async fn wait_for_pid(path: &PathBuf) -> u32 {
        for _ in 0..100 {
            if let Ok(value) = fs::read_to_string(path) {
                if let Ok(pid) = value.parse() {
                    return pid;
                }
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("child did not record its pid")
    }

    async fn wait_for_process_exit(pid: u32) {
        for _ in 0..100 {
            if !PathBuf::from(format!("/proc/{pid}")).exists() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
        panic!("process {pid} was not killed and reaped")
    }
}

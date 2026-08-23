use anyhow::{Context, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tracing::{debug, trace, warn};
use vt100::Parser;

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send>,
    writer: Box<dyn Write + Send>,
    output: Arc<Mutex<Vec<u8>>>,
    screen: Arc<Mutex<Parser>>,
    read_cursor: usize,
    exited: bool,
}

/// Terminal type advertised to PTY children. The renderer is xterm.js, which
/// speaks the xterm sequence set and supports 256 colours, so this is an
/// accurate claim rather than an optimistic one.
const DEFAULT_TERM: &str = "xterm-256color";

impl PtySession {
    pub fn spawn_shell(cwd: &Path, env: Vec<(String, OsString)>) -> Result<Self> {
        let shell = crate::platform::shell_program();
        Self::spawn(shell, Vec::new(), cwd, env, 24, 80)
    }

    pub fn spawn(
        program: PathBuf,
        args: Vec<String>,
        cwd: &Path,
        env: Vec<(String, OsString)>,
        rows: u16,
        cols: u16,
    ) -> Result<Self> {
        debug!(
            program = %program.display(),
            cwd = %cwd.display(),
            args = ?args,
            env_count = env.len(),
            rows,
            cols,
            "spawning pty session"
        );
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("open pty")?;

        let mut command = CommandBuilder::new(&program);
        command.cwd(cwd);
        command.args(args);

        // CommandBuilder starts from an empty environment, so without this the
        // child runs with no TERM at all: `tput` fails outright ("No value for
        // $TERM"), and ncurses programs, `clear`, pagers and colour output all
        // misbehave. Set before the caller's pairs so an explicit TERM still
        // wins.
        if !env.iter().any(|(key, _)| key == "TERM") {
            command.env("TERM", DEFAULT_TERM);
        }

        for (key, value) in env {
            command.env(key, value);
        }

        let child = pair
            .slave
            .spawn_command(command)
            .with_context(|| format!("spawn pty command {}", program.display()))?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().context("clone pty reader")?;
        let writer = pair.master.take_writer().context("take pty writer")?;
        let output = Arc::new(Mutex::new(Vec::new()));
        let screen = Arc::new(Mutex::new(Parser::new(rows, cols, 0)));
        let output_for_reader = Arc::clone(&output);
        let screen_for_reader = Arc::clone(&screen);
        thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => {
                        trace!(bytes = n, "pty read chunk");
                        if let Ok(mut output) = output_for_reader.lock() {
                            output.extend_from_slice(&buffer[..n]);
                        }
                        if let Ok(mut screen) = screen_for_reader.lock() {
                            screen.process(&buffer[..n]);
                        }
                    }
                    Err(err) => {
                        warn!(error = %err, "pty reader stopped");
                        break;
                    }
                }
            }
        });

        Ok(Self {
            master: pair.master,
            child,
            writer,
            output,
            screen,
            read_cursor: 0,
            exited: false,
        })
    }

    pub fn write(&mut self, input: &str) -> Result<()> {
        self.write_bytes(input.as_bytes())
    }

    pub fn write_bytes(&mut self, input: &[u8]) -> Result<()> {
        trace!(bytes = input.len(), "writing to pty");
        self.writer.write_all(input).context("write to pty")?;
        self.writer.flush().context("flush pty writer")
    }

    pub fn send_line(&mut self, input: &str) -> Result<()> {
        let bytes = crate::codex_tui::encode_send_line(input);
        let (line, enter) = bytes.split_at(bytes.len().saturating_sub(1));
        self.write_bytes(line)?;
        thread::sleep(Duration::from_millis(20));
        self.write_bytes(enter)
    }

    pub fn process_id(&self) -> Option<u32> {
        self.child.process_id()
    }

    #[cfg(unix)]
    pub fn process_group_leader(&self) -> Option<u32> {
        self.master
            .process_group_leader()
            .and_then(|pid| u32::try_from(pid).ok())
    }

    pub fn resize(&self, rows: u16, cols: u16) -> Result<()> {
        trace!(rows, cols, "resizing pty");
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("resize pty")?;
        if let Ok(mut screen) = self.screen.lock() {
            screen.screen_mut().set_size(rows, cols);
        }
        Ok(())
    }

    pub fn has_exited(&mut self) -> Result<bool> {
        if self.exited {
            return Ok(true);
        }
        self.exited = self.child.try_wait().context("poll pty child")?.is_some();
        Ok(self.exited)
    }

    pub fn read_available(&mut self) -> String {
        let Ok(output) = self.output.lock() else {
            return String::new();
        };
        let next = output.get(self.read_cursor..).unwrap_or_default().to_vec();
        self.read_cursor = output.len();
        if !next.is_empty() {
            trace!(bytes = next.len(), "drained pty output");
        }
        String::from_utf8_lossy(&next).into_owned()
    }

    pub fn visible_screen_text(&self) -> String {
        let Ok(screen) = self.screen.lock() else {
            return String::new();
        };
        screen.screen().contents()
    }

    pub fn read_until(&mut self, needle: &str, timeout: Duration) -> Result<String> {
        let deadline = Instant::now() + timeout;
        let mut collected = String::new();
        while Instant::now() < deadline {
            collected.push_str(&self.read_available());
            if collected.contains(needle) {
                return Ok(collected);
            }
            thread::sleep(Duration::from_millis(20));
        }
        anyhow::bail!("timed out waiting for PTY output containing {needle:?}: {collected:?}")
    }

    pub fn stop(&mut self) -> Result<()> {
        debug!(pid = self.process_id(), "stopping pty session");
        if self.child.try_wait().context("poll pty child")?.is_some() {
            let _ = self.child.wait();
            self.exited = true;
            return Ok(());
        }
        if let Some(pid) = self.process_id() {
            request_graceful_stop(pid, self.process_group_leader_for_stop());
            if wait_for_child_exit(&mut *self.child, Duration::from_secs(3))? {
                self.exited = true;
                return Ok(());
            }
            force_stop(pid, self.process_group_leader_for_stop());
            if wait_for_child_exit(&mut *self.child, Duration::from_millis(500))? {
                self.exited = true;
                return Ok(());
            }
        }
        if self.child.try_wait().context("poll pty child")?.is_none() {
            self.child.kill().context("kill pty child")?;
        }
        let _ = self.child.wait();
        self.exited = true;
        Ok(())
    }
}

#[cfg(unix)]
impl PtySession {
    fn process_group_leader_for_stop(&self) -> Option<u32> {
        self.process_group_leader()
    }
}

#[cfg(not(unix))]
impl PtySession {
    fn process_group_leader_for_stop(&self) -> Option<u32> {
        None
    }
}

fn wait_for_child_exit(child: &mut dyn Child, timeout: Duration) -> Result<bool> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if child.try_wait().context("poll pty child")?.is_some() {
            let _ = child.wait();
            return Ok(true);
        }
        thread::sleep(Duration::from_millis(50));
    }
    Ok(false)
}

fn request_graceful_stop(pid: u32, process_group_leader: Option<u32>) {
    if let Some(group_leader) = process_group_leader {
        if crate::platform::terminate_process_group(group_leader, false).unwrap_or(false) {
            return;
        }
    } else if crate::platform::terminate_process_group(pid, false).unwrap_or(false) {
        return;
    }
    let _ = terminate_process(pid, false);
}

fn force_stop(pid: u32, process_group_leader: Option<u32>) {
    if let Some(group_leader) = process_group_leader {
        if crate::platform::terminate_process_group(group_leader, true).unwrap_or(false) {
            return;
        }
    } else if crate::platform::terminate_process_group(pid, true).unwrap_or(false) {
        return;
    }
    let _ = terminate_process(pid, true);
}

#[cfg(unix)]
fn terminate_process(pid: u32, force: bool) -> std::io::Result<bool> {
    let signal = if force { "-KILL" } else { "-TERM" };
    std::process::Command::new("kill")
        .arg(signal)
        .arg(pid.to_string())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
}

#[cfg(windows)]
fn terminate_process(pid: u32, force: bool) -> std::io::Result<bool> {
    crate::platform::terminate_process_tree(pid, force)
}

#[cfg(not(any(unix, windows)))]
fn terminate_process(_pid: u32, _force: bool) -> std::io::Result<bool> {
    Ok(false)
}

impl Drop for PtySession {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// A PTY child with no TERM cannot run `tput`, `clear`, or any ncurses
    /// program, and tools fall back to uncoloured output. Asserted through a
    /// real PTY rather than by inspecting the builder, because the empty-env
    /// behaviour being compensated for here belongs to portable_pty.
    #[cfg(unix)]
    #[test]
    fn spawns_children_with_a_usable_term() {
        let mut session = PtySession::spawn(
            PathBuf::from("/bin/sh"),
            vec!["-c".into(), "printf T=%s\\\\n \"$TERM\"".into()],
            Path::new("/tmp"),
            Vec::new(),
            24,
            80,
        )
        .expect("spawn pty");

        let out = session
            .read_until("T=", Duration::from_secs(5))
            .expect("child reported TERM");
        assert!(
            out.contains("T=xterm-256color"),
            "expected TERM to default to xterm-256color, got {out:?}"
        );
    }

    /// An explicit TERM from the caller must win over the default.
    #[cfg(unix)]
    #[test]
    fn lets_an_explicit_term_override_the_default() {
        let mut session = PtySession::spawn(
            PathBuf::from("/bin/sh"),
            vec!["-c".into(), "printf T=%s\\\\n \"$TERM\"".into()],
            Path::new("/tmp"),
            vec![("TERM".to_string(), OsString::from("dumb"))],
            24,
            80,
        )
        .expect("spawn pty");

        let out = session
            .read_until("T=", Duration::from_secs(5))
            .expect("child reported TERM");
        assert!(out.contains("T=dumb"), "expected caller TERM to win, got {out:?}");
    }
}

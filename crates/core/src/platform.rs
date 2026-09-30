use std::path::PathBuf;
use std::process::Command;

pub fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

pub fn shell_program() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var_os("COMSPEC")
            .filter(|shell| !shell.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("cmd.exe"))
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("SHELL")
            .filter(|shell| !shell.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/bin/sh"))
    }
}

pub fn shell_command(script: &str) -> Command {
    let mut command = Command::new(shell_program());
    #[cfg(windows)]
    command.args(["/D", "/S", "/C", script]);
    #[cfg(not(windows))]
    command.args(["-c", script]);
    command
}

/// A process whose working directory sits inside some directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessInDirectory {
    pub pid: u32,
    pub command: String,
}

/// Every process whose current working directory is `dir` or below it, except
/// this process and its ancestors (a shell that ran us from inside `dir` is not
/// something we should refuse on). Deleting a directory out from under a live
/// process is how a worktree "comes back": the process keeps running there and
/// recreates it on its next write.
///
/// Linux reads `/proc`; other platforms have no cheap equivalent and return an
/// empty list, so this check is best-effort outside Linux.
pub fn processes_with_cwd_under(dir: &std::path::Path) -> Vec<ProcessInDirectory> {
    #[cfg(target_os = "linux")]
    {
        let Ok(dir) = dir.canonicalize() else {
            return Vec::new();
        };
        let excluded = own_process_lineage();
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return Vec::new();
        };
        let mut found = entries
            .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse::<u32>().ok())
            .filter(|pid| !excluded.contains(pid))
            .filter_map(|pid| {
                let cwd = std::fs::read_link(format!("/proc/{pid}/cwd")).ok()?;
                if !cwd.starts_with(&dir) {
                    return None;
                }
                let raw = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
                let command = String::from_utf8_lossy(&raw)
                    .split('\0')
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ");
                let command: String = command.chars().take(120).collect();
                Some(ProcessInDirectory { pid, command })
            })
            .collect::<Vec<_>>();
        found.sort_by_key(|process| process.pid);
        found
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = dir;
        Vec::new()
    }
}

#[cfg(target_os = "linux")]
fn own_process_lineage() -> std::collections::HashSet<u32> {
    let mut lineage = std::collections::HashSet::new();
    let mut pid = std::process::id();
    while pid > 1 && lineage.insert(pid) {
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            break;
        };
        // `pid (comm) state ppid …`; comm may contain spaces or parens, so
        // parse from the last ')'.
        let Some(ppid) = stat
            .rsplit_once(')')
            .and_then(|(_, rest)| rest.split_whitespace().nth(1))
            .and_then(|ppid| ppid.parse::<u32>().ok())
        else {
            break;
        };
        pid = ppid;
    }
    lineage
}

pub fn process_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        let filter = format!("PID eq {pid}");
        Command::new("tasklist.exe")
            .args(["/FI", &filter, "/FO", "CSV", "/NH"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| {
                let stdout = String::from_utf8_lossy(&output.stdout);
                !stdout.contains("No tasks are running")
                    && stdout
                        .lines()
                        .any(|line| line.contains(&format!("\"{pid}\"")))
            })
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let pid = pid.to_string();
        let signalable = Command::new("kill")
            .arg("-0")
            .arg(&pid)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if !signalable {
            return false;
        }

        Command::new("ps")
            .args(["-o", "stat=", "-p", &pid])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| {
                let stat = String::from_utf8_lossy(&output.stdout);
                !stat.trim_start().starts_with('Z')
            })
            .unwrap_or(true)
    }
}

#[cfg(unix)]
pub fn configure_new_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    command.process_group(0);
}

#[cfg(not(unix))]
pub fn configure_new_process_group(_command: &mut Command) {}

/// Send `signal` (e.g. `"-TERM"`) to the process group led by `pid`.
///
/// The `--` matters: procps-ng 4.0.4 (Ubuntu 24.04) reads `kill -TERM -1234`
/// as options, exits 0, and signals nothing, so every group stop silently
/// fell through to killing the leader alone and left the rest of its group —
/// an agent's tool shells — running. pid 0 and 1 are refused outright:
/// `kill -- -0` is our own group and `-1` is every process we may signal.
#[cfg(unix)]
pub fn signal_process_group(pid: u32, signal: &str) -> std::io::Result<bool> {
    if pid <= 1 {
        return Ok(false);
    }
    Command::new("kill")
        .arg(signal)
        .arg("--")
        .arg(format!("-{pid}"))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
}

#[cfg(unix)]
/// Sends SIGINT to the process group rooted at `pid`.
pub fn interrupt_process_group(pid: u32) -> std::io::Result<bool> {
    signal_process_group(pid, "-INT")
}

#[cfg(windows)]
/// Best-effort interruption for a Windows process tree.
///
/// Archductor does not currently attach managed providers to a Windows console
/// control group that can receive CTRL_C_EVENT, so this falls back to the same
/// non-forced tree termination used elsewhere.
pub fn interrupt_process_group(pid: u32) -> std::io::Result<bool> {
    terminate_process_tree(pid, false)
}

#[cfg(not(any(unix, windows)))]
/// Best-effort interruption for platforms without process-group support.
pub fn interrupt_process_group(_pid: u32) -> std::io::Result<bool> {
    Ok(false)
}

#[cfg(unix)]
pub fn terminate_process_group(pid: u32, force: bool) -> std::io::Result<bool> {
    signal_process_group(pid, if force { "-KILL" } else { "-TERM" })
}

#[cfg(windows)]
pub fn terminate_process_group(pid: u32, force: bool) -> std::io::Result<bool> {
    terminate_process_tree(pid, force)
}

#[cfg(not(any(unix, windows)))]
pub fn terminate_process_group(_pid: u32, _force: bool) -> std::io::Result<bool> {
    Ok(false)
}

#[cfg(windows)]
pub fn terminate_process_tree(pid: u32, force: bool) -> std::io::Result<bool> {
    let mut command = Command::new("taskkill.exe");
    command.args(["/PID", &pid.to_string(), "/T"]);
    if force {
        command.arg("/F");
    }
    command.status().map(|status| status.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_program_has_a_platform_default() {
        assert!(!shell_program().as_os_str().is_empty());
    }

    #[test]
    fn shell_command_accepts_a_script() {
        let command = shell_command("echo archductor");
        assert!(!command.get_program().is_empty());
        assert!(!command.get_args().collect::<Vec<_>>().is_empty());
        #[cfg(windows)]
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            ["/D", "/S", "/C", "echo archductor"]
        );
    }

    #[cfg(unix)]
    fn gone_within(pid: u32, timeout: std::time::Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            if !process_alive(pid) {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        !process_alive(pid)
    }

    #[cfg(unix)]
    #[test]
    fn terminating_a_group_stops_every_member_not_just_the_leader() {
        use std::io::BufRead;
        use std::os::unix::process::CommandExt;

        // A leader with a backgrounded member, like an agent and its tool shell.
        let mut leader = Command::new("sh")
            .args(["-c", "sleep 30 & echo $!; wait"])
            .stdout(std::process::Stdio::piped())
            .process_group(0)
            .spawn()
            .unwrap();
        let mut line = String::new();
        std::io::BufReader::new(leader.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let member: u32 = line.trim().parse().unwrap();

        assert!(terminate_process_group(leader.id(), false).unwrap());

        let timeout = std::time::Duration::from_secs(2);
        let leader_gone = gone_within(leader.id(), timeout);
        let member_gone = gone_within(member, timeout);
        for pid in [leader.id(), member] {
            let _ = Command::new("kill")
                .args(["-KILL", &pid.to_string()])
                .status();
        }
        let _ = leader.wait();
        assert!(leader_gone, "group leader survived SIGTERM to its group");
        assert!(
            member_gone,
            "group member {member} survived SIGTERM to its group"
        );
    }

    #[cfg(unix)]
    #[test]
    fn our_own_and_every_group_are_never_signalled() {
        // Would be `kill -- -0` (this test's own group) and `kill -- -1`.
        assert!(!signal_process_group(0, "-TERM").unwrap());
        assert!(!signal_process_group(1, "-TERM").unwrap());
    }
}

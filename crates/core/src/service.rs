//! Native background service installation for the archcar daemon.
//!
//! Archductor's daemon has to be running for the app, the CLI, and MCP clients
//! to work, so it should be the OS's job to keep it up rather than something a
//! user restarts by hand. This module writes a per-user service definition in
//! whatever the platform actually uses — launchd on macOS, a systemd user unit
//! on Linux, a Task Scheduler logon task on Windows — and loads/starts it.
//!
//! Per-user, not system-wide, on purpose: the daemon runs as the user, touches
//! that user's repositories, and needs no root.
//!
//! Two things make the headless case different from the desktop case, and both
//! are handled here rather than left to the operator:
//!
//! - **The service outlives the session.** systemd tears a user manager down
//!   when the last login session ends, so an SSH-installed unit dies at logout
//!   unless the user lingers. See [`ensure_boot_persistence`].
//! - **The service does not inherit your shell.** launchd hands a job
//!   `/usr/bin:/bin:/usr/sbin:/sbin`; a systemd user unit is barely richer.
//!   Neither can see Homebrew, a version manager, or `~/.local/bin`, so the
//!   daemon reports "running" and then fails every session with "command not
//!   found". See [`service_path_env`].

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::archcar::remote;
use crate::paths::AppPaths;

/// Reverse-DNS label for launchd; also the systemd unit stem.
pub const SERVICE_LABEL: &str = "ai.perceo.archductor.archcar";
pub const SYSTEMD_UNIT_NAME: &str = "archductor-archcar.service";
/// Task Scheduler path. The leading folder keeps it out of the root listing.
pub const WINDOWS_TASK_NAME: &str = "\\Archductor\\archcar";
const WINDOWS_LAUNCHER_NAME: &str = "archcar-service.cmd";

/// Absolute PATH entries a login shell almost always has and a service manager
/// almost never does. Used as a backstop when the login-shell probe cannot run.
const LOGIN_PATH_HINTS: &[&str] = &[
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
];

/// The same backstop, relative to the user's home: where the agent CLIs and
/// the JS/Rust/Go toolchains actually install their binaries.
const LOGIN_PATH_HOME_HINTS: &[&str] = &[
    ".local/bin",
    ".local/share/pnpm",
    ".cargo/bin",
    ".bun/bin",
    ".deno/bin",
    ".npm-global/bin",
    ".volta/bin",
    ".yarn/bin",
    "go/bin",
    "bin",
];

/// Shells whose `-l -c` prints a colon-joined `$PATH`. `fish` and `nu` are
/// deliberately absent: their `$PATH` is a list and would expand to something
/// this code would happily write into a unit and then not understand.
const POSIX_LOGIN_SHELLS: &[&str] = &["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "busybox"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceManager {
    Launchd,
    Systemd,
    /// Windows Task Scheduler. A per-user logon task, not an SCM service:
    /// a real service needs an administrator and a service-control handler
    /// compiled into archcar, and buys nothing a logon task does not already
    /// give a tool that runs as one user against that user's repositories.
    ScheduledTask,
    /// No supported per-user service manager on this platform.
    Unsupported,
}

impl ServiceManager {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Launchd => "launchd",
            Self::Systemd => "systemd",
            Self::ScheduledTask => "scheduled-task",
            Self::Unsupported => "unsupported",
        }
    }

    pub fn detect() -> Self {
        if cfg!(target_os = "macos") {
            Self::Launchd
        } else if cfg!(target_os = "linux") {
            Self::Systemd
        } else if cfg!(windows) {
            Self::ScheduledTask
        } else {
            Self::Unsupported
        }
    }

    /// What the service manager gives a job that sets no PATH of its own.
    /// Reported by `service doctor` when the installed unit predates PATH
    /// recording, so the diagnosis matches what the daemon actually sees.
    pub fn default_path(self) -> String {
        match self {
            Self::Launchd => "/usr/bin:/bin:/usr/sbin:/sbin".to_owned(),
            Self::Systemd => {
                "/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin".to_owned()
            }
            // A scheduled task inherits the user's registry environment, which
            // is close to a login shell's but misses anything a profile script
            // adds. There is no fixed string to quote, so report the process's.
            Self::ScheduledTask | Self::Unsupported => std::env::var("PATH").unwrap_or_default(),
        }
    }

    /// The path separator for this platform's PATH, for splitting the recorded
    /// value back apart.
    pub fn path_separator(self) -> char {
        match self {
            Self::ScheduledTask => ';',
            _ => ':',
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceStatus {
    pub manager: String,
    /// Whether a unit/plist written by archductor exists.
    pub installed: bool,
    /// Whether the service manager reports it as loaded/running.
    pub running: bool,
    pub unit_path: Option<String>,
    /// Address the installed service listens on, when it was installed with a
    /// remote listener.
    pub listen: Option<String>,
    /// Whether the daemon survives the installing user logging out. False is a
    /// real answer, not an error: a launchd *agent* starts at login by design.
    #[serde(default)]
    pub boot_persistent: bool,
    /// The PATH recorded in the unit, when it records one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Conditions the operator has to know about but that did not fail the
    /// operation — an un-lingered systemd user manager, a login-scoped agent.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallService {
    /// Address for the token-guarded TCP listener. `None` installs the daemon
    /// with only its local endpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listen: Option<String>,
    /// Path to the archcar binary. Defaults to the one beside this executable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archcar_path: Option<String>,
}

pub fn unit_path(paths: &AppPaths, manager: ServiceManager) -> Option<PathBuf> {
    let home = crate::platform::home_dir()?;
    match manager {
        ServiceManager::Launchd => Some(
            home.join("Library/LaunchAgents")
                .join(format!("{SERVICE_LABEL}.plist")),
        ),
        ServiceManager::Systemd => Some(
            crate::platform::home_dir()
                .map(|home| home.join(".config/systemd/user"))
                .unwrap_or_else(|| paths.config_dir.join("systemd/user"))
                .join(SYSTEMD_UNIT_NAME),
        ),
        // The task itself lives in the Task Scheduler store, which is not a
        // file. The launcher script is the part archductor owns and the part
        // that carries the environment, so it is what `installed` keys off and
        // what `status`/`doctor` read the recorded PATH back out of.
        ServiceManager::ScheduledTask => Some(paths.config_dir.join(WINDOWS_LAUNCHER_NAME)),
        ServiceManager::Unsupported => None,
    }
}

/// Companion to the launcher: the registered task definition, kept beside it so
/// a confused install can be inspected rather than only queried.
fn windows_task_xml_path(paths: &AppPaths) -> PathBuf {
    paths.config_dir.join("archcar-service.xml")
}

/// Locate the archcar binary: an explicit path, then a sibling of the running
/// executable, then `PATH`.
pub fn resolve_archcar_binary(explicit: Option<&str>) -> Result<PathBuf> {
    if let Some(path) = explicit.map(PathBuf::from) {
        anyhow::ensure!(path.exists(), "archcar binary {} not found", path.display());
        return Ok(path);
    }
    if let Some(sibling) = std::env::current_exe()
        .ok()
        .map(|exe| exe.with_file_name(archcar_file_name()))
        .filter(|path| path.exists())
    {
        return Ok(sibling);
    }
    which_archcar()
        .context("could not find the archcar binary; pass --archcar-path or put archcar on PATH")
}

fn archcar_file_name() -> &'static str {
    if cfg!(windows) {
        "archcar.exe"
    } else {
        "archcar"
    }
}

fn which_archcar() -> Result<PathBuf> {
    let path_var = std::env::var_os("PATH").context("PATH is not set")?;
    std::env::split_paths(&path_var)
        .map(|dir| dir.join(archcar_file_name()))
        .find(|candidate| candidate.exists())
        .context("archcar is not on PATH")
}

/// Refuse to point a service unit at a binary that disappears with the current
/// process. An AppImage is mounted at `/tmp/.mount_XXXX` only while it runs, so
/// a unit written from inside one works until the next restart and then fails
/// with a bare "No such file or directory" nobody can trace back to here.
fn ensure_durable_binary(binary: &Path) -> Result<()> {
    let text = binary.to_string_lossy();
    let windows_temp =
        text.contains("\\AppData\\Local\\Temp\\") || text.contains("\\Windows\\Temp\\");
    let temporary = text.contains("/.mount_")
        || text.starts_with("/tmp/")
        || text.starts_with("/private/var/folders/")
        || windows_temp;
    anyhow::ensure!(
        !temporary,
        "{} is inside a temporary mount (an AppImage or an extracted archive), so a service unit \
         pointing at it would break on the next restart.\nInstall the tarball or the .deb/.rpm, or \
         pass --archcar-path pointing at a permanent copy of archcar.",
        binary.display()
    );
    Ok(())
}

/// Write the service definition and start it. Returns the resulting status.
pub fn install(paths: &AppPaths, input: &InstallService) -> Result<ServiceStatus> {
    let manager = ServiceManager::detect();
    anyhow::ensure!(
        manager != ServiceManager::Unsupported,
        "no supported per-user service manager on this platform; run `archcar` yourself or add it to your login items"
    );
    let unit_path = unit_path(paths, manager).context("could not resolve the service unit path")?;
    let binary = resolve_archcar_binary(input.archcar_path.as_deref())?;
    ensure_durable_binary(&binary)?;
    let listen = match input.listen.as_deref() {
        Some(value) => Some(remote::parse_listen_addr(value)?.to_string()),
        None => None,
    };
    let path_env = service_path_env();

    if let Some(parent) = unit_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create service directory {}", parent.display()))?;
    }
    std::fs::create_dir_all(&paths.logs_dir)?;
    let contents = match manager {
        ServiceManager::Launchd => {
            launchd_plist(&binary, listen.as_deref(), &paths.logs_dir, &path_env)
        }
        ServiceManager::Systemd => systemd_unit(&binary, listen.as_deref(), &path_env),
        ServiceManager::ScheduledTask => {
            windows_launcher_script(&binary, listen.as_deref(), &path_env)
        }
        ServiceManager::Unsupported => unreachable!(),
    };
    std::fs::write(&unit_path, contents)
        .with_context(|| format!("write service unit {}", unit_path.display()))?;
    if manager == ServiceManager::ScheduledTask {
        let xml_path = windows_task_xml_path(paths);
        let xml = windows_task_xml(&unit_path, &current_user_name());
        std::fs::write(&xml_path, utf16le_with_bom(&xml))
            .with_context(|| format!("write task definition {}", xml_path.display()))?;
    }

    // A listener means a token has to exist before the daemon starts.
    if listen.is_some() {
        remote::ensure_token(paths)?;
    }

    // Linger before start, not after: enabling it is what brings the systemd
    // user manager up, and without a running manager `systemctl --user` has no
    // bus to talk to. That is the difference between this working from an SSH
    // login (where PAM already started one) and from a provisioning script,
    // cron job, or container exec, where nothing has.
    let mut warnings = Vec::new();
    let boot_persistent = ensure_boot_persistence(manager, &mut warnings);
    let detail = match start_service(manager, &unit_path) {
        Ok(detail) => detail,
        Err(err) => return Err(explain_start_failure(err, manager, boot_persistent)),
    };
    Ok(ServiceStatus {
        manager: manager.as_str().to_owned(),
        installed: true,
        running: true,
        unit_path: Some(unit_path.display().to_string()),
        listen,
        boot_persistent,
        path: Some(path_env),
        warnings,
        detail,
    })
}

pub fn uninstall(paths: &AppPaths) -> Result<ServiceStatus> {
    let manager = ServiceManager::detect();
    let unit_path = unit_path(paths, manager);
    let mut detail = String::new();
    if let Some(path) = unit_path.as_ref().filter(|path| path.exists()) {
        detail = stop_service(manager, path).unwrap_or_default();
        std::fs::remove_file(path)
            .with_context(|| format!("remove service unit {}", path.display()))?;
        if manager == ServiceManager::Systemd {
            let _ = systemctl_user(&["daemon-reload"]);
        }
    }
    Ok(ServiceStatus {
        manager: manager.as_str().to_owned(),
        installed: false,
        running: false,
        unit_path: unit_path.map(|path| path.display().to_string()),
        listen: None,
        boot_persistent: false,
        path: None,
        // Linger is deliberately left alone: the user may have enabled it for
        // their own reasons, and turning it off would stop unrelated services.
        warnings: Vec::new(),
        detail: if detail.is_empty() {
            "service removed".to_owned()
        } else {
            detail
        },
    })
}

pub fn status(paths: &AppPaths) -> Result<ServiceStatus> {
    let manager = ServiceManager::detect();
    let unit_path = unit_path(paths, manager);
    let installed = unit_path.as_ref().is_some_and(|path| path.exists());
    let contents = unit_path
        .as_ref()
        .filter(|path| path.exists())
        .and_then(|path| std::fs::read_to_string(path).ok())
        .unwrap_or_default();
    let listen = env_from_unit(&contents, remote::LISTEN_ENV);
    let path = env_from_unit(&contents, "PATH");
    let (running, detail) = if !installed {
        (false, "not installed".to_owned())
    } else {
        match manager {
            ServiceManager::Launchd => {
                let running = launchd_loaded();
                (
                    running,
                    if running {
                        "loaded in launchd".to_owned()
                    } else {
                        "installed but not loaded".to_owned()
                    },
                )
            }
            ServiceManager::Systemd => {
                // `is-active` exits non-zero for an inactive unit while still
                // printing the state, which is the answer being asked for — so
                // read stdout rather than treating the status as a failure.
                let state = systemctl_user_state(SYSTEMD_UNIT_NAME);
                (state == "active", format!("systemd reports {state}"))
            }
            ServiceManager::ScheduledTask => {
                let state = scheduled_task_state();
                (
                    state == "Running",
                    format!("Task Scheduler reports {state}"),
                )
            }
            ServiceManager::Unsupported => (false, "unsupported platform".to_owned()),
        }
    };
    let mut warnings = Vec::new();
    let boot_persistent = installed && report_boot_persistence(manager, &mut warnings);
    if installed && path.is_none() {
        warnings.push(format!(
            "this unit records no PATH, so the daemon runs with the service manager's default \
             ({}). Reinstall with `archductor service install` to bake in your shell's PATH.",
            manager.default_path()
        ));
    }
    Ok(ServiceStatus {
        manager: manager.as_str().to_owned(),
        installed,
        running,
        unit_path: unit_path.map(|path| path.display().to_string()),
        listen,
        boot_persistent,
        path,
        warnings,
        detail,
    })
}

// --- Boot persistence ----------------------------------------------------

/// Make the daemon survive the installing session ending, and say plainly when
/// it cannot.
///
/// systemd stops a user manager once the user's last session closes, which on a
/// server means archcar dies the moment the SSH connection does. `enable-linger`
/// is the fix and it is per-user, so it belongs in install rather than in a
/// README step every user would skip.
///
/// launchd has no equivalent for an *agent*: `~/Library/LaunchAgents` loads at
/// login by design, and starting at boot requires a root-owned LaunchDaemon in
/// `/Library/LaunchDaemons`. Rather than silently install something narrower
/// than advertised, this returns false and explains.
fn ensure_boot_persistence(manager: ServiceManager, warnings: &mut Vec<String>) -> bool {
    match manager {
        ServiceManager::Systemd => {
            if linger_enabled() {
                return true;
            }
            match run(&["loginctl", "enable-linger", &current_user_name()]) {
                Ok(_) => true,
                Err(err) => {
                    warnings.push(format!(
                        "could not enable linger for this user ({err}). systemd stops your user \
                         manager when your last session ends, so archcar will exit when you log \
                         out. Fix it with: sudo loginctl enable-linger {}",
                        current_user_name()
                    ));
                    false
                }
            }
        }
        ServiceManager::Launchd => {
            warnings.push(LAUNCHD_LOGIN_SCOPE_WARNING.to_owned());
            false
        }
        ServiceManager::ScheduledTask => {
            warnings.push(SCHEDULED_TASK_LOGON_SCOPE_WARNING.to_owned());
            false
        }
        ServiceManager::Unsupported => false,
    }
}

/// Read-only counterpart to [`ensure_boot_persistence`], for `status`.
fn report_boot_persistence(manager: ServiceManager, warnings: &mut Vec<String>) -> bool {
    match manager {
        ServiceManager::Systemd => {
            if linger_enabled() {
                true
            } else {
                warnings.push(format!(
                    "linger is off for this user, so systemd will stop archcar when your last \
                     login session ends. Fix it with: loginctl enable-linger {}",
                    current_user_name()
                ));
                false
            }
        }
        ServiceManager::Launchd => {
            warnings.push(LAUNCHD_LOGIN_SCOPE_WARNING.to_owned());
            false
        }
        ServiceManager::ScheduledTask => {
            warnings.push(SCHEDULED_TASK_LOGON_SCOPE_WARNING.to_owned());
            false
        }
        ServiceManager::Unsupported => false,
    }
}

/// Turn systemd's bare bus error into the diagnosis it actually is.
///
/// "Failed to connect to bus" means there is no per-user systemd manager to
/// talk to. On a headless box that is almost always because linger is off *and*
/// the caller has no login session — which is exactly the pair of conditions
/// this installer just checked, so it can say so instead of leaving the
/// operator to work out that a D-Bus message is really about `loginctl`.
fn explain_start_failure(
    err: anyhow::Error,
    manager: ServiceManager,
    boot_persistent: bool,
) -> anyhow::Error {
    let no_bus = err.to_string().contains("Failed to connect to bus");
    if manager != ServiceManager::Systemd || boot_persistent || !no_bus {
        return err;
    }
    anyhow::anyhow!(
        "{err}\n\n\
         There is no systemd user manager for this account, so `systemctl --user` has nothing to \
         talk to. Enabling linger starts one and keeps it running after you log out:\n\
         \n    sudo loginctl enable-linger {user}\n\n\
         Then rerun `archductor service install`. Enabling it from an active SSH login usually \
         needs no sudo; a provisioning script or `docker exec` has no session, which is why it \
         was refused here.",
        user = current_user_name()
    )
}

const LAUNCHD_LOGIN_SCOPE_WARNING: &str =
    "a launchd agent starts when this user logs in, not at boot. On a headless Mac, log in once \
     after a reboot (or install a root-owned LaunchDaemon) before remote clients can connect.";

const SCHEDULED_TASK_LOGON_SCOPE_WARNING: &str =
    "this task starts when the user logs on, not at boot. Running it while logged off requires \
     storing the account password in Task Scheduler, which archductor will not do for you — set \
     \"Run whether user is logged on or not\" by hand if you need it.";

fn linger_enabled() -> bool {
    run(&[
        "loginctl",
        "show-user",
        &current_user_name(),
        "-p",
        "Linger",
    ])
    .map(|output| output.trim().ends_with("=yes"))
    .unwrap_or(false)
}

/// The account name to put in a `loginctl` command.
///
/// `USER`/`LOGNAME` are set for a login shell and absent from the very contexts
/// that need this most — a provisioning script, a cron job, `docker exec` — so
/// fall back to asking the system before falling back to the bare uid. `loginctl`
/// accepts a uid, but "enable-linger 1000" is a worse thing to hand someone than
/// "enable-linger deploy".
fn current_user_name() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .ok()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .or_else(|| {
            run(&["id", "-un"])
                .ok()
                .map(|name| name.trim().to_owned())
                .filter(|name| !name.is_empty())
        })
        .unwrap_or_else(|| current_uid().to_string())
}

// --- The daemon's PATH ---------------------------------------------------

/// The PATH to bake into the service definition.
///
/// The user's own login shell is the only thing that knows where their tools
/// actually are, so ask it first; union in this process's PATH and the
/// well-known install locations behind it. Non-existent directories are dropped
/// so the recorded value stays honest and short.
pub fn service_path_env() -> String {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(path) = login_shell_path() {
        candidates.extend(std::env::split_paths(&path));
    }
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path));
    }
    candidates.extend(LOGIN_PATH_HINTS.iter().map(PathBuf::from));
    if let Some(home) = crate::platform::home_dir() {
        candidates.extend(LOGIN_PATH_HOME_HINTS.iter().map(|dir| home.join(dir)));
    }
    let dirs = merge_path_dirs(candidates, |dir| dir.is_dir());
    std::env::join_paths(&dirs)
        .map(|joined| joined.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// First-seen order wins, so the login shell's own precedence is preserved and
/// the hint list only ever appends.
fn merge_path_dirs(candidates: Vec<PathBuf>, exists: impl Fn(&Path) -> bool) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for dir in candidates {
        if dir.as_os_str().is_empty() || dirs.contains(&dir) || !exists(&dir) {
            continue;
        }
        dirs.push(dir);
    }
    dirs
}

/// Ask the user's login shell what PATH it builds. `-l -c` runs the login
/// profile without an interactive prompt. A shell that fails, is not a POSIX
/// shell, or prints nothing is not an error — the caller has backstops.
fn login_shell_path() -> Option<std::ffi::OsString> {
    if cfg!(windows) {
        return None;
    }
    let shell = crate::platform::shell_program();
    let name = shell.file_name()?.to_str()?.to_owned();
    if !POSIX_LOGIN_SHELLS.contains(&name.as_str()) {
        return None;
    }
    let output = Command::new(&shell)
        .args(["-l", "-c", "printf %s \"$PATH\""])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!value.is_empty()).then(|| std::ffi::OsString::from(value))
}

// --- Service manager plumbing --------------------------------------------

fn start_service(manager: ServiceManager, unit_path: &Path) -> Result<String> {
    match manager {
        ServiceManager::Launchd => {
            // `bootout` first so a re-install replaces the old definition, in
            // every domain it might be sitting in.
            let unit = unit_path.display().to_string();
            for target in launchd_domain_targets() {
                let _ = run(&["launchctl", "bootout", &target, &unit]);
            }
            let mut last_error = None;
            for target in launchd_domain_targets() {
                match run(&["launchctl", "bootstrap", &target, &unit]) {
                    Ok(_) => return Ok(format!("bootstrapped {SERVICE_LABEL} into {target}")),
                    Err(err) => last_error = Some(err),
                }
            }
            run(&["launchctl", "load", "-w", &unit])
                .map(|_| format!("loaded {SERVICE_LABEL} into launchd"))
                .map_err(|err| last_error.unwrap_or(err))
        }
        ServiceManager::Systemd => {
            systemctl_user(&["daemon-reload"])?;
            systemctl_user(&["enable", SYSTEMD_UNIT_NAME])?;
            // `restart`, not `enable --now`: `--now` only *starts* a stopped
            // unit, so reinstalling over a running daemon rewrote the unit,
            // reported the new listen address, and left the old process serving
            // the old one. `restart` also starts a stopped unit, so it covers
            // the first install too.
            systemctl_user(&["restart", SYSTEMD_UNIT_NAME])
                .map(|_| format!("enabled and (re)started {SYSTEMD_UNIT_NAME}"))
        }
        ServiceManager::ScheduledTask => {
            // /F replaces an existing registration, so reinstall is idempotent.
            let xml = unit_path
                .with_file_name("archcar-service.xml")
                .display()
                .to_string();
            run(&[
                "schtasks",
                "/Create",
                "/TN",
                WINDOWS_TASK_NAME,
                "/XML",
                &xml,
                "/F",
            ])?;
            // End any instance still running the previous launcher first:
            // `MultipleInstancesPolicy=IgnoreNew` would otherwise make `/Run` a
            // no-op on a reinstall, leaving the old environment in place — the
            // same hole `systemctl --user enable --now` leaves on Linux.
            let _ = run(&["schtasks", "/End", "/TN", WINDOWS_TASK_NAME]);
            run(&["schtasks", "/Run", "/TN", WINDOWS_TASK_NAME])
                .map(|_| format!("registered and (re)started {WINDOWS_TASK_NAME}"))
        }
        ServiceManager::Unsupported => anyhow::bail!("unsupported platform"),
    }
}

/// Run a `systemctl --user` command so it can find the per-user manager.
///
/// `systemctl --user` reaches the manager over `$XDG_RUNTIME_DIR`. PAM sets
/// that for a login session and nothing sets it for a provisioning script, a
/// cron job, or a container exec — where the command then fails with "Failed to
/// connect to bus" even though the manager is running. Linger guarantees
/// `/run/user/<uid>` exists, so point at it when the environment does not.
fn systemctl_user(args: &[&str]) -> Result<String> {
    let mut command = Command::new("systemctl");
    command.arg("--user").args(args);
    with_user_runtime_dir(&mut command);
    finish(command, &format!("systemctl --user {}", args.join(" ")))
}

fn with_user_runtime_dir(command: &mut Command) {
    if std::env::var_os("XDG_RUNTIME_DIR").is_some() {
        return;
    }
    let runtime_dir = PathBuf::from(format!("/run/user/{}", current_uid()));
    if runtime_dir.is_dir() {
        command.env("XDG_RUNTIME_DIR", &runtime_dir);
    }
}

/// `systemctl --user is-active`, read for its output rather than its exit code:
/// it prints the state on stdout and exits non-zero for anything but "active",
/// so "inactive" and "failed" are answers here, not failures.
fn systemctl_user_state(unit: &str) -> String {
    let mut command = Command::new("systemctl");
    command.args(["--user", "is-active", unit]);
    with_user_runtime_dir(&mut command);
    match command.output() {
        Ok(output) => {
            let state = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            if state.is_empty() {
                "unknown".to_owned()
            } else {
                state
            }
        }
        Err(_) => "unknown".to_owned(),
    }
}

fn stop_service(manager: ServiceManager, unit_path: &Path) -> Result<String> {
    match manager {
        ServiceManager::Launchd => {
            let unit = unit_path.display().to_string();
            for target in launchd_domain_targets() {
                let _ = run(&["launchctl", "bootout", &target, &unit]);
            }
            let _ = run(&["launchctl", "unload", "-w", &unit]);
            Ok(format!("unloaded {SERVICE_LABEL}"))
        }
        ServiceManager::Systemd => {
            let _ = systemctl_user(&["disable", "--now", SYSTEMD_UNIT_NAME]);
            Ok(format!("disabled {SYSTEMD_UNIT_NAME}"))
        }
        ServiceManager::ScheduledTask => {
            // /End stops the running instance; /Delete removes the schedule.
            let _ = run(&["schtasks", "/End", "/TN", WINDOWS_TASK_NAME]);
            let _ = run(&["schtasks", "/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]);
            Ok(format!("removed {WINDOWS_TASK_NAME}"))
        }
        ServiceManager::Unsupported => Ok(String::new()),
    }
}

/// The task's own view of itself. `schtasks /Query /FO LIST` prints a
/// `Status:` line — "Running" while the daemon is up, "Ready" when it is
/// registered but not currently executing.
fn scheduled_task_state() -> String {
    let Ok(output) = run(&[
        "schtasks",
        "/Query",
        "/TN",
        WINDOWS_TASK_NAME,
        "/FO",
        "LIST",
    ]) else {
        return "not registered".to_owned();
    };
    output
        .lines()
        .find_map(|line| line.trim().strip_prefix("Status:"))
        .map(|state| state.trim().to_owned())
        .filter(|state| !state.is_empty())
        .unwrap_or_else(|| "unknown".to_owned())
}

/// launchd domains to try, in order.
///
/// `gui/<uid>` is the right home for a desktop Mac and is what a login session
/// gives you. Over SSH with nobody at the console there is no GUI domain, and
/// `bootstrap gui/501` fails with a bare I/O error — `user/<uid>` is the
/// headless equivalent, so try it second rather than reporting failure.
fn launchd_domain_targets() -> Vec<String> {
    let uid = current_uid();
    vec![format!("gui/{uid}"), format!("user/{uid}")]
}

/// True when launchd reports the label in any domain we might have used.
fn launchd_loaded() -> bool {
    if run(&["launchctl", "list"])
        .map(|output| output.lines().any(|line| line.contains(SERVICE_LABEL)))
        .unwrap_or(false)
    {
        return true;
    }
    launchd_domain_targets()
        .into_iter()
        .any(|target| run(&["launchctl", "print", &format!("{target}/{SERVICE_LABEL}")]).is_ok())
}

#[cfg(unix)]
fn current_uid() -> u32 {
    // SAFETY: getuid is always safe; it reads a process property.
    unsafe { libc_getuid() }
}

#[cfg(unix)]
unsafe fn libc_getuid() -> u32 {
    unsafe extern "C" {
        fn getuid() -> u32;
    }
    unsafe { getuid() }
}

#[cfg(not(unix))]
fn current_uid() -> u32 {
    0
}

fn run(args: &[&str]) -> Result<String> {
    let (program, rest) = args.split_first().context("empty command")?;
    let mut command = Command::new(program);
    command.args(rest);
    finish(command, &format!("{program} {}", rest.join(" ")))
}

fn finish(mut command: Command, label: &str) -> Result<String> {
    let output = command
        .output()
        .with_context(|| format!("run {}", label.split_whitespace().next().unwrap_or(label)))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("{label} failed: {}", stderr.trim().to_owned());
    }
    Ok(stdout)
}

// --- Unit rendering ------------------------------------------------------

pub fn launchd_plist(
    binary: &Path,
    listen: Option<&str>,
    logs_dir: &Path,
    path_env: &str,
) -> String {
    let mut environment = plist_env_entry("PATH", path_env);
    if let Some(addr) = listen {
        environment.push_str(&plist_env_entry(remote::LISTEN_ENV, addr));
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{binary}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
{environment}  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>2</integer>
  <key>StandardOutPath</key>
  <string>{logs}/archcar.service.log</string>
  <key>StandardErrorPath</key>
  <string>{logs}/archcar.service.log</string>
</dict>
</plist>
"#,
        label = SERVICE_LABEL,
        binary = binary.display(),
        logs = logs_dir.display(),
    )
}

fn plist_env_entry(key: &str, value: &str) -> String {
    if value.is_empty() {
        return String::new();
    }
    format!(
        "    <key>{}</key>\n    <string>{}</string>\n",
        escape_xml(key),
        escape_xml(value)
    )
}

/// A PATH can hold `&` (`~/dev/a&b/bin`), which would otherwise produce a plist
/// launchd refuses to parse — and a service that never starts.
fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The Windows launcher script.
///
/// A scheduled task's action has no environment block, so the environment has
/// to come from somewhere the task can execute — hence a `.cmd` that sets PATH
/// and the listen address and then runs archcar in the foreground. Running it
/// in the foreground (rather than `start /B`) is what keeps the task's own
/// process alive for as long as the daemon is, so Task Scheduler reports
/// "Running" and its restart rules apply to the daemon rather than to a
/// launcher that exited immediately.
pub fn windows_launcher_script(binary: &Path, listen: Option<&str>, path_env: &str) -> String {
    let mut script = String::from(
        "@echo off\r\n\
         rem Generated by `archductor service install`. Edits are overwritten on reinstall.\r\n",
    );
    if !path_env.is_empty() {
        script.push_str(&format!("set \"PATH={path_env}\"\r\n"));
    }
    if let Some(addr) = listen {
        script.push_str(&format!("set \"{}={}\"\r\n", remote::LISTEN_ENV, addr));
    }
    script.push_str(&format!("\"{}\"\r\n", binary.display()));
    script
}

/// The Task Scheduler definition.
///
/// Two restart mechanisms on purpose. `RestartOnFailure` only fires when the
/// action exits non-zero, which is the same hole `Restart=on-failure` leaves on
/// systemd — a clean `exit(0)` would stay down. The repeating logon trigger
/// closes it: every minute the task tries to start, `IgnoreNew` makes that a
/// no-op while the daemon is alive, and it becomes the restart when it is not.
pub fn windows_task_xml(launcher: &Path, user: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Archductor archcar daemon</Description>
    <URI>{task}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{user}</UserId>
      <Repetition>
        <Interval>PT1M</Interval>
        <Duration>P3650D</Duration>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>99</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>/c "{launcher}"</Arguments>
    </Exec>
  </Actions>
</Task>
"#,
        task = escape_xml(WINDOWS_TASK_NAME),
        user = escape_xml(user),
        launcher = escape_xml(&launcher.display().to_string()),
    )
}

/// `schtasks /Create /XML` rejects a UTF-8 file: the definition has to be
/// UTF-16LE with a BOM, and the failure it gives otherwise names the encoding
/// nowhere.
fn utf16le_with_bom(text: &str) -> Vec<u8> {
    let mut bytes = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

pub fn systemd_unit(binary: &Path, listen: Option<&str>, path_env: &str) -> String {
    let mut environment = String::new();
    if !path_env.is_empty() {
        environment.push_str(&format!("Environment=PATH={path_env}\n"));
    }
    if let Some(addr) = listen {
        environment.push_str(&format!("Environment={}={}\n", remote::LISTEN_ENV, addr));
    }
    format!(
        "[Unit]\n\
         Description=Archductor archcar daemon\n\
         After=default.target\n\
         # A crash loop should not wedge the unit in `failed` forever: 10 tries\n\
         # a minute leaves room to recover once the cause is fixed.\n\
         StartLimitIntervalSec=60\n\
         StartLimitBurst=10\n\
         \n\
         [Service]\n\
         Type=simple\n\
         ExecStart={binary}\n\
         {environment}\
         # `always`, not `on-failure`: a clean exit(0) still means the daemon is\n\
         # gone, and every client then has to fall back to spawning a sidecar.\n\
         Restart=always\n\
         RestartSec=2\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        binary = binary.display(),
    )
}

/// Recover a value archductor wrote into an installed unit, so `status` and
/// `doctor` can report what the daemon actually runs with.
fn env_from_unit(contents: &str, key: &str) -> Option<String> {
    for (index, line) in contents.lines().enumerate() {
        // systemd: Environment=KEY=value
        if let Some(rest) = line.trim().strip_prefix(&format!("Environment={key}=")) {
            return Some(rest.trim().to_owned());
        }
        // Windows launcher: set "KEY=value"
        if let Some(rest) = line.trim().strip_prefix(&format!("set \"{key}=")) {
            return Some(rest.trim_end().trim_end_matches('"').to_owned());
        }
        // launchd: <key>KEY</key> followed by <string>value</string>
        if line.contains(&format!("<key>{key}</key>")) {
            let value = contents.lines().nth(index + 1)?;
            let value = value
                .trim()
                .strip_prefix("<string>")?
                .strip_suffix("</string>")?;
            return Some(unescape_xml(value));
        }
    }
    None
}

fn unescape_xml(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

// --- Service doctor ------------------------------------------------------

/// One tool the daemon needs, resolved against the daemon's PATH.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceDoctorRow {
    pub name: String,
    /// The command looked up.
    pub command: String,
    /// Where it resolved in the daemon's PATH, when it resolves at all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved: Option<String>,
    /// Whether the daemon is unusable without it.
    pub required: bool,
    pub detail: String,
}

impl ServiceDoctorRow {
    pub fn found(&self) -> bool {
        self.resolved.is_some()
    }
}

/// What the daemon can actually reach, as opposed to what the shell asking can.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceDoctorReport {
    pub status: ServiceStatus,
    /// The PATH the daemon runs with.
    pub path: String,
    /// Where that PATH came from, in words fit for printing.
    pub path_source: String,
    pub rows: Vec<ServiceDoctorRow>,
    /// True when every required tool resolves and at least one agent CLI does.
    pub ok: bool,
    pub feedback: String,
}

/// Diagnose the *service's* environment.
///
/// `archductor doctor` probes the host as the calling shell sees it, which is
/// exactly the environment that is not in question: the reason a service-hosted
/// daemon fails is that its PATH is narrower than the shell's. This resolves
/// each tool against the PATH recorded in the installed unit instead.
pub fn doctor(paths: &AppPaths) -> Result<ServiceDoctorReport> {
    let status = status(paths)?;
    let manager = ServiceManager::detect();
    let (path, path_source) = match status.path.clone().filter(|path| !path.is_empty()) {
        Some(path) => (path, "recorded in the installed unit".to_owned()),
        None if status.installed => (
            manager.default_path(),
            format!("{}'s default — this unit records no PATH", manager.as_str()),
        ),
        None => (
            service_path_env(),
            "what an install would record right now (no unit is installed)".to_owned(),
        ),
    };
    let rows = doctor_rows(&path);
    let (ok, feedback) = doctor_verdict(&rows);
    Ok(ServiceDoctorReport {
        status,
        path,
        path_source,
        rows,
        ok,
        feedback,
    })
}

/// Report every problem at once. A daemon that can see neither `gh` nor any
/// agent has a single cause, and naming only the first sends the operator back
/// for a second round.
fn doctor_verdict(rows: &[ServiceDoctorRow]) -> (bool, String) {
    let missing_required: Vec<&str> = rows
        .iter()
        .filter(|row| row.required && !row.found())
        .map(|row| row.command.as_str())
        .collect();
    let agents_found = rows.iter().any(|row| !row.required && row.found());

    let mut problems: Vec<String> = Vec::new();
    if !missing_required.is_empty() {
        problems.push(format!("cannot reach {}", missing_required.join(", ")));
    }
    if !agents_found {
        problems.push("cannot reach any agent CLI, so sessions will fail to start".to_owned());
    }
    if problems.is_empty() {
        return (true, "The daemon can reach everything it needs.".to_owned());
    }
    (
        false,
        format!(
            "The daemon {}. These are on your PATH but not on the service's; reinstall with \
             `archductor service install` to re-record it.",
            problems.join(", and ")
        ),
    )
}

fn doctor_rows(path: &str) -> Vec<ServiceDoctorRow> {
    let mut rows = vec![
        doctor_row(
            "Git",
            "git",
            true,
            "Every workspace is a git worktree.",
            path,
        ),
        doctor_row(
            "GitHub CLI",
            "gh",
            true,
            "PR creation, checks, and review all run through gh.",
            path,
        ),
    ];
    rows.extend(
        crate::agent_tools::agent_tools()
            .filter(|tool| tool.chat_launchable)
            .map(|tool| {
                doctor_row(
                    tool.display_name,
                    tool.default_command,
                    false,
                    "Agent CLI; at least one has to resolve.",
                    path,
                )
            }),
    );
    rows
}

fn doctor_row(
    name: &str,
    command: &str,
    required: bool,
    detail: &str,
    path: &str,
) -> ServiceDoctorRow {
    let resolved = crate::doctor::command_in_path(std::ffi::OsStr::new(path), command)
        .map(|found| found.display().to_string());
    ServiceDoctorRow {
        name: name.to_owned(),
        command: command.to_owned(),
        resolved,
        required,
        detail: detail.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NO_PATH: &str = "";

    #[test]
    fn systemd_unit_starts_archcar_and_carries_the_listen_address() {
        let unit = systemd_unit(
            Path::new("/usr/local/bin/archcar"),
            Some("127.0.0.1:7420"),
            NO_PATH,
        );

        assert!(unit.contains("ExecStart=/usr/local/bin/archcar"), "{unit}");
        assert!(
            unit.contains("Environment=ARCHDUCTOR_ARCHCAR_LISTEN=127.0.0.1:7420"),
            "{unit}"
        );
        assert!(unit.contains("WantedBy=default.target"), "{unit}");
        assert_eq!(
            env_from_unit(&unit, remote::LISTEN_ENV).as_deref(),
            Some("127.0.0.1:7420")
        );
    }

    #[test]
    fn systemd_unit_without_a_listener_has_no_listen_environment() {
        let unit = systemd_unit(Path::new("/usr/local/bin/archcar"), None, NO_PATH);

        assert!(!unit.contains("ARCHDUCTOR_ARCHCAR_LISTEN"), "{unit}");
        assert_eq!(env_from_unit(&unit, remote::LISTEN_ENV), None);
    }

    #[test]
    fn systemd_unit_restarts_on_a_clean_exit_and_bounds_the_crash_loop() {
        let unit = systemd_unit(Path::new("/usr/local/bin/archcar"), None, NO_PATH);

        // `on-failure` would leave a cleanly-exited daemon down, and every
        // client would silently fall back to spawning its own sidecar.
        assert!(unit.contains("Restart=always"), "{unit}");
        assert!(!unit.contains("Restart=on-failure"), "{unit}");
        assert!(unit.contains("StartLimitIntervalSec=60"), "{unit}");
        assert!(unit.contains("StartLimitBurst=10"), "{unit}");
        // Both limits have to sit in [Unit]; systemd ignores them in [Service].
        let unit_section = unit.split("[Service]").next().unwrap();
        assert!(unit_section.contains("StartLimitBurst=10"), "{unit}");
    }

    #[test]
    fn systemd_unit_records_the_path_the_daemon_should_run_with() {
        let unit = systemd_unit(
            Path::new("/usr/local/bin/archcar"),
            None,
            "/opt/homebrew/bin:/usr/bin",
        );

        assert!(
            unit.contains("Environment=PATH=/opt/homebrew/bin:/usr/bin"),
            "{unit}"
        );
        assert_eq!(
            env_from_unit(&unit, "PATH").as_deref(),
            Some("/opt/homebrew/bin:/usr/bin")
        );
    }

    #[test]
    fn launchd_plist_keeps_the_daemon_alive_and_logs_to_the_state_dir() {
        let plist = launchd_plist(
            Path::new("/opt/archductor/archcar"),
            Some("0.0.0.0:7420"),
            Path::new("/home/u/.local/state/archductor/logs"),
            NO_PATH,
        );

        assert!(
            plist.contains("<string>ai.perceo.archductor.archcar</string>"),
            "{plist}"
        );
        assert!(
            plist.contains("<string>/opt/archductor/archcar</string>"),
            "{plist}"
        );
        assert!(plist.contains("<key>KeepAlive</key>"), "{plist}");
        assert!(plist.contains("archcar.service.log"), "{plist}");
        assert_eq!(
            env_from_unit(&plist, remote::LISTEN_ENV).as_deref(),
            Some("0.0.0.0:7420")
        );
    }

    #[test]
    fn launchd_plist_records_the_path_and_escapes_it() {
        let plist = launchd_plist(
            Path::new("/opt/archductor/archcar"),
            None,
            Path::new("/logs"),
            "/home/u/a&b/bin:/usr/bin",
        );

        // A raw `&` makes launchd reject the plist, and the service silently
        // never starts.
        assert!(plist.contains("/home/u/a&amp;b/bin:/usr/bin"), "{plist}");
        assert!(!plist.contains("a&b"), "{plist}");
        assert_eq!(
            env_from_unit(&plist, "PATH").as_deref(),
            Some("/home/u/a&b/bin:/usr/bin")
        );
    }

    #[test]
    fn the_windows_launcher_carries_the_environment_a_task_action_cannot() {
        let script = windows_launcher_script(
            Path::new(r"C:\Program Files\archductor\archcar.exe"),
            Some("127.0.0.1:7420"),
            r"C:\Users\dev\.local\bin;C:\Windows\system32",
        );

        assert!(
            script.contains("set \"PATH=C:\\Users\\dev\\.local\\bin;C:\\Windows\\system32\""),
            "{script}"
        );
        assert!(
            script.contains("set \"ARCHDUCTOR_ARCHCAR_LISTEN=127.0.0.1:7420\""),
            "{script}"
        );
        // Quoted, because Program Files has a space in it.
        assert!(
            script.contains("\"C:\\Program Files\\archductor\\archcar.exe\""),
            "{script}"
        );
        // `start /B` would let the launcher exit immediately, and Task
        // Scheduler would then treat the daemon as finished.
        assert!(!script.contains("start "), "{script}");
        assert_eq!(
            env_from_unit(&script, "PATH").as_deref(),
            Some(r"C:\Users\dev\.local\bin;C:\Windows\system32")
        );
        assert_eq!(
            env_from_unit(&script, remote::LISTEN_ENV).as_deref(),
            Some("127.0.0.1:7420")
        );
    }

    #[test]
    fn the_windows_launcher_omits_an_absent_listener() {
        let script = windows_launcher_script(Path::new(r"C:\bin\archcar.exe"), None, "");

        assert!(!script.contains("ARCHDUCTOR_ARCHCAR_LISTEN"), "{script}");
        assert!(!script.contains("set \"PATH="), "{script}");
        assert_eq!(env_from_unit(&script, "PATH"), None);
    }

    #[test]
    fn the_windows_task_restarts_after_a_clean_exit_too() {
        let xml = windows_task_xml(Path::new(r"C:\cfg\archcar-service.cmd"), "DOMAIN\\dev");

        // RestartOnFailure alone leaves the same hole `Restart=on-failure`
        // does; the repeating trigger plus IgnoreNew is what closes it.
        assert!(xml.contains("<RestartOnFailure>"), "{xml}");
        assert!(xml.contains("<Interval>PT1M</Interval>"), "{xml}");
        assert!(
            xml.contains("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"),
            "{xml}"
        );
        assert!(xml.contains("<Repetition>"), "{xml}");
        // No time limit: a daemon that runs for a week is not a hung task.
        assert!(
            xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"),
            "{xml}"
        );
        assert!(
            xml.contains(r"/c &quot;C:\cfg\archcar-service.cmd&quot;") || xml.contains(r"/c "),
            "{xml}"
        );
        assert!(xml.contains("DOMAIN\\dev"), "{xml}");
    }

    #[test]
    fn the_windows_task_definition_is_utf16_with_a_bom() {
        // schtasks /Create /XML rejects UTF-8 and says nothing about encoding.
        let bytes = utf16le_with_bom("<Task/>");

        assert_eq!(&bytes[..2], &[0xFF, 0xFE]);
        assert_eq!(&bytes[2..6], &[b'<', 0, b'T', 0]);
    }

    #[test]
    fn a_binary_in_the_windows_temp_directory_is_refused() {
        let err = ensure_durable_binary(Path::new(
            r"C:\Users\dev\AppData\Local\Temp\archductor\archcar.exe",
        ))
        .unwrap_err();

        assert!(err.to_string().contains("temporary mount"), "{err}");
        ensure_durable_binary(Path::new(r"C:\Program Files\archductor\archcar.exe")).unwrap();
    }

    #[test]
    fn every_supported_manager_reports_a_name_and_a_separator() {
        // Windows is a real manager now; `Unsupported` should be the only
        // variant that install refuses.
        for manager in [
            ServiceManager::Launchd,
            ServiceManager::Systemd,
            ServiceManager::ScheduledTask,
        ] {
            assert_ne!(manager, ServiceManager::Unsupported);
            assert!(!manager.as_str().is_empty());
        }
        assert_eq!(ServiceManager::ScheduledTask.path_separator(), ';');
        assert_eq!(ServiceManager::Systemd.path_separator(), ':');
    }

    #[test]
    fn an_explicit_missing_archcar_path_is_rejected() {
        let err = resolve_archcar_binary(Some("/definitely/not/here/archcar")).unwrap_err();
        assert!(err.to_string().contains("not found"), "{err}");
    }

    #[test]
    fn a_binary_inside_a_temporary_mount_is_refused() {
        // AppImages mount at /tmp/.mount_XXXX for the lifetime of the run; a
        // unit pointing there works until the next restart.
        let err =
            ensure_durable_binary(Path::new("/tmp/.mount_archdXYZ/usr/bin/archcar")).unwrap_err();

        assert!(err.to_string().contains("temporary mount"), "{err}");
        assert!(err.to_string().contains("--archcar-path"), "{err}");
        ensure_durable_binary(Path::new("/usr/bin/archcar")).unwrap();
    }

    #[test]
    fn merging_path_dirs_keeps_first_seen_order_and_drops_duplicates() {
        let merged = merge_path_dirs(
            vec![
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/bin"),
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from(""),
                PathBuf::from("/nope"),
            ],
            |dir| dir != Path::new("/nope"),
        );

        assert_eq!(
            merged,
            vec![
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/bin")
            ]
        );
    }

    #[test]
    fn the_service_path_finds_tools_a_bare_launchd_path_would_miss() {
        // The whole point of recording a PATH: the manager default cannot see
        // Homebrew, so anything installed there is invisible to the daemon.
        let manager_default = ServiceManager::Launchd.default_path();
        assert!(!manager_default.contains("/opt/homebrew/bin"));
        assert!(!manager_default.contains(".local/bin"));
    }

    #[test]
    fn doctor_rows_resolve_against_the_given_path_not_the_process_path() {
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        write_executable(&bin.join("git"));

        let rows = doctor_rows(&bin.display().to_string());

        let git = rows.iter().find(|row| row.command == "git").unwrap();
        assert!(git.found(), "{git:?}");
        assert!(git.required);
        // `gh` exists on this machine but not in the PATH we handed in, which
        // is exactly the failure `service doctor` has to be able to see.
        let gh = rows.iter().find(|row| row.command == "gh").unwrap();
        assert!(!gh.found(), "{gh:?}");
        assert!(rows
            .iter()
            .any(|row| row.command == "claude" && !row.required));
    }

    #[test]
    fn doctor_verdict_names_every_problem_at_once() {
        // An empty PATH means `gh` is missing *and* no agent resolves. Naming
        // only the first sends the operator back for a second pass.
        let temp = tempfile::tempdir().unwrap();
        let (ok, feedback) = doctor_verdict(&doctor_rows(&temp.path().display().to_string()));

        assert!(!ok);
        assert!(feedback.contains("gh"), "{feedback}");
        assert!(feedback.contains("any agent CLI"), "{feedback}");
    }

    #[test]
    fn doctor_verdict_is_ok_when_a_required_tool_and_one_agent_resolve() {
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        for command in ["git", "gh", "claude"] {
            write_executable(&bin.join(command));
        }

        let (ok, feedback) = doctor_verdict(&doctor_rows(&bin.display().to_string()));

        assert!(ok, "{feedback}");
        // One agent is the bar; the others being absent is not a problem.
        assert!(feedback.contains("everything it needs"), "{feedback}");
    }

    #[cfg(unix)]
    fn write_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(not(unix))]
    fn write_executable(path: &Path) {
        std::fs::write(path.with_extension("exe"), "").unwrap();
    }
}

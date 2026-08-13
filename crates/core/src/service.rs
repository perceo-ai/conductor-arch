//! Native background service installation for the archcar daemon.
//!
//! Archductor's daemon has to be running for the app, the CLI, and MCP clients
//! to work, so it should be the OS's job to keep it up rather than something a
//! user restarts by hand. This module writes a per-user service definition in
//! whatever the platform actually uses — launchd on macOS, a systemd user unit
//! on Linux — and loads/starts it.
//!
//! Per-user, not system-wide, on purpose: the daemon runs as the user, touches
//! that user's repositories, and needs no root.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::archcar::remote;
use crate::paths::AppPaths;

/// Reverse-DNS label for launchd; also the systemd unit stem.
pub const SERVICE_LABEL: &str = "ai.perceo.archductor.archcar";
pub const SYSTEMD_UNIT_NAME: &str = "archductor-archcar.service";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceManager {
    Launchd,
    Systemd,
    /// No supported per-user service manager on this platform.
    Unsupported,
}

impl ServiceManager {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Launchd => "launchd",
            Self::Systemd => "systemd",
            Self::Unsupported => "unsupported",
        }
    }

    pub fn detect() -> Self {
        if cfg!(target_os = "macos") {
            Self::Launchd
        } else if cfg!(target_os = "linux") {
            Self::Systemd
        } else {
            Self::Unsupported
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
        ServiceManager::Unsupported => None,
    }
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

/// Write the service definition and start it. Returns the resulting status.
pub fn install(paths: &AppPaths, input: &InstallService) -> Result<ServiceStatus> {
    let manager = ServiceManager::detect();
    anyhow::ensure!(
        manager != ServiceManager::Unsupported,
        "no supported per-user service manager on this platform; run `archcar` yourself or add it to your login items"
    );
    let unit_path = unit_path(paths, manager).context("could not resolve the service unit path")?;
    let binary = resolve_archcar_binary(input.archcar_path.as_deref())?;
    let listen = match input.listen.as_deref() {
        Some(value) => Some(remote::parse_listen_addr(value)?.to_string()),
        None => None,
    };

    if let Some(parent) = unit_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create service directory {}", parent.display()))?;
    }
    std::fs::create_dir_all(&paths.logs_dir)?;
    let contents = match manager {
        ServiceManager::Launchd => launchd_plist(&binary, listen.as_deref(), &paths.logs_dir),
        ServiceManager::Systemd => systemd_unit(&binary, listen.as_deref()),
        ServiceManager::Unsupported => unreachable!(),
    };
    std::fs::write(&unit_path, contents)
        .with_context(|| format!("write service unit {}", unit_path.display()))?;

    // A listener means a token has to exist before the daemon starts.
    if listen.is_some() {
        remote::ensure_token(paths)?;
    }

    let detail = start_service(manager, &unit_path)?;
    Ok(ServiceStatus {
        manager: manager.as_str().to_owned(),
        installed: true,
        running: true,
        unit_path: Some(unit_path.display().to_string()),
        listen,
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
            let _ = run(&["systemctl", "--user", "daemon-reload"]);
        }
    }
    Ok(ServiceStatus {
        manager: manager.as_str().to_owned(),
        installed: false,
        running: false,
        unit_path: unit_path.map(|path| path.display().to_string()),
        listen: None,
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
    let listen = listen_from_unit(&contents);
    let (running, detail) = if !installed {
        (false, "not installed".to_owned())
    } else {
        match manager {
            ServiceManager::Launchd => {
                let output = run(&["launchctl", "list"]).unwrap_or_default();
                let running = output.lines().any(|line| line.contains(SERVICE_LABEL));
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
                let output = run(&["systemctl", "--user", "is-active", SYSTEMD_UNIT_NAME])
                    .unwrap_or_default();
                let running = output.trim() == "active";
                (running, format!("systemd reports {}", output.trim()))
            }
            ServiceManager::Unsupported => (false, "unsupported platform".to_owned()),
        }
    };
    Ok(ServiceStatus {
        manager: manager.as_str().to_owned(),
        installed,
        running,
        unit_path: unit_path.map(|path| path.display().to_string()),
        listen,
        detail,
    })
}

fn start_service(manager: ServiceManager, unit_path: &Path) -> Result<String> {
    match manager {
        ServiceManager::Launchd => {
            // `bootout` first so a re-install replaces the old definition.
            let target = launchd_domain_target();
            let _ = run(&[
                "launchctl",
                "bootout",
                &target,
                &unit_path.display().to_string(),
            ]);
            run(&[
                "launchctl",
                "bootstrap",
                &target,
                &unit_path.display().to_string(),
            ])
            .or_else(|_| run(&["launchctl", "load", "-w", &unit_path.display().to_string()]))
            .map(|_| format!("loaded {SERVICE_LABEL} into launchd"))
        }
        ServiceManager::Systemd => {
            run(&["systemctl", "--user", "daemon-reload"])?;
            run(&["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT_NAME])
                .map(|_| format!("enabled and started {SYSTEMD_UNIT_NAME}"))
        }
        ServiceManager::Unsupported => anyhow::bail!("unsupported platform"),
    }
}

fn stop_service(manager: ServiceManager, unit_path: &Path) -> Result<String> {
    match manager {
        ServiceManager::Launchd => {
            let target = launchd_domain_target();
            let _ = run(&[
                "launchctl",
                "bootout",
                &target,
                &unit_path.display().to_string(),
            ]);
            let _ = run(&[
                "launchctl",
                "unload",
                "-w",
                &unit_path.display().to_string(),
            ]);
            Ok(format!("unloaded {SERVICE_LABEL}"))
        }
        ServiceManager::Systemd => {
            let _ = run(&["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT_NAME]);
            Ok(format!("disabled {SYSTEMD_UNIT_NAME}"))
        }
        ServiceManager::Unsupported => Ok(String::new()),
    }
}

fn launchd_domain_target() -> String {
    format!("gui/{}", current_uid())
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
    let output = Command::new(program)
        .args(rest)
        .output()
        .with_context(|| format!("run {program}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!(
            "{} {} failed: {}",
            program,
            rest.join(" "),
            stderr.trim().to_owned()
        );
    }
    Ok(stdout)
}

pub fn launchd_plist(binary: &Path, listen: Option<&str>, logs_dir: &Path) -> String {
    let listen_env = listen
        .map(|addr| {
            format!(
                "    <key>{}</key>\n    <string>{}</string>\n",
                remote::LISTEN_ENV,
                addr
            )
        })
        .unwrap_or_default();
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
{listen_env}  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
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

pub fn systemd_unit(binary: &Path, listen: Option<&str>) -> String {
    let environment = listen
        .map(|addr| format!("Environment={}={}\n", remote::LISTEN_ENV, addr))
        .unwrap_or_default();
    format!(
        "[Unit]\n\
         Description=Archductor archcar daemon\n\
         After=default.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         ExecStart={binary}\n\
         {environment}Restart=on-failure\n\
         RestartSec=2\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        binary = binary.display(),
    )
}

/// Recover the configured listen address from an installed unit, so `status`
/// can report where the daemon is reachable.
fn listen_from_unit(contents: &str) -> Option<String> {
    let needle = remote::LISTEN_ENV;
    for (index, line) in contents.lines().enumerate() {
        // systemd: Environment=KEY=value
        if let Some(rest) = line.trim().strip_prefix(&format!("Environment={needle}=")) {
            return Some(rest.trim().to_owned());
        }
        // launchd: <key>KEY</key> followed by <string>value</string>
        if line.contains(&format!("<key>{needle}</key>")) {
            let value = contents.lines().nth(index + 1)?;
            let value = value
                .trim()
                .strip_prefix("<string>")?
                .strip_suffix("</string>")?;
            return Some(value.to_owned());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn systemd_unit_starts_archcar_and_carries_the_listen_address() {
        let unit = systemd_unit(Path::new("/usr/local/bin/archcar"), Some("127.0.0.1:7420"));

        assert!(unit.contains("ExecStart=/usr/local/bin/archcar"), "{unit}");
        assert!(
            unit.contains("Environment=ARCHDUCTOR_ARCHCAR_LISTEN=127.0.0.1:7420"),
            "{unit}"
        );
        assert!(unit.contains("WantedBy=default.target"), "{unit}");
        assert_eq!(listen_from_unit(&unit).as_deref(), Some("127.0.0.1:7420"));
    }

    #[test]
    fn systemd_unit_without_a_listener_has_no_listen_environment() {
        let unit = systemd_unit(Path::new("/usr/local/bin/archcar"), None);

        assert!(!unit.contains("ARCHDUCTOR_ARCHCAR_LISTEN"), "{unit}");
        assert_eq!(listen_from_unit(&unit), None);
    }

    #[test]
    fn launchd_plist_keeps_the_daemon_alive_and_logs_to_the_state_dir() {
        let plist = launchd_plist(
            Path::new("/opt/archductor/archcar"),
            Some("0.0.0.0:7420"),
            Path::new("/home/u/.local/state/archductor/logs"),
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
        assert_eq!(listen_from_unit(&plist).as_deref(), Some("0.0.0.0:7420"));
    }

    #[test]
    fn an_explicit_missing_archcar_path_is_rejected() {
        let err = resolve_archcar_binary(Some("/definitely/not/here/archcar")).unwrap_err();
        assert!(err.to_string().contains("not found"), "{err}");
    }
}

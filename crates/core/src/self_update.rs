//! Bring a daemon up to the latest release without reinstalling it by hand.
//!
//! The daemon is the one process that knows where it was installed from, so it
//! answers "can you update yourself?" and does it; a client on another machine
//! only asks. That is what makes updating a headless server a one-liner from a
//! laptop instead of an SSH session per box.
//!
//! Only a tarball install is rewritten in place — it is the one channel where
//! the binaries belong to the user the daemon runs as. Package managers, Nix,
//! Homebrew, and the desktop app own their files, so for those the answer is
//! the channel's own upgrade command. Every channel shares the second half:
//! once the binary on disk is newer than the running one (whoever put it
//! there), applying is just a restart.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};

use crate::paths::AppPaths;
use crate::update_check;

/// Where release assets are downloaded from: `<base>/v<version>/<asset>`.
/// Overridable for a mirror (or a smoke test serving `file://…`); a mirror may
/// publish targets GitHub releases do not, so it is not held to them.
pub const DOWNLOAD_BASE_ENV: &str = "ARCHDUCTOR_UPDATE_BASE_URL";
const DEFAULT_DOWNLOAD_BASE: &str = "https://github.com/perceo-ai/conductor-arch/releases/download";

/// The only standalone build the release workflow publishes.
const PUBLISHED_OS: &str = "linux";
const PUBLISHED_ARCH: &str = "x86_64";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallChannel {
    /// Release tarball unpacked somewhere the daemon's user can write.
    Tarball,
    /// Bundled inside the desktop app, which updates itself.
    DesktopApp,
    Homebrew,
    Nix,
    Apt,
    Rpm,
    Pacman,
    AppImage,
    /// `cargo build` — no release version to compare against.
    Development,
    /// Anything else: a read-only directory, Windows, an unknown layout.
    Unsupported,
}

impl InstallChannel {
    pub fn label(self) -> &'static str {
        match self {
            Self::Tarball => "tarball",
            Self::DesktopApp => "desktop app",
            Self::Homebrew => "Homebrew",
            Self::Nix => "Nix",
            Self::Apt => "apt",
            Self::Rpm => "rpm",
            Self::Pacman => "pacman",
            Self::AppImage => "AppImage",
            Self::Development => "development build",
            Self::Unsupported => "unsupported",
        }
    }
}

/// What a client needs to decide whether, and how, a daemon can be updated.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateStatus {
    pub current_version: String,
    /// Latest published release as of the daemon's last check, without `v`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    /// Epoch seconds of that check.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<u64>,
    pub update_available: bool,
    pub channel: InstallChannel,
    pub binary_path: String,
    /// Version of the binary on disk now, when it differs from the one running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_disk_version: Option<String>,
    /// The binary on disk is newer than the running daemon: a restart finishes
    /// an update someone else (a package manager, the desktop app) installed.
    pub restart_pending: bool,
    /// This daemon can download and install a release itself.
    pub can_self_update: bool,
    /// What to do when it cannot — the channel's own upgrade command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guidance: Option<String>,
    /// Apply updates unattended while no agent is mid-turn.
    pub auto_update: bool,
}

impl UpdateStatus {
    /// Applying would change the running version: a restart onto a newer
    /// binary already on disk, or a download this daemon can do itself.
    pub fn actionable(&self) -> bool {
        self.restart_pending || (self.update_available && self.can_self_update)
    }
}

/// What `apply` did. The caller restarts the daemon either way.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppliedUpdate {
    pub from_version: String,
    pub to_version: String,
    /// False when the newer binary was already on disk and only a restart was
    /// needed.
    pub downloaded: bool,
}

/// Facts about the machine that decide the channel, gathered separately so
/// the decision itself is a pure function a test can drive.
#[derive(Debug, Clone, Default)]
pub struct ChannelFacts {
    pub release_build: bool,
    pub os: &'static str,
    pub arch: &'static str,
    pub dir_writable: bool,
    /// The system package manager that owns the binary, if any.
    pub package_owner: Option<InstallChannel>,
    pub appimage: bool,
    /// Downloads come from `ARCHDUCTOR_UPDATE_BASE_URL`, not GitHub releases.
    pub mirror: bool,
}

impl ChannelFacts {
    pub fn probe(binary: &Path) -> Self {
        let dir = binary.parent().unwrap_or(Path::new("."));
        Self {
            release_build: update_check::is_release_build(),
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            dir_writable: dir_is_writable(dir),
            package_owner: package_owner(binary),
            appimage: std::env::var_os("APPIMAGE").is_some(),
            mirror: std::env::var_os(DOWNLOAD_BASE_ENV).is_some(),
        }
    }
}

/// Decide the channel and, when the daemon cannot update itself, say what
/// will. Returns `(channel, can_self_update, guidance)`.
pub fn classify(binary: &Path, facts: &ChannelFacts) -> (InstallChannel, bool, Option<String>) {
    let path = binary.to_string_lossy();
    let say = |text: &str| Some(text.to_owned());
    if !facts.release_build {
        return (
            InstallChannel::Development,
            false,
            say("a development build has no release version to update from; rebuild it"),
        );
    }
    if path.contains("/nix/store/") {
        return (
            InstallChannel::Nix,
            false,
            say("update the flake input (or `nix profile upgrade`), then apply to restart"),
        );
    }
    if path.contains("/Cellar/") || path.starts_with("/opt/homebrew/") {
        return (
            InstallChannel::Homebrew,
            false,
            say("run `brew upgrade archductor` on that machine, then apply to restart"),
        );
    }
    // macOS bundle, or the Linux desktop packages' `resources/bin` — the
    // deb/rpm there is `archductor-desktop`, whose upgrade is the app's.
    if path.contains(".app/Contents/") || path.contains("/resources/bin/") {
        return (
            InstallChannel::DesktopApp,
            false,
            say("the desktop app updates itself (Settings → Updates); apply afterwards to restart the daemon onto it"),
        );
    }
    if facts.appimage || path.contains("/.mount_") {
        return (
            InstallChannel::AppImage,
            false,
            say("download the new AppImage from the releases page and replace this one"),
        );
    }
    if let Some(owner) = facts.package_owner {
        let command = match owner {
            InstallChannel::Apt => "sudo apt-get install --only-upgrade archductor",
            InstallChannel::Rpm => "sudo dnf upgrade archductor",
            _ => "your AUR helper (for example `yay -S archductor`)",
        };
        return (
            owner,
            false,
            Some(format!(
                "the {} package owns this install; run `{command}` on that machine, then apply to restart",
                owner.label()
            )),
        );
    }
    if facts.os == "windows" {
        return (
            InstallChannel::Unsupported,
            false,
            say("self-update is not supported on Windows yet; install the new zip from the releases page"),
        );
    }
    if !facts.dir_writable {
        return (
            InstallChannel::Unsupported,
            false,
            Some(format!(
                "{} is not writable by the daemon's user; reinstall the new release there by hand",
                binary.parent().unwrap_or(Path::new("/")).display()
            )),
        );
    }
    if !facts.mirror && (facts.os != PUBLISHED_OS || facts.arch != PUBLISHED_ARCH) {
        return (
            InstallChannel::Tarball,
            false,
            Some(format!(
                "releases publish a standalone build for {PUBLISHED_OS}-{PUBLISHED_ARCH} only, not \
                 {}-{}; rebuild from source, or serve builds from a mirror via {DOWNLOAD_BASE_ENV}",
                facts.os, facts.arch
            )),
        );
    }
    (InstallChannel::Tarball, true, None)
}

/// The daemon's own binary. On Linux, `current_exe` of a process whose file
/// was replaced reads `…/archcar (deleted)`; the path that matters is the one
/// the service manager will start next time.
pub fn running_binary() -> Result<PathBuf> {
    Ok(without_deleted_suffix(
        std::env::current_exe().context("locate the running binary")?,
    ))
}

fn without_deleted_suffix(exe: PathBuf) -> PathBuf {
    match exe.to_string_lossy().strip_suffix(" (deleted)") {
        Some(stripped) => PathBuf::from(stripped),
        None => exe,
    }
}

pub fn status(paths: &AppPaths, binary: &Path) -> UpdateStatus {
    let facts = ChannelFacts::probe(binary);
    status_with(paths, binary, &facts, binary_version(binary))
}

fn status_with(
    paths: &AppPaths,
    binary: &Path,
    facts: &ChannelFacts,
    on_disk: Option<String>,
) -> UpdateStatus {
    let current = update_check::current_version()
        .trim_start_matches('v')
        .to_owned();
    let cache = update_check::load_cache(&update_check::cache_path(paths));
    let latest = cache
        .as_ref()
        .map(|cache| cache.latest_tag.trim().trim_start_matches('v').to_owned())
        .filter(|tag| !tag.is_empty());
    let (channel, can_self_update, guidance) = classify(binary, facts);
    let release = facts.release_build;
    let update_available = release
        && latest.as_deref().is_some_and(|latest| {
            update_check::compare_versions(latest, &current) == Ordering::Greater
        });
    let on_disk = on_disk.filter(|version| version != &current);
    let restart_pending = release
        && on_disk.as_deref().is_some_and(|disk| {
            update_check::compare_versions(disk, &current) == Ordering::Greater
        });
    UpdateStatus {
        current_version: current,
        latest_version: latest,
        checked_at: cache.map(|cache| cache.checked_at),
        update_available,
        channel,
        binary_path: binary.display().to_string(),
        on_disk_version: on_disk,
        restart_pending,
        can_self_update,
        guidance,
        auto_update: auto_update_enabled(paths),
    }
}

/// Bring this install to `requested` (or the latest release). The caller
/// restarts the daemon afterwards, whether or not anything was downloaded.
pub fn apply(paths: &AppPaths, binary: &Path, requested: Option<&str>) -> Result<AppliedUpdate> {
    let status = status(paths, binary);
    let requested_on_disk = requested.is_none_or(|version| {
        Some(version.trim().trim_start_matches('v')) == status.on_disk_version.as_deref()
    });
    if status.restart_pending && requested_on_disk {
        return Ok(AppliedUpdate {
            to_version: status.on_disk_version.clone().unwrap_or_default(),
            from_version: status.current_version,
            downloaded: false,
        });
    }
    if !status.can_self_update {
        bail!(
            "this {} install cannot update itself: {}",
            status.channel.label(),
            status.guidance.as_deref().unwrap_or("no guidance")
        );
    }
    // Install what the status reported — the version the caller saw and
    // agreed to — and ask the network only when the daemon has no answer yet.
    let target = match requested {
        Some(version) => {
            let version = version.trim().trim_start_matches('v');
            // It reaches a URL and a directory name next to the binaries, and
            // it arrives from a client: accept a version, nothing path-like.
            ensure!(
                is_release_version(version),
                "`{version}` is not a release version"
            );
            version.to_owned()
        }
        None => match status.latest_version.clone() {
            Some(latest) => latest,
            None => update_check::fetch_latest_tag()
                .map(|tag| tag.trim_start_matches('v').to_owned())
                .context("could not find the latest release; pass a version explicitly")?,
        },
    };
    ensure!(
        update_check::compare_versions(&target, &status.current_version) == Ordering::Greater,
        "already at v{}; nothing newer than that to install (asked for v{target})",
        status.current_version
    );
    let dir = binary
        .parent()
        .context("the running binary has no parent directory")?;
    install_release(
        dir,
        &target,
        &download_base(),
        std::env::consts::OS,
        std::env::consts::ARCH,
    )?;
    Ok(AppliedUpdate {
        from_version: status.current_version,
        to_version: target,
        downloaded: true,
    })
}

/// `MAJOR.MINOR.PATCH`, optionally `-prerelease` of letters, digits, and dots.
fn is_release_version(version: &str) -> bool {
    let (core, pre) = match version.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (version, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
        && pre.is_none_or(|pre| {
            !pre.is_empty()
                && !pre.contains("..")
                && pre.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.')
        })
}

fn download_base() -> String {
    std::env::var(DOWNLOAD_BASE_ENV)
        .ok()
        .map(|base| base.trim().trim_end_matches('/').to_owned())
        .filter(|base| !base.is_empty())
        .unwrap_or_else(|| DEFAULT_DOWNLOAD_BASE.to_owned())
}

/// `archductor-0.8.3-linux-x86_64.tar.gz`, the publish workflow's naming.
pub fn tarball_name(version: &str, os: &str, arch: &str) -> String {
    format!("archductor-{version}-{os}-{arch}.tar.gz")
}

/// Download, verify, and swap in a release's `archductor` and `archcar`.
///
/// Both new binaries are staged next to the old ones before either is
/// replaced, so a failed download or checksum leaves the install untouched,
/// and the swap itself is two same-directory renames. The previous binaries
/// stay beside them as `*.previous` for a manual rollback.
pub fn install_release(dir: &Path, version: &str, base: &str, os: &str, arch: &str) -> Result<()> {
    ensure!(
        is_release_version(version),
        "`{version}` is not a release version"
    );
    let asset = tarball_name(version, os, arch);
    let staging = dir.join(format!(".archductor-update-{version}"));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)
        .with_context(|| format!("create staging directory {}", staging.display()))?;
    let result = stage_and_swap(dir, version, base, &asset, &staging);
    let _ = std::fs::remove_dir_all(&staging);
    if result.is_err() {
        for name in ["archcar", "archductor"] {
            let _ = std::fs::remove_file(dir.join(format!(".{name}.new")));
        }
    }
    result
}

fn stage_and_swap(
    dir: &Path,
    version: &str,
    base: &str,
    asset: &str,
    staging: &Path,
) -> Result<()> {
    let tarball = staging.join(asset);
    let sums = staging.join("SHA256SUMS");
    download(&format!("{base}/v{version}/{asset}"), &tarball)?;
    download(&format!("{base}/v{version}/SHA256SUMS"), &sums)?;
    let sums_text = std::fs::read_to_string(&sums).context("read SHA256SUMS")?;
    let expected = expected_sha256(&sums_text, asset)
        .with_context(|| format!("SHA256SUMS for v{version} does not list {asset}"))?;
    let actual = sha256_file(&tarball)?;
    ensure!(
        actual.eq_ignore_ascii_case(&expected),
        "checksum mismatch for {asset}: expected {expected}, got {actual}; nothing was replaced"
    );

    let output = Command::new("tar")
        .arg("-xzf")
        .arg(&tarball)
        .arg("-C")
        .arg(staging)
        .output()
        .context("run tar")?;
    ensure!(
        output.status.success(),
        "could not unpack {asset}: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    let unpacked = staging.join(asset.trim_end_matches(".tar.gz")).join("bin");
    let new_version = binary_version(&unpacked.join("archductor"));
    ensure!(
        new_version.as_deref() == Some(version),
        "the downloaded archductor reports {}, not v{version}; nothing was replaced",
        new_version.as_deref().unwrap_or("no version")
    );

    const BINARIES: [&str; 2] = ["archcar", "archductor"];
    for name in BINARIES {
        let source = unpacked.join(name);
        ensure!(source.is_file(), "{asset} has no bin/{name}");
        let staged = dir.join(format!(".{name}.new"));
        std::fs::copy(&source, &staged).with_context(|| format!("stage {}", staged.display()))?;
        make_executable(&staged)?;
    }
    for name in BINARIES {
        let target = dir.join(name);
        if target.exists() {
            let _ = std::fs::copy(&target, dir.join(format!("{name}.previous")));
        }
        std::fs::rename(dir.join(format!(".{name}.new")), &target)
            .with_context(|| format!("replace {}", target.display()))?;
    }
    Ok(())
}

fn download(url: &str, dest: &Path) -> Result<()> {
    let output = Command::new("curl")
        .args([
            "--silent",
            "--show-error",
            "--fail",
            "--location",
            "--max-time",
            "600",
            "--output",
        ])
        .arg(dest)
        .arg(url)
        .output()
        .context("run curl (needed to download the release)")?;
    ensure!(
        output.status.success(),
        "download {url} failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(())
}

/// The hash `sha256sum` recorded for `asset`. The release workflow writes
/// paths as `./name`; plain `name` and binary-mode `*name` are accepted too.
pub fn expected_sha256(sums: &str, asset: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let (hash, name) = line.trim().split_once(char::is_whitespace)?;
        let name = name.trim().trim_start_matches('*').trim_start_matches("./");
        (name == asset && hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
            .then(|| hash.to_ascii_lowercase())
    })
}

fn sha256_file(path: &Path) -> Result<String> {
    // `sha256sum` on Linux, `shasum` on macOS; both print `<hash>  <path>`.
    for (program, args) in [("sha256sum", vec![]), ("shasum", vec!["-a", "256"])] {
        let Ok(output) = Command::new(program).args(&args).arg(path).output() else {
            continue;
        };
        if output.status.success() {
            if let Some(hash) = String::from_utf8_lossy(&output.stdout)
                .split_whitespace()
                .next()
            {
                return Ok(hash.to_ascii_lowercase());
            }
        }
    }
    bail!("neither sha256sum nor shasum is available to verify the download")
}

/// `<binary> --version` → `0.8.3`. Both `archductor` and `archcar` answer it
/// without doing anything else.
pub fn binary_version(binary: &Path) -> Option<String> {
    let output = Command::new(binary)
        .arg("--version")
        .env("ARCHDUCTOR_NO_UPDATE_NOTICE", "1")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .nth(1)
        .map(|version| version.trim_start_matches('v').to_owned())
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .with_context(|| format!("mark {} executable", path.display()))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<()> {
    Ok(())
}

fn dir_is_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".archductor-write-probe-{}", std::process::id()));
    let writable = std::fs::write(&probe, b"").is_ok();
    let _ = std::fs::remove_file(&probe);
    writable
}

/// Which system package manager, if any, owns `binary`.
fn package_owner(binary: &Path) -> Option<InstallChannel> {
    let owned = |program: &str, args: &[&str]| {
        Command::new(program)
            .args(args)
            .arg(binary)
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    };
    if !binary.starts_with("/usr") && !binary.starts_with("/opt") {
        return None;
    }
    if owned("dpkg", &["-S"]) {
        Some(InstallChannel::Apt)
    } else if owned("rpm", &["-qf"]) {
        Some(InstallChannel::Rpm)
    } else if owned("pacman", &["-Qo"]) {
        Some(InstallChannel::Pacman)
    } else {
        None
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct AutoUpdateConfig {
    #[serde(default)]
    enabled: bool,
}

fn auto_update_path(paths: &AppPaths) -> PathBuf {
    paths.state_dir.join("auto-update.json")
}

/// Off unless someone turned it on: replacing a server's binaries is not
/// something to start doing on upgrade without being asked.
pub fn auto_update_enabled(paths: &AppPaths) -> bool {
    std::fs::read_to_string(auto_update_path(paths))
        .ok()
        .and_then(|raw| serde_json::from_str::<AutoUpdateConfig>(&raw).ok())
        .is_some_and(|config| config.enabled)
}

pub fn set_auto_update(paths: &AppPaths, enabled: bool) -> Result<()> {
    let path = auto_update_path(paths);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, serde_json::to_string(&AutoUpdateConfig { enabled })?)
        .with_context(|| format!("write {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release_facts() -> ChannelFacts {
        ChannelFacts {
            release_build: true,
            os: "linux",
            arch: "x86_64",
            dir_writable: true,
            package_owner: None,
            appimage: false,
            mirror: false,
        }
    }

    fn channel(path: &str, facts: &ChannelFacts) -> (InstallChannel, bool) {
        let (channel, can, _) = classify(Path::new(path), facts);
        (channel, can)
    }

    #[test]
    fn only_a_writable_linux_tarball_updates_itself() {
        let facts = release_facts();
        assert_eq!(
            channel("/home/me/.local/archductor/bin/archcar", &facts),
            (InstallChannel::Tarball, true)
        );
        let read_only = ChannelFacts {
            dir_writable: false,
            ..release_facts()
        };
        assert_eq!(
            channel("/srv/archductor/bin/archcar", &read_only),
            (InstallChannel::Unsupported, false)
        );
        let arm = ChannelFacts {
            arch: "aarch64",
            ..release_facts()
        };
        let (_, can, guidance) = classify(Path::new("/home/me/bin/archcar"), &arm);
        assert!(!can);
        assert!(guidance.unwrap().contains("linux-x86_64"));
        // A mirror publishes whatever it builds.
        let mirrored_arm = ChannelFacts {
            mirror: true,
            ..arm
        };
        assert_eq!(
            channel("/home/me/bin/archcar", &mirrored_arm),
            (InstallChannel::Tarball, true)
        );
    }

    #[test]
    fn managed_installs_get_their_own_upgrade_command() {
        let facts = release_facts();
        let apt = ChannelFacts {
            package_owner: Some(InstallChannel::Apt),
            ..release_facts()
        };
        let (apt_channel, can, guidance) = classify(Path::new("/usr/bin/archcar"), &apt);
        assert_eq!((apt_channel, can), (InstallChannel::Apt, false));
        assert!(guidance.unwrap().contains("apt-get install --only-upgrade"));

        assert_eq!(
            channel("/opt/homebrew/Cellar/archductor/0.8.2/bin/archcar", &facts).0,
            InstallChannel::Homebrew
        );
        assert_eq!(
            channel("/nix/store/abc-archductor/bin/archcar", &facts).0,
            InstallChannel::Nix
        );
        assert_eq!(
            channel(
                "/Applications/archductor-desktop.app/Contents/Resources/bin/archcar",
                &facts
            )
            .0,
            InstallChannel::DesktopApp
        );
        assert_eq!(
            channel("/tmp/.mount_archdXYZ/usr/bin/archcar", &facts).0,
            InstallChannel::AppImage
        );
        // The Linux desktop deb puts its daemon under /opt and dpkg owns it,
        // but upgrading it means upgrading the app, not `archductor`.
        let desktop_deb = ChannelFacts {
            package_owner: Some(InstallChannel::Apt),
            ..release_facts()
        };
        assert_eq!(
            channel("/opt/Archductor/resources/bin/archcar", &desktop_deb).0,
            InstallChannel::DesktopApp
        );
    }

    #[test]
    fn a_development_build_never_updates() {
        let facts = ChannelFacts {
            release_build: false,
            ..release_facts()
        };
        assert_eq!(
            channel("/home/me/src/target/debug/archcar", &facts),
            (InstallChannel::Development, false)
        );
    }

    #[test]
    fn checksums_are_read_the_way_the_release_writes_them() {
        let hash = "a".repeat(64);
        let other = "b".repeat(64);
        let sums = format!(
            "{other}  ./archductor-0.8.3-x86_64.AppImage\n{hash}  ./archductor-0.8.3-linux-x86_64.tar.gz\n"
        );
        assert_eq!(
            expected_sha256(&sums, "archductor-0.8.3-linux-x86_64.tar.gz"),
            Some(hash.clone())
        );
        assert_eq!(
            expected_sha256(
                &format!("{hash} *archductor-0.8.3-linux-x86_64.tar.gz"),
                "archductor-0.8.3-linux-x86_64.tar.gz"
            ),
            Some(hash)
        );
        assert_eq!(
            expected_sha256(&sums, "archductor-0.8.4-linux-x86_64.tar.gz"),
            None
        );
        assert_eq!(
            expected_sha256(
                "not-a-hash  ./archductor-0.8.3-linux-x86_64.tar.gz",
                "archductor-0.8.3-linux-x86_64.tar.gz"
            ),
            None
        );
    }

    fn paths_in(dir: &Path) -> AppPaths {
        AppPaths {
            config_dir: dir.join("config"),
            data_dir: dir.join("data"),
            state_dir: dir.join("state"),
            cache_dir: dir.join("cache"),
            database_path: dir.join("data/archductor.db"),
            logs_dir: dir.join("state/logs"),
        }
    }

    #[test]
    fn a_newer_binary_on_disk_means_a_restart_is_pending() {
        let temp = tempfile::tempdir().unwrap();
        let paths = paths_in(temp.path());
        let binary = Path::new("/home/me/bin/archcar");
        let facts = release_facts();
        let current = update_check::current_version()
            .trim_start_matches('v')
            .to_owned();

        let same = status_with(&paths, binary, &facts, Some(current.clone()));
        assert!(!same.restart_pending);
        assert_eq!(same.on_disk_version, None);

        let newer = status_with(&paths, binary, &facts, Some("999.0.0".to_owned()));
        assert!(newer.restart_pending);
        assert!(newer.actionable());

        // Older on disk than running is not a reason to restart onto it.
        let older = status_with(&paths, binary, &facts, Some("0.0.1".to_owned()));
        assert!(!older.restart_pending);
    }

    #[test]
    fn an_update_is_available_only_past_the_running_version() {
        let temp = tempfile::tempdir().unwrap();
        let paths = paths_in(temp.path());
        let binary = Path::new("/home/me/bin/archcar");
        update_check::save_cache(
            &update_check::cache_path(&paths),
            &update_check::UpdateCheckCache {
                latest_tag: "v999.0.0".to_owned(),
                checked_at: 7,
            },
        )
        .unwrap();

        let status = status_with(&paths, binary, &release_facts(), None);
        assert!(status.update_available);
        assert_eq!(status.latest_version.as_deref(), Some("999.0.0"));
        assert_eq!(status.checked_at, Some(7));
        assert!(status.actionable());

        let dev = ChannelFacts {
            release_build: false,
            ..release_facts()
        };
        assert!(!status_with(&paths, binary, &dev, None).update_available);
    }

    /// A release directory laid out like GitHub's download URLs, holding a
    /// tarball whose "binaries" are scripts that report `version`.
    #[cfg(unix)]
    fn fake_release(root: &Path, version: &str) -> String {
        let bundle_name = format!("archductor-{version}-linux-x86_64");
        let bundle = root.join("build").join(&bundle_name).join("bin");
        std::fs::create_dir_all(&bundle).unwrap();
        for name in ["archductor", "archcar"] {
            let path = bundle.join(name);
            std::fs::write(&path, format!("#!/bin/sh\necho \"{name} {version}\"\n")).unwrap();
            make_executable(&path).unwrap();
        }
        let release = root.join("releases").join(format!("v{version}"));
        std::fs::create_dir_all(&release).unwrap();
        let asset = tarball_name(version, "linux", "x86_64");
        let status = Command::new("tar")
            .arg("-czf")
            .arg(release.join(&asset))
            .arg("-C")
            .arg(root.join("build"))
            .arg(&bundle_name)
            .status()
            .unwrap();
        assert!(status.success());
        let hash = sha256_file(&release.join(&asset)).unwrap();
        std::fs::write(release.join("SHA256SUMS"), format!("{hash}  ./{asset}\n")).unwrap();
        format!("file://{}", root.join("releases").display())
    }

    #[cfg(unix)]
    fn old_install(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        for name in ["archductor", "archcar"] {
            let path = dir.join(name);
            std::fs::write(&path, format!("#!/bin/sh\necho \"{name} 0.8.2\"\n")).unwrap();
            make_executable(&path).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn installing_a_release_swaps_both_binaries_and_keeps_the_old_ones() {
        let temp = tempfile::tempdir().unwrap();
        let base = fake_release(temp.path(), "0.8.3");
        let bin = temp.path().join("install/bin");
        old_install(&bin);

        install_release(&bin, "0.8.3", &base, "linux", "x86_64").unwrap();

        assert_eq!(
            binary_version(&bin.join("archductor")).as_deref(),
            Some("0.8.3")
        );
        assert_eq!(
            binary_version(&bin.join("archcar")).as_deref(),
            Some("0.8.3")
        );
        assert_eq!(
            binary_version(&bin.join("archcar.previous")).as_deref(),
            Some("0.8.2")
        );
        let leftovers: Vec<_> = std::fs::read_dir(&bin)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with('.'))
            .collect();
        assert!(leftovers.is_empty(), "staging left behind: {leftovers:?}");
    }

    #[cfg(unix)]
    #[test]
    fn a_checksum_mismatch_replaces_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let base = fake_release(temp.path(), "0.8.3");
        let sums = temp.path().join("releases/v0.8.3/SHA256SUMS");
        std::fs::write(
            &sums,
            format!(
                "{}  ./{}\n",
                "0".repeat(64),
                tarball_name("0.8.3", "linux", "x86_64")
            ),
        )
        .unwrap();
        let bin = temp.path().join("install/bin");
        old_install(&bin);

        let err = install_release(&bin, "0.8.3", &base, "linux", "x86_64").unwrap_err();

        assert!(format!("{err:#}").contains("checksum mismatch"), "{err:#}");
        assert_eq!(
            binary_version(&bin.join("archcar")).as_deref(),
            Some("0.8.2")
        );
        assert!(!bin.join("archcar.previous").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_missing_release_replaces_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let base = fake_release(temp.path(), "0.8.3");
        let bin = temp.path().join("install/bin");
        old_install(&bin);

        let err = install_release(&bin, "0.9.0", &base, "linux", "x86_64").unwrap_err();

        assert!(format!("{err:#}").contains("download"), "{err:#}");
        assert_eq!(
            binary_version(&bin.join("archcar")).as_deref(),
            Some("0.8.2")
        );
    }

    #[test]
    fn a_replaced_binary_is_found_at_its_path_not_its_tombstone() {
        // What Linux reports for a running process whose file a package
        // manager replaced: the path the service manager will start next.
        assert_eq!(
            without_deleted_suffix(PathBuf::from("/usr/bin/archcar (deleted)")),
            PathBuf::from("/usr/bin/archcar")
        );
        assert_eq!(
            without_deleted_suffix(PathBuf::from("/usr/bin/archcar")),
            PathBuf::from("/usr/bin/archcar")
        );
    }

    #[test]
    fn only_a_release_version_reaches_a_url_or_a_path() {
        for good in ["0.8.3", "10.0.1", "0.9.0-rc.1"] {
            assert!(is_release_version(good), "{good}");
        }
        for bad in [
            "../../etc",
            "0.8",
            "0.8.3/../../x",
            "0.8.3-../x",
            "0.8.x",
            "",
            "0.8.3-",
            "0.8.3 && rm",
        ] {
            assert!(!is_release_version(bad), "{bad}");
        }
        let temp = tempfile::tempdir().unwrap();
        let err = install_release(temp.path(), "../../x", "file:///nowhere", "linux", "x86_64")
            .unwrap_err();
        assert!(err.to_string().contains("not a release version"), "{err}");
    }

    #[test]
    fn auto_update_is_off_until_turned_on() {
        let temp = tempfile::tempdir().unwrap();
        let paths = paths_in(temp.path());
        assert!(!auto_update_enabled(&paths));
        set_auto_update(&paths, true).unwrap();
        assert!(auto_update_enabled(&paths));
        set_auto_update(&paths, false).unwrap();
        assert!(!auto_update_enabled(&paths));
    }
}

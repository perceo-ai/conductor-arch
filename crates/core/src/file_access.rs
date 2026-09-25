//! Whether the daemon can actually read the folders repositories live in.
//!
//! On macOS a process launchd starts is its own TCC subject: it does not
//! inherit the desktop app's grants and, having no GUI, can never raise a
//! consent prompt. Documents, Desktop and Downloads are therefore denied
//! silently, and every caller sees only the downstream failure — `git` exiting
//! non-zero with "Operation not permitted". Probing here, in the daemon, is the
//! only place the answer means anything: the shell that asks has access the
//! daemon lacks.

use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};

/// The protected folders worth probing, relative to the home directory.
const PROTECTED_DIRS: [&str; 3] = ["Documents", "Desktop", "Downloads"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileAccessState {
    /// The daemon read the directory.
    Granted,
    /// The directory is there and the daemon was refused.
    Denied,
    /// Nothing to probe: no such directory, or not a directory at all.
    Absent,
}

/// One probed root, as the daemon sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileAccessProbe {
    pub root: PathBuf,
    pub state: FileAccessState,
    pub detail: String,
    /// True when this root holds a repository the user has already added, which
    /// is what turns a denial from a warning into a blocker.
    #[serde(default)]
    pub registered: bool,
}

/// Probe one root. `read_dir` is the cheapest call that TCC actually gates:
/// metadata on the directory itself is allowed even when its contents are not.
pub fn probe_root(root: &Path, registered: bool) -> FileAccessProbe {
    let (state, detail) = match std::fs::read_dir(root) {
        Ok(mut entries) => match entries.next() {
            Some(Err(err)) if err.kind() == io::ErrorKind::PermissionDenied => {
                (FileAccessState::Denied, denied_detail(root))
            }
            _ => (
                FileAccessState::Granted,
                format!("{} is readable.", root.display()),
            ),
        },
        Err(err) if err.kind() == io::ErrorKind::PermissionDenied => {
            (FileAccessState::Denied, denied_detail(root))
        }
        Err(_) => (
            FileAccessState::Absent,
            format!("{} is not a directory on this host.", root.display()),
        ),
    };
    FileAccessProbe {
        root: root.to_path_buf(),
        state,
        detail,
        registered,
    }
}

fn denied_detail(root: &Path) -> String {
    format!(
        "macOS is denying the archcar daemon access to {}. Grant Full Disk Access to the archcar binary.",
        root.display()
    )
}

/// Probe the protected folders plus every registered repository root.
///
/// Returns an empty vec off macOS: no other platform has TCC, and an empty list
/// is what every surface renders as "nothing to say".
pub fn probe_roots(registered: &[PathBuf]) -> Vec<FileAccessProbe> {
    if !cfg!(target_os = "macos") {
        return Vec::new();
    }
    let mut probes: Vec<FileAccessProbe> = Vec::new();
    if let Some(home) = crate::platform::home_dir() {
        for dir in PROTECTED_DIRS {
            probes.push(probe_root(&home.join(dir), false));
        }
    }
    for root in registered {
        // A repository whose git root IS one of the protected folders was
        // already probed above, as unregistered. Promote that probe rather than
        // skipping the root: `registered` is what turns a denial from advisory
        // into a blocker, and dropping it here would understate the problem.
        if let Some(probe) = probes.iter_mut().find(|probe| &probe.root == root) {
            probe.registered = true;
            continue;
        }
        probes.push(probe_root(root, true));
    }
    probes.retain(|probe| probe.state != FileAccessState::Absent);
    probes
}

/// Every probe that came back denied, in probe order.
pub fn denied(probes: &[FileAccessProbe]) -> Vec<&FileAccessProbe> {
    probes
        .iter()
        .filter(|probe| probe.state == FileAccessState::Denied)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn a_readable_directory_is_granted() {
        let dir = tempfile::tempdir().unwrap();
        let probe = probe_root(dir.path(), false);
        assert_eq!(probe.state, FileAccessState::Granted);
        assert!(!probe.registered);
    }

    #[test]
    fn a_missing_directory_is_absent() {
        let dir = tempfile::tempdir().unwrap();
        let probe = probe_root(&dir.path().join("nope"), false);
        assert_eq!(probe.state, FileAccessState::Absent);
    }

    // Review Focus 1: a path that exists but is not a directory.
    #[test]
    fn a_file_where_a_directory_was_expected_is_absent() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("Documents");
        fs::write(&file, b"not a directory").unwrap();
        assert_eq!(probe_root(&file, false).state, FileAccessState::Absent);
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_directory_is_denied_and_says_so() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let locked = dir.path().join("locked");
        fs::create_dir(&locked).unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();

        let probe = probe_root(&locked, true);

        // Restore before asserting so a failure still leaves a removable dir.
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(probe.state, FileAccessState::Denied);
        assert!(probe.registered);
        assert!(
            probe.detail.contains("archcar"),
            "detail should name the daemon: {}",
            probe.detail
        );
    }

    // A repository whose git root IS ~/Documents collides with the protected
    // folder probed first. Skipping it would file the denial as advisory when
    // an added repository is sitting behind it.
    #[test]
    #[cfg(target_os = "macos")]
    fn a_registered_root_that_is_a_protected_folder_stays_registered() {
        let home = crate::platform::home_dir().expect("home");
        let documents = home.join("Documents");
        if !documents.is_dir() {
            return;
        }

        let probes = probe_roots(std::slice::from_ref(&documents));

        let probe = probes
            .iter()
            .find(|probe| probe.root == documents)
            .expect("Documents probed");
        assert!(probe.registered, "the registered flag must survive dedup");
        assert_eq!(
            probes.iter().filter(|p| p.root == documents).count(),
            1,
            "and it must still be probed only once"
        );
    }

    #[test]
    fn denied_selects_only_denied_probes() {
        let probes = vec![
            FileAccessProbe {
                root: PathBuf::from("/a"),
                state: FileAccessState::Granted,
                detail: String::new(),
                registered: false,
            },
            FileAccessProbe {
                root: PathBuf::from("/b"),
                state: FileAccessState::Denied,
                detail: String::new(),
                registered: true,
            },
        ];
        let denied = denied(&probes);
        assert_eq!(denied.len(), 1);
        assert_eq!(denied[0].root, PathBuf::from("/b"));
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn other_platforms_probe_nothing() {
        assert!(probe_roots(&[PathBuf::from("/tmp")]).is_empty());
    }
}

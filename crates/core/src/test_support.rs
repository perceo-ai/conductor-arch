//! Shared support for this crate's unit tests.
//!
//! The process environment is global, and the unit-test binary runs its tests
//! on several threads at once. Per-module env locks do not exclude each other,
//! so two tests holding different ones could still overwrite each other's
//! `HOME`. Every unit test that changes an environment variable goes through
//! [`EnvGuard`] instead, and the scan test at the bottom of this file fails
//! the build if a new `set_var`/`remove_var` turns up anywhere else.

use std::ffi::{OsStr, OsString};
use std::sync::{Mutex, MutexGuard};

/// The one lock behind every [`EnvGuard`].
static PROCESS_ENV: Mutex<()> = Mutex::new(());

/// Exclusive, self-restoring access to the process environment.
///
/// Holds the crate's single env lock while alive, and on drop puts back every
/// variable it changed, in reverse order, before releasing the lock. Restoring
/// in `Drop` means a test that panics midway still leaves the environment as
/// it found it.
///
/// Not re-entrant: take one guard per test and pass `&mut` to helpers that
/// need to change the environment (see `workspace::tests::install_fake_gh`).
pub(crate) struct EnvGuard {
    // Field order is load-bearing: fields drop in declaration order, so the
    // variables are restored before the lock is released.
    saved: SavedEnv,
    _lock: MutexGuard<'static, ()>,
}

impl EnvGuard {
    /// Waits for every other env-changing test to finish, then takes over.
    pub(crate) fn lock() -> Self {
        Self {
            saved: SavedEnv::default(),
            _lock: lock_process_env(),
        }
    }

    pub(crate) fn set(&mut self, key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) {
        let key = key.as_ref();
        self.saved.remember(key);
        std::env::set_var(key, value);
    }

    pub(crate) fn remove(&mut self, key: impl AsRef<OsStr>) {
        let key = key.as_ref();
        self.saved.remember(key);
        std::env::remove_var(key);
    }
}

fn lock_process_env() -> MutexGuard<'static, ()> {
    // A test that panicked while holding a guard poisons the mutex, but its
    // guard's drop has already restored the environment during the unwind,
    // so there is nothing left to protect and the next test may go ahead.
    PROCESS_ENV
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Each variable's value from before the guard first touched it.
#[derive(Default)]
struct SavedEnv(Vec<(OsString, Option<OsString>)>);

impl SavedEnv {
    fn remember(&mut self, key: &OsStr) {
        if !self.0.iter().any(|(saved, _)| saved == key) {
            self.0.push((key.to_owned(), std::env::var_os(key)));
        }
    }
}

impl Drop for SavedEnv {
    fn drop(&mut self) {
        for (key, value) in self.0.drain(..).rev() {
            match value {
                Some(value) => std::env::set_var(&key, value),
                None => std::env::remove_var(&key),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{lock_process_env, EnvGuard};
    use std::path::Path;

    /// Gives `key` a known value under the lock, outside any guard, so a
    /// test can check a guard puts it back. Every guard leaves the variable
    /// as it found it, so the value survives until the caller relocks. Each
    /// test seeds its own key so the two never clear each other's.
    fn seed(key: &str, value: &str) {
        let _lock = lock_process_env();
        std::env::set_var(key, value);
    }

    fn take(key: &str) -> Option<std::ffi::OsString> {
        let _lock = lock_process_env();
        let value = std::env::var_os(key);
        std::env::remove_var(key);
        value
    }

    #[test]
    fn guard_restores_each_variable_to_its_value_before_the_guard() {
        const KEY: &str = "ARCHDUCTOR_TEST_SUPPORT_RESTORE";
        seed(KEY, "before");
        let mut env = EnvGuard::lock();
        env.set(KEY, "first");
        env.set(KEY, "second");
        env.remove(KEY);
        env.set("ARCHDUCTOR_TEST_SUPPORT_UNSET", "x");
        drop(env);

        assert!(std::env::var_os("ARCHDUCTOR_TEST_SUPPORT_UNSET").is_none());
        assert_eq!(take(KEY).as_deref(), Some(std::ffi::OsStr::new("before")));
    }

    #[test]
    fn a_test_that_panics_holding_the_guard_restores_and_releases_it() {
        const KEY: &str = "ARCHDUCTOR_TEST_SUPPORT_PANIC";
        seed(KEY, "before");
        let panicked = std::thread::spawn(|| {
            let mut env = EnvGuard::lock();
            env.set(KEY, "leaked");
            panic!("simulated failing test");
        })
        .join();
        assert!(panicked.is_err());

        // The poisoned lock is taken again rather than hanging or panicking,
        // and the value the panicking test set did not leak.
        drop(EnvGuard::lock());
        assert_eq!(take(KEY).as_deref(), Some(std::ffi::OsStr::new("before")));
    }

    /// Code outside this module that may change the process environment.
    /// Production paths only: a test must use [`EnvGuard`].
    const PRODUCTION_ENV_WRITERS: &[&str] = &[
        // Refreshes PATH from the Windows registry after an install.
        "doctor.rs",
        // Clears the inherited-socket variables so children never see them.
        "archcar/handoff.rs",
    ];

    #[test]
    fn only_env_guard_changes_the_environment_in_tests() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut stray = Vec::new();
        scan(&src, &src, &mut stray);
        assert!(
            stray.is_empty(),
            "change the environment through test_support::EnvGuard, so the \
             change holds the crate's one env lock and is undone on drop:\n{}",
            stray.join("\n")
        );
    }

    /// An integration-test binary cannot reach [`EnvGuard`], so one that
    /// changes the environment is race-free only while it holds one test.
    #[test]
    fn env_changing_integration_tests_hold_a_single_test() {
        let tests = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
        let mut crowded = Vec::new();
        for entry in std::fs::read_dir(&tests).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_none_or(|ext| ext != "rs") {
                continue;
            }
            let source = std::fs::read_to_string(&path).unwrap();
            let changes_env = source.contains("env::set_var") || source.contains("env::remove_var");
            let test_count = source
                .lines()
                .filter(|line| line.trim() == "#[test]")
                .count();
            if changes_env && test_count > 1 {
                crowded.push(format!("{} has {test_count} tests", path.display()));
            }
        }
        assert!(
            crowded.is_empty(),
            "these integration tests change the process environment, so a \
             second test in the same binary races the first; give the file \
             its own lock-and-restore guard before adding tests:\n{}",
            crowded.join("\n")
        );
    }

    fn scan(root: &Path, dir: &Path, stray: &mut Vec<String>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                scan(root, &path, stray);
                continue;
            }
            let relative = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if path.extension().is_none_or(|ext| ext != "rs")
                || relative == "test_support.rs"
                || PRODUCTION_ENV_WRITERS.contains(&relative.as_str())
            {
                continue;
            }
            let source = std::fs::read_to_string(&path).unwrap();
            for (index, line) in source.lines().enumerate() {
                if line.contains("env::set_var") || line.contains("env::remove_var") {
                    stray.push(format!("{relative}:{}: {}", index + 1, line.trim()));
                }
            }
        }
    }
}

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
    // variables are restored before the lock is released. Gated by
    // `tests::the_guard_restores_the_environment_before_releasing_the_lock`.
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
        #[cfg(test)]
        tests::run_restore_hook();
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
    use super::{lock_process_env, EnvGuard, PROCESS_ENV};
    use std::cell::Cell;
    use std::path::Path;
    use std::sync::TryLockError;

    thread_local! {
        /// Runs once at the start of the next `SavedEnv` restore on this
        /// thread, so a test can observe the guard mid-drop.
        static RESTORE_HOOK: Cell<Option<fn()>> = const { Cell::new(None) };
    }

    pub(super) fn run_restore_hook() {
        if let Some(hook) = RESTORE_HOOK.with(Cell::take) {
            hook();
        }
    }

    /// Whether some thread holds the process env lock right now, asked from
    /// a fresh thread so the answer never depends on the caller's own guard.
    fn env_lock_is_held() -> bool {
        std::thread::spawn(|| matches!(PROCESS_ENV.try_lock(), Err(TryLockError::WouldBlock)))
            .join()
            .unwrap()
    }

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

    #[test]
    fn the_guard_restores_the_environment_before_releasing_the_lock() {
        thread_local! {
            static OBSERVED: Cell<Option<bool>> = const { Cell::new(None) };
        }
        // The hook runs inside `SavedEnv::drop`, synchronously, on this
        // thread, so the check lands exactly in the restore window. Another
        // test could hold the lock at that instant, but only once the guard
        // has (wrongly) let it go, so retrying a few times keeps a swapped
        // field order from slipping through while the correct order still
        // sees the lock held on every try.
        fn observe() {
            let held = (0..20).all(|_| {
                let held = env_lock_is_held();
                std::thread::yield_now();
                held
            });
            OBSERVED.with(|observed| observed.set(Some(held)));
        }

        let mut env = EnvGuard::lock();
        env.set("ARCHDUCTOR_TEST_SUPPORT_DROP_ORDER", "x");
        RESTORE_HOOK.with(|hook| hook.set(Some(observe)));
        drop(env);

        assert_eq!(
            OBSERVED.with(Cell::take),
            Some(true),
            "EnvGuard released the env lock before restoring the environment; \
             keep `saved` declared before `_lock` so it drops first"
        );
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
            let changes_env = source.lines().any(names_an_env_writer);
            let test_count = source
                .lines()
                .filter(|line| is_test_attribute(line))
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
                if names_an_env_writer(line) {
                    stray.push(format!("{relative}:{}: {}", index + 1, line.trim()));
                }
            }
        }
    }

    /// The functions that change the process environment.
    const ENV_WRITERS: &[&str] = &["set_var", "remove_var"];

    /// Whether `line` names `set_var` or `remove_var` as a whole identifier,
    /// whatever path leads to it: `std::env::set_var(..)`, a bare `set_var(..)`
    /// after `use std::env::{remove_var, set_var};`, or `set_var as alias`.
    fn names_an_env_writer(line: &str) -> bool {
        let is_ident = |c: char| c == '_' || c.is_alphanumeric();
        ENV_WRITERS.iter().any(|writer| {
            line.match_indices(writer).any(|(start, _)| {
                let before = line[..start].chars().next_back();
                let after = line[start + writer.len()..].chars().next();
                !before.is_some_and(is_ident) && !after.is_some_and(is_ident)
            })
        })
    }

    /// Whether `line` opens with a test attribute: `#[test]`, a one-line
    /// `#[test] fn x() {}`, or a runner's `#[tokio::test]`.
    fn is_test_attribute(line: &str) -> bool {
        let line = line.trim();
        line.starts_with("#[") && line.contains("test]")
    }

    #[test]
    fn the_scans_recognise_every_spelling_they_guard_against() {
        for line in [
            "std::env::set_var(\"X\", \"1\");",
            "env::remove_var(\"X\");",
            "use std::env::{remove_var, set_var};",
            "    set_var(\"X\", \"1\");",
            "use std::env::set_var as alias;",
        ] {
            assert!(names_an_env_writer(line), "missed {line:?}");
        }
        for line in [
            "fn reset_variable() {}",
            "unset_var_count += 1;",
            "let set_vars = 2;",
        ] {
            assert!(!names_an_env_writer(line), "flagged {line:?}");
        }
        for line in ["#[test]", "  #[test] fn x() {}", "#[tokio::test]"] {
            assert!(is_test_attribute(line), "missed {line:?}");
        }
        for line in ["#[cfg(test)]", "// #[test]", "fn test() {}"] {
            assert!(!is_test_attribute(line), "flagged {line:?}");
        }
    }
}

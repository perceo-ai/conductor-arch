//! Test-only seams in the archcar input path.
//!
//! Compiled in only with the `test-handoff-delay` feature, which the CLI's
//! integration tests turn on through a dev-dependency. Release and ordinary
//! builds get the empty versions below, so nothing here ships.

/// Stalls right after an input has been handed to the provider (the session
/// command sent, or the turn written to the provider's stdin) for
/// `ARCHDUCTOR_TEST_HANDOFF_DELAY_MS` milliseconds. A test widens the gap
/// between handoff and the rest of the bookkeeping this way, so a `session
/// send` can land in it deterministically.
#[cfg(feature = "test-handoff-delay")]
pub(crate) fn pause_after_provider_handoff() {
    let delay = std::env::var("ARCHDUCTOR_TEST_HANDOFF_DELAY_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok());
    if let Some(delay) = delay {
        std::thread::sleep(std::time::Duration::from_millis(delay));
    }
}

#[cfg(not(feature = "test-handoff-delay"))]
#[inline(always)]
pub(crate) fn pause_after_provider_handoff() {}

/// When set, and the path it names exists, `durable_thread_is_first_user_turn`
/// returns this as an Err instead of reading chat history -- lets a test force
/// the dropped-`SendInput`-above-the-readiness-write path deterministically,
/// for one specific send, by creating the marker file only once earlier sends
/// (e.g. the one that starts the session) must still succeed.
#[cfg(feature = "test-handoff-delay")]
pub(crate) fn forced_first_turn_check_failure() -> Option<String> {
    let path = std::env::var_os("ARCHDUCTOR_TEST_FORCE_FIRST_TURN_CHECK_ERROR_PATH")?;
    std::path::Path::new(&path).exists().then(|| {
        format!(
            "forced failure via test seam: {}",
            std::path::Path::new(&path).display()
        )
    })
}

#[cfg(not(feature = "test-handoff-delay"))]
#[inline(always)]
pub(crate) fn forced_first_turn_check_failure() -> Option<String> {
    None
}

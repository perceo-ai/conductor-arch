//! Provider identity for sessions.
//!
//! This was a closed three-variant enum, which meant every new agent needed a
//! new variant and a new arm in every match across the workspace. It is now an
//! interned string newtype: the wire format and the database columns are
//! unchanged (both were already strings), but the set of providers is open, so
//! registering an agent no longer edits the type system.
//!
//! Keeping it `Copy` matters — it is threaded through session state, snapshots,
//! and channel messages — so interned keys are leaked into `'static`. That is
//! bounded by the number of distinct provider keys a process ever sees, which
//! is the registry plus anything a peer daemon names.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::HashSet;
use std::fmt;
use std::sync::{Mutex, OnceLock};

/// Which agent a session runs. Compare with the associated consts
/// (`SessionKind::CODEX`) or against the registry; do not assume the set is
/// closed.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SessionKind(&'static str);

impl SessionKind {
    /// A plain terminal. Deliberately not a chat agent: it has no turns, no
    /// readiness signal, and no managed harness.
    pub const SHELL: Self = SessionKind("shell");
    pub const CODEX: Self = SessionKind("codex");
    pub const CLAUDE: Self = SessionKind("claude");

    /// Interns `key`, so the returned value is `Copy` and comparable by
    /// pointer-free equality. Unknown keys are accepted: validation against the
    /// registry belongs at launch, where a useful error can be produced, not at
    /// parse time where it would break a client talking to a newer daemon.
    pub fn new(key: &str) -> Self {
        let normalized = key.trim().to_ascii_lowercase();
        for known in Self::BUILT_INS {
            if known.0 == normalized {
                return *known;
            }
        }
        SessionKind(intern(&normalized))
    }

    pub const BUILT_INS: &'static [SessionKind] = &[Self::SHELL, Self::CODEX, Self::CLAUDE];

    pub fn as_str(self) -> &'static str {
        self.0
    }

    /// Shell is the one kind that is never a chat agent, so several call sites
    /// need exactly this question rather than a full match.
    pub fn is_shell(self) -> bool {
        self == Self::SHELL
    }

    /// Human-readable name for prompts and logs. Shell is not a registry entry,
    /// and an unregistered provider falls back to its key so output degrades to
    /// something readable rather than blank.
    pub fn display_name(self) -> &'static str {
        if self == Self::SHELL {
            return "Shell";
        }
        crate::agent_tools::tool_by_provider(self.0)
            .map(|tool| tool.display_name)
            .unwrap_or(self.0)
    }
}

impl fmt::Debug for SessionKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Renders as `SessionKind(codex)` rather than the tuple default, which
        // would quote the key and read badly inside larger derived Debug output.
        write!(f, "SessionKind({})", self.0)
    }
}

impl fmt::Display for SessionKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

impl Serialize for SessionKind {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.0)
    }
}

impl<'de> Deserialize<'de> for SessionKind {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Ok(SessionKind::new(&raw))
    }
}

impl From<&str> for SessionKind {
    fn from(value: &str) -> Self {
        SessionKind::new(value)
    }
}

fn intern(key: &str) -> &'static str {
    static INTERNED: OnceLock<Mutex<HashSet<&'static str>>> = OnceLock::new();
    let table = INTERNED.get_or_init(|| Mutex::new(HashSet::new()));
    let mut table = table
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(existing) = table.get(key) {
        return existing;
    }
    let leaked: &'static str = Box::leak(key.to_owned().into_boxed_str());
    table.insert(leaked);
    leaked
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_keys_round_trip_to_the_same_constant() {
        assert_eq!(SessionKind::new("codex"), SessionKind::CODEX);
        assert_eq!(SessionKind::new("Claude"), SessionKind::CLAUDE);
        assert_eq!(SessionKind::new("  shell "), SessionKind::SHELL);
        assert_eq!(SessionKind::CODEX.as_str(), "codex");
    }

    /// The whole point: an agent nobody compiled in still has an identity.
    #[test]
    fn unknown_providers_are_interned_and_compare_equal() {
        let first = SessionKind::new("gemini");
        let second = SessionKind::new("gemini");

        assert_eq!(first, second);
        assert_eq!(first.as_str(), "gemini");
        assert_ne!(first, SessionKind::CODEX);
        assert!(!first.is_shell());
    }

    #[test]
    fn serde_uses_the_bare_provider_key_so_the_wire_format_is_unchanged() {
        assert_eq!(
            serde_json::to_string(&SessionKind::CLAUDE).unwrap(),
            "\"claude\""
        );
        assert_eq!(
            serde_json::from_str::<SessionKind>("\"codex\"").unwrap(),
            SessionKind::CODEX
        );
        // A daemon that knows an agent this build does not must still decode.
        assert_eq!(
            serde_json::from_str::<SessionKind>("\"aider\"")
                .unwrap()
                .as_str(),
            "aider"
        );
    }

    #[test]
    fn interning_is_stable_across_many_calls() {
        let keys = (0..64).map(|_| SessionKind::new("amp")).collect::<Vec<_>>();

        assert!(keys.windows(2).all(|pair| pair[0] == pair[1]));
        assert_eq!(keys[0].as_str().as_ptr(), keys[63].as_str().as_ptr());
    }
}

//! The daemon's cache of workspace git facts.
//!
//! Deriving a workspace's changed-file count, diff stats and ahead/behind
//! counts costs about six git subprocesses. Any request that wants them for
//! every workspace pays that per workspace, which is what made
//! `list_workspaces` cost 5s across ten
//! (`docs/evidence/2026-11-19-concurrent-chat-perf-baseline.md`).
//!
//! This lives beside the store rather than inside the server so every caller
//! that builds workspace rows — the inventory, and the attention sweep through
//! `agent_status` — can read the same derived set instead of each shelling out
//! for its own copy.

use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;

use crate::workspace::{WorkspaceGitFacts, WorkspaceStatusLine};

/// Workspace git facts held in memory.
///
/// It has its own lock rather than living inside `ServerState`: deriving is
/// slow, and nothing else should queue behind it.
#[derive(Debug, Default)]
pub struct GitFactCache {
    inner: Mutex<GitFactCacheInner>,
}

#[derive(Debug, Default)]
struct GitFactCacheInner {
    facts: HashMap<String, crate::workspace::WorkspaceGitFacts>,
    dirty: BTreeSet<String>,
}

impl GitFactCache {
    pub fn get(&self, workspace: &str) -> Option<crate::workspace::WorkspaceGitFacts> {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.facts.get(workspace).cloned())
    }

    pub fn publish(&self, workspace: &str, facts: crate::workspace::WorkspaceGitFacts) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.facts.insert(workspace.to_owned(), facts);
        }
    }

    /// Note that a workspace's git state may have moved.
    pub fn mark_dirty(&self, workspace: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.dirty.insert(workspace.to_owned());
        }
    }

    /// Take the set of workspaces owed a recompute, clearing it.
    ///
    /// Taking rather than peeking means a workspace marked again while its
    /// recompute is running is picked up by the next pass instead of being
    /// silently dropped.
    pub fn dirty_workspaces(&self) -> Vec<String> {
        self.inner
            .lock()
            .map(|mut inner| std::mem::take(&mut inner.dirty).into_iter().collect())
            .unwrap_or_default()
    }

    pub fn forget(&self, workspace: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.facts.remove(workspace);
            inner.dirty.remove(workspace);
        }
    }
}

/// Fill a git-free status line from cached or persisted facts.
///
/// The single definition of how a `WorkspaceStatusLine` gets its git-derived
/// fields without running git, shared by the workspace inventory and the
/// attention sweep so the two cannot drift.
///
/// Order is cache, then the last persisted set, then nothing. A workspace
/// whose state was never measured reports zeros and is queued for the
/// refresher — correct for a brand-new workspace, which genuinely has no
/// changes, and corrected within a tick for any other.
///
/// Every git-derived field is gated on the workspace being active, matching
/// what deriving inline produced: an archived workspace has no live worktree,
/// and nothing re-derives one, so its last live numbers would otherwise stay
/// on screen for good.
pub fn fill_status_line_from_facts(
    line: &mut WorkspaceStatusLine,
    cache: &GitFactCache,
    stored: impl FnOnce(&str) -> Option<WorkspaceGitFacts>,
) -> usize {
    let name = line.workspace.name.clone();
    let facts = cache.get(&name).or_else(|| {
        let stored = stored(&name);
        if let Some(facts) = stored.clone() {
            cache.publish(&name, facts);
        }
        stored
    });
    let facts = match facts {
        Some(facts) => facts,
        None => {
            cache.mark_dirty(&name);
            WorkspaceGitFacts {
                changed_files: 0,
                diff_additions: 0,
                diff_deletions: 0,
                push: None,
                computed_at_ms: 0,
            }
        }
    };
    let active = line.workspace.status == "active";
    line.diff_additions = if active { facts.diff_additions } else { 0 };
    line.diff_deletions = if active { facts.diff_deletions } else { 0 };
    line.branch_push_state = if active { facts.push.clone() } else { None };
    if active {
        facts.changed_files
    } else {
        0
    }
}

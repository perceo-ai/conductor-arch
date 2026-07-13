use anyhow::Result;

use crate::workspace::{SessionHarnessOptions, SessionKind, WorkspaceStore};

pub trait HarnessController: Send + Sync {
    fn kind(&self) -> SessionKind;
    fn supports_auto_spawn(&self) -> bool;
    fn build_launch(
        &self,
        store: &WorkspaceStore,
        workspace: &str,
        harness: SessionHarnessOptions,
    ) -> Result<crate::workspace::SessionLaunch>;
}

pub fn controller_for_kind(kind: SessionKind) -> Box<dyn HarnessController> {
    match kind {
        SessionKind::Codex => Box::new(CodexHarnessController),
        SessionKind::Claude => Box::new(ClaudeHarnessController),
        SessionKind::Shell => Box::new(ShellHarnessController),
    }
}

pub struct CodexHarnessController;

impl HarnessController for CodexHarnessController {
    fn kind(&self) -> SessionKind {
        SessionKind::Codex
    }

    fn supports_auto_spawn(&self) -> bool {
        true
    }

    fn build_launch(
        &self,
        store: &WorkspaceStore,
        workspace: &str,
        harness: SessionHarnessOptions,
    ) -> Result<crate::workspace::SessionLaunch> {
        store.session_launch_with_options(workspace, SessionKind::Codex, harness)
    }
}

pub struct ClaudeHarnessController;

impl HarnessController for ClaudeHarnessController {
    fn kind(&self) -> SessionKind {
        SessionKind::Claude
    }

    fn supports_auto_spawn(&self) -> bool {
        true
    }

    fn build_launch(
        &self,
        store: &WorkspaceStore,
        workspace: &str,
        harness: SessionHarnessOptions,
    ) -> Result<crate::workspace::SessionLaunch> {
        store.session_launch_with_options(workspace, SessionKind::Claude, harness)
    }
}

pub struct ShellHarnessController;

impl HarnessController for ShellHarnessController {
    fn kind(&self) -> SessionKind {
        SessionKind::Shell
    }

    fn supports_auto_spawn(&self) -> bool {
        false
    }

    fn build_launch(
        &self,
        store: &WorkspaceStore,
        workspace: &str,
        harness: SessionHarnessOptions,
    ) -> Result<crate::workspace::SessionLaunch> {
        store.session_launch_with_options(workspace, SessionKind::Shell, harness)
    }
}

pub fn provider_name(kind: SessionKind) -> &'static str {
    match kind {
        SessionKind::Codex => "codex",
        SessionKind::Claude => "claude",
        SessionKind::Shell => "shell",
    }
}

pub fn ensure_thread_for_kind(
    store: &WorkspaceStore,
    workspace: &str,
    kind: SessionKind,
) -> Result<crate::workspace::ChatThreadRecord> {
    let provider = provider_name(kind);
    if let Some(existing) = store
        .list_chat_threads(workspace)?
        .into_iter()
        .find(|thread| thread.provider == provider)
    {
        return Ok(existing);
    }
    let title = match kind {
        SessionKind::Codex => "Codex Chat 1",
        SessionKind::Claude => "Claude Chat 1",
        SessionKind::Shell => "Shell Chat 1",
    };
    store.create_chat_thread(workspace, provider, title, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::{AddRepository, RepositoryStore};
    use crate::workspace::CreateWorkspace;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;

    #[test]
    fn codex_harness_reports_runtime_capabilities_without_screen_hooks() {
        let controller = CodexHarnessController;
        assert_eq!(controller.kind(), SessionKind::Codex);
        assert!(controller.supports_auto_spawn());
    }

    #[test]
    fn claude_harness_reports_runtime_capabilities() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("test.db");
        let repo_path = init_repo(temp.path().join("demo"));
        RepositoryStore::open(&db)
            .unwrap()
            .add(AddRepository {
                name: Some("demo".to_owned()),
                root_path: repo_path,
                default_branch: Some("main".to_owned()),
                remote_name: "origin".to_owned(),
                workspace_parent_path: Some(temp.path().join("workspaces/demo")),
            })
            .unwrap();
        let store = WorkspaceStore::open(&db).unwrap();
        store
            .create(CreateWorkspace {
                repository_name: "demo".to_owned(),
                name: "berlin".to_owned(),
                branch: "lc/berlin".to_owned(),
                base_ref: Some("main".to_owned()),
            })
            .unwrap();
        let controller = ClaudeHarnessController;

        assert_eq!(controller.kind(), SessionKind::Claude);
        assert!(controller.supports_auto_spawn());
        let launch = controller
            .build_launch(&store, "berlin", SessionHarnessOptions::default())
            .unwrap();
        assert_eq!(launch.kind, SessionKind::Claude);
        assert_eq!(launch.program, PathBuf::from("claude"));
        assert!(launch.session_resume_id.is_some());
        assert_eq!(
            launch.args,
            vec![
                "--session-id".to_owned(),
                launch.session_resume_id.as_deref().unwrap().to_owned(),
            ]
        );
        assert!(launch.cwd.ends_with("berlin"));
    }

    fn init_repo(path: PathBuf) -> PathBuf {
        fs::create_dir(&path).unwrap();
        Command::new("git")
            .args(["init", "--initial-branch", "main"])
            .arg(&path)
            .status()
            .unwrap();
        fs::write(path.join("README.md"), "demo\n").unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&path)
            .args(["add", "."])
            .status()
            .unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&path)
            .args([
                "-c",
                "user.name=Archductor",
                "-c",
                "user.email=archductor@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "initial",
            ])
            .status()
            .unwrap();
        path
    }
}

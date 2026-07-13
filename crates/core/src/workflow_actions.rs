#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkflowAction {
    pub id: &'static str,
    pub cli_route: &'static str,
    pub mutates_state: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GtkLiveControl {
    pub provider: &'static str,
    pub control: &'static str,
    pub workflow_action_id: &'static str,
}

pub const ACTION_SESSION_PROVIDER_SELECT: &str = "session.provider.select";
pub const ACTION_SESSION_CONTROL_MODEL: &str = "session.control.model";
pub const ACTION_SESSION_CONTROL_THINKING: &str = "session.control.thinking";

pub const WORKFLOW_ACTIONS: &[WorkflowAction] = &[
    WorkflowAction {
        id: "doctor",
        cli_route: "doctor",
        mutates_state: false,
    },
    WorkflowAction {
        id: "repo.add",
        cli_route: "repo add <path>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "repo.list",
        cli_route: "repo list",
        mutates_state: false,
    },
    WorkflowAction {
        id: "repo.doctor",
        cli_route: "repo doctor [name]",
        mutates_state: false,
    },
    WorkflowAction {
        id: "repo.update",
        cli_route: "repo update <name>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "repo.settings.export",
        cli_route: "repo settings <name> export",
        mutates_state: false,
    },
    WorkflowAction {
        id: "repo.settings.import",
        cli_route: "repo settings <name> import <input>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "workspace.create",
        cli_route: "workspace create <repository>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "workspace.list",
        cli_route: "workspace list",
        mutates_state: false,
    },
    WorkflowAction {
        id: "workspace.archive",
        cli_route: "workspace archive <name>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "workspace.restore",
        cli_route: "workspace restore <name>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "workspace.discard",
        cli_route: "workspace discard <name>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "workspace.delete",
        cli_route: "workspace delete <name>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "workspace.rename",
        cli_route: "workspace rename <name> <new-name>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "workspace.duplicate",
        cli_route: "workspace duplicate <name> <new-name>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "workspace.link_dir",
        cli_route: "workspace link-dir <workspace> <target>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "workspace.unlink_dir",
        cli_route: "workspace unlink-dir <workspace> <target>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "workspace.linked_dirs",
        cli_route: "workspace linked-dirs <workspace>",
        mutates_state: false,
    },
    WorkflowAction {
        id: "workspace.branch.create",
        cli_route: "workspace branch <workspace> create <branch>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "workspace.branch.checkout",
        cli_route: "workspace branch <workspace> checkout <branch>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "workspace.branch.rename",
        cli_route: "workspace branch <workspace> rename <branch>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "workspace.branch.delete",
        cli_route: "workspace branch <workspace> delete <branch>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "workspace.timeline",
        cli_route: "workspace timeline <workspace>",
        mutates_state: false,
    },
    WorkflowAction {
        id: "workspace.source_preflight",
        cli_route: "workspace source-preflight",
        mutates_state: false,
    },
    WorkflowAction {
        id: "run.start",
        cli_route: "run <workspace>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "run.stop",
        cli_route: "stop <workspace>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "logs.show",
        cli_route: "logs <workspace> --run|--session",
        mutates_state: false,
    },
    WorkflowAction {
        id: "runs.list",
        cli_route: "runs <workspace>",
        mutates_state: false,
    },
    WorkflowAction {
        id: "diff.show",
        cli_route: "diff <workspace>",
        mutates_state: false,
    },
    WorkflowAction {
        id: "checks.show",
        cli_route: "checks <workspace>",
        mutates_state: false,
    },
    WorkflowAction {
        id: "open.editor",
        cli_route: "open <workspace>",
        mutates_state: false,
    },
    WorkflowAction {
        id: "status.show",
        cli_route: "status",
        mutates_state: false,
    },
    WorkflowAction {
        id: "conflicts.show",
        cli_route: "conflicts <workspace>",
        mutates_state: false,
    },
    WorkflowAction {
        id: "archive.workspace",
        cli_route: "archive <name>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "discard.workspace",
        cli_route: "discard <name>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "import.conductor",
        cli_route: "import conductor",
        mutates_state: true,
    },
    WorkflowAction {
        id: "history.list",
        cli_route: "history list",
        mutates_state: false,
    },
    WorkflowAction {
        id: "history.show",
        cli_route: "history show <process-id>",
        mutates_state: false,
    },
    WorkflowAction {
        id: "pr.create",
        cli_route: "pr create <workspace>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "pr.checks",
        cli_route: "pr checks <workspace>",
        mutates_state: false,
    },
    WorkflowAction {
        id: "pr.summary",
        cli_route: "pr summary <workspace>",
        mutates_state: false,
    },
    WorkflowAction {
        id: "pr.resolve_thread",
        cli_route: "pr resolve-thread <workspace> <thread-id>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "pr.reopen_thread",
        cli_route: "pr reopen-thread <workspace> <thread-id>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "pr.view",
        cli_route: "pr view <workspace>",
        mutates_state: false,
    },
    WorkflowAction {
        id: "pr.merge",
        cli_route: "pr merge <workspace>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "session.start",
        cli_route: "session start <workspace>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "session.open",
        cli_route: "session open <workspace>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "session.stop",
        cli_route: "session stop <workspace>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "session.attach",
        cli_route: "session attach <workspace>",
        mutates_state: false,
    },
    WorkflowAction {
        id: "session.list",
        cli_route: "session list <workspace>",
        mutates_state: false,
    },
    WorkflowAction {
        id: ACTION_SESSION_PROVIDER_SELECT,
        cli_route: "session start|open <workspace> --kind <kind>",
        mutates_state: true,
    },
    WorkflowAction {
        id: ACTION_SESSION_CONTROL_MODEL,
        cli_route: "archcar model <session-id> <model>",
        mutates_state: true,
    },
    WorkflowAction {
        id: ACTION_SESSION_CONTROL_THINKING,
        cli_route: "archcar send <session-id> --kind control-command /thinking <level>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "session.input.user",
        cli_route: "archcar send <session-id> --kind user <input>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "session.input.review_prompt",
        cli_route: "archcar send <session-id> --kind review-prompt <input>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "archcar.ensure",
        cli_route: "archcar ensure <workspace>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "archcar.spawn",
        cli_route: "archcar spawn <workspace>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "archcar.status",
        cli_route: "archcar status <session-id>",
        mutates_state: false,
    },
    WorkflowAction {
        id: "archcar.screen",
        cli_route: "archcar screen <session-id>",
        mutates_state: false,
    },
    WorkflowAction {
        id: "archcar.resize",
        cli_route: "archcar resize <session-id> <rows> <cols>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "archcar.kill",
        cli_route: "archcar kill <session-id>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "todo.add",
        cli_route: "todo add <workspace> <text>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "todo.list",
        cli_route: "todo list <workspace>",
        mutates_state: false,
    },
    WorkflowAction {
        id: "todo.done",
        cli_route: "todo done <id>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "todo.sync",
        cli_route: "todo sync <workspace>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "review.add",
        cli_route: "review add <workspace> <file>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "review.list",
        cli_route: "review list <workspace>",
        mutates_state: false,
    },
    WorkflowAction {
        id: "review.resolve",
        cli_route: "review resolve <id>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "checkpoint.create",
        cli_route: "checkpoint create <workspace>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "checkpoint.list",
        cli_route: "checkpoint list <workspace>",
        mutates_state: false,
    },
    WorkflowAction {
        id: "checkpoint.restore",
        cli_route: "checkpoint restore <workspace> <id>",
        mutates_state: true,
    },
    WorkflowAction {
        id: "mcp.status",
        cli_route: "mcp status <workspace>",
        mutates_state: false,
    },
];

pub const GTK_LIVE_CONTROLS: &[GtkLiveControl] = &[
    GtkLiveControl {
        provider: "codex",
        control: "provider",
        workflow_action_id: ACTION_SESSION_PROVIDER_SELECT,
    },
    GtkLiveControl {
        provider: "codex",
        control: "model",
        workflow_action_id: ACTION_SESSION_CONTROL_MODEL,
    },
    GtkLiveControl {
        provider: "codex",
        control: "thinking",
        workflow_action_id: ACTION_SESSION_CONTROL_THINKING,
    },
    GtkLiveControl {
        provider: "claude",
        control: "provider",
        workflow_action_id: ACTION_SESSION_PROVIDER_SELECT,
    },
    GtkLiveControl {
        provider: "shell",
        control: "provider",
        workflow_action_id: ACTION_SESSION_PROVIDER_SELECT,
    },
];

pub fn workflow_action_by_id(id: &str) -> Option<&'static WorkflowAction> {
    WORKFLOW_ACTIONS.iter().find(|action| action.id == id)
}

pub fn gtk_live_controls_for_provider(
    provider: &str,
) -> impl Iterator<Item = &'static GtkLiveControl> + '_ {
    GTK_LIVE_CONTROLS
        .iter()
        .filter(move |control| control.provider == provider)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn workflow_action_ids_are_unique() {
        let mut seen = HashSet::new();
        for action in WORKFLOW_ACTIONS {
            assert!(seen.insert(action.id), "duplicate action id {}", action.id);
        }
    }

    #[test]
    fn automation_workflow_actions_have_cli_routes() {
        for action in WORKFLOW_ACTIONS {
            assert!(
                !action.cli_route.trim().is_empty(),
                "{} must define a CLI route",
                action.id
            );
        }
    }

    #[test]
    fn gtk_live_controls_reference_cli_backed_workflow_actions() {
        for control in GTK_LIVE_CONTROLS {
            let action = workflow_action_by_id(control.workflow_action_id).unwrap_or_else(|| {
                panic!(
                    "{}:{} maps to missing workflow action {}",
                    control.provider, control.control, control.workflow_action_id
                )
            });
            assert!(
                !action.cli_route.trim().is_empty(),
                "{}:{} must have CLI parity",
                control.provider,
                control.control
            );
        }
    }

    #[test]
    fn codex_live_model_and_thinking_controls_have_control_command_routes() {
        let controls = gtk_live_controls_for_provider("codex").collect::<Vec<_>>();
        assert!(controls.iter().any(|control| {
            control.control == "model" && control.workflow_action_id == ACTION_SESSION_CONTROL_MODEL
        }));
        assert!(controls.iter().any(|control| {
            control.control == "thinking"
                && control.workflow_action_id == ACTION_SESSION_CONTROL_THINKING
        }));

        let model = workflow_action_by_id(ACTION_SESSION_CONTROL_MODEL).unwrap();
        let thinking = workflow_action_by_id(ACTION_SESSION_CONTROL_THINKING).unwrap();
        assert!(model.cli_route.starts_with("archcar model "));
        assert!(thinking.cli_route.contains("--kind control-command"));
    }
}

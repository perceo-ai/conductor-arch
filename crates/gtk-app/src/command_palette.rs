use crate::state::{AppPage, WorkspaceTab};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PaletteTarget {
    Page(AppPage),
    WorkspaceTab(WorkspaceTab),
    Refresh,
    ToggleSidebar,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PaletteCommand {
    pub label: &'static str,
    pub shortcut: Option<&'static str>,
    pub target: PaletteTarget,
}

pub(crate) fn palette_commands(has_workspace: bool) -> Vec<PaletteCommand> {
    let mut commands = vec![
        PaletteCommand {
            label: "Dashboard",
            shortcut: None,
            target: PaletteTarget::Page(AppPage::Dashboard),
        },
        PaletteCommand {
            label: "Projects",
            shortcut: None,
            target: PaletteTarget::Page(AppPage::Projects),
        },
        PaletteCommand {
            label: "History",
            shortcut: None,
            target: PaletteTarget::Page(AppPage::History),
        },
        PaletteCommand {
            label: "Refresh",
            shortcut: Some("Ctrl+R"),
            target: PaletteTarget::Refresh,
        },
        PaletteCommand {
            label: "Toggle Sidebar",
            shortcut: Some("Ctrl+B"),
            target: PaletteTarget::ToggleSidebar,
        },
    ];

    if has_workspace {
        commands.extend([
            PaletteCommand {
                label: "Workspace",
                shortcut: None,
                target: PaletteTarget::Page(AppPage::Workspace),
            },
            PaletteCommand {
                label: "Changes",
                shortcut: None,
                target: PaletteTarget::WorkspaceTab(WorkspaceTab::Changes),
            },
            PaletteCommand {
                label: "Checks",
                shortcut: None,
                target: PaletteTarget::WorkspaceTab(WorkspaceTab::Checks),
            },
            PaletteCommand {
                label: "Review",
                shortcut: None,
                target: PaletteTarget::WorkspaceTab(WorkspaceTab::Changes),
            },
            PaletteCommand {
                label: "Chat / Terminal",
                shortcut: None,
                target: PaletteTarget::WorkspaceTab(WorkspaceTab::Chats),
            },
            PaletteCommand {
                label: "Big Terminal",
                shortcut: None,
                target: PaletteTarget::WorkspaceTab(WorkspaceTab::Terminal),
            },
            PaletteCommand {
                label: "Todos",
                shortcut: None,
                target: PaletteTarget::WorkspaceTab(WorkspaceTab::Todos),
            },
            PaletteCommand {
                label: "Processes",
                shortcut: None,
                target: PaletteTarget::WorkspaceTab(WorkspaceTab::Processes),
            },
            PaletteCommand {
                label: "Checkpoints",
                shortcut: None,
                target: PaletteTarget::WorkspaceTab(WorkspaceTab::Checkpoints),
            },
        ]);
    }

    commands
}

pub(crate) fn filter_palette_commands<'a>(
    commands: &'a [PaletteCommand],
    query: &str,
) -> Vec<&'a PaletteCommand> {
    let query = normalize_palette_query(query);
    if query.is_empty() {
        return commands.iter().collect();
    }
    commands
        .iter()
        .filter(|command| palette_command_matches(command, &query))
        .collect()
}

fn palette_command_matches(command: &PaletteCommand, normalized_query: &str) -> bool {
    palette_command_search_terms(command)
        .iter()
        .any(|term| normalize_palette_query(term).contains(normalized_query))
}

fn palette_command_search_terms(command: &PaletteCommand) -> Vec<String> {
    let mut terms = vec![command.label.to_owned()];
    if let Some(shortcut) = command.shortcut {
        terms.push(shortcut.to_owned());
    }
    terms.extend(match &command.target {
        PaletteTarget::Page(AppPage::Dashboard) => vec!["home".to_owned(), "overview".to_owned()],
        PaletteTarget::Page(AppPage::Projects) => vec!["repo".to_owned(), "repository".to_owned()],
        PaletteTarget::Page(AppPage::History) => vec!["archive".to_owned(), "past".to_owned()],
        PaletteTarget::Page(AppPage::Workspace) => vec!["worktree".to_owned(), "branch".to_owned()],
        PaletteTarget::Page(AppPage::Settings) => vec!["config".to_owned()],
        PaletteTarget::Page(AppPage::Review) => vec!["review".to_owned()],
        PaletteTarget::WorkspaceTab(WorkspaceTab::Chats) => {
            vec!["chat".to_owned(), "agent".to_owned(), "session".to_owned()]
        }
        PaletteTarget::WorkspaceTab(WorkspaceTab::Changes) => {
            vec!["diff".to_owned(), "files".to_owned(), "review".to_owned()]
        }
        PaletteTarget::WorkspaceTab(WorkspaceTab::Checks) => {
            vec!["ci".to_owned(), "pr".to_owned(), "github".to_owned()]
        }
        PaletteTarget::WorkspaceTab(WorkspaceTab::Checkpoints) => {
            vec!["checkpoint".to_owned(), "restore".to_owned()]
        }
        PaletteTarget::WorkspaceTab(WorkspaceTab::Todos) => {
            vec!["todo".to_owned(), "tasks".to_owned()]
        }
        PaletteTarget::WorkspaceTab(WorkspaceTab::Processes) => {
            vec!["process".to_owned(), "runs".to_owned()]
        }
        PaletteTarget::WorkspaceTab(WorkspaceTab::Terminal) => {
            vec!["terminal".to_owned(), "shell".to_owned(), "big".to_owned()]
        }
        PaletteTarget::Refresh => vec!["reload".to_owned(), "sync".to_owned()],
        PaletteTarget::ToggleSidebar => vec!["sidebar".to_owned(), "nav".to_owned()],
    });
    terms
}

fn normalize_palette_query(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn palette_commands_include_global_navigation_and_shortcuts() {
        let commands = palette_commands(false);

        assert!(commands.iter().any(|command| command.label == "Dashboard"
            && command.target == PaletteTarget::Page(AppPage::Dashboard)));
        assert!(commands
            .iter()
            .any(|command| command.label == "Refresh" && command.shortcut == Some("Ctrl+R")));
        assert!(
            commands
                .iter()
                .any(|command| command.label == "Toggle Sidebar"
                    && command.shortcut == Some("Ctrl+B"))
        );
        assert!(!commands
            .iter()
            .any(|command| command.label == "Big Terminal"));
    }

    #[test]
    fn palette_commands_include_workspace_tabs_when_workspace_selected() {
        let commands = palette_commands(true);

        assert!(commands
            .iter()
            .any(|command| command.label == "Big Terminal"
                && command.target == PaletteTarget::WorkspaceTab(WorkspaceTab::Terminal)));
        assert!(commands.iter().any(|command| command.label == "Changes"
            && command.target == PaletteTarget::WorkspaceTab(WorkspaceTab::Changes)));
    }

    #[test]
    fn palette_filter_matches_label_shortcut_and_aliases() {
        let commands = palette_commands(true);

        let terminal = filter_palette_commands(&commands, "term");
        assert_eq!(terminal[0].label, "Chat / Terminal");
        assert!(terminal
            .iter()
            .any(|command| command.label == "Big Terminal"));

        let refresh = filter_palette_commands(&commands, "ctrl+r");
        assert_eq!(refresh.len(), 1);
        assert_eq!(refresh[0].label, "Refresh");

        let checks = filter_palette_commands(&commands, "ci");
        assert!(checks.iter().any(|command| command.label == "Checks"));

        let chat = filter_palette_commands(&commands, "chat");
        assert_eq!(
            chat[0].target,
            PaletteTarget::WorkspaceTab(WorkspaceTab::Chats)
        );
    }

    #[test]
    fn palette_filter_hides_workspace_commands_without_workspace() {
        let commands = palette_commands(false);

        assert!(filter_palette_commands(&commands, "terminal").is_empty());
        assert!(filter_palette_commands(&commands, "project")
            .iter()
            .any(|command| command.label == "Projects"));
    }
}

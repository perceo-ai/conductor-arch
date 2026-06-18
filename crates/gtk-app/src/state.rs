use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;

use linux_conductor_core::paths::AppPaths;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppPage {
    Dashboard,
    Projects,
    Workspace,
    History,
    Settings,
    Review,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceTab {
    Chats,
    Changes,
    Checks,
    Todos,
    Processes,
    Terminal,
}

#[derive(Debug, Clone)]
pub struct AppStateSnapshot {
    pub selected_workspace: Option<String>,
    pub selected_project: Option<String>,
    pub active_page: AppPage,
    pub active_workspace_tab: WorkspaceTab,
    pub selected_agent_session: Option<i64>,
    pub running_processes: Vec<i64>,
    pub attention_state: AttentionState,
    pub settings_layer: SettingsLayer,
}

#[derive(Debug, Clone, Default)]
pub struct AttentionState {
    pub failed_checks: usize,
    pub open_todos: usize,
    pub open_comments: usize,
    pub conflicts: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingsLayer {
    BuiltInDefaults,
    UserShared,
    RepositoryShared,
    LocalProjectOverride,
    Managed,
}

#[derive(Debug, Clone)]
pub struct AppState {
    inner: Rc<RefCell<AppStateSnapshot>>,
    pub paths: AppPaths,
}

impl AppState {
    pub fn new(paths: AppPaths, initial_workspace: Option<String>) -> Self {
        let active_page = if initial_workspace.is_some() {
            AppPage::Workspace
        } else {
            AppPage::Dashboard
        };
        Self {
            inner: Rc::new(RefCell::new(AppStateSnapshot {
                selected_workspace: initial_workspace,
                selected_project: None,
                active_page,
                active_workspace_tab: WorkspaceTab::Chats,
                selected_agent_session: None,
                running_processes: Vec::new(),
                attention_state: AttentionState::default(),
                settings_layer: SettingsLayer::BuiltInDefaults,
            })),
            paths,
        }
    }

    pub fn selected_workspace(&self) -> Option<String> {
        self.inner.borrow().selected_workspace.clone()
    }

    pub fn set_selected_workspace(&self, workspace: Option<String>) {
        let mut state = self.inner.borrow_mut();
        state.selected_workspace = workspace;
        state.active_page = AppPage::Workspace;
    }

    pub fn set_active_page(&self, page: AppPage) {
        self.inner.borrow_mut().active_page = page;
    }

    pub fn set_active_workspace_tab(&self, tab: WorkspaceTab) {
        self.inner.borrow_mut().active_workspace_tab = tab;
    }

    pub fn workspace_database_path(&self) -> PathBuf {
        self.paths.database_path.clone()
    }

    pub fn snapshot(&self) -> AppStateSnapshot {
        self.inner.borrow().clone()
    }
}

use std::cell::RefCell;
use std::rc::Rc;

#[derive(Clone, Copy, Debug)]
pub enum RefreshScope {
    All,
    Sidebar,
    Dashboard,
    Projects,
    History,
    Workspace,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RefreshEvent {
    Manual,
    ProjectInventoryChanged,
    SettingsChanged,
    WorkspaceSelectionChanged,
    WorkspaceInventoryChanged,
    WorkspaceRuntimeChanged { workspace: String },
    WorkspaceReviewChanged { workspace: String },
    WorkspaceChatLifecycleChanged { workspace: String },
    WorkspaceChatMessagesChanged { workspace: String, thread_id: i64 },
    TerminalChanged { workspace: String },
}

type RefreshHandler = Rc<dyn Fn()>;

/// Dumb UI fanout for page refresh callbacks.
///
/// PER-190: RefreshHub intentionally has no typed error channel; each page owns
/// its load/store error handling and renders failures in-place before or during
/// its registered callback. Replace this with typed refresh results only if
/// multiple pages need shared page-owned error handling semantics.
#[derive(Clone, Default)]
pub struct RefreshHub {
    sidebar: Rc<RefCell<Option<RefreshHandler>>>,
    dashboard: Rc<RefCell<Option<RefreshHandler>>>,
    projects: Rc<RefCell<Option<RefreshHandler>>>,
    history: Rc<RefCell<Option<RefreshHandler>>>,
    workspace: Rc<RefCell<Option<RefreshHandler>>>,
}

impl RefreshHub {
    pub fn set_sidebar(&self, handler: impl Fn() + 'static) {
        *self.sidebar.borrow_mut() = Some(Rc::new(handler));
    }

    pub fn set_dashboard(&self, handler: impl Fn() + 'static) {
        *self.dashboard.borrow_mut() = Some(Rc::new(handler));
    }

    pub fn set_projects(&self, handler: impl Fn() + 'static) {
        *self.projects.borrow_mut() = Some(Rc::new(handler));
    }

    pub fn set_history(&self, handler: impl Fn() + 'static) {
        *self.history.borrow_mut() = Some(Rc::new(handler));
    }

    pub fn set_workspace(&self, handler: impl Fn() + 'static) {
        *self.workspace.borrow_mut() = Some(Rc::new(handler));
    }

    pub fn refresh_event(&self, event: RefreshEvent) {
        match event {
            RefreshEvent::Manual => self.refresh(RefreshScope::All),
            RefreshEvent::ProjectInventoryChanged => {
                self.refresh(RefreshScope::Projects);
                self.refresh(RefreshScope::Sidebar);
                self.refresh(RefreshScope::Dashboard);
            }
            RefreshEvent::SettingsChanged => {
                self.refresh(RefreshScope::Projects);
                self.refresh(RefreshScope::Workspace);
            }
            RefreshEvent::WorkspaceSelectionChanged => {
                self.refresh(RefreshScope::Sidebar);
                self.refresh(RefreshScope::Workspace);
            }
            RefreshEvent::WorkspaceInventoryChanged => {
                self.refresh(RefreshScope::Sidebar);
                self.refresh(RefreshScope::Dashboard);
                self.refresh(RefreshScope::History);
                self.refresh(RefreshScope::Workspace);
            }
            RefreshEvent::WorkspaceRuntimeChanged { .. }
            | RefreshEvent::WorkspaceChatLifecycleChanged { .. }
            | RefreshEvent::TerminalChanged { .. } => {
                self.refresh(RefreshScope::Sidebar);
                self.refresh(RefreshScope::Dashboard);
                self.refresh(RefreshScope::History);
                self.refresh(RefreshScope::Workspace);
            }
            RefreshEvent::WorkspaceReviewChanged { .. } => {
                self.refresh(RefreshScope::Dashboard);
                self.refresh(RefreshScope::History);
                self.refresh(RefreshScope::Workspace);
            }
            RefreshEvent::WorkspaceChatMessagesChanged { .. } => {
                self.refresh(RefreshScope::Workspace);
            }
        }
    }

    pub fn refresh(&self, scope: RefreshScope) {
        match scope {
            RefreshScope::All => {
                self.run(&self.sidebar);
                self.run(&self.dashboard);
                self.run(&self.projects);
                self.run(&self.history);
                self.run(&self.workspace);
            }
            RefreshScope::Sidebar => self.run(&self.sidebar),
            RefreshScope::Dashboard => self.run(&self.dashboard),
            RefreshScope::Projects => self.run(&self.projects),
            RefreshScope::History => self.run(&self.history),
            RefreshScope::Workspace => self.run(&self.workspace),
        }
    }

    fn run(&self, slot: &Rc<RefCell<Option<RefreshHandler>>>) {
        let handler = slot.borrow().as_ref().cloned();
        if let Some(handler) = handler {
            handler();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[derive(Default)]
    struct RefreshCounts {
        sidebar: Rc<Cell<u32>>,
        dashboard: Rc<Cell<u32>>,
        projects: Rc<Cell<u32>>,
        history: Rc<Cell<u32>>,
        workspace: Rc<Cell<u32>>,
    }

    impl RefreshCounts {
        fn install(&self, hub: &RefreshHub) {
            let sidebar = Rc::clone(&self.sidebar);
            hub.set_sidebar(move || sidebar.set(sidebar.get() + 1));

            let dashboard = Rc::clone(&self.dashboard);
            hub.set_dashboard(move || dashboard.set(dashboard.get() + 1));

            let projects = Rc::clone(&self.projects);
            hub.set_projects(move || projects.set(projects.get() + 1));

            let history = Rc::clone(&self.history);
            hub.set_history(move || history.set(history.get() + 1));

            let workspace = Rc::clone(&self.workspace);
            hub.set_workspace(move || workspace.set(workspace.get() + 1));
        }

        fn values(&self) -> (u32, u32, u32, u32, u32) {
            (
                self.sidebar.get(),
                self.dashboard.get(),
                self.projects.get(),
                self.history.get(),
                self.workspace.get(),
            )
        }
    }

    #[test]
    fn refresh_handler_can_replace_same_scope_without_refcell_panic() {
        let hub = RefreshHub::default();
        let hub_for_handler = hub.clone();
        hub.set_workspace(move || {
            hub_for_handler.set_workspace(|| {});
        });

        hub.refresh(RefreshScope::Workspace);
    }

    #[test]
    fn runtime_refresh_event_skips_projects() {
        let hub = RefreshHub::default();
        let counts = RefreshCounts::default();
        counts.install(&hub);

        hub.refresh_event(RefreshEvent::WorkspaceRuntimeChanged {
            workspace: "demo".to_owned(),
        });

        assert_eq!(counts.values(), (1, 1, 0, 1, 1));
    }

    #[test]
    fn chat_message_refresh_event_only_refreshes_workspace() {
        let hub = RefreshHub::default();
        let counts = RefreshCounts::default();
        counts.install(&hub);

        hub.refresh_event(RefreshEvent::WorkspaceChatMessagesChanged {
            workspace: "demo".to_owned(),
            thread_id: 7,
        });

        assert_eq!(counts.values(), (0, 0, 0, 0, 1));
    }

    #[test]
    fn project_inventory_refresh_event_updates_global_summaries() {
        let hub = RefreshHub::default();
        let counts = RefreshCounts::default();
        counts.install(&hub);

        hub.refresh_event(RefreshEvent::ProjectInventoryChanged);

        assert_eq!(counts.values(), (1, 1, 1, 0, 0));
    }
}

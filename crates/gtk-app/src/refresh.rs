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
        if let Some(handler) = slot.borrow().as_ref() {
            handler();
        }
    }
}

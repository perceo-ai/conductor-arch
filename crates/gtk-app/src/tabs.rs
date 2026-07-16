use gtk::prelude::*;

const TAB_SHELL_CLASS: &str = "ws-tab-shell";
const TAB_LABEL_CLASS: &str = "ws-tab-label";
const TAB_ACTIVE_CLASS: &str = "ws-tab-active";

pub(crate) fn standard_tab(label: &str) -> gtk::Button {
    let button = gtk::Button::new();
    button.set_accessible_role(gtk::AccessibleRole::Tab);
    button.add_css_class(TAB_SHELL_CLASS);
    let label = gtk::Label::new(Some(label));
    label.add_css_class(TAB_LABEL_CLASS);
    button.set_child(Some(&label));
    button
}

pub(crate) fn set_standard_tab_active(button: &gtk::Button, active: bool) {
    if active {
        button.add_css_class(TAB_ACTIVE_CLASS);
    } else {
        button.remove_css_class(TAB_ACTIVE_CLASS);
    }
    button.update_state(&[gtk::accessible::State::Selected(Some(active))]);
}

pub(crate) fn standard_tab_strip() -> (gtk::ScrolledWindow, gtk::Box) {
    let tabs = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    tabs.set_accessible_role(gtk::AccessibleRole::TabList);
    let scroll = gtk::ScrolledWindow::new();
    scroll.set_policy(gtk::PolicyType::Automatic, gtk::PolicyType::Never);
    scroll.set_hexpand(true);
    scroll.set_propagate_natural_width(false);
    scroll.set_child(Some(&tabs));
    (scroll, tabs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_tabs_reuse_workspace_chat_tab_classes() {
        assert_eq!(TAB_SHELL_CLASS, "ws-tab-shell");
        assert_eq!(TAB_LABEL_CLASS, "ws-tab-label");
        assert_eq!(TAB_ACTIVE_CLASS, "ws-tab-active");
    }
}

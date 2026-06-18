use gtk::prelude::*;
use gtk::{Box as GBox, Button, Entry, Orientation, ScrolledWindow, TextView};
use std::path::Path;

pub fn embedded_terminal_panel(workspace_name: &str, workspace_path: &Path) -> GBox {
    let root = GBox::new(Orientation::Vertical, 8);
    root.add_css_class("terminal-panel");

    let transcript = TextView::new();
    transcript.set_editable(false);
    transcript.set_monospace(true);
    transcript.add_css_class("history-view");
    transcript.buffer().set_text(&format!(
        "Workspace terminal foundation\nworkspace: {}\npath: {}\n\nCommands entered here are captured in-app and can be promoted to PTY-backed execution next.",
        workspace_name,
        workspace_path.display()
    ));

    let transcript_scroll = ScrolledWindow::new();
    transcript_scroll.set_policy(gtk::PolicyType::Automatic, gtk::PolicyType::Automatic);
    transcript_scroll.set_vexpand(true);
    transcript_scroll.set_child(Some(&transcript));
    root.append(&transcript_scroll);

    let command_row = GBox::new(Orientation::Horizontal, 8);
    let entry = Entry::new();
    entry.set_placeholder_text(Some("workspace command"));
    entry.set_hexpand(true);
    let append_btn = Button::with_label("Queue");
    let buffer = transcript.buffer();
    let workspace = workspace_name.to_owned();
    let path = workspace_path.display().to_string();
    let entry_clone = entry.clone();
    append_btn.connect_clicked(move |_| {
        let command = entry_clone.text().trim().to_owned();
        if command.is_empty() {
            return;
        }
        let mut end = buffer.end_iter();
        buffer.insert(
            &mut end,
            &format!("\n$ cd {path}\n$ {command}\nqueued for {workspace}\n"),
        );
        entry_clone.set_text("");
    });

    command_row.append(&entry);
    command_row.append(&append_btn);
    root.append(&command_row);
    root
}

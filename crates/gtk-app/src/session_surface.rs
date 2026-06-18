use gtk::prelude::*;
use gtk::{Box as GBox, Button, Entry, Label, Orientation, ScrolledWindow, TextView};
use linux_conductor_core::workspace::{SessionKind, WorkspaceStore};
use std::path::{Path, PathBuf};

pub fn agent_session_panel(
    database_path: PathBuf,
    workspace_name: &str,
    refresh: impl Fn() + Clone + 'static,
) -> GBox {
    let root = GBox::new(Orientation::Vertical, 10);
    root.add_css_class("agent-panel");

    let controls = GBox::new(Orientation::Horizontal, 8);
    for (label, kind) in [
        ("Shell", SessionKind::Shell),
        ("Codex", SessionKind::Codex),
        ("Claude", SessionKind::Claude),
        ("Cursor", SessionKind::Cursor),
    ] {
        let button = Button::with_label(label);
        button.set_tooltip_text(Some("Start supervised in-app session"));
        let db_path = database_path.clone();
        let workspace = workspace_name.to_owned();
        let refresh_after_start = refresh.clone();
        button.connect_clicked(move |_| {
            if let Ok(store) = WorkspaceStore::open(db_path.clone()) {
                let _ = store.start_session(&workspace, kind);
                refresh_after_start();
            }
        });
        controls.append(&button);
    }
    root.append(&controls);

    let transcript = TextView::new();
    transcript.set_editable(false);
    transcript.set_monospace(true);
    transcript.add_css_class("history-view");
    transcript
        .buffer()
        .set_text(&latest_session_text(&database_path, workspace_name));

    let transcript_scroll = ScrolledWindow::new();
    transcript_scroll.set_policy(gtk::PolicyType::Automatic, gtk::PolicyType::Automatic);
    transcript_scroll.set_vexpand(true);
    transcript_scroll.set_child(Some(&transcript));
    root.append(&transcript_scroll);

    let composer = GBox::new(Orientation::Horizontal, 8);
    let input = Entry::new();
    input.set_placeholder_text(Some("Prompt draft or review context"));
    input.set_hexpand(true);
    let queue = Button::with_label("Stage");
    let buffer = transcript.buffer();
    let input_clone = input.clone();
    queue.connect_clicked(move |_| {
        let draft = input_clone.text().trim().to_owned();
        if draft.is_empty() {
            return;
        }
        let mut end = buffer.end_iter();
        buffer.insert(&mut end, &format!("\n[staged prompt]\n{draft}\n"));
        input_clone.set_text("");
    });
    composer.append(&input);
    composer.append(&queue);
    root.append(&composer);

    let hint = Label::new(Some(
        "Supervised sessions are captured as process logs now; PTY streaming and bidirectional chat attach here next.",
    ));
    hint.add_css_class("card-meta");
    hint.set_xalign(0.0);
    hint.set_wrap(true);
    root.append(&hint);

    root
}

fn latest_session_text(database_path: &Path, workspace_name: &str) -> String {
    let Ok(store) = WorkspaceStore::open(database_path) else {
        return "Could not open workspace database.".to_owned();
    };
    let sessions = store.list_sessions(workspace_name).unwrap_or_default();
    let latest = sessions
        .into_iter()
        .max_by_key(|record| record.started_at.clone());
    let Some(record) = latest else {
        return "No local sessions yet. Start Shell, Codex, Claude, or Cursor above.".to_owned();
    };
    let log = store
        .read_latest_session_log(workspace_name)
        .unwrap_or_else(|err| format!("Could not read latest session log: {err:#}"));
    format!(
        "#{} {} pid={} status={}\nlog={}\n\n{}",
        record.id,
        record.command,
        record.pid,
        record.status.as_str(),
        record.log_path.display(),
        log
    )
}

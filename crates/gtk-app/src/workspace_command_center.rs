use adw::{Toast, ToastOverlay};
use gtk::prelude::*;
use gtk::{
    Align, Box as GBox, Button, CheckButton, ComboBoxText, Entry, Expander, Label, ListBox,
    ListBoxRow, Orientation, Paned, PolicyType, ScrolledWindow, Separator, Stack, StackSwitcher,
    TextView, WrapMode,
};
use linux_conductor_core::workspace::{
    DiffFileSummary, PullRequest, PullRequestReviewThread, ReviewComment, Workspace, WorkspaceStore,
};
use std::cell::RefCell;
use std::fs;
use std::path::Path;
use std::rc::Rc;

use crate::projects::show_create_workspace_dialog;
use crate::refresh::{RefreshHub, RefreshScope};
use crate::state::{AppState, WorkspaceTab};
use crate::{
    cli_binary, detail_row, history, session_surface, shell_quote, spawn_terminal_command,
    terminal, title_case_workspace,
};

pub(crate) fn build_workspace_command_center(
    app_state: &AppState,
    refresh_hub: RefreshHub,
    toast_overlay: ToastOverlay,
) -> (GBox, impl Fn() + Clone + 'static) {
    let root = GBox::new(Orientation::Vertical, 0);
    root.set_vexpand(true);
    root.set_hexpand(true);

    // body is what gets swapped on refresh
    let body = GBox::new(Orientation::Vertical, 0);
    body.set_vexpand(true);
    body.set_hexpand(true);
    root.append(&body);

    let db_path = app_state.workspace_database_path();
    let state = app_state.clone();
    let refresh = move || {
        while let Some(child) = body.first_child() {
            body.remove(&child);
        }

        let Some(name) = state.selected_workspace() else {
            let empty = Label::new(Some("Select a workspace from the sidebar."));
            empty.add_css_class("workspace-empty-label");
            empty.set_valign(Align::Center);
            empty.set_halign(Align::Center);
            empty.set_vexpand(true);
            body.append(&empty);
            return;
        };
        let Ok(store) = WorkspaceStore::open(db_path.clone()) else {
            return;
        };
        let Ok(Some(line)) = store
            .list_status()
            .map(|lines| lines.into_iter().find(|l| l.workspace.name == name))
        else {
            return;
        };

        let pr = line.pull_request;
        body.append(&simple_workspace_shell(
            &db_path,
            &store,
            &line.workspace,
            &state,
            pr,
            refresh_hub.clone(),
            toast_overlay.clone(),
        ));
    };
    refresh();
    (root, refresh)
}

fn simple_workspace_shell(
    db_path: &Path,
    store: &WorkspaceStore,
    ws: &Workspace,
    state: &AppState,
    pr: Option<PullRequest>,
    refresh_hub: RefreshHub,
    toast_overlay: ToastOverlay,
) -> GBox {
    let shell = GBox::new(Orientation::Vertical, 0);
    shell.set_vexpand(true);
    shell.set_hexpand(true);

    // Title bar: breadcrumb + PR badge
    shell.append(&ws_title_bar(ws, pr.as_ref()));

    // Horizontal split: center (flex) + right (fixed 300px)
    let split = Paned::new(Orientation::Horizontal);
    split.set_wide_handle(false);
    split.set_resize_start_child(true);
    split.set_resize_end_child(false);
    split.set_shrink_start_child(false);
    split.set_shrink_end_child(false);
    split.set_vexpand(true);

    // Center: custom tab bar + chat/terminal/file content
    let (center, open_file) = ws_center_panel(db_path, store, ws, state, refresh_hub.clone());
    split.set_start_child(Some(&center));

    // Right: file list + run console
    let right = ws_right_panel(
        db_path,
        store,
        ws,
        state,
        refresh_hub,
        toast_overlay,
        open_file,
    );
    split.set_end_child(Some(&right));

    shell.append(&split);
    shell
}

fn make_action_row() -> GBox {
    let row = GBox::new(Orientation::Horizontal, 8);
    row.add_css_class("action-row");
    row
}

// ── Title bar ───────────────────────────────────────────────────

fn ws_title_bar(ws: &Workspace, pr: Option<&PullRequest>) -> GBox {
    let bar = GBox::new(Orientation::Horizontal, 10);
    bar.add_css_class("ws-title-bar");

    let breadcrumb = Label::new(Some(&format!(
        "{} / {}",
        title_case_workspace(&ws.name),
        ws.branch
    )));
    breadcrumb.add_css_class("ws-breadcrumb");
    breadcrumb.set_xalign(0.0);
    breadcrumb.set_hexpand(true);
    breadcrumb.set_ellipsize(gtk::pango::EllipsizeMode::End);
    bar.append(&breadcrumb);

    if let Some(pr) = pr {
        let pr_badge = GBox::new(Orientation::Horizontal, 0);
        pr_badge.add_css_class("ws-pr-badge");

        let num_lbl = Label::new(Some(&format!("PR #{}", pr.number)));
        num_lbl.add_css_class("ws-pr-num");
        pr_badge.append(&num_lbl);

        let sep = Separator::new(Orientation::Vertical);
        sep.add_css_class("ws-pr-sep");
        pr_badge.append(&sep);

        let state_lbl = Label::new(Some(&pr.state));
        state_lbl.add_css_class("ws-pr-state");
        pr_badge.append(&state_lbl);

        bar.append(&pr_badge);
    }

    bar
}

// ── Center panel (chat + terminal + file tabs) ───────────────────

fn ws_center_panel(
    db_path: &Path,
    store: &WorkspaceStore,
    ws: &Workspace,
    state: &AppState,
    refresh_hub: RefreshHub,
) -> (GBox, Rc<dyn Fn(&str)>) {
    let panel = GBox::new(Orientation::Vertical, 0);
    panel.add_css_class("ws-center");
    panel.set_hexpand(true);
    panel.set_vexpand(true);

    // Tab bar
    let tab_bar = GBox::new(Orientation::Horizontal, 0);
    tab_bar.add_css_class("ws-tab-bar");
    panel.append(&tab_bar);

    // Separator below tab bar
    let tab_sep = Separator::new(Orientation::Horizontal);
    tab_sep.add_css_class("ws-tab-sep");
    panel.append(&tab_sep);

    // Content stack
    let content = Stack::new();
    content.set_vexpand(true);
    content.set_hexpand(true);

    // Chat tab
    let refresh_sessions = refresh_hub.clone();
    let chat_widget = session_surface::agent_session_panel(
        db_path.to_path_buf(),
        &ws.name,
        state.clone(),
        move || refresh_sessions.refresh(RefreshScope::Workspace),
    );
    content.add_named(&chat_widget, Some("chat"));

    let chat_btn = ws_tab_button("Chat");
    chat_btn.add_css_class("ws-tab-active");
    {
        let c = content.clone();
        let tb = tab_bar.clone();
        chat_btn.connect_clicked(move |_| {
            c.set_visible_child_name("chat");
            ws_sync_tab_active(&tb, "ws-tab-btn");
        });
    }
    tab_bar.append(&chat_btn);

    // Terminal tab
    let term_prefs = store
        .workspace_view_defaults(&ws.name)
        .map(|d| terminal::TerminalPreferences::from_config(d.terminal_font.as_deref(), d.terminal_scrollback))
        .unwrap_or_default();
    let term_presets = store
        .workspace_view_defaults(&ws.name)
        .map(|d| terminal::terminal_command_presets(&d.command_palette_presets))
        .unwrap_or_else(|_| terminal::terminal_command_presets(&[]));

    let term_widget = terminal::embedded_terminal_panel(
        db_path.to_path_buf(),
        &ws.name,
        &ws.path,
        true,
        refresh_hub.clone(),
        term_prefs,
        term_presets,
    );
    content.add_named(&term_widget, Some("terminal"));

    let term_btn = ws_tab_button("Terminal");
    {
        let c = content.clone();
        let tb = tab_bar.clone();
        term_btn.connect_clicked(move |_| {
            c.set_visible_child_name("terminal");
            ws_sync_tab_active(&tb, "ws-tab-btn");
        });
    }
    tab_bar.append(&term_btn);

    // Sync active tab state
    let state_tabs = state.clone();
    content.connect_visible_child_name_notify(move |stack| {
        match stack.visible_child_name().as_deref() {
            Some("terminal") => state_tabs.set_active_workspace_tab(WorkspaceTab::Terminal),
            _ => state_tabs.set_active_workspace_tab(WorkspaceTab::Chats),
        }
    });

    content.set_visible_child_name(match state.snapshot().active_workspace_tab {
        WorkspaceTab::Terminal => "terminal",
        _ => "chat",
    });

    panel.append(&content);

    // Open-file closure: reads file from disk, opens as a new tab
    let ws_path = ws.path.clone();
    let content_ref = content.clone();
    let tab_bar_ref = tab_bar.clone();

    let open_file: Rc<dyn Fn(&str)> = Rc::new(move |rel_path: &str| {
        let tab_key = format!("file:{rel_path}");

        if content_ref.child_by_name(&tab_key).is_none() {
            // File pane with Edit / Diff mode switcher
            let file_pane = GBox::new(Orientation::Vertical, 0);
            file_pane.set_vexpand(true);

            let mode_tabs = Stack::new();
            mode_tabs.set_vexpand(true);
            let mode_sw = StackSwitcher::new();
            mode_sw.set_stack(Some(&mode_tabs));
            mode_sw.add_css_class("ws-mode-switcher");
            file_pane.append(&mode_sw);

            let full_path = ws_path.join(rel_path);
            let file_content = fs::read_to_string(&full_path)
                .unwrap_or_else(|e| format!("# Error reading file\n{e}"));

            let edit_view = TextView::new();
            edit_view.set_monospace(true);
            edit_view.set_vexpand(true);
            edit_view.buffer().set_text(&file_content);
            let edit_scroll = ScrolledWindow::new();
            edit_scroll.set_vexpand(true);
            edit_scroll.set_child(Some(&edit_view));
            mode_tabs.add_titled(&edit_scroll, Some("edit"), "Edit");

            let diff_view = TextView::new();
            diff_view.set_editable(false);
            diff_view.set_monospace(true);
            diff_view.set_vexpand(true);
            let diff_scroll = ScrolledWindow::new();
            diff_scroll.set_vexpand(true);
            diff_scroll.set_child(Some(&diff_view));
            mode_tabs.add_titled(&diff_scroll, Some("diff"), "Diff");

            let preview_view = TextView::new();
            preview_view.set_editable(false);
            preview_view.set_wrap_mode(WrapMode::WordChar);
            preview_view.set_vexpand(true);
            preview_view.buffer().set_text(&file_content);
            let preview_scroll = ScrolledWindow::new();
            preview_scroll.set_vexpand(true);
            preview_scroll.set_child(Some(&preview_view));
            mode_tabs.add_titled(&preview_scroll, Some("preview"), "Preview");

            mode_tabs.set_visible_child_name("edit");
            file_pane.append(&mode_tabs);
            content_ref.add_named(&file_pane, Some(&tab_key));

            // Tab button for this file
            let short_name = std::path::Path::new(rel_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(rel_path);
            let file_btn = ws_tab_button(short_name);
            let cr = content_ref.clone();
            let tk = tab_key.clone();
            let tb = tab_bar_ref.clone();
            file_btn.connect_clicked(move |_| {
                cr.set_visible_child_name(&tk);
                ws_sync_tab_active(&tb, "ws-tab-btn");
            });
            tab_bar_ref.append(&file_btn);
        }
        content_ref.set_visible_child_name(&tab_key);
    });

    (panel, open_file)
}

fn ws_tab_button(label: &str) -> Button {
    let btn = Button::with_label(label);
    btn.add_css_class("ws-tab-btn");
    btn
}

fn ws_sync_tab_active(tab_bar: &GBox, _class: &str) {
    // Visual active state is handled by CSS on the stack's visible child name notify
    // This is a placeholder for future per-button active highlighting
    let _ = tab_bar;
}

// ── Right panel (file list + run console) ───────────────────────

fn ws_right_panel(
    db_path: &Path,
    store: &WorkspaceStore,
    ws: &Workspace,
    state: &AppState,
    refresh_hub: RefreshHub,
    toast_overlay: ToastOverlay,
    open_file: Rc<dyn Fn(&str)>,
) -> GBox {
    let panel = GBox::new(Orientation::Vertical, 0);
    panel.add_css_class("ws-right-panel");
    panel.set_vexpand(true);
    panel.set_width_request(300);

    // Top tab strip: All files | Changes | Checks
    let tab_strip = GBox::new(Orientation::Horizontal, 4);
    tab_strip.add_css_class("ws-right-tabs");

    let content = Stack::new();
    content.set_vexpand(true);

    // All files
    let all_btn = Button::with_label("All files");
    all_btn.add_css_class("ws-right-tab-btn");
    all_btn.add_css_class("ws-right-tab-active");
    let files_widget = ws_simple_file_list(db_path, ws, open_file.clone());
    content.add_named(&files_widget, Some("files"));
    {
        let c = content.clone();
        all_btn.connect_clicked(move |_| c.set_visible_child_name("files"));
    }
    tab_strip.append(&all_btn);

    // Changes
    let changes_btn = Button::with_label("Changes");
    changes_btn.add_css_class("ws-right-tab-btn");
    let changes_widget =
        workspace_changes_panel(db_path, store, &ws.name, refresh_hub.clone(), toast_overlay.clone());
    content.add_named(&changes_widget, Some("changes"));
    {
        let c = content.clone();
        changes_btn.connect_clicked(move |_| c.set_visible_child_name("changes"));
    }
    tab_strip.append(&changes_btn);

    // Checks
    let checks_btn = Button::with_label("Checks");
    checks_btn.add_css_class("ws-right-tab-btn");
    let checks_widget = workspace_checks_panel(
        db_path,
        store,
        &ws.name,
        state.clone(),
        refresh_hub.clone(),
        toast_overlay.clone(),
    );
    content.add_named(&checks_widget, Some("checks"));
    {
        let c = content.clone();
        checks_btn.connect_clicked(move |_| c.set_visible_child_name("checks"));
    }
    tab_strip.append(&checks_btn);

    content.set_visible_child_name("files");

    panel.append(&tab_strip);
    panel.append(&Separator::new(Orientation::Horizontal));
    panel.append(&content);

    // Run console at bottom
    panel.append(&Separator::new(Orientation::Horizontal));
    panel.append(&ws_run_console(db_path, store, ws, state, refresh_hub, toast_overlay));

    panel
}

fn ws_simple_file_list(
    db_path: &Path,
    ws: &Workspace,
    open_file: Rc<dyn Fn(&str)>,
) -> GBox {
    let panel = GBox::new(Orientation::Vertical, 0);
    panel.set_vexpand(true);

    let list = ListBox::new();
    list.add_css_class("ws-file-list");
    list.set_selection_mode(gtk::SelectionMode::Single);

    let file_paths: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));

    if let Ok(store) = WorkspaceStore::open(db_path) {
        if let Ok(files) = store.changed_files(&ws.name) {
            for path in &files {
                let row_box = GBox::new(Orientation::Horizontal, 6);
                row_box.add_css_class("ws-file-row");

                let ext_lbl = Label::new(Some(file_type_badge(path)));
                ext_lbl.add_css_class("ws-file-badge");
                row_box.append(&ext_lbl);

                let short = std::path::Path::new(path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(path.as_str());
                let name_lbl = Label::new(Some(short));
                name_lbl.add_css_class("ws-file-name");
                name_lbl.set_xalign(0.0);
                name_lbl.set_hexpand(true);
                row_box.append(&name_lbl);

                if short != path.as_str() {
                    let dir_part = &path[..path.len().saturating_sub(short.len())];
                    let dir_lbl = Label::new(Some(dir_part));
                    dir_lbl.add_css_class("ws-file-dir");
                    dir_lbl.set_xalign(1.0);
                    dir_lbl.set_ellipsize(gtk::pango::EllipsizeMode::Start);
                    row_box.append(&dir_lbl);
                }

                list.append(&ListBoxRow::builder().child(&row_box).build());
                file_paths.borrow_mut().push(path.clone());
            }
        }
    }

    let paths_select = file_paths.clone();
    list.connect_row_selected(move |_, row| {
        if let Some(r) = row {
            let idx = r.index() as usize;
            if let Some(path) = paths_select.borrow().get(idx) {
                open_file(path.as_str());
            }
        }
    });

    let scroll = ScrolledWindow::new();
    scroll.set_vexpand(true);
    scroll.set_policy(PolicyType::Never, PolicyType::Automatic);
    scroll.set_child(Some(&list));
    panel.append(&scroll);

    panel
}

fn file_type_badge(path: &str) -> &'static str {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    match ext {
        "rs" => "rs",
        "ts" | "tsx" => "ts",
        "js" | "jsx" => "js",
        "py" => "py",
        "md" => "md",
        "toml" => "ml",
        "yaml" | "yml" => "yl",
        "json" => "{}",
        "css" | "scss" => "cs",
        "html" => "ht",
        "sh" | "bash" => "sh",
        "go" => "go",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" => "c+",
        _ => "  ",
    }
}

fn ws_run_console(
    db_path: &Path,
    store: &WorkspaceStore,
    ws: &Workspace,
    state: &AppState,
    refresh_hub: RefreshHub,
    toast_overlay: ToastOverlay,
) -> GBox {
    let section = GBox::new(Orientation::Vertical, 0);
    section.add_css_class("ws-run-section");

    // Tab strip: Run | Terminal | Actions
    let run_content = Stack::new();
    let run_switcher = StackSwitcher::new();
    run_switcher.set_stack(Some(&run_content));
    run_switcher.add_css_class("ws-run-switcher");
    section.append(&run_switcher);

    run_content.add_titled(
        &runtime_panel(db_path, ws, store, refresh_hub.clone(), toast_overlay.clone()),
        Some("run"),
        "Run",
    );

    let term_prefs = store
        .workspace_view_defaults(&ws.name)
        .map(|d| terminal::TerminalPreferences::from_config(d.terminal_font.as_deref(), d.terminal_scrollback))
        .unwrap_or_default();
    let term_presets = store
        .workspace_view_defaults(&ws.name)
        .map(|d| terminal::terminal_command_presets(&d.command_palette_presets))
        .unwrap_or_else(|_| terminal::terminal_command_presets(&[]));

    run_content.add_titled(
        &terminal::embedded_terminal_panel(
            db_path.to_path_buf(),
            &ws.name,
            &ws.path,
            false,
            refresh_hub.clone(),
            term_prefs,
            term_presets,
        ),
        Some("terminal"),
        "Terminal",
    );

    run_content.add_titled(
        &lifecycle_panel(db_path, ws, state, refresh_hub, toast_overlay),
        Some("actions"),
        "Actions",
    );

    run_content.set_visible_child_name("run");
    section.append(&run_content);

    section
}

fn workspace_files_panel(
    db_path: &Path,
    ws: &Workspace,
    refresh_hub: RefreshHub,
    toast_overlay: ToastOverlay,
) -> GBox {
    let panel = GBox::new(Orientation::Vertical, 8);
    panel.set_vexpand(true);

    let selected_file = Rc::new(RefCell::new(None::<String>));
    let current_file = Label::new(Some("Select a file."));
    current_file.add_css_class("card-meta");
    current_file.set_xalign(0.0);
    current_file.set_wrap(true);
    panel.append(&current_file);

    let mode_stack = Stack::new();
    let mode_switcher = StackSwitcher::new();
    mode_switcher.set_stack(Some(&mode_stack));
    mode_switcher.add_css_class("panel-switcher");
    panel.append(&mode_switcher);

    let edit_view = TextView::new();
    edit_view.set_monospace(true);
    edit_view.set_vexpand(true);
    let edit_scroll = ScrolledWindow::new();
    edit_scroll.set_policy(PolicyType::Automatic, PolicyType::Automatic);
    edit_scroll.set_vexpand(true);
    edit_scroll.set_child(Some(&edit_view));
    mode_stack.add_titled(&edit_scroll, Some("edit"), "Edit");

    let diff_view = TextView::new();
    diff_view.set_editable(false);
    diff_view.set_monospace(true);
    diff_view.set_vexpand(true);
    let diff_scroll = ScrolledWindow::new();
    diff_scroll.set_policy(PolicyType::Automatic, PolicyType::Automatic);
    diff_scroll.set_vexpand(true);
    diff_scroll.set_child(Some(&diff_view));
    mode_stack.add_titled(&diff_scroll, Some("diff"), "Diff");

    let preview_view = TextView::new();
    preview_view.set_editable(false);
    preview_view.set_wrap_mode(WrapMode::WordChar);
    preview_view.set_vexpand(true);
    let preview_scroll = ScrolledWindow::new();
    preview_scroll.set_policy(PolicyType::Automatic, PolicyType::Automatic);
    preview_scroll.set_vexpand(true);
    preview_scroll.set_child(Some(&preview_view));
    mode_stack.add_titled(&preview_scroll, Some("preview"), "Preview");

    let feedback = Label::new(Some("No file action run yet."));
    feedback.add_css_class("card-meta");
    feedback.set_xalign(0.0);
    feedback.set_wrap(true);

    let action_row = make_action_row();
    let reload_btn = secondary_button("Reload");
    let save_btn = Button::with_label("Save");
    save_btn.add_css_class("suggested-action");
    action_row.append(&reload_btn);
    action_row.append(&save_btn);
    panel.append(&action_row);

    let file_list = GBox::new(Orientation::Vertical, 4);
    let files = list_workspace_files(&ws.path);
    if files.is_empty() {
        file_list.append(&detail_row("Files", "No visible files."));
    } else {
        for relative in files {
            let open_btn = flat_button(&relative);
            open_btn.set_hexpand(true);
            open_btn.set_halign(Align::Fill);
            let current_file_open = current_file.clone();
            let selected_file_open = selected_file.clone();
            let edit_buffer = edit_view.buffer();
            let diff_buffer = diff_view.buffer();
            let preview_buffer = preview_view.buffer();
            let workspace_path = ws.path.clone();
            let db_path_open = db_path.to_path_buf();
            let workspace_name = ws.name.clone();
            let relative_path = relative.clone();
            let mode_stack_open = mode_stack.clone();
            open_btn.connect_clicked(move |_| {
                *selected_file_open.borrow_mut() = Some(relative_path.clone());
                current_file_open.set_text(&relative_path);
                let file_path = workspace_path.join(&relative_path);
                let contents = fs::read_to_string(&file_path)
                    .unwrap_or_else(|_| "[binary or unreadable file]".to_owned());
                edit_buffer.set_text(&contents);
                preview_buffer.set_text(&contents);
                diff_buffer.set_text(&workspace_diff_text_for_path(
                    &db_path_open,
                    &workspace_name,
                    Some(&relative_path),
                ));
                if relative_path.ends_with(".md") {
                    mode_stack_open.set_visible_child_name("preview");
                } else {
                    mode_stack_open.set_visible_child_name("edit");
                }
            });
            file_list.append(&open_btn);
        }
    }

    let file_scroll = ScrolledWindow::new();
    file_scroll.set_policy(PolicyType::Automatic, PolicyType::Automatic);
    file_scroll.set_min_content_height(160);
    file_scroll.set_child(Some(&file_list));
    panel.append(&file_scroll);
    panel.append(&mode_stack);
    panel.append(&feedback);

    let selected_file_reload = selected_file.clone();
    let current_file_reload = current_file.clone();
    let edit_buffer_reload = edit_view.buffer();
    let diff_buffer_reload = diff_view.buffer();
    let preview_buffer_reload = preview_view.buffer();
    let workspace_path_reload = ws.path.clone();
    let db_path_reload = db_path.to_path_buf();
    let workspace_name_reload = ws.name.clone();
    reload_btn.connect_clicked(move |_| {
        let Some(relative_path) = selected_file_reload.borrow().clone() else {
            current_file_reload.set_text("Select a file.");
            return;
        };
        let file_path = workspace_path_reload.join(&relative_path);
        let contents = fs::read_to_string(&file_path)
            .unwrap_or_else(|_| "[binary or unreadable file]".to_owned());
        edit_buffer_reload.set_text(&contents);
        preview_buffer_reload.set_text(&contents);
        diff_buffer_reload.set_text(&workspace_diff_text_for_path(
            &db_path_reload,
            &workspace_name_reload,
            Some(&relative_path),
        ));
    });

    let selected_file_save = selected_file;
    let edit_buffer_save = edit_view.buffer();
    let workspace_path_save = ws.path.clone();
    let feedback_save = feedback.clone();
    let toast_save = toast_overlay;
    save_btn.connect_clicked(move |_| {
        let Some(relative_path) = selected_file_save.borrow().clone() else {
            apply_action_feedback(
                &feedback_save,
                &toast_save,
                "Select a file before saving.",
                true,
            );
            return;
        };
        let file_path = workspace_path_save.join(&relative_path);
        match fs::write(&file_path, text_buffer_contents(&edit_buffer_save)) {
            Ok(()) => {
                apply_action_feedback(
                    &feedback_save,
                    &toast_save,
                    &format!("Saved {}.", relative_path),
                    true,
                );
                refresh_hub.refresh(RefreshScope::Workspace);
            }
            Err(err) => apply_action_feedback(
                &feedback_save,
                &toast_save,
                &format!("Could not save {}: {err}", relative_path),
                true,
            ),
        }
    });

    panel
}

fn list_workspace_files(root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    list_workspace_files_recursive(root, root, &mut files);
    files.sort();
    files.truncate(400);
    files
}

fn list_workspace_files_recursive(root: &Path, current: &Path, files: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(current) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if matches!(name.as_ref(), ".git" | "target" | "node_modules") {
            continue;
        }
        if path.is_dir() {
            // ponytail: skip deep vendor/build trees; add a real tree model only if users hit this ceiling.
            list_workspace_files_recursive(root, &path, files);
            continue;
        }
        if let Ok(relative) = path.strip_prefix(root) {
            files.push(relative.to_string_lossy().to_string());
        }
    }
}

fn text_buffer_contents(buffer: &gtk::TextBuffer) -> String {
    buffer
        .text(&buffer.start_iter(), &buffer.end_iter(), true)
        .to_string()
}

fn make_action_stack() -> GBox {
    let stack = GBox::new(Orientation::Vertical, 8);
    stack.add_css_class("action-stack");
    stack
}

fn secondary_button(label: &str) -> Button {
    let button = Button::with_label(label);
    button.add_css_class("secondary-action");
    button
}

fn flat_button(label: &str) -> Button {
    let button = Button::with_label(label);
    button.add_css_class("flat-action");
    button
}

fn destructive_button(label: &str) -> Button {
    let button = Button::with_label(label);
    button.add_css_class("destructive-action");
    button
}

fn toolbar_label(text: &str) -> Label {
    let label = Label::new(Some(text));
    label.add_css_class("toolbar-label");
    label.set_xalign(0.0);
    label
}

fn workspace_status_strip(
    ws: &Workspace,
    checks: Option<&linux_conductor_core::workspace::ChecksSummary>,
) -> GBox {
    let strip = GBox::new(Orientation::Horizontal, 10);
    strip.add_css_class("command-center-strip");
    strip.add_css_class("workspace-summary-strip");
    strip.append(&metric_card("Status", &ws.status));
    strip.append(&metric_card("Port", &ws.port_base.to_string()));
    strip.append(&metric_card(
        "Files",
        &checks
            .map(|summary| summary.changed_files.to_string())
            .unwrap_or_else(|| "-".to_owned()),
    ));
    strip.append(&metric_card(
        "Todos",
        &checks
            .map(|summary| format!("{} open", summary.open_todos))
            .unwrap_or_else(|| "-".to_owned()),
    ));
    strip.append(&metric_card(
        "Review",
        &checks
            .map(|summary| format!("{} open", summary.open_review_comments))
            .unwrap_or_else(|| "-".to_owned()),
    ));
    strip.append(&metric_card(
        "Sessions",
        &checks
            .map(|summary| summary.active_sessions.to_string())
            .unwrap_or_else(|| "-".to_owned()),
    ));
    strip
}

fn metric_card(label: &str, value: &str) -> GBox {
    let card = GBox::new(Orientation::Vertical, 4);
    card.add_css_class("metric-card");
    card.set_hexpand(true);
    let label_widget = Label::new(Some(label));
    label_widget.add_css_class("detail-label");
    label_widget.set_xalign(0.0);
    let value_widget = Label::new(Some(value));
    value_widget.add_css_class("metric-value");
    value_widget.set_xalign(0.0);
    value_widget.set_ellipsize(gtk::pango::EllipsizeMode::End);
    card.append(&label_widget);
    card.append(&value_widget);
    card
}

fn agents_panel(
    db_path: &Path,
    ws: &Workspace,
    app_state: &AppState,
    refresh_hub: RefreshHub,
) -> GBox {
    let panel = GBox::new(Orientation::Vertical, 10);
    panel.add_css_class("command-panel");
    panel.add_css_class("session-tool-surface");
    panel.set_hexpand(true);
    panel.append(&section_title("Agents"));

    // Profile selector: populated from configured agent profiles
    let profile_row = GBox::new(Orientation::Horizontal, 8);
    let profile_label = Label::new(Some("Profile:"));
    profile_label.add_css_class("detail-label");
    let profile_select = ComboBoxText::new();
    profile_select.append(Some("default"), "Default");
    let profile_names = WorkspaceStore::open(db_path)
        .and_then(|store| store.workspace_view_defaults(&ws.name))
        .map(|defaults| defaults.agent_profile_names)
        .unwrap_or_default();
    for name in &profile_names {
        profile_select.append(Some(name.as_str()), name.as_str());
    }
    profile_select.set_active_id(Some("default"));
    if profile_names.is_empty() {
        profile_row.set_visible(false);
    }
    profile_row.append(&profile_label);
    profile_row.append(&profile_select);
    panel.append(&profile_row);

    let actions = GBox::new(Orientation::Horizontal, 8);
    for (label, kind) in [
        ("Shell", "shell"),
        ("Codex", "codex"),
        ("Claude", "claude"),
        ("Cursor", "cursor"),
    ] {
        let button = Button::with_label(label);
        let workspace = ws.name.clone();
        let db_for_launch = db_path.to_path_buf();
        let profile_select_for_launch = profile_select.clone();
        button.connect_clicked(move |_| {
            let profile = profile_select_for_launch
                .active_id()
                .filter(|id| id != "default")
                .map(|id| id.to_string());
            let general_prompt = WorkspaceStore::open(db_for_launch.clone())
                .and_then(|store| store.workspace_repo_settings(&workspace))
                .ok()
                .and_then(|settings| settings.prompts.and_then(|p| p.general))
                .filter(|p| !p.is_empty());
            let launch_cmd = build_session_open_command(&workspace, kind, profile.as_deref());
            if let Some(prompt) = general_prompt {
                show_prompt_preview(&prompt, &launch_cmd);
            } else {
                spawn_terminal_command(&launch_cmd);
            }
        });
        actions.append(&button);
    }
    panel.append(&actions);

    let session_box = GBox::new(Orientation::Vertical, 8);
    let db_for_sessions = db_path.to_path_buf();
    let workspace_for_sessions = ws.name.clone();
    let refresh_sessions = refresh_hub.clone();
    session_box.append(&session_surface::agent_session_panel(
        db_for_sessions,
        &workspace_for_sessions,
        app_state.clone(),
        move || refresh_sessions.refresh(RefreshScope::Workspace),
    ));
    panel.append(&session_box);
    panel
}

fn build_session_open_command(workspace: &str, kind: &str, profile: Option<&str>) -> String {
    let mut cmd = format!(
        "{} session open {} --kind {}",
        cli_binary().display(),
        shell_quote(workspace),
        kind
    );
    if let Some(profile) = profile {
        cmd.push_str(&format!(" --profile {}", shell_quote(profile)));
    }
    cmd
}

fn show_prompt_preview(prompt: &str, launch_cmd: &str) {
    let dialog = gtk::Window::builder()
        .title("Prompt Preview")
        .modal(true)
        .default_width(520)
        .default_height(320)
        .build();
    let body = GBox::new(Orientation::Vertical, 10);
    body.add_css_class("modal-body");
    body.set_margin_top(14);
    body.set_margin_bottom(14);
    body.set_margin_start(14);
    body.set_margin_end(14);
    let title = Label::new(Some("General agent prompt"));
    title.add_css_class("section-title");
    title.set_xalign(0.0);
    body.append(&title);
    let hint = Label::new(Some(
        "This prompt will be injected when the session starts.",
    ));
    hint.add_css_class("card-meta");
    hint.set_xalign(0.0);
    hint.set_wrap(true);
    body.append(&hint);
    let text_view = TextView::new();
    text_view.set_editable(false);
    text_view.set_monospace(true);
    text_view.set_wrap_mode(WrapMode::WordChar);
    text_view.buffer().set_text(prompt);
    let scroll = ScrolledWindow::new();
    scroll.set_policy(PolicyType::Never, PolicyType::Automatic);
    scroll.set_vexpand(true);
    scroll.set_min_content_height(140);
    scroll.set_child(Some(&text_view));
    body.append(&scroll);
    let buttons = GBox::new(Orientation::Horizontal, 8);
    buttons.set_halign(Align::End);
    let cancel_btn = Button::with_label("Cancel");
    let launch_btn = Button::with_label("Launch");
    launch_btn.add_css_class("suggested-action");
    let dialog_for_cancel = dialog.clone();
    cancel_btn.connect_clicked(move |_| {
        dialog_for_cancel.close();
    });
    let dialog_for_launch = dialog.clone();
    let cmd = launch_cmd.to_owned();
    launch_btn.connect_clicked(move |_| {
        spawn_terminal_command(&cmd);
        dialog_for_launch.close();
    });
    buttons.append(&cancel_btn);
    buttons.append(&launch_btn);
    body.append(&buttons);
    dialog.set_child(Some(&body));
    dialog.present();
}

fn runtime_panel(
    db_path: &Path,
    ws: &Workspace,
    store: &WorkspaceStore,
    refresh_hub: RefreshHub,
    toast_overlay: ToastOverlay,
) -> GBox {
    let panel = GBox::new(Orientation::Vertical, 10);
    panel.add_css_class("command-panel");
    panel.set_hexpand(true);
    panel.append(&section_title("Runtime"));

    let actions = make_action_stack();
    let setup_btn = secondary_button("Setup");
    let run_btn = Button::with_label("Run");
    run_btn.add_css_class("suggested-action");
    let stop_btn = destructive_button("Stop");
    let spotlight_on_btn = Button::with_label("Spotlight On");
    spotlight_on_btn.add_css_class("suggested-action");
    let spotlight_sync_btn = secondary_button("Sync Spotlight");
    let spotlight_repair_btn = destructive_button("Repair Spotlight");
    let spotlight_off_btn = flat_button("Spotlight Off");
    let folder_btn = flat_button("Open Folder");
    let status = Label::new(None);
    status.add_css_class("card-meta");
    status.set_xalign(0.0);
    status.set_wrap(true);

    let autosync_workspace = ws.name.clone();
    let autosync_db_path = db_path.to_path_buf();
    let autosync_status = status.clone();
    let autosync_refresh = refresh_hub.clone();
    let autosync_panel = panel.clone();
    glib::timeout_add_local(std::time::Duration::from_secs(3), move || {
        if autosync_panel.root().is_none() {
            return glib::ControlFlow::Break;
        }
        match WorkspaceStore::open(autosync_db_path.clone())
            .and_then(|store| store.spotlight_sync_if_changed(&autosync_workspace))
        {
            Ok(Some(session)) => {
                autosync_status.set_text(&format!(
                    "Spotlight auto-synced for {}",
                    session.workspace_name
                ));
                autosync_refresh.refresh(RefreshScope::All);
            }
            Ok(None) => {}
            Err(err) => {
                autosync_status.set_text(&format!("Spotlight auto-sync paused: {err:#}"));
            }
        }
        glib::ControlFlow::Continue
    });

    let setup_workspace = ws.name.clone();
    let db_path_setup = db_path.to_path_buf();
    let refresh_setup = refresh_hub.clone();
    let status_setup = status.clone();
    let toast_setup = toast_overlay.clone();
    setup_btn.connect_clicked(move |_| {
        status_setup.set_text("Starting setup...");
        match WorkspaceStore::open(db_path_setup.clone())
            .and_then(|store| store.setup_workspace(&setup_workspace))
        {
            Ok(record) => {
                let message = format!("Setup started: pid {}", record.pid);
                apply_action_feedback(&status_setup, &toast_setup, &message, true);
            }
            Err(err) => apply_runtime_action_feedback(
                &status_setup,
                &toast_setup,
                runtime_action_failure_feedback("Setup", &err),
            ),
        }
        refresh_setup.refresh(RefreshScope::All);
    });

    let run_workspace = ws.name.clone();
    let db_path_run = db_path.to_path_buf();
    let refresh_run = refresh_hub.clone();
    let status_run = status.clone();
    let toast_run = toast_overlay.clone();
    run_btn.connect_clicked(move |_| {
        status_run.set_text("Starting run...");
        match WorkspaceStore::open(db_path_run.clone())
            .and_then(|store| store.run_workspace(&run_workspace))
        {
            Ok(record) => {
                let message = format!("Run started: pid {}", record.pid);
                apply_action_feedback(&status_run, &toast_run, &message, true);
            }
            Err(err) => apply_runtime_action_feedback(
                &status_run,
                &toast_run,
                runtime_action_failure_feedback("Run", &err),
            ),
        }
        refresh_run.refresh(RefreshScope::All);
    });

    let stop_workspace = ws.name.clone();
    let db_path_stop = db_path.to_path_buf();
    let refresh_stop = refresh_hub.clone();
    let status_stop = status.clone();
    let toast_stop = toast_overlay.clone();
    stop_btn.connect_clicked(move |_| {
        status_stop.set_text("Stopping run...");
        match WorkspaceStore::open(db_path_stop.clone())
            .and_then(|store| store.stop_workspace(&stop_workspace))
        {
            Ok(record) => {
                let message = format!("Stopped pid {}", record.pid);
                apply_action_feedback(&status_stop, &toast_stop, &message, true);
            }
            Err(err) => apply_runtime_action_feedback(
                &status_stop,
                &toast_stop,
                runtime_action_failure_feedback("Stop", &err),
            ),
        }
        refresh_stop.refresh(RefreshScope::All);
    });

    let spotlight_workspace = ws.name.clone();
    let db_path_spotlight_on = db_path.to_path_buf();
    let refresh_spotlight_on = refresh_hub.clone();
    let status_spotlight_on = status.clone();
    let toast_spotlight_on = toast_overlay.clone();
    spotlight_on_btn.connect_clicked(move |_| {
        status_spotlight_on.set_text("Starting Spotlight...");
        match WorkspaceStore::open(db_path_spotlight_on.clone())
            .and_then(|store| store.spotlight_start(&spotlight_workspace))
        {
            Ok(session) => {
                let message = format!("Spotlight active for {}", session.workspace_name);
                apply_action_feedback(&status_spotlight_on, &toast_spotlight_on, &message, true);
            }
            Err(err) => apply_runtime_action_feedback(
                &status_spotlight_on,
                &toast_spotlight_on,
                runtime_action_failure_feedback("Spotlight", &err),
            ),
        }
        refresh_spotlight_on.refresh(RefreshScope::All);
    });

    let spotlight_sync_workspace = ws.name.clone();
    let db_path_spotlight_sync = db_path.to_path_buf();
    let refresh_spotlight_sync = refresh_hub.clone();
    let status_spotlight_sync = status.clone();
    let toast_spotlight_sync = toast_overlay.clone();
    spotlight_sync_btn.connect_clicked(move |_| {
        status_spotlight_sync.set_text("Syncing Spotlight...");
        match WorkspaceStore::open(db_path_spotlight_sync.clone())
            .and_then(|store| store.spotlight_sync(&spotlight_sync_workspace))
        {
            Ok(session) => {
                let message = format!("Spotlight synced for {}", session.workspace_name);
                apply_action_feedback(
                    &status_spotlight_sync,
                    &toast_spotlight_sync,
                    &message,
                    true,
                );
            }
            Err(err) => apply_runtime_action_feedback(
                &status_spotlight_sync,
                &toast_spotlight_sync,
                runtime_action_failure_feedback("Spotlight sync", &err),
            ),
        }
        refresh_spotlight_sync.refresh(RefreshScope::All);
    });

    let spotlight_repair_workspace = ws.name.clone();
    let db_path_spotlight_repair = db_path.to_path_buf();
    let refresh_spotlight_repair = refresh_hub.clone();
    let status_spotlight_repair = status.clone();
    let toast_spotlight_repair = toast_overlay.clone();
    spotlight_repair_btn.connect_clicked(move |_| {
        status_spotlight_repair.set_text("Repairing Spotlight root: discarding root-only edits...");
        match WorkspaceStore::open(db_path_spotlight_repair.clone())
            .and_then(|store| store.spotlight_repair_root(&spotlight_repair_workspace))
        {
            Ok(session) => {
                let message = format!("Spotlight root repaired for {}", session.workspace_name);
                apply_action_feedback(
                    &status_spotlight_repair,
                    &toast_spotlight_repair,
                    &message,
                    true,
                );
            }
            Err(err) => apply_runtime_action_feedback(
                &status_spotlight_repair,
                &toast_spotlight_repair,
                runtime_action_failure_feedback("Spotlight repair", &err),
            ),
        }
        refresh_spotlight_repair.refresh(RefreshScope::All);
    });

    let spotlight_stop_workspace = ws.name.clone();
    let db_path_spotlight_off = db_path.to_path_buf();
    let refresh_spotlight_off = refresh_hub.clone();
    let status_spotlight_off = status.clone();
    let toast_spotlight_off = toast_overlay;
    spotlight_off_btn.connect_clicked(move |_| {
        status_spotlight_off.set_text("Stopping Spotlight...");
        match WorkspaceStore::open(db_path_spotlight_off.clone())
            .and_then(|store| store.spotlight_stop(&spotlight_stop_workspace))
        {
            Ok(session) => {
                let message = format!("Spotlight stopped for {}", session.workspace_name);
                apply_action_feedback(&status_spotlight_off, &toast_spotlight_off, &message, true);
            }
            Err(err) => apply_runtime_action_feedback(
                &status_spotlight_off,
                &toast_spotlight_off,
                runtime_action_failure_feedback("Spotlight stop", &err),
            ),
        }
        refresh_spotlight_off.refresh(RefreshScope::All);
    });

    let path = ws.path.clone();
    folder_btn.connect_clicked(move |_| {
        let _ = std::process::Command::new("xdg-open").arg(&path).spawn();
    });

    let launch_row = make_action_row();
    launch_row.append(&setup_btn);
    launch_row.append(&run_btn);
    launch_row.append(&stop_btn);
    let spotlight_row = make_action_row();
    spotlight_row.append(&spotlight_on_btn);
    spotlight_row.append(&spotlight_sync_btn);
    spotlight_row.append(&spotlight_repair_btn);
    spotlight_row.append(&spotlight_off_btn);
    let utility_row = make_action_row();
    utility_row.append(&folder_btn);
    actions.append(&launch_row);
    actions.append(&spotlight_row);
    actions.append(&utility_row);
    panel.append(&actions);
    panel.append(&detail_row("Setup", &latest_setup_line(store, &ws.name)));
    panel.append(&detail_row("Latest", &latest_runtime_line(store, &ws.name)));
    panel.append(&detail_row("Spotlight", &spotlight_line(store, &ws.name)));
    panel.append(&detail_row(
        "Setup Log",
        &latest_setup_log_line(store, &ws.name),
    ));
    panel.append(&detail_row(
        "Run Log",
        &latest_run_log_line(store, &ws.name),
    ));
    panel.append(&status);
    panel
}

fn lifecycle_panel(
    db_path: &Path,
    ws: &Workspace,
    state: &AppState,
    refresh_hub: RefreshHub,
    toast_overlay: ToastOverlay,
) -> GBox {
    let panel = GBox::new(Orientation::Vertical, 10);
    panel.add_css_class("command-panel");
    panel.append(&section_title("Workspace Actions"));

    let row = make_action_stack();
    let rename_entry = Entry::new();
    rename_entry.set_placeholder_text(Some("new workspace name"));
    rename_entry.set_text(&ws.name);
    let rename_btn = secondary_button("Rename");
    let confirm = CheckButton::with_label("Confirm archive/discard");
    let archive_btn = secondary_button("Archive");
    let restore_btn = flat_button("Restore");
    let discard_btn = destructive_button("Discard");
    let progress = Label::new(None);
    progress.add_css_class("card-meta");
    progress.set_xalign(0.0);
    progress.set_wrap(true);

    let db_rename = db_path.to_path_buf();
    let current_name = ws.name.clone();
    let state_after_rename = state.clone();
    let refresh_after_rename = refresh_hub.clone();
    let progress_rename = progress.clone();
    let toast_rename = toast_overlay.clone();
    let rename_entry_clone = rename_entry.clone();
    rename_btn.connect_clicked(move |_| {
        let new_name = rename_entry_clone.text().trim().to_owned();
        if new_name.is_empty() || new_name == current_name {
            progress_rename.set_text("Enter a different workspace name.");
            return;
        }
        progress_rename.set_text("Renaming...");
        match WorkspaceStore::open(db_rename.clone())
            .and_then(|store| store.rename(&current_name, &new_name))
        {
            Ok(workspace) => {
                state_after_rename.set_selected_workspace(Some(workspace.name.clone()));
                progress_rename.set_text(&format!("Renamed to {}", workspace.name));
            }
            Err(err) => apply_runtime_action_feedback(
                &progress_rename,
                &toast_rename,
                lifecycle_action_failure_feedback("Rename", &err),
            ),
        }
        refresh_after_rename.refresh(RefreshScope::All);
    });

    for (button, action) in [
        (archive_btn.clone(), "archive"),
        (restore_btn.clone(), "restore"),
        (discard_btn.clone(), "discard"),
    ] {
        let workspace = ws.name.clone();
        let db_action = db_path.to_path_buf();
        let refresh_after_action = refresh_hub.clone();
        let confirm_action = confirm.clone();
        let progress_action = progress.clone();
        let toast_action = toast_overlay.clone();
        button.connect_clicked(move |_| {
            if matches!(action, "archive" | "discard") && !confirm_action.is_active() {
                progress_action.set_text("Check confirm before archive/discard.");
                return;
            }
            progress_action.set_text(&format!("{action} in progress..."));
            let result = WorkspaceStore::open(db_action.clone()).and_then(|store| match action {
                "archive" => store.archive(&workspace, false),
                "restore" => store.restore(&workspace),
                "discard" => store.discard(&workspace),
                _ => unreachable!(),
            });
            match result {
                Ok(workspace) => progress_action.set_text(&format!(
                    "{} complete: {}",
                    title_case_workspace(action),
                    workspace.name
                )),
                Err(err) => apply_runtime_action_feedback(
                    &progress_action,
                    &toast_action,
                    lifecycle_action_failure_feedback(&title_case_workspace(action), &err),
                ),
            }
            refresh_after_action.refresh(RefreshScope::All);
        });
    }

    let rename_row = make_action_row();
    rename_row.append(&rename_entry);
    rename_row.append(&rename_btn);
    let lifecycle_row = make_action_row();
    lifecycle_row.append(&confirm);
    lifecycle_row.append(&archive_btn);
    lifecycle_row.append(&restore_btn);
    lifecycle_row.append(&discard_btn);
    row.append(&rename_row);
    row.append(&lifecycle_row);
    panel.append(&row);
    panel.append(&progress);
    panel
}

fn work_tabs(
    db_path: &Path,
    store: &WorkspaceStore,
    ws: &Workspace,
    state: &AppState,
    refresh_hub: RefreshHub,
    toast_overlay: ToastOverlay,
) -> GBox {
    let panel = GBox::new(Orientation::Vertical, 8);
    let tabs = Stack::new();
    tabs.set_vexpand(true);
    let switcher = StackSwitcher::new();
    switcher.set_stack(Some(&tabs));
    switcher.add_css_class("panel-switcher");
    panel.append(&switcher);
    let terminal_preferences = store
        .workspace_view_defaults(&ws.name)
        .map(|defaults| {
            terminal::TerminalPreferences::from_config(
                defaults.terminal_font.as_deref(),
                defaults.terminal_scrollback,
            )
        })
        .unwrap_or_default();
    let terminal_command_presets = store
        .workspace_view_defaults(&ws.name)
        .map(|defaults| terminal::terminal_command_presets(&defaults.command_palette_presets))
        .unwrap_or_else(|_| terminal::terminal_command_presets(&[]));

    tabs.add_titled(
        &changes_checks_review_tabs(
            db_path,
            store,
            &ws.name,
            state.clone(),
            refresh_hub.clone(),
            toast_overlay.clone(),
        ),
        Some("work"),
        "Changes",
    );
    tabs.add_titled(
        &parallel_agents_panel(db_path, ws, state.clone(), refresh_hub.clone()),
        Some("chat-terminal"),
        "Chat",
    );
    tabs.add_titled(
        &terminal::embedded_terminal_panel(
            db_path.to_path_buf(),
            &ws.name,
            &ws.path,
            true,
            refresh_hub.clone(),
            terminal_preferences,
            terminal_command_presets,
        ),
        Some("terminal"),
        "Terminal",
    );
    tabs.add_titled(
        &workspace_todos_panel(store, &ws.name),
        Some("todos"),
        "Todos",
    );
    tabs.add_titled(
        &workspace_checkpoint_panel(
            db_path,
            &ws.name,
            refresh_hub.clone(),
            toast_overlay.clone(),
        ),
        Some("checkpoints"),
        "Checkpoints",
    );
    tabs.add_titled(
        &text_panel(&workspace_processes_text(store, &ws.name)),
        Some("processes"),
        "Processes",
    );
    tabs.set_visible_child_name(workspace_tab_stack_name(
        &state.snapshot().active_workspace_tab,
    ));

    let state_tabs = state.clone();
    tabs.connect_visible_child_name_notify(move |stack| {
        match stack.visible_child_name().as_deref() {
            Some("work") => {
                if !matches!(
                    state_tabs.snapshot().active_workspace_tab,
                    WorkspaceTab::Checks | WorkspaceTab::Review
                ) {
                    state_tabs.set_active_workspace_tab(WorkspaceTab::Changes);
                }
            }
            Some("todos") => state_tabs.set_active_workspace_tab(WorkspaceTab::Todos),
            Some("processes") => state_tabs.set_active_workspace_tab(WorkspaceTab::Processes),
            Some("terminal") => state_tabs.set_active_workspace_tab(WorkspaceTab::Terminal),
            Some("chat-terminal") => state_tabs.set_active_workspace_tab(WorkspaceTab::Chats),
            Some("checkpoints") => state_tabs.set_active_workspace_tab(WorkspaceTab::Checkpoints),
            _ => state_tabs.set_active_workspace_tab(WorkspaceTab::Chats),
        }
    });
    panel.append(&tabs);
    panel
}

fn workspace_tab_stack_name(tab: &WorkspaceTab) -> &'static str {
    match tab {
        WorkspaceTab::Chats => "chat-terminal",
        WorkspaceTab::Changes | WorkspaceTab::Checks | WorkspaceTab::Review => "work",
        WorkspaceTab::Checkpoints => "checkpoints",
        WorkspaceTab::Todos => "todos",
        WorkspaceTab::Processes => "processes",
        WorkspaceTab::Terminal => "terminal",
    }
}

fn workspace_checkpoint_panel(
    db_path: &Path,
    name: &str,
    refresh_hub: RefreshHub,
    toast_overlay: ToastOverlay,
) -> GBox {
    let panel = GBox::new(Orientation::Vertical, 8);
    panel.add_css_class("command-panel");
    panel.append(&section_title("Checkpoints"));

    let create_row = make_action_row();
    let message = Entry::new();
    message.set_placeholder_text(Some("Checkpoint message"));
    message.set_hexpand(true);
    let create_btn = Button::with_label("Create");
    create_btn.add_css_class("suggested-action");
    let feedback = Label::new(None);
    feedback.add_css_class("card-meta");
    feedback.set_xalign(0.0);
    feedback.set_wrap(true);

    let db_for_create = db_path.to_path_buf();
    let workspace_for_create = name.to_owned();
    let refresh_after_create = refresh_hub.clone();
    let feedback_for_create = feedback.clone();
    let toast_for_create = toast_overlay.clone();
    let message_for_create = message.clone();
    create_btn.connect_clicked(move |_| {
        let message = message_for_create.text().trim().to_owned();
        if message.is_empty() {
            apply_action_feedback(
                &feedback_for_create,
                &toast_for_create,
                "Checkpoint message required.",
                true,
            );
            return;
        }
        match WorkspaceStore::open(db_for_create.clone())
            .and_then(|store| store.checkpoint_create(&workspace_for_create, &message, None))
        {
            Ok(cp) => {
                apply_action_feedback(
                    &feedback_for_create,
                    &toast_for_create,
                    &format!("Created checkpoint #{}", cp.id),
                    true,
                );
                message_for_create.set_text("");
                refresh_after_create.refresh(RefreshScope::Workspace);
            }
            Err(err) => apply_action_feedback(
                &feedback_for_create,
                &toast_for_create,
                &format!("Create checkpoint failed: {err:#}"),
                true,
            ),
        }
    });
    create_row.append(&message);
    create_row.append(&create_btn);
    panel.append(&create_row);
    panel.append(&feedback);

    let mut checkpoints_loaded = Vec::new();
    let mut list_error = None;
    match WorkspaceStore::open(db_path).and_then(|store| store.checkpoint_list(name)) {
        Ok(checkpoints) => {
            checkpoints_loaded = checkpoints;
        }
        Err(err) => {
            list_error = Some(err.to_string());
        }
    }

    if let Some(err) = list_error {
        panel.append(&detail_row(
            "Checkpoint list",
            &format!("Could not load checkpoints: {err}"),
        ));
        return panel;
    }

    if checkpoints_loaded.is_empty() {
        panel.append(&detail_row("Checkpoints", "No checkpoints yet."));
        return panel;
    }

    let header = GBox::new(Orientation::Horizontal, 8);
    header.append(&detail_row("ID", "Status"));
    panel.append(&header);

    for checkpoint in checkpoints_loaded {
        let row = make_action_row();
        let label = Label::new(Some(&format!(
            "#{} {} - {}",
            checkpoint.id, checkpoint.created_at, checkpoint.message
        )));
        label.set_xalign(0.0);
        label.set_wrap(true);
        label.set_hexpand(true);
        let restore_btn = secondary_button("Restore");
        let checkpoint_id = checkpoint.id;
        let workspace_for_restore = name.to_owned();
        let db_for_restore = db_path.to_path_buf();
        let refresh_after_restore = refresh_hub.clone();
        let feedback_for_restore = feedback.clone();
        let toast_for_restore = toast_overlay.clone();
        restore_btn.connect_clicked(move |_| {
            match WorkspaceStore::open(db_for_restore.clone())
                .and_then(|store| store.checkpoint_restore(&workspace_for_restore, checkpoint_id))
            {
                Ok(cp) => {
                    apply_action_feedback(
                        &feedback_for_restore,
                        &toast_for_restore,
                        &format!("Restored checkpoint #{}", cp.id),
                        true,
                    );
                    refresh_after_restore.refresh(RefreshScope::Workspace);
                }
                Err(err) => {
                    apply_action_feedback(
                        &feedback_for_restore,
                        &toast_for_restore,
                        &format!("Restore checkpoint failed: {err:#}"),
                        true,
                    );
                }
            }
        });
        row.append(&label);
        row.append(&restore_btn);
        panel.append(&row);
    }

    panel
}

fn changes_checks_review_tabs(
    db_path: &Path,
    store: &WorkspaceStore,
    name: &str,
    app_state: AppState,
    refresh_hub: RefreshHub,
    toast_overlay: ToastOverlay,
) -> GBox {
    let panel = GBox::new(Orientation::Vertical, 8);
    let tabs = Stack::new();
    tabs.set_vexpand(true);
    let switcher = StackSwitcher::new();
    switcher.set_stack(Some(&tabs));
    switcher.add_css_class("panel-switcher");
    panel.append(&switcher);
    tabs.add_titled(
        &workspace_changes_panel(
            db_path,
            store,
            name,
            refresh_hub.clone(),
            toast_overlay.clone(),
        ),
        Some("changes"),
        "Changes",
    );
    tabs.add_titled(
        &workspace_checks_panel(
            db_path,
            store,
            name,
            app_state.clone(),
            refresh_hub.clone(),
            toast_overlay.clone(),
        ),
        Some("checks"),
        "Checks",
    );
    tabs.add_titled(
        &workspace_review_panel(
            db_path,
            store,
            name,
            app_state.clone(),
            refresh_hub,
            toast_overlay,
        ),
        Some("review"),
        "Review",
    );
    tabs.set_visible_child_name(changes_checks_review_tab_stack_name(
        &app_state.snapshot().active_workspace_tab,
    ));
    let state_tabs = app_state.clone();
    tabs.connect_visible_child_name_notify(move |stack| {
        match stack.visible_child_name().as_deref() {
            Some("checks") => state_tabs.set_active_workspace_tab(WorkspaceTab::Checks),
            Some("review") => state_tabs.set_active_workspace_tab(WorkspaceTab::Review),
            Some("changes") => state_tabs.set_active_workspace_tab(WorkspaceTab::Changes),
            _ => {}
        }
    });
    panel.append(&tabs);
    panel
}

fn changes_checks_review_tab_stack_name(tab: &WorkspaceTab) -> &'static str {
    match tab {
        WorkspaceTab::Checks => "checks",
        WorkspaceTab::Review => "review",
        _ => "changes",
    }
}

fn chat_terminal_split(
    db_path: &Path,
    ws: &Workspace,
    app_state: AppState,
    refresh_hub: RefreshHub,
    terminal_preferences: terminal::TerminalPreferences,
    terminal_command_presets: Vec<terminal::TerminalCommandPreset>,
) -> Paned {
    let split = Paned::new(Orientation::Horizontal);
    split.set_wide_handle(true);
    split.set_position(520);

    let chat_box = GBox::new(Orientation::Vertical, 8);
    chat_box.add_css_class("command-panel");
    chat_box.add_css_class("session-tool-surface");
    chat_box.append(&section_title("Chat"));
    let db_for_sessions = db_path.to_path_buf();
    let workspace_for_sessions = ws.name.clone();
    let refresh_sessions = refresh_hub.clone();
    chat_box.append(&session_surface::agent_session_panel(
        db_for_sessions,
        &workspace_for_sessions,
        app_state,
        move || refresh_sessions.refresh(RefreshScope::Workspace),
    ));
    for chat in history::sessions_for_workspace_path(db_path, &ws.path)
        .into_iter()
        .take(8)
    {
        chat_box.append(&history::session_summary_row(&chat));
    }
    chat_box.append(&linked_directories_panel(
        db_path,
        &ws.name,
        refresh_hub.clone(),
    ));

    let terminal_box = GBox::new(Orientation::Vertical, 8);
    terminal_box.add_css_class("command-panel");
    terminal_box.add_css_class("session-tool-surface");
    terminal_box.append(&section_title("Terminal"));
    terminal_box.append(&terminal::embedded_terminal_panel(
        db_path.to_path_buf(),
        &ws.name,
        &ws.path,
        false,
        refresh_hub,
        terminal_preferences,
        terminal_command_presets,
    ));

    split.set_start_child(Some(&chat_box));
    split.set_end_child(Some(&terminal_box));
    split
}

fn parallel_agents_panel(
    db_path: &Path,
    ws: &Workspace,
    app_state: AppState,
    refresh_hub: RefreshHub,
) -> Paned {
    let split = Paned::new(Orientation::Horizontal);
    split.set_wide_handle(true);
    split.set_position(580);

    let chat_box = GBox::new(Orientation::Vertical, 8);
    chat_box.add_css_class("command-panel");
    chat_box.add_css_class("session-tool-surface");
    chat_box.append(&section_title("Chat"));
    let refresh_chat = refresh_hub.clone();
    chat_box.append(&session_surface::agent_session_panel(
        db_path.to_path_buf(),
        &ws.name,
        app_state,
        move || refresh_chat.refresh(RefreshScope::Workspace),
    ));
    for chat in history::sessions_for_workspace_path(db_path, &ws.path)
        .into_iter()
        .take(8)
    {
        chat_box.append(&history::session_summary_row(&chat));
    }
    chat_box.append(&linked_directories_panel(db_path, &ws.name, refresh_hub));

    let right = GBox::new(Orientation::Vertical, 0);
    right.add_css_class("command-panel");
    right.add_css_class("session-tool-surface");

    let file_tabs = Stack::new();
    file_tabs.set_vexpand(true);
    let file_switcher = StackSwitcher::new();
    file_switcher.set_stack(Some(&file_tabs));
    file_switcher.add_css_class("panel-switcher");

    let changes_text = WorkspaceStore::open(db_path)
        .and_then(|store| store.diff_file_summaries(&ws.name))
        .map(|summaries| format_diff_file_summary(&summaries))
        .unwrap_or_else(|_| "No changes yet.\n".to_owned());
    file_tabs.add_titled(&text_panel(&changes_text), Some("changes"), "Changes");

    let checks_text = WorkspaceStore::open(db_path)
        .map(|store| workspace_checks_text(&store, &ws.name))
        .unwrap_or_else(|_| "No checks yet.\n".to_owned());
    file_tabs.add_titled(&text_panel(&checks_text), Some("checks"), "Checks");

    right.append(&file_switcher);
    right.append(&file_tabs);

    let run_label = section_title("Run");
    run_label.set_margin_top(8);
    run_label.set_margin_start(8);
    right.append(&run_label);

    let run_text = WorkspaceStore::open(db_path)
        .map(|store| latest_run_log_line(&store, &ws.name))
        .unwrap_or_else(|_| "No run log yet.\n".to_owned());
    let run_view = TextView::new();
    run_view.set_editable(false);
    run_view.set_monospace(true);
    run_view.add_css_class("history-view");
    run_view.buffer().set_text(&run_text);
    let run_scroll = ScrolledWindow::new();
    run_scroll.set_policy(PolicyType::Automatic, PolicyType::Automatic);
    run_scroll.set_min_content_height(120);
    run_scroll.set_child(Some(&run_view));
    right.append(&run_scroll);

    split.set_start_child(Some(&chat_box));
    split.set_end_child(Some(&right));
    split
}

fn linked_directories_panel(db_path: &Path, name: &str, refresh_hub: RefreshHub) -> GBox {
    let panel = GBox::new(Orientation::Vertical, 6);
    panel.append(&section_title("Linked Directories"));

    let links_view = TextView::new();
    links_view.set_editable(false);
    links_view.set_monospace(true);
    links_view.add_css_class("history-view");
    links_view
        .buffer()
        .set_text(&linked_directories_text(db_path, name));
    let scroll = ScrolledWindow::new();
    scroll.set_policy(PolicyType::Automatic, PolicyType::Automatic);
    scroll.set_min_content_height(86);
    scroll.set_child(Some(&links_view));
    panel.append(&scroll);

    let row = GBox::new(Orientation::Horizontal, 8);
    let target_entry = Entry::new();
    target_entry.set_placeholder_text(Some("Target workspace name"));
    target_entry.set_hexpand(true);
    let link_btn = Button::with_label("Link");
    link_btn.add_css_class("suggested-action");
    let unlink_btn = destructive_button("Unlink");
    row.append(&target_entry);
    row.append(&link_btn);
    row.append(&unlink_btn);
    panel.append(&row);

    let db_for_link = db_path.to_path_buf();
    let workspace_for_link = name.to_owned();
    let target_for_link = target_entry.clone();
    let buffer_for_link = links_view.buffer();
    let hub_for_link = refresh_hub.clone();
    link_btn.connect_clicked(move |_| {
        let target = target_for_link.text().trim().to_owned();
        if target.is_empty() {
            buffer_for_link.set_text("Enter a target workspace name to link.\n");
            return;
        }
        match WorkspaceStore::open(db_for_link.clone())
            .and_then(|store| store.link_workspace_directory(&workspace_for_link, &target))
        {
            Ok(_) => {
                buffer_for_link
                    .set_text(&linked_directories_text(&db_for_link, &workspace_for_link));
                hub_for_link.refresh(RefreshScope::Workspace);
            }
            Err(err) => buffer_for_link.set_text(&format!("Could not link directory: {err:#}\n")),
        }
    });

    let db_for_unlink = db_path.to_path_buf();
    let workspace_for_unlink = name.to_owned();
    let target_for_unlink = target_entry;
    let buffer_for_unlink = links_view.buffer();
    let hub_for_unlink = refresh_hub;
    unlink_btn.connect_clicked(move |_| {
        let target = target_for_unlink.text().trim().to_owned();
        if target.is_empty() {
            buffer_for_unlink.set_text("Enter a target workspace name to unlink.\n");
            return;
        }
        match WorkspaceStore::open(db_for_unlink.clone())
            .and_then(|store| store.unlink_workspace_directory(&workspace_for_unlink, &target))
        {
            Ok(_) => {
                buffer_for_unlink.set_text(&linked_directories_text(
                    &db_for_unlink,
                    &workspace_for_unlink,
                ));
                hub_for_unlink.refresh(RefreshScope::Workspace);
            }
            Err(err) => {
                buffer_for_unlink.set_text(&format!("Could not unlink directory: {err:#}\n"))
            }
        }
    });

    panel
}

fn linked_directories_text(db_path: &Path, name: &str) -> String {
    match WorkspaceStore::open(db_path).and_then(|store| store.list_linked_directories(name)) {
        Ok(links) if links.is_empty() => "No linked directories.\n".to_owned(),
        Ok(links) => links
            .into_iter()
            .map(|link| {
                format!(
                    "{} -> {}\nlink: {}\n",
                    link.target_workspace_name,
                    link.target_workspace_path.display(),
                    link.link_path.display()
                )
            })
            .collect(),
        Err(err) => format!("Could not read linked directories: {err:#}\n"),
    }
}

fn section_title(text: &str) -> Label {
    let label = Label::new(Some(text));
    label.add_css_class("section-title");
    label.set_xalign(0.0);
    label
}

fn text_panel(text: &str) -> ScrolledWindow {
    let view = TextView::new();
    view.set_editable(false);
    view.set_monospace(true);
    view.add_css_class("history-view");
    view.buffer().set_text(text);
    let scroll = ScrolledWindow::new();
    scroll.set_policy(PolicyType::Automatic, PolicyType::Automatic);
    scroll.set_vexpand(true);
    scroll.set_child(Some(&view));
    scroll
}

fn workspace_changes_panel(
    db_path: &Path,
    store: &WorkspaceStore,
    name: &str,
    refresh_hub: RefreshHub,
    toast_overlay: ToastOverlay,
) -> GBox {
    let panel = GBox::new(Orientation::Vertical, 8);
    panel.append(&detail_row(
        "Branch",
        &workspace_branch_state_text(store, name),
    ));
    panel.append(&detail_row(
        "Status",
        &store
            .git_status_short(name)
            .unwrap_or_else(|err| format!("Could not read status: {err:#}")),
    ));

    let commits = TextView::new();
    commits.set_editable(false);
    commits.set_monospace(true);
    commits.add_css_class("history-view");
    commits.buffer().set_text(
        &store
            .git_log_oneline(name, 12)
            .unwrap_or_else(|err| format!("Could not read log: {err:#}\n")),
    );
    let commits_scroll = ScrolledWindow::new();
    commits_scroll.set_policy(PolicyType::Automatic, PolicyType::Automatic);
    commits_scroll.set_min_content_height(120);
    commits_scroll.set_child(Some(&commits));
    panel.append(&section_title("Recent commits"));
    panel.append(&commits_scroll);

    let summary = store.diff_file_summaries(name).unwrap_or_default();
    let selected_file = std::rc::Rc::new(std::cell::RefCell::new(None::<String>));
    let diff_view = TextView::new();
    diff_view.set_editable(false);
    diff_view.set_monospace(true);
    diff_view.set_vexpand(true);
    diff_view
        .buffer()
        .set_text(&workspace_diff_text(store, name, None));
    let diff_scroll = ScrolledWindow::new();
    diff_scroll.set_policy(PolicyType::Automatic, PolicyType::Automatic);
    diff_scroll.set_vexpand(true);
    diff_scroll.set_child(Some(&diff_view));

    let selection_status = Label::new(Some("Showing full workspace diff."));
    selection_status.add_css_class("card-meta");
    selection_status.set_xalign(0.0);
    selection_status.set_wrap(true);
    let feedback = Label::new(Some("No file action run yet."));
    feedback.add_css_class("card-meta");
    feedback.set_xalign(0.0);
    feedback.set_wrap(true);

    let action_row = make_action_row();
    let show_all_btn = secondary_button("Show All");
    let revert_btn = destructive_button("Revert Selected");
    action_row.append(&show_all_btn);
    action_row.append(&revert_btn);
    panel.append(&selection_status);
    panel.append(&action_row);

    let comment_row = make_action_row();
    comment_row.add_css_class("action-input-row");
    let comment_line = Entry::new();
    comment_line.set_placeholder_text(Some("line"));
    let comment_body = Entry::new();
    comment_body.set_placeholder_text(Some("Add comment on selected file"));
    comment_body.set_hexpand(true);
    let comment_btn = Button::with_label("Comment");
    comment_btn.add_css_class("suggested-action");
    comment_row.append(&comment_line);
    comment_row.append(&comment_body);
    comment_row.append(&comment_btn);
    panel.append(&comment_row);

    let comments_view = TextView::new();
    comments_view.set_editable(false);
    comments_view.set_monospace(true);
    comments_view.set_vexpand(false);
    comments_view
        .buffer()
        .set_text("Select a changed file to view inline comments.");
    let comments_scroll = ScrolledWindow::new();
    comments_scroll.set_policy(PolicyType::Automatic, PolicyType::Automatic);
    comments_scroll.set_min_content_height(96);
    comments_scroll.set_child(Some(&comments_view));
    panel.append(&section_title("Inline comments"));
    panel.append(&comments_scroll);

    let list_box = GBox::new(Orientation::Vertical, 6);
    if summary.is_empty() {
        list_box.append(&detail_row("Files", "No changed files."));
    } else {
        for row in diff_tree_rows(&summary) {
            match row {
                DiffTreeRow::Directory(label) => {
                    let directory = Label::new(Some(&label));
                    directory.add_css_class("detail-label");
                    directory.set_xalign(0.0);
                    list_box.append(&directory);
                }
                DiffTreeRow::File(file) => {
                    let row_box = make_action_row();
                    let open_btn = flat_button(&diff_tree_file_label(&file));
                    open_btn.set_hexpand(true);
                    let selected_file_for_open = selected_file.clone();
                    let db_for_open = db_path.to_path_buf();
                    let workspace_for_open = name.to_owned();
                    let diff_buffer = diff_view.buffer();
                    let comments_buffer = comments_view.buffer();
                    let selection_status_for_open = selection_status.clone();
                    let path_for_open = file.path.clone();
                    open_btn.connect_clicked(move |_| {
                        *selected_file_for_open.borrow_mut() = Some(path_for_open.clone());
                        diff_buffer.set_text(&workspace_diff_text_for_path(
                            &db_for_open,
                            &workspace_for_open,
                            Some(path_for_open.as_str()),
                        ));
                        comments_buffer.set_text(&workspace_file_comments_text(
                            &db_for_open,
                            &workspace_for_open,
                            &path_for_open,
                        ));
                        selection_status_for_open
                            .set_text(&format!("Showing diff for {}.", path_for_open));
                    });
                    row_box.append(&open_btn);
                    list_box.append(&row_box);
                }
            }
        }
    }
    let list_scroll = ScrolledWindow::new();
    list_scroll.set_policy(PolicyType::Automatic, PolicyType::Automatic);
    list_scroll.set_min_content_width(260);
    list_scroll.set_child(Some(&list_box));

    let split = Paned::new(Orientation::Horizontal);
    split.set_start_child(Some(&list_scroll));
    split.set_end_child(Some(&diff_scroll));
    split.set_position(280);
    split.set_wide_handle(true);
    panel.append(&split);
    panel.append(&feedback);

    let diff_buffer_for_all = diff_view.buffer();
    let db_for_all = db_path.to_path_buf();
    let workspace_for_all = name.to_owned();
    let selected_file_for_all = selected_file.clone();
    let comments_buffer_for_all = comments_view.buffer();
    let selection_status_for_all = selection_status.clone();
    show_all_btn.connect_clicked(move |_| {
        *selected_file_for_all.borrow_mut() = None;
        diff_buffer_for_all.set_text(&workspace_diff_text_for_path(
            &db_for_all,
            &workspace_for_all,
            None,
        ));
        comments_buffer_for_all.set_text("Select a changed file to view inline comments.");
        selection_status_for_all.set_text("Showing full workspace diff.");
    });

    let db_for_revert = db_path.to_path_buf();
    let workspace_for_revert = name.to_owned();
    let selected_file_for_revert = selected_file.clone();
    let diff_buffer_for_revert = diff_view.buffer();
    let comments_buffer_for_revert = comments_view.buffer();
    let feedback_for_revert = feedback.clone();
    let toast_for_revert = toast_overlay.clone();
    let selection_status_for_revert = selection_status.clone();
    let refresh_after_revert = refresh_hub.clone();
    revert_btn.connect_clicked(move |_| {
        let Some(path) = selected_file_for_revert.borrow().clone() else {
            apply_action_feedback(
                &feedback_for_revert,
                &toast_for_revert,
                "Select one tracked file before reverting.",
                true,
            );
            return;
        };
        match WorkspaceStore::open(db_for_revert.clone())
            .and_then(|store| store.revert_workspace_file(&workspace_for_revert, &path))
        {
            Ok(()) => {
                *selected_file_for_revert.borrow_mut() = None;
                diff_buffer_for_revert.set_text(&workspace_diff_text_for_path(
                    &db_for_revert,
                    &workspace_for_revert,
                    None,
                ));
                comments_buffer_for_revert
                    .set_text("Select a changed file to view inline comments.");
                selection_status_for_revert.set_text("Showing full workspace diff.");
                apply_action_feedback(
                    &feedback_for_revert,
                    &toast_for_revert,
                    &format!("Reverted {} back to HEAD.", path),
                    true,
                );
                refresh_after_revert.refresh(RefreshScope::Workspace);
            }
            Err(err) => apply_action_feedback(
                &feedback_for_revert,
                &toast_for_revert,
                &format!("Could not revert {}: {err:#}", path),
                true,
            ),
        }
    });

    let db_for_comment = db_path.to_path_buf();
    let workspace_for_comment = name.to_owned();
    let selected_file_for_comment = selected_file.clone();
    let comment_line_for_add = comment_line.clone();
    let comment_body_for_add = comment_body.clone();
    let comments_buffer_for_comment = comments_view.buffer();
    let feedback_for_comment = feedback.clone();
    let toast_for_comment = toast_overlay.clone();
    let refresh_after_comment = refresh_hub.clone();
    comment_btn.connect_clicked(move |_| {
        let Some(path) = selected_file_for_comment.borrow().clone() else {
            apply_action_feedback(
                &feedback_for_comment,
                &toast_for_comment,
                "Select a file diff before adding a comment.",
                true,
            );
            return;
        };
        let body = comment_body_for_add.text().trim().to_owned();
        if body.is_empty() {
            apply_action_feedback(
                &feedback_for_comment,
                &toast_for_comment,
                "Comment text is required.",
                true,
            );
            return;
        }
        let line = match parse_review_comment_line(comment_line_for_add.text().as_ref()) {
            Ok(line) => line,
            Err(err) => {
                apply_action_feedback(&feedback_for_comment, &toast_for_comment, err, true);
                return;
            }
        };
        match WorkspaceStore::open(db_for_comment.clone())
            .and_then(|store| store.add_review_comment(&workspace_for_comment, &path, line, &body))
        {
            Ok(comment) => {
                comment_line_for_add.set_text("");
                comment_body_for_add.set_text("");
                comments_buffer_for_comment.set_text(&workspace_file_comments_text(
                    &db_for_comment,
                    &workspace_for_comment,
                    &path,
                ));
                apply_action_feedback(
                    &feedback_for_comment,
                    &toast_for_comment,
                    &format!("Added review comment #{} on {}.", comment.id, path),
                    true,
                );
                refresh_after_comment.refresh(RefreshScope::Workspace);
            }
            Err(err) => apply_action_feedback(
                &feedback_for_comment,
                &toast_for_comment,
                &format!("Could not add review comment: {err:#}"),
                true,
            ),
        }
    });

    panel
}

fn workspace_changes_text(store: &WorkspaceStore, name: &str) -> String {
    let mut out = String::new();
    out.push_str("Recent commits\n");
    out.push_str(
        &store
            .git_log_oneline(name, 12)
            .unwrap_or_else(|err| format!("Could not read log: {err:#}\n")),
    );
    out.push_str("\n\nStatus\n");
    out.push_str(
        &store
            .git_status_short(name)
            .unwrap_or_else(|err| format!("Could not read status: {err:#}\n")),
    );
    out.push_str("\n\n");
    match store.diff_file_summaries(name) {
        Ok(summaries) => out.push_str(&format_diff_file_summary(&summaries)),
        Err(err) => out.push_str(&format!(
            "Files changed\nCould not read diff summary: {err:#}\n"
        )),
    }
    out.push_str("\n\nDiff\n");
    out.push_str(
        &store
            .unified_diff(name, None)
            .unwrap_or_else(|err| format!("Could not read diff: {err:#}\n")),
    );
    out
}

fn workspace_branch_state_text(store: &WorkspaceStore, name: &str) -> String {
    match store.checks_summary(name) {
        Ok(summary) => summary
            .branch_push_state
            .map(|state| {
                if state.has_upstream {
                    format!("ahead {} / behind {}", state.ahead, state.behind)
                } else {
                    "no upstream".to_owned()
                }
            })
            .unwrap_or_else(|| "unavailable".to_owned()),
        Err(err) => format!("Could not read branch state: {err:#}"),
    }
}

fn workspace_diff_text(store: &WorkspaceStore, name: &str, path: Option<&str>) -> String {
    match path {
        Some(path) => store
            .unified_diff(name, Some(Path::new(path)))
            .unwrap_or_else(|err| format!("Could not read diff for {path}: {err:#}\n")),
        None => store
            .unified_diff(name, None)
            .unwrap_or_else(|err| format!("Could not read diff: {err:#}\n")),
    }
}

fn workspace_diff_text_for_path(db_path: &Path, name: &str, path: Option<&str>) -> String {
    WorkspaceStore::open(db_path)
        .map(|store| workspace_diff_text(&store, name, path))
        .unwrap_or_else(|err| format!("Could not open workspace database: {err:#}\n"))
}

fn workspace_file_comments_text(db_path: &Path, name: &str, path: &str) -> String {
    WorkspaceStore::open(db_path)
        .and_then(|store| store.list_review_comments(name))
        .map(|comments| file_inline_comments_text(&comments, path))
        .unwrap_or_else(|err| format!("Could not read comments for {path}: {err:#}\n"))
}

fn diff_summary_label(summary: &DiffFileSummary) -> String {
    let counts = match (summary.additions, summary.deletions) {
        (Some(additions), Some(deletions)) => format!("+{additions} -{deletions}"),
        _ => "binary".to_owned(),
    };
    format!("{} {}", summary.path, counts)
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DiffTreeRow {
    Directory(String),
    File(DiffFileSummary),
}

fn diff_tree_rows(summaries: &[DiffFileSummary]) -> Vec<DiffTreeRow> {
    let mut rows = Vec::new();
    let mut seen_directories = std::collections::BTreeSet::new();
    for summary in summaries {
        let parts = summary.path.split('/').collect::<Vec<_>>();
        if parts.len() > 1 {
            let mut prefix = String::new();
            for (depth, part) in parts[..parts.len() - 1].iter().enumerate() {
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(part);
                if seen_directories.insert(prefix.clone()) {
                    rows.push(DiffTreeRow::Directory(format!(
                        "{}{}/",
                        "  ".repeat(depth),
                        part
                    )));
                }
            }
        }
        rows.push(DiffTreeRow::File(summary.clone()));
    }
    rows
}

fn diff_tree_file_label(summary: &DiffFileSummary) -> String {
    let depth = summary.path.matches('/').count();
    format!("{}{}", "  ".repeat(depth), diff_summary_label(summary))
}

fn file_inline_comments_text(comments: &[ReviewComment], path: &str) -> String {
    let filtered = comments
        .iter()
        .filter(|comment| comment.file_path == path)
        .collect::<Vec<_>>();
    if filtered.is_empty() {
        return format!("No inline comments for {path}.");
    }
    let mut out = format!("Inline comments for {path}\n");
    for comment in filtered {
        let line = comment
            .line_number
            .map(|line| format!(":{line}"))
            .unwrap_or_default();
        out.push_str(&format!(
            "#{} [{}] {}{} - {}\n",
            comment.id, comment.status, comment.file_path, line, comment.body
        ));
    }
    out
}

fn format_diff_file_summary(summaries: &[DiffFileSummary]) -> String {
    let mut out = "Files changed\n".to_owned();
    if summaries.is_empty() {
        out.push_str("No unstaged file changes.\n");
        return out;
    }
    for summary in summaries {
        let counts = match (summary.additions, summary.deletions) {
            (Some(additions), Some(deletions)) => format!("+{additions} -{deletions}"),
            _ => "binary".to_owned(),
        };
        out.push_str(&format!("{} {}\n", summary.path, counts));
    }
    out
}

fn workspace_checks_text(store: &WorkspaceStore, name: &str) -> String {
    match store.checks_summary(name) {
        Ok(summary) => {
            let push = summary
                .branch_push_state
                .as_ref()
                .map(|state| {
                    if state.has_upstream {
                        format!("ahead {} / behind {}", state.ahead, state.behind)
                    } else {
                        "no upstream".to_owned()
                    }
                })
                .unwrap_or_else(|| "unavailable".to_owned());
            let pr = summary
                .pull_request
                .as_ref()
                .map(|pr| format!("#{} {} {}", pr.number, pr.state, pr.url))
                .unwrap_or_else(|| "none".to_owned());
            let conflicts = if summary.conflicting_workspaces.is_empty() {
                "none".to_owned()
            } else {
                summary
                    .conflicting_workspaces
                    .iter()
                    .map(|(workspace, files)| format!("{workspace}: {}", files.join(", ")))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            let blockers = merge_blockers_text(
                summary.open_todos,
                summary.open_review_comments,
                summary.conflicting_workspaces.len(),
            );
            format!(
                "Changed files: {}\nRun: {}\nSessions: {}\nPR: {}\n{}\nTodos: {} open / {} total\nReview comments: {} open\nBranch: {}\nConflicts:\n{}",
                summary.changed_files,
                summary
                    .run_status
                    .map(|status| status.as_str().to_owned())
                    .unwrap_or_else(|| "none".to_owned()),
                summary.active_sessions,
                pr,
                blockers,
                summary.open_todos,
                summary.total_todos,
                summary.open_review_comments,
                push,
                conflicts
            )
        }
        Err(err) => format!("Could not read checks: {err:#}"),
    }
}

fn workspace_checks_panel(
    db_path: &Path,
    store: &WorkspaceStore,
    name: &str,
    app_state: AppState,
    refresh_hub: RefreshHub,
    toast_overlay: ToastOverlay,
) -> GBox {
    let panel = GBox::new(Orientation::Vertical, 8);
    panel.append(&text_panel(&workspace_checks_text(store, name)));

    let pr_form = make_action_stack();
    let title_entry = Entry::new();
    title_entry.set_placeholder_text(Some("PR title (blank = gh --fill)"));
    title_entry.set_hexpand(true);
    let body_entry = Entry::new();
    body_entry.set_placeholder_text(Some("PR body"));
    body_entry.set_hexpand(true);
    let draft = CheckButton::with_label("Draft");
    let create_btn = Button::with_label("Create PR");
    create_btn.add_css_class("suggested-action");
    let inspect_row = make_action_stack();
    let refresh_pr_btn = secondary_button("Refresh PR");
    let view_summary_btn = flat_button("Preview Summary");
    let stage_summary_btn = Button::with_label("Queue Summary");
    stage_summary_btn.add_css_class("suggested-action");
    let view_checks_btn = flat_button("Preview Checks");
    let stage_checks_btn = Button::with_label("Queue Failing Checks");
    stage_checks_btn.add_css_class("suggested-action");
    let view_reviews_btn = flat_button("Preview Comments");
    let stage_reviews_btn = Button::with_label("Queue Comments");
    stage_reviews_btn.add_css_class("suggested-action");
    let thread_row = make_action_row();
    let thread_id_entry = Entry::new();
    thread_id_entry.set_placeholder_text(Some("Review thread ID from PR summary"));
    thread_id_entry.set_hexpand(true);
    let resolve_thread_btn = secondary_button("Resolve Thread");
    let reopen_thread_btn = flat_button("Reopen Thread");
    let merge_row = make_action_row();
    let merge_method = ComboBoxText::new();
    merge_method.append(Some("squash"), "Squash");
    merge_method.append(Some("merge"), "Merge");
    merge_method.append(Some("rebase"), "Rebase");
    merge_method.set_active_id(Some("squash"));
    let merge_btn = Button::with_label("Merge PR");
    merge_btn.add_css_class("suggested-action");
    let archive_after_merge_btn = destructive_button("Archive Workspace");
    let feedback = Label::new(None);
    feedback.add_css_class("card-meta");
    feedback.set_xalign(0.0);
    feedback.set_wrap(true);
    let checks_output = Label::new(None);
    checks_output.add_css_class("checks-view");
    checks_output.set_xalign(0.0);
    checks_output.set_wrap(true);
    checks_output.set_selectable(true);

    let db_for_create = db_path.to_path_buf();
    let workspace_for_create = name.to_owned();
    let refresh_after_create = refresh_hub.clone();
    let title_for_create = title_entry.clone();
    let body_for_create = body_entry.clone();
    let draft_for_create = draft.clone();
    let feedback_for_create = feedback.clone();
    let toast_for_create = toast_overlay.clone();
    create_btn.connect_clicked(move |_| {
        let title = optional_entry_text(&title_for_create);
        let body = optional_entry_text(&body_for_create);
        let result = WorkspaceStore::open(db_for_create.clone()).and_then(|store| {
            store.create_pull_request(
                &workspace_for_create,
                title.as_deref(),
                body.as_deref(),
                draft_for_create.is_active(),
            )
        });
        apply_action_feedback(
            &feedback_for_create,
            &toast_for_create,
            &pull_request_create_feedback(result),
            true,
        );
        refresh_after_create.refresh(RefreshScope::All);
    });

    let db_for_refresh = db_path.to_path_buf();
    let workspace_for_refresh = name.to_owned();
    let refresh_after_pr_refresh = refresh_hub.clone();
    let feedback_for_refresh = feedback.clone();
    let toast_for_refresh = toast_overlay.clone();
    refresh_pr_btn.connect_clicked(move |_| {
        let result = WorkspaceStore::open(db_for_refresh.clone())
            .and_then(|store| store.refresh_pull_request_state(&workspace_for_refresh));
        apply_action_feedback(
            &feedback_for_refresh,
            &toast_for_refresh,
            &pull_request_refresh_feedback(result),
            true,
        );
        refresh_after_pr_refresh.refresh(RefreshScope::All);
    });

    let db_for_summary = db_path.to_path_buf();
    let workspace_for_summary = name.to_owned();
    let checks_output_for_summary = checks_output.clone();
    let feedback_for_summary = feedback.clone();
    let toast_for_summary = toast_overlay.clone();
    view_summary_btn.connect_clicked(move |_| {
        let result = WorkspaceStore::open(db_for_summary.clone())
            .and_then(|store| store.pull_request_readiness_text(&workspace_for_summary));
        let text = pull_request_readiness_feedback(result);
        apply_action_feedback(&feedback_for_summary, &toast_for_summary, &text, true);
        checks_output_for_summary.set_text(&text);
    });

    let db_for_stage_summary = db_path.to_path_buf();
    let workspace_for_stage_summary = name.to_owned();
    let feedback_for_stage_summary = feedback.clone();
    let toast_for_stage_summary = toast_overlay.clone();
    let app_state_for_stage_summary = app_state.clone();
    stage_summary_btn.connect_clicked(move |_| {
        match WorkspaceStore::open(db_for_stage_summary.clone()).and_then(|store| {
            store.pull_request_readiness_agent_prompt(&workspace_for_stage_summary)
        }) {
            Ok(prompt) => {
                app_state_for_stage_summary.set_staged_review_prompt(Some(prompt));
                apply_action_feedback(
                    &feedback_for_stage_summary,
                    &toast_for_stage_summary,
                    "Staged PR readiness summary for the selected agent session.",
                    true,
                );
            }
            Err(err) => apply_action_feedback(
                &feedback_for_stage_summary,
                &toast_for_stage_summary,
                &format!("Could not stage PR readiness summary: {err:#}"),
                true,
            ),
        }
    });

    let db_for_checks = db_path.to_path_buf();
    let workspace_for_checks = name.to_owned();
    let checks_output_for_checks = checks_output.clone();
    let feedback_for_checks = feedback.clone();
    let toast_for_checks = toast_overlay.clone();
    view_checks_btn.connect_clicked(move |_| {
        let result = WorkspaceStore::open(db_for_checks.clone())
            .and_then(|store| store.pull_request_checks(&workspace_for_checks));
        let text = pull_request_checks_feedback(result);
        apply_action_feedback(&feedback_for_checks, &toast_for_checks, &text, true);
        checks_output_for_checks.set_text(&text);
    });

    let db_for_stage_checks = db_path.to_path_buf();
    let workspace_for_stage_checks = name.to_owned();
    let feedback_for_stage_checks = feedback.clone();
    let toast_for_stage_checks = toast_overlay.clone();
    let app_state_for_stage_checks = app_state.clone();
    stage_checks_btn.connect_clicked(move |_| {
        match WorkspaceStore::open(db_for_stage_checks.clone()).and_then(|store| {
            let prompt = store.pull_request_checks_agent_prompt(&workspace_for_stage_checks)?;
            if prompt.contains("No failing PR checks.") {
                anyhow::bail!("No failing PR checks to stage");
            }
            Ok(prompt)
        }) {
            Ok(prompt) => {
                app_state_for_stage_checks.set_staged_review_prompt(Some(prompt));
                apply_action_feedback(
                    &feedback_for_stage_checks,
                    &toast_for_stage_checks,
                    "Staged failing PR checks for the selected agent session.",
                    true,
                );
            }
            Err(err) => apply_action_feedback(
                &feedback_for_stage_checks,
                &toast_for_stage_checks,
                &format!("Could not stage failing checks: {err:#}"),
                true,
            ),
        }
    });

    let db_for_reviews = db_path.to_path_buf();
    let workspace_for_reviews = name.to_owned();
    let checks_output_for_reviews = checks_output.clone();
    let feedback_for_reviews = feedback.clone();
    let toast_for_reviews = toast_overlay.clone();
    view_reviews_btn.connect_clicked(move |_| {
        let result = WorkspaceStore::open(db_for_reviews.clone())
            .and_then(|store| store.pull_request_review_state(&workspace_for_reviews));
        let text = pull_request_review_feedback(result);
        apply_action_feedback(&feedback_for_reviews, &toast_for_reviews, &text, true);
        checks_output_for_reviews.set_text(&text);
    });

    let db_for_stage_reviews = db_path.to_path_buf();
    let workspace_for_stage_reviews = name.to_owned();
    let feedback_for_stage_reviews = feedback.clone();
    let toast_for_stage_reviews = toast_overlay.clone();
    let app_state_for_stage_reviews = app_state.clone();
    stage_reviews_btn.connect_clicked(move |_| {
        match WorkspaceStore::open(db_for_stage_reviews.clone()).and_then(|store| {
            let prompt = store.pull_request_review_agent_prompt(&workspace_for_stage_reviews)?;
            if prompt.contains("No GitHub PR review/comment output.") {
                anyhow::bail!("No GitHub PR comments or reviews to stage");
            }
            Ok(prompt)
        }) {
            Ok(prompt) => {
                app_state_for_stage_reviews.set_staged_review_prompt(Some(prompt));
                apply_action_feedback(
                    &feedback_for_stage_reviews,
                    &toast_for_stage_reviews,
                    "Staged GitHub PR comments/reviews for the selected agent session.",
                    true,
                );
            }
            Err(err) => apply_action_feedback(
                &feedback_for_stage_reviews,
                &toast_for_stage_reviews,
                &format!("Could not stage PR comments/reviews: {err:#}"),
                true,
            ),
        }
    });

    let db_for_resolve_thread = db_path.to_path_buf();
    let workspace_for_resolve_thread = name.to_owned();
    let thread_id_for_resolve = thread_id_entry.clone();
    let feedback_for_resolve_thread = feedback.clone();
    let toast_for_resolve_thread = toast_overlay.clone();
    resolve_thread_btn.connect_clicked(move |_| {
        let thread_id = thread_id_for_resolve.text().trim().to_owned();
        let result = if thread_id.is_empty() {
            Err(anyhow::anyhow!("review thread id is required"))
        } else {
            WorkspaceStore::open(db_for_resolve_thread.clone()).and_then(|store| {
                store.set_pull_request_review_thread_resolution(
                    &workspace_for_resolve_thread,
                    &thread_id,
                    true,
                )
            })
        };
        apply_action_feedback(
            &feedback_for_resolve_thread,
            &toast_for_resolve_thread,
            &pull_request_review_thread_action_feedback("Resolve", result),
            true,
        );
    });

    let db_for_reopen_thread = db_path.to_path_buf();
    let workspace_for_reopen_thread = name.to_owned();
    let thread_id_for_reopen = thread_id_entry.clone();
    let feedback_for_reopen_thread = feedback.clone();
    let toast_for_reopen_thread = toast_overlay.clone();
    reopen_thread_btn.connect_clicked(move |_| {
        let thread_id = thread_id_for_reopen.text().trim().to_owned();
        let result = if thread_id.is_empty() {
            Err(anyhow::anyhow!("review thread id is required"))
        } else {
            WorkspaceStore::open(db_for_reopen_thread.clone()).and_then(|store| {
                store.set_pull_request_review_thread_resolution(
                    &workspace_for_reopen_thread,
                    &thread_id,
                    false,
                )
            })
        };
        apply_action_feedback(
            &feedback_for_reopen_thread,
            &toast_for_reopen_thread,
            &pull_request_review_thread_action_feedback("Reopen", result),
            true,
        );
    });

    let db_for_merge = db_path.to_path_buf();
    let workspace_for_merge = name.to_owned();
    let refresh_after_merge = refresh_hub.clone();
    let merge_method_for_merge = merge_method.clone();
    let feedback_for_merge = feedback.clone();
    let toast_for_merge = toast_overlay.clone();
    merge_btn.connect_clicked(move |_| {
        let method = merge_method_for_merge
            .active_id()
            .map(|method| method.to_string())
            .unwrap_or_else(|| "squash".to_owned());
        let result = WorkspaceStore::open(db_for_merge.clone()).and_then(|store| {
            store.merge_and_maybe_archive_pull_request(&workspace_for_merge, Some(&method))
        });
        apply_action_feedback(
            &feedback_for_merge,
            &toast_for_merge,
            &pull_request_merge_and_archive_feedback(result),
            true,
        );
        refresh_after_merge.refresh(RefreshScope::All);
    });

    let db_for_archive = db_path.to_path_buf();
    let workspace_for_archive = name.to_owned();
    let refresh_after_archive = refresh_hub.clone();
    let feedback_for_archive = feedback.clone();
    let toast_for_archive = toast_overlay.clone();
    archive_after_merge_btn.connect_clicked(move |_| {
        let result = WorkspaceStore::open(db_for_archive.clone())
            .and_then(|store| store.archive(&workspace_for_archive, false));
        apply_action_feedback(
            &feedback_for_archive,
            &toast_for_archive,
            &pull_request_archive_feedback(result),
            true,
        );
        refresh_after_archive.refresh(RefreshScope::All);
    });

    let create_inputs_row = make_action_row();
    create_inputs_row.append(&title_entry);
    create_inputs_row.append(&body_entry);
    let create_controls_row = make_action_row();
    create_controls_row.append(&draft);
    create_controls_row.append(&create_btn);
    pr_form.append(&create_inputs_row);
    pr_form.append(&create_controls_row);
    panel.append(&pr_form);
    let inspect_refresh_row = make_action_row();
    inspect_refresh_row.append(&refresh_pr_btn);
    inspect_row.append(&inspect_refresh_row);

    let summary_group = make_action_stack();
    summary_group.append(&toolbar_label("PR summary"));
    let summary_row = make_action_row();
    summary_row.append(&view_summary_btn);
    summary_row.append(&stage_summary_btn);
    summary_group.append(&summary_row);

    let checks_group = make_action_stack();
    checks_group.append(&toolbar_label("Checks"));
    let checks_row = make_action_row();
    checks_row.append(&view_checks_btn);
    checks_row.append(&stage_checks_btn);
    checks_group.append(&checks_row);

    let comments_group = make_action_stack();
    comments_group.append(&toolbar_label("Review comments"));
    let comments_row = make_action_row();
    comments_row.append(&view_reviews_btn);
    comments_row.append(&stage_reviews_btn);
    comments_group.append(&comments_row);

    inspect_row.append(&summary_group);
    inspect_row.append(&checks_group);
    inspect_row.append(&comments_group);
    panel.append(&inspect_row);
    thread_row.append(&thread_id_entry);
    thread_row.append(&resolve_thread_btn);
    thread_row.append(&reopen_thread_btn);
    panel.append(&thread_row);
    merge_row.append(&merge_method);
    merge_row.append(&merge_btn);
    merge_row.append(&archive_after_merge_btn);
    panel.append(&merge_row);
    panel.append(&feedback);
    panel.append(&checks_output);
    panel.append(&workspace_conflict_resolution_panel(
        db_path,
        store,
        name,
        app_state,
        refresh_hub,
    ));
    panel
}

fn optional_entry_text(entry: &Entry) -> Option<String> {
    let value = entry.text().trim().to_owned();
    (!value.is_empty()).then_some(value)
}

fn workspace_conflict_resolution_panel(
    db_path: &Path,
    store: &WorkspaceStore,
    name: &str,
    app_state: AppState,
    refresh_hub: RefreshHub,
) -> GBox {
    let panel = GBox::new(Orientation::Vertical, 8);
    panel.add_css_class("command-panel");
    panel.append(&section_title("Conflict Resolution"));

    let summary = match store.checks_summary(name) {
        Ok(summary) => summary,
        Err(err) => {
            panel.append(&detail_row(
                "Conflict resolution",
                &format!("Could not load conflicts: {err:#}"),
            ));
            return panel;
        }
    };

    if summary.conflicting_workspaces.is_empty() {
        panel.append(&detail_row("Conflicts", "No sibling workspace conflicts."));
        return panel;
    }

    let diff_preview = TextView::new();
    diff_preview.set_editable(false);
    diff_preview.set_monospace(true);
    diff_preview.set_hexpand(true);
    diff_preview.set_vexpand(true);
    diff_preview
        .buffer()
        .set_text("Select a conflict file to preview its diff.");
    let conflict_feedback = Label::new(None);
    conflict_feedback.add_css_class("card-meta");
    conflict_feedback.set_xalign(0.0);
    conflict_feedback.set_wrap(true);
    conflict_feedback.set_text("No conflict action run yet.");
    let diff_container = ScrolledWindow::new();
    diff_container.set_policy(PolicyType::Automatic, PolicyType::Automatic);
    diff_container.set_min_content_height(180);
    diff_container.set_child(Some(&diff_preview));

    for (conflict_workspace, files) in summary.conflicting_workspaces {
        let workspace_group = GBox::new(Orientation::Vertical, 6);
        let title = Label::new(Some(&format!(
            "{} ({})",
            conflict_workspace,
            if files.len() == 1 {
                "1 file".to_owned()
            } else {
                format!("{} files", files.len())
            }
        )));
        title.set_xalign(0.0);
        title.add_css_class("detail-label");

        let open_workspace_btn = flat_button("Open workspace");
        let app_state_for_open = app_state.clone();
        let refresh_for_open = refresh_hub.clone();
        let conflict_workspace_for_open = conflict_workspace.clone();
        open_workspace_btn.connect_clicked(move |_| {
            app_state_for_open.set_selected_workspace(Some(conflict_workspace_for_open.clone()));
            refresh_for_open.refresh(RefreshScope::All);
        });

        let action_row = make_action_row();
        action_row.append(&title);
        action_row.append(&open_workspace_btn);
        let diff_all_btn = flat_button("View all diffs");
        let files_for_diff_all = files.clone();
        let source_workspace_for_diff_all = conflict_workspace.clone();
        let feedback_for_diff_all = conflict_feedback.clone();
        let diff_buffer_for_diff_all = diff_preview.buffer();
        let db_for_diff_all = db_path.to_path_buf();
        diff_all_btn.connect_clicked(move |_| {
            let mut sections = Vec::new();
            for file in &files_for_diff_all {
                let file_path = Path::new(file).to_path_buf();
                match WorkspaceStore::open(db_for_diff_all.clone()).and_then(|store| {
                    store.unified_diff(&source_workspace_for_diff_all, Some(file_path.as_path()))
                }) {
                    Ok(output) => {
                        sections.push(format!(
                            "# {}:{}\n{}\n",
                            source_workspace_for_diff_all,
                            file_path.display(),
                            output
                        ));
                    }
                    Err(err) => {
                        feedback_for_diff_all
                            .set_text(&format!("Could not read diff for {file}: {err:#}"));
                        return;
                    }
                }
            }
            if sections.is_empty() {
                diff_buffer_for_diff_all.set_text("No conflicting files to diff.");
            } else {
                diff_buffer_for_diff_all.set_text(&sections.join("\n"));
            }
        });
        let copy_all_btn = secondary_button("Copy all from sibling");
        let files_for_copy_all = files.clone();
        let source_workspace = conflict_workspace.clone();
        let destination_workspace = name.to_owned();
        let db_for_copy_all = db_path.to_path_buf();
        let feedback_for_copy_all = conflict_feedback.clone();
        let refresh_after_copy_all = refresh_hub.clone();
        copy_all_btn.connect_clicked(move |_| {
            let mut copied = 0usize;
            let mut failures = Vec::new();
            for file in &files_for_copy_all {
                let result = WorkspaceStore::open(db_for_copy_all.clone()).and_then(|store| {
                    store.copy_conflict_file_from_workspace(
                        &destination_workspace,
                        &source_workspace,
                        file,
                    )
                });
                match result {
                    Ok(()) => copied += 1,
                    Err(err) => failures.push(format!("{file}: {err:#}")),
                }
            }
            match (copied, failures.is_empty()) {
                (0, true) => {
                    feedback_for_copy_all.set_text(&format!(
                        "No files available to copy from {source_workspace}."
                    ));
                }
                (0, false) => {
                    feedback_for_copy_all.set_text(&format!(
                        "Failed to copy files from {source_workspace}: {}",
                        failures.join("; ")
                    ));
                }
                (_, true) => {
                    refresh_after_copy_all.refresh(RefreshScope::Workspace);
                    feedback_for_copy_all.set_text(&format!(
                        "Copied {} conflicting file(s) from {source_workspace}.",
                        copied
                    ));
                }
                (_, false) => {
                    refresh_after_copy_all.refresh(RefreshScope::Workspace);
                    feedback_for_copy_all.set_text(&format!(
                        "Copied {copied} file(s) from {source_workspace}, but {} failed: {}",
                        failures.len(),
                        failures.join("; ")
                    ));
                }
            }
        });

        action_row.append(&copy_all_btn);
        action_row.append(&diff_all_btn);
        workspace_group.append(&action_row);

        for file in files {
            let file_row = make_action_row();
            let file_label = Label::new(Some(&file));
            file_label.set_xalign(0.0);
            file_label.set_wrap(true);
            file_label.set_hexpand(true);

            let diff_btn = flat_button("View diff");
            let db_for_diff = db_path.to_path_buf();
            let source_workspace_for_diff = conflict_workspace.clone();
            let file_for_diff = Path::new(&file).to_path_buf();
            let diff_buffer = diff_preview.buffer();
            diff_btn.connect_clicked(move |_| {
                let output = WorkspaceStore::open(db_for_diff.clone())
                    .and_then(|store| {
                        store
                            .unified_diff(&source_workspace_for_diff, Some(file_for_diff.as_path()))
                    })
                    .unwrap_or_else(|err| {
                        format!(
                            "Could not read diff for {}: {err:#}",
                            file_for_diff.display()
                        )
                    });
                let formatted = format!(
                    "# {}:{}\n{}",
                    source_workspace_for_diff,
                    file_for_diff.display(),
                    output
                );
                diff_buffer.set_text(&formatted);
            });

            let copy_btn = secondary_button("Copy from sibling");
            let file_for_copy = file.clone();
            let db_for_copy = db_path.to_path_buf();
            let destination_workspace = name.to_owned();
            let source_workspace = conflict_workspace.clone();
            let feedback_for_copy = conflict_feedback.clone();
            let refresh_after_copy = refresh_hub.clone();
            copy_btn.connect_clicked(move |_| {
                let result = WorkspaceStore::open(db_for_copy.clone()).and_then(|store| {
                    store.copy_conflict_file_from_workspace(
                        &destination_workspace,
                        &source_workspace,
                        &file_for_copy,
                    )
                });
                match result {
                    Ok(()) => {
                        feedback_for_copy.set_text(&format!(
                            "Copied {file_for_copy} from {source_workspace} into {destination_workspace}"
                        ));
                        refresh_after_copy.refresh(RefreshScope::Workspace);
                    }
                    Err(err) => {
                        feedback_for_copy
                            .set_text(&format!("Could not copy {file_for_copy}: {err:#}"));
                    }
                }
            });

            file_row.append(&file_label);
            file_row.append(&diff_btn);
            file_row.append(&copy_btn);
            workspace_group.append(&file_row);
        }

        panel.append(&workspace_group);
    }

    panel.append(&conflict_feedback);
    panel.append(&diff_container);
    panel
}

fn pull_request_create_feedback(result: anyhow::Result<String>) -> String {
    match result {
        Ok(output) => output
            .lines()
            .rev()
            .map(str::trim)
            .find(|line| line.starts_with("https://"))
            .map(|url| format!("Created PR: {url}"))
            .unwrap_or_else(|| "Created PR.".to_owned()),
        Err(err) => format!("Create PR failed: {err:#}"),
    }
}

fn pull_request_merge_feedback(result: anyhow::Result<String>) -> String {
    match result {
        Ok(output) => output
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(|line| format!("Merged PR: {line}"))
            .unwrap_or_else(|| "Merged PR.".to_owned()),
        Err(err) => format!("Merge PR failed: {err:#}"),
    }
}

fn pull_request_merge_and_archive_feedback(
    result: anyhow::Result<linux_conductor_core::workspace::MergePullRequestResult>,
) -> String {
    match result {
        Ok(result) => {
            let mut text = pull_request_merge_feedback(Ok(result.merge_output));
            if let Some(workspace) = result.archived_workspace {
                text.push_str(&format!("; archived workspace {}.", workspace.name));
            }
            text
        }
        Err(err) => format!("Merge PR failed: {err:#}"),
    }
}

fn pull_request_refresh_feedback(result: anyhow::Result<Option<PullRequest>>) -> String {
    match result {
        Ok(Some(pr)) => format!("PR #{} state: {}", pr.number, pr.state),
        Ok(None) => "No PR recorded for this workspace.".to_owned(),
        Err(err) => format!("Refresh PR failed: {err:#}"),
    }
}

fn pull_request_checks_feedback(result: anyhow::Result<String>) -> String {
    match result {
        Ok(output) => {
            let output = output.trim();
            if output.is_empty() {
                "PR checks returned no output.".to_owned()
            } else {
                format!("PR checks:\n{output}")
            }
        }
        Err(err) => format!("View checks failed: {err:#}"),
    }
}

fn pull_request_review_feedback(result: anyhow::Result<String>) -> String {
    match result {
        Ok(output) => {
            let output = output.trim();
            if output.is_empty() {
                "PR comments/reviews returned no output.".to_owned()
            } else {
                format!("PR comments/reviews:\n{output}")
            }
        }
        Err(err) => format!("View PR comments/reviews failed: {err:#}"),
    }
}

fn pull_request_readiness_feedback(result: anyhow::Result<String>) -> String {
    match result {
        Ok(output) => {
            let output = output.trim();
            if output.is_empty() {
                "PR readiness summary returned no output.".to_owned()
            } else {
                output.to_owned()
            }
        }
        Err(err) => format!("View PR summary failed: {err:#}"),
    }
}

fn pull_request_review_thread_action_feedback(
    action: &str,
    result: anyhow::Result<PullRequestReviewThread>,
) -> String {
    match result {
        Ok(thread) => {
            let id = thread.id.as_deref().unwrap_or("unknown thread");
            let state = if thread.resolved {
                "resolved"
            } else {
                "unresolved"
            };
            let location = match (thread.path.as_deref(), thread.line) {
                (Some(path), Some(line)) => format!("{path}:{line}"),
                (Some(path), None) => path.to_owned(),
                (None, Some(line)) => format!("line {line}"),
                (None, None) => "unknown location".to_owned(),
            };
            format!("{action} review thread {id}: {state} at {location}.")
        }
        Err(err) => format!("{action} review thread failed: {err:#}"),
    }
}

fn pull_request_archive_feedback(result: anyhow::Result<Workspace>) -> String {
    match result {
        Ok(workspace) => format!("Archived workspace {}.", workspace.name),
        Err(err) => format!("Archive failed: {err:#}"),
    }
}

fn merge_blockers_text(
    open_todos: usize,
    open_review_comments: usize,
    conflicting_workspaces: usize,
) -> String {
    let mut blockers = Vec::new();
    if open_todos > 0 {
        blockers.push(pluralize(open_todos, "open todo"));
    }
    if open_review_comments > 0 {
        blockers.push(pluralize(open_review_comments, "open review comment"));
    }
    if conflicting_workspaces > 0 {
        blockers.push(pluralize(conflicting_workspaces, "conflicting workspace"));
    }
    if blockers.is_empty() {
        "Merge blockers: none".to_owned()
    } else {
        format!("Merge blockers: {}", blockers.join(", "))
    }
}

fn pluralize(count: usize, noun: &str) -> String {
    if count == 1 {
        format!("1 {noun}")
    } else {
        format!("{count} {noun}s")
    }
}

fn workspace_review_panel(
    db_path: &Path,
    store: &WorkspaceStore,
    name: &str,
    app_state: AppState,
    refresh_hub: RefreshHub,
    toast_overlay: ToastOverlay,
) -> GBox {
    let panel = GBox::new(Orientation::Vertical, 8);
    let form = make_action_row();
    let file_entry = Entry::new();
    file_entry.set_placeholder_text(Some("file path"));
    file_entry.set_hexpand(true);
    let line_entry = Entry::new();
    line_entry.set_placeholder_text(Some("line"));
    let body_entry = Entry::new();
    body_entry.set_placeholder_text(Some("comment"));
    body_entry.set_hexpand(true);
    let add_btn = Button::with_label("Add Comment");
    add_btn.add_css_class("suggested-action");
    let feedback = Label::new(None);
    feedback.add_css_class("card-meta");
    feedback.set_xalign(0.0);
    feedback.set_wrap(true);
    let db_for_add = db_path.to_path_buf();
    let workspace_for_add = name.to_owned();
    let refresh_after_add = refresh_hub.clone();
    let file_for_add = file_entry.clone();
    let line_for_add = line_entry.clone();
    let body_for_add = body_entry.clone();
    let feedback_for_add = feedback.clone();
    let toast_for_add = toast_overlay.clone();
    add_btn.connect_clicked(move |_| {
        let file = file_for_add.text().trim().to_owned();
        let body = body_for_add.text().trim().to_owned();
        if file.is_empty() || body.is_empty() {
            apply_action_feedback(
                &feedback_for_add,
                &toast_for_add,
                "File and comment are required.",
                true,
            );
            return;
        }
        let line = match parse_review_comment_line(line_for_add.text().as_ref()) {
            Ok(line) => line,
            Err(err) => {
                apply_action_feedback(&feedback_for_add, &toast_for_add, err, true);
                return;
            }
        };
        match WorkspaceStore::open(db_for_add.clone())
            .and_then(|store| store.add_review_comment(&workspace_for_add, &file, line, &body))
        {
            Ok(comment) => {
                apply_action_feedback(
                    &feedback_for_add,
                    &toast_for_add,
                    &format!("Added review comment #{}", comment.id),
                    true,
                );
                file_for_add.set_text("");
                line_for_add.set_text("");
                body_for_add.set_text("");
                refresh_after_add.refresh(RefreshScope::All);
            }
            Err(err) => apply_action_feedback(
                &feedback_for_add,
                &toast_for_add,
                &format!("Could not add comment: {err:#}"),
                true,
            ),
        }
    });
    form.append(&file_entry);
    form.append(&line_entry);
    form.append(&body_entry);
    form.append(&add_btn);
    panel.append(&form);

    let stage_btn = Button::with_label("Queue Open Comments");
    stage_btn.add_css_class("suggested-action");
    let stage_feedback = feedback.clone();
    let stage_toast = toast_overlay.clone();
    let db_for_stage = db_path.to_path_buf();
    let workspace_for_stage = name.to_owned();
    stage_btn.connect_clicked(move |_| {
        match WorkspaceStore::open(db_for_stage.clone()).and_then(|store| {
            let prompt = store.review_comments_agent_prompt(&workspace_for_stage)?;
            if prompt.contains("No open review comments.") {
                anyhow::bail!("No open review comments to stage");
            }
            Ok(prompt)
        }) {
            Ok(prompt) => {
                app_state.set_staged_review_prompt(Some(prompt));
                apply_action_feedback(
                    &stage_feedback,
                    &stage_toast,
                    "Staged open review comments for the selected agent session.",
                    true,
                );
            }
            Err(err) => apply_action_feedback(
                &stage_feedback,
                &stage_toast,
                &format!("Could not stage review prompt: {err:#}"),
                true,
            ),
        }
    });
    panel.append(&stage_btn);
    panel.append(&feedback);

    match store.list_review_comments(name) {
        Ok(comments) if comments.is_empty() => panel.append(&detail_row("Review", "No comments")),
        Ok(comments) => {
            for comment in comments {
                let row = make_action_row();
                let summary = Label::new(Some(&review_comment_row_summary(&comment)));
                summary.set_xalign(0.0);
                summary.set_wrap(true);
                summary.set_hexpand(true);
                row.append(&summary);
                if review_comment_can_resolve(&comment) {
                    let button = secondary_button("Resolve");
                    let db_for_resolve = db_path.to_path_buf();
                    let refresh_after_resolve = refresh_hub.clone();
                    let comment_id = comment.id;
                    let feedback_for_resolve = feedback.clone();
                    let toast_for_resolve = toast_overlay.clone();
                    button.connect_clicked(move |_| {
                        let result = WorkspaceStore::open(db_for_resolve.clone())
                            .and_then(|store| store.resolve_review_comment(comment_id));
                        let message = match result {
                            Ok(ref comment) => {
                                format!("Resolved review comment #{}", comment.id)
                            }
                            Err(ref err) => format!("Could not resolve comment: {err:#}"),
                        };
                        apply_action_feedback(
                            &feedback_for_resolve,
                            &toast_for_resolve,
                            &message,
                            true,
                        );
                        if result.is_ok() {
                            refresh_after_resolve.refresh(RefreshScope::All);
                        }
                    });
                    row.append(&button);
                }
                panel.append(&row);
            }
        }
        Err(err) => panel.append(&detail_row(
            "Review",
            &format!("Could not read review comments: {err:#}"),
        )),
    }
    panel
}

fn review_comment_row_summary(comment: &ReviewComment) -> String {
    let line = comment
        .line_number
        .map(|line| format!(":{line}"))
        .unwrap_or_default();
    format!(
        "#{} [{}] {}{} - {}",
        comment.id, comment.status, comment.file_path, line, comment.body
    )
}

fn review_comment_can_resolve(comment: &ReviewComment) -> bool {
    comment.status == "open"
}

fn parse_review_comment_line(value: &str) -> Result<Option<i64>, &'static str> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    let line = value
        .parse::<i64>()
        .map_err(|_| "line must be a positive number")?;
    if line <= 0 {
        return Err("line must be greater than zero");
    }
    Ok(Some(line))
}

fn workspace_todos_panel(store: &WorkspaceStore, name: &str) -> GBox {
    let panel = GBox::new(Orientation::Vertical, 8);
    match store.list_todos(name) {
        Ok(todos) if todos.is_empty() => panel.append(&detail_row("Todos", "No todos")),
        Ok(todos) => {
            for todo in todos {
                panel.append(&detail_row(
                    &format!("#{} {}", todo.id, todo.status),
                    &todo.text,
                ));
            }
        }
        Err(err) => panel.append(&detail_row(
            "Todos",
            &format!("Could not read todos: {err:#}"),
        )),
    }
    let entry_row = make_action_row();
    let entry = Entry::new();
    entry.set_placeholder_text(Some("Add todo..."));
    entry.set_hexpand(true);
    let add_btn = Button::with_label("Add Todo");
    add_btn.add_css_class("suggested-action");
    let db_path = linux_conductor_core::paths::AppPaths::from_env().database_path;
    let workspace = name.to_owned();
    let entry_clone = entry.clone();
    add_btn.connect_clicked(move |_| {
        let text = entry_clone.text().trim().to_owned();
        if text.is_empty() {
            return;
        }
        if let Ok(store) = WorkspaceStore::open(db_path.clone()) {
            let _ = store.add_todo(&workspace, &text);
            entry_clone.set_text("");
        }
    });
    entry_row.append(&entry);
    entry_row.append(&add_btn);
    panel.append(&entry_row);
    panel
}

fn workspace_processes_text(store: &WorkspaceStore, name: &str) -> String {
    let mut out = String::new();
    out.push_str("Setups\n");
    match store.list_setups(name) {
        Ok(records) if records.is_empty() => out.push_str("No setup runs recorded.\n"),
        Ok(records) => {
            for record in records {
                out.push_str(&format!(
                    "#{} {} pid={} exit={} started={} log={}\n",
                    record.id,
                    record.status.as_str(),
                    record.pid,
                    exit_code_label(record.exit_code),
                    record.started_at,
                    record.log_path.display()
                ));
            }
        }
        Err(err) => out.push_str(&format!("Could not read setup runs: {err:#}\n")),
    }
    out.push('\n');
    out.push_str("Runs\n");
    match store.list_runs(name) {
        Ok(records) if records.is_empty() => out.push_str("No runs recorded.\n"),
        Ok(records) => {
            for record in records {
                out.push_str(&format!(
                    "#{} {} pid={} exit={} started={} log={}\n",
                    record.id,
                    record.status.as_str(),
                    record.pid,
                    exit_code_label(record.exit_code),
                    record.started_at,
                    record.log_path.display()
                ));
            }
        }
        Err(err) => out.push_str(&format!("Could not read runs: {err:#}\n")),
    }
    out.push_str("\nSessions\n");
    match store.list_sessions(name) {
        Ok(records) if records.is_empty() => out.push_str("No sessions recorded.\n"),
        Ok(records) => {
            for record in records {
                out.push_str(&format!(
                    "#{} {} {} pid={} exit={} started={} log={}\n",
                    record.id,
                    record.command,
                    record.status.as_str(),
                    record.pid,
                    exit_code_label(record.exit_code),
                    record.started_at,
                    record.log_path.display()
                ));
            }
        }
        Err(err) => out.push_str(&format!("Could not read sessions: {err:#}\n")),
    }
    out.push_str("\nTerminals\n");
    match store.list_terminals(name) {
        Ok(records) if records.is_empty() => out.push_str("No terminal shells recorded.\n"),
        Ok(records) => {
            for record in records {
                out.push_str(&format!(
                    "#{} {} {} pid={} exit={} started={} log={}\n",
                    record.id,
                    record.command,
                    record.status.as_str(),
                    record.pid,
                    exit_code_label(record.exit_code),
                    record.started_at,
                    record.log_path.display()
                ));
            }
        }
        Err(err) => out.push_str(&format!("Could not read terminals: {err:#}\n")),
    }
    out
}

fn latest_setup_line(store: &WorkspaceStore, name: &str) -> String {
    match store.list_setups(name) {
        Ok(records) => records
            .into_iter()
            .next()
            .map(|record| {
                format!(
                    "{} pid={} exit={} log={}",
                    record.status.as_str(),
                    record.pid,
                    exit_code_label(record.exit_code),
                    record.log_path.display()
                )
            })
            .unwrap_or_else(|| "No setup runs recorded.".to_owned()),
        Err(err) => format!("Could not read setup runtime: {err:#}"),
    }
}

fn latest_runtime_line(store: &WorkspaceStore, name: &str) -> String {
    match store.list_runs(name) {
        Ok(records) => records
            .into_iter()
            .next()
            .map(|record| {
                format!(
                    "{} pid={} exit={} log={}",
                    record.status.as_str(),
                    record.pid,
                    exit_code_label(record.exit_code),
                    record.log_path.display()
                )
            })
            .unwrap_or_else(|| "No runs recorded.".to_owned()),
        Err(err) => format!("Could not read runtime: {err:#}"),
    }
}

fn spotlight_line(store: &WorkspaceStore, name: &str) -> String {
    match store.spotlight_status(name) {
        Ok(Some(session)) => {
            let root_status = match store.spotlight_root_conflict_paths(name) {
                Ok(paths) => spotlight_root_conflict_status(&paths),
                Err(err) => format!("root check failed: {err:#}"),
            };
            format!(
                "{} since {} patch={}\n{}",
                session.status,
                session.started_at,
                session.patch_path.display(),
                root_status
            )
        }
        Ok(None) => "Inactive".to_owned(),
        Err(err) => format!("Could not read Spotlight status: {err:#}"),
    }
}

fn spotlight_root_conflict_status(paths: &[String]) -> String {
    if paths.is_empty() {
        return "root clean".to_owned();
    }
    format!("root extra edits: {}", paths.join(", "))
}

fn latest_setup_log_line(store: &WorkspaceStore, name: &str) -> String {
    match store.read_latest_setup_log(name) {
        Ok(log) => tail_lines(&log, 12),
        Err(_) => "No setup log yet.".to_owned(),
    }
}

fn latest_run_log_line(store: &WorkspaceStore, name: &str) -> String {
    match store.read_latest_run_log(name) {
        Ok(log) => tail_lines(&log, 12),
        Err(_) => "No run log yet.".to_owned(),
    }
}

fn tail_lines(text: &str, max_lines: usize) -> String {
    let lines = text.lines().collect::<Vec<_>>();
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].join("\n")
}

fn exit_code_label(exit_code: Option<i32>) -> String {
    exit_code
        .map(|code| code.to_string())
        .unwrap_or_else(|| "-".to_owned())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RuntimeActionFeedback {
    status_text: String,
    toast_text: Option<String>,
}

fn runtime_action_failure_feedback(action: &str, err: &anyhow::Error) -> RuntimeActionFeedback {
    if is_spotlight_dirty_root_error(err) {
        let detail = spotlight_dirty_root_paths(err)
            .map(|paths| {
                let list = paths
                    .into_iter()
                    .map(|path| format!("\n- {path}"))
                    .collect::<String>();
                format!("\nConflicting root edits:{list}")
            })
            .unwrap_or_default();
        return RuntimeActionFeedback {
            status_text: format!(
                "{action} blocked: repository root has extra edits outside the active Spotlight patch.{detail}\nRepair Spotlight discards root-only edits and reapplies the active patch. Clean/save root changes manually if you need to keep them."
            ),
            toast_text: Some(
                "Spotlight root has extra edits. Use Repair Spotlight or clean/save root changes."
                    .to_owned(),
            ),
        };
    }
    let text = format!("{action} failed: {err:#}");
    RuntimeActionFeedback {
        status_text: text.clone(),
        toast_text: Some(text),
    }
}

fn is_spotlight_dirty_root_error(err: &anyhow::Error) -> bool {
    err.to_string()
        .contains("repository root has changes outside the active Spotlight patch")
}

fn spotlight_dirty_root_detail(err: &anyhow::Error) -> Option<String> {
    let message = err.to_string();
    let detail = message.split("changed root paths: ").nth(1)?;
    let detail = detail
        .split("; clean or save root changes")
        .next()
        .unwrap_or(detail)
        .trim();
    (!detail.is_empty()).then(|| detail.to_owned())
}

fn spotlight_dirty_root_paths(err: &anyhow::Error) -> Option<Vec<String>> {
    let detail = spotlight_dirty_root_detail(err)?;
    let paths = detail
        .split(',')
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    (!paths.is_empty()).then_some(paths)
}

fn lifecycle_action_failure_feedback(action: &str, err: &anyhow::Error) -> RuntimeActionFeedback {
    let text = format!("{action} failed: {err:#}");
    RuntimeActionFeedback {
        status_text: text.clone(),
        toast_text: Some(text),
    }
}

fn apply_runtime_action_feedback(
    status: &Label,
    toast_overlay: &ToastOverlay,
    feedback: RuntimeActionFeedback,
) {
    status.set_text(&feedback.status_text);
    if let Some(toast_text) = feedback.toast_text {
        toast_overlay.add_toast(Toast::new(&toast_text));
    }
}

fn apply_action_feedback(
    status: &Label,
    toast_overlay: &ToastOverlay,
    text: &str,
    show_toast: bool,
) {
    status.set_text(text);
    if show_toast {
        toast_overlay.add_toast(Toast::new(text));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_tab_stack_name_maps_palette_targets_to_tabs() {
        assert_eq!(
            workspace_tab_stack_name(&WorkspaceTab::Chats),
            "chat-terminal"
        );
        assert_eq!(workspace_tab_stack_name(&WorkspaceTab::Changes), "work");
        assert_eq!(workspace_tab_stack_name(&WorkspaceTab::Checks), "work");
        assert_eq!(
            workspace_tab_stack_name(&WorkspaceTab::Terminal),
            "terminal"
        );
        assert_eq!(workspace_tab_stack_name(&WorkspaceTab::Todos), "todos");
        assert_eq!(
            workspace_tab_stack_name(&WorkspaceTab::Checkpoints),
            "checkpoints"
        );
        assert_eq!(
            workspace_tab_stack_name(&WorkspaceTab::Processes),
            "processes"
        );
    }

    #[test]
    fn runtime_action_failure_feedback_includes_status_and_toast() {
        let feedback = runtime_action_failure_feedback("Setup", &anyhow::anyhow!("missing setup"));

        assert_eq!(feedback.status_text, "Setup failed: missing setup");
        assert_eq!(
            feedback.toast_text.as_deref(),
            Some("Setup failed: missing setup")
        );
    }

    #[test]
    fn spotlight_conflict_feedback_points_to_repair_action() {
        let feedback = runtime_action_failure_feedback(
            "Spotlight sync",
            &anyhow::anyhow!(
                "repository root has changes outside the active Spotlight patch; changed root paths: root-only.txt"
            ),
        );

        assert!(feedback.status_text.contains("Spotlight sync blocked"));
        assert!(feedback.status_text.contains("Repair Spotlight"));
        assert!(feedback.status_text.contains("root-only.txt"));
        assert_eq!(
            feedback.toast_text.as_deref(),
            Some(
                "Spotlight root has extra edits. Use Repair Spotlight or clean/save root changes."
            )
        );
    }

    #[test]
    fn spotlight_conflict_feedback_lists_paths_and_warns_repair_discards_root_edits() {
        let feedback = runtime_action_failure_feedback(
            "Spotlight stop",
            &anyhow::anyhow!(
                "repository root has changes outside the active Spotlight patch; changed root paths: root-only.txt, config/local.env; clean or save root changes before changing Spotlight state"
            ),
        );

        assert!(feedback.status_text.contains("Conflicting root edits:"));
        assert!(feedback.status_text.contains("- root-only.txt"));
        assert!(feedback.status_text.contains("- config/local.env"));
        assert!(feedback.status_text.contains("Repair Spotlight discards"));
    }

    #[test]
    fn spotlight_root_conflict_status_summarizes_clean_and_dirty_roots() {
        assert_eq!(spotlight_root_conflict_status(&[]), "root clean");
        assert_eq!(
            spotlight_root_conflict_status(&[
                "root-only.txt".to_owned(),
                "config/local.env".to_owned()
            ]),
            "root extra edits: root-only.txt, config/local.env"
        );
    }

    #[test]
    fn diff_file_summary_renders_review_scan_rows() {
        let summaries = vec![
            linux_conductor_core::workspace::DiffFileSummary {
                path: "README.md".to_owned(),
                additions: Some(2),
                deletions: Some(1),
            },
            linux_conductor_core::workspace::DiffFileSummary {
                path: "assets/logo.png".to_owned(),
                additions: None,
                deletions: None,
            },
        ];

        let rendered = format_diff_file_summary(&summaries);

        assert!(rendered.contains("Files changed"));
        assert!(rendered.contains("README.md +2 -1"));
        assert!(rendered.contains("assets/logo.png binary"));
    }

    #[test]
    fn review_comment_summary_marks_open_comments_resolvable() {
        let comment = linux_conductor_core::workspace::ReviewComment {
            id: 7,
            workspace_id: 1,
            file_path: "src/lib.rs".to_owned(),
            line_number: Some(42),
            body: "handle empty input".to_owned(),
            status: "open".to_owned(),
            github_thread_id: None,
            created_at: "2026-06-19T00:00:00Z".to_owned(),
            updated_at: "2026-06-19T00:00:00Z".to_owned(),
        };

        let summary = review_comment_row_summary(&comment);

        assert_eq!(summary, "#7 [open] src/lib.rs:42 - handle empty input");
        assert!(review_comment_can_resolve(&comment));
    }

    #[test]
    fn file_inline_comments_text_filters_to_selected_file() {
        let comments = vec![
            linux_conductor_core::workspace::ReviewComment {
                id: 7,
                workspace_id: 1,
                file_path: "src/lib.rs".to_owned(),
                line_number: Some(42),
                body: "handle empty input".to_owned(),
                status: "open".to_owned(),
                github_thread_id: None,
                created_at: "2026-06-19T00:00:00Z".to_owned(),
                updated_at: "2026-06-19T00:00:00Z".to_owned(),
            },
            linux_conductor_core::workspace::ReviewComment {
                id: 8,
                workspace_id: 1,
                file_path: "README.md".to_owned(),
                line_number: None,
                body: "clarify setup".to_owned(),
                status: "resolved".to_owned(),
                github_thread_id: None,
                created_at: "2026-06-19T00:00:00Z".to_owned(),
                updated_at: "2026-06-19T00:00:00Z".to_owned(),
            },
        ];

        let rendered = file_inline_comments_text(&comments, "src/lib.rs");

        assert!(rendered.contains("Inline comments for src/lib.rs"));
        assert!(rendered.contains("#7 [open] src/lib.rs:42 - handle empty input"));
        assert!(!rendered.contains("clarify setup"));
    }

    #[test]
    fn diff_tree_rows_insert_directory_headers_once() {
        let summaries = vec![
            linux_conductor_core::workspace::DiffFileSummary {
                path: "src/lib.rs".to_owned(),
                additions: Some(1),
                deletions: Some(0),
            },
            linux_conductor_core::workspace::DiffFileSummary {
                path: "src/ui/panel.rs".to_owned(),
                additions: Some(3),
                deletions: Some(1),
            },
        ];

        let rows = diff_tree_rows(&summaries);

        assert_eq!(
            rows,
            vec![
                DiffTreeRow::Directory("src/".to_owned()),
                DiffTreeRow::File(summaries[0].clone()),
                DiffTreeRow::Directory("  ui/".to_owned()),
                DiffTreeRow::File(summaries[1].clone()),
            ]
        );
        assert_eq!(
            diff_tree_file_label(&summaries[1]),
            "    src/ui/panel.rs +3 -1"
        );
    }

    #[test]
    fn review_comment_line_input_allows_blank_or_positive_numbers() {
        assert_eq!(parse_review_comment_line(""), Ok(None));
        assert_eq!(parse_review_comment_line(" 42 "), Ok(Some(42)));
        assert_eq!(
            parse_review_comment_line("zero").unwrap_err(),
            "line must be a positive number"
        );
        assert_eq!(
            parse_review_comment_line("0").unwrap_err(),
            "line must be greater than zero"
        );
    }

    #[test]
    fn pull_request_create_feedback_summarizes_output() {
        let success = pull_request_create_feedback(Ok(
            "Creating pull request\nhttps://github.com/example/demo/pull/42\n".to_owned(),
        ));
        assert_eq!(
            success,
            "Created PR: https://github.com/example/demo/pull/42"
        );

        let failure = pull_request_create_feedback(Err(anyhow::anyhow!(
            "workspace berlin has no changed files"
        )));
        assert_eq!(
            failure,
            "Create PR failed: workspace berlin has no changed files"
        );
    }

    #[test]
    fn pull_request_merge_feedback_summarizes_output() {
        let success = pull_request_merge_feedback(Ok(
            "Merged pull request #42\nDeleted branch lc/berlin\n".to_owned(),
        ));
        assert_eq!(success, "Merged PR: Merged pull request #42");

        let failure = pull_request_merge_feedback(Err(anyhow::anyhow!(
            "2 open todo(s) remain in workspace berlin"
        )));
        assert_eq!(
            failure,
            "Merge PR failed: 2 open todo(s) remain in workspace berlin"
        );
    }

    #[test]
    fn pull_request_merge_and_archive_feedback_reports_archive_state() {
        let success = pull_request_merge_and_archive_feedback(Ok(
            linux_conductor_core::workspace::MergePullRequestResult {
                merge_output: "Merged pull request #42\n".to_owned(),
                archived_workspace: Some(Workspace {
                    id: 1,
                    repository_id: 2,
                    name: "berlin".to_owned(),
                    path: std::path::PathBuf::from("/tmp/berlin"),
                    branch: "lc/berlin".to_owned(),
                    base_ref: "main".to_owned(),
                    port_base: 4200,
                    status: "archived".to_owned(),
                    archived_at: Some("now".to_owned()),
                    created_at: "then".to_owned(),
                    updated_at: "now".to_owned(),
                }),
            },
        ));
        assert_eq!(
            success,
            "Merged PR: Merged pull request #42; archived workspace berlin."
        );

        let no_archive = pull_request_merge_and_archive_feedback(Ok(
            linux_conductor_core::workspace::MergePullRequestResult {
                merge_output: "Merged pull request #42\n".to_owned(),
                archived_workspace: None,
            },
        ));
        assert_eq!(no_archive, "Merged PR: Merged pull request #42");
    }

    #[test]
    fn merge_blockers_text_lists_blocking_review_state() {
        let text = merge_blockers_text(2, 1, 1);

        assert_eq!(
            text,
            "Merge blockers: 2 open todos, 1 open review comment, 1 conflicting workspace"
        );
        assert_eq!(merge_blockers_text(0, 0, 0), "Merge blockers: none");
    }

    #[test]
    fn pull_request_refresh_feedback_summarizes_state() {
        let success =
            pull_request_refresh_feedback(Ok(Some(linux_conductor_core::workspace::PullRequest {
                id: 1,
                workspace_id: 2,
                provider: "github".to_owned(),
                number: 42,
                url: "https://github.com/example/demo/pull/42".to_owned(),
                state: "MERGED".to_owned(),
                created_at: "now".to_owned(),
                updated_at: "now".to_owned(),
            })));
        assert_eq!(success, "PR #42 state: MERGED");

        let missing = pull_request_refresh_feedback(Ok(None));
        assert_eq!(missing, "No PR recorded for this workspace.");

        let failure = pull_request_refresh_feedback(Err(anyhow::anyhow!("gh auth required")));
        assert_eq!(failure, "Refresh PR failed: gh auth required");
    }

    #[test]
    fn pull_request_checks_feedback_keeps_raw_check_output() {
        let success = pull_request_checks_feedback(Ok(
            "build\tpass\t1m\thttps://github.com/example/demo/actions/runs/1\n".to_owned(),
        ));
        assert_eq!(
            success,
            "PR checks:\nbuild\tpass\t1m\thttps://github.com/example/demo/actions/runs/1"
        );

        let empty = pull_request_checks_feedback(Ok(String::new()));
        assert_eq!(empty, "PR checks returned no output.");

        let failure = pull_request_checks_feedback(Err(anyhow::anyhow!("no pull requests found")));
        assert_eq!(failure, "View checks failed: no pull requests found");
    }

    #[test]
    fn pull_request_review_feedback_keeps_raw_review_output() {
        let success = pull_request_review_feedback(Ok(
            "Reviewers: changes requested\nalice: add a test\n".to_owned(),
        ));
        assert_eq!(
            success,
            "PR comments/reviews:\nReviewers: changes requested\nalice: add a test"
        );

        let empty = pull_request_review_feedback(Ok(String::new()));
        assert_eq!(empty, "PR comments/reviews returned no output.");

        let failure = pull_request_review_feedback(Err(anyhow::anyhow!("gh auth required")));
        assert_eq!(failure, "View PR comments/reviews failed: gh auth required");
    }

    #[test]
    fn pull_request_readiness_feedback_summarizes_structured_pr_state() {
        let success = pull_request_readiness_feedback(Ok(
            "PR readiness for workspace berlin.\nReview decision: CHANGES_REQUESTED\n".to_owned(),
        ));
        assert_eq!(
            success,
            "PR readiness for workspace berlin.\nReview decision: CHANGES_REQUESTED"
        );

        let empty = pull_request_readiness_feedback(Ok(String::new()));
        assert_eq!(empty, "PR readiness summary returned no output.");

        let failure = pull_request_readiness_feedback(Err(anyhow::anyhow!("gh auth required")));
        assert_eq!(failure, "View PR summary failed: gh auth required");
    }

    #[test]
    fn pull_request_review_thread_action_feedback_reports_state_and_id() {
        let success = pull_request_review_thread_action_feedback(
            "Resolve",
            Ok(linux_conductor_core::workspace::PullRequestReviewThread {
                id: Some("PRRT_fake".to_owned()),
                path: Some("src/lib.rs".to_owned()),
                line: Some(42),
                resolved: true,
                comments: Vec::new(),
            }),
        );
        assert_eq!(
            success,
            "Resolve review thread PRRT_fake: resolved at src/lib.rs:42."
        );

        let failure =
            pull_request_review_thread_action_feedback("Reopen", Err(anyhow::anyhow!("bad id")));
        assert_eq!(failure, "Reopen review thread failed: bad id");
    }

    #[test]
    fn pull_request_archive_feedback_summarizes_workspace_status() {
        let success = pull_request_archive_feedback(Ok(Workspace {
            id: 1,
            repository_id: 2,
            name: "berlin".to_owned(),
            path: std::path::PathBuf::from("/tmp/berlin"),
            branch: "lc/berlin".to_owned(),
            base_ref: "main".to_owned(),
            port_base: 4200,
            status: "archived".to_owned(),
            archived_at: Some("now".to_owned()),
            created_at: "then".to_owned(),
            updated_at: "now".to_owned(),
        }));
        assert_eq!(success, "Archived workspace berlin.");

        let failure = pull_request_archive_feedback(Err(anyhow::anyhow!("archive script failed")));
        assert_eq!(failure, "Archive failed: archive script failed");
    }

    #[test]
    fn lifecycle_action_failure_feedback_includes_status_and_toast() {
        let feedback = lifecycle_action_failure_feedback("Rename", &anyhow::anyhow!("bad name"));

        assert_eq!(feedback.status_text, "Rename failed: bad name");
        assert_eq!(
            feedback.toast_text.as_deref(),
            Some("Rename failed: bad name")
        );
    }
}

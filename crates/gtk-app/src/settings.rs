use gtk::prelude::*;
use gtk::{
    Box as GBox, Button, CheckButton, ComboBoxText, Entry, Label, Orientation, PolicyType,
    ScrolledWindow, Stack, StackSwitcher, TextView,
};
use linux_conductor_core::paths::AppPaths;
use linux_conductor_core::repository::RepositoryStore;
use linux_conductor_core::settings::{
    customization_settings_from_toml, customization_settings_to_toml, inspect_repository_settings,
    load_repository_settings, save_repository_settings, FilePatternSource, GitSettings,
    PromptSettings, ProviderSettings, RepositorySettings, ScriptSettings, SettingsLayer,
};
use std::path::PathBuf;

pub(crate) fn build_settings_page(paths: &AppPaths) -> (GBox, impl Fn() + Clone + 'static) {
    let root = GBox::new(Orientation::Vertical, 0);
    root.add_css_class("dashboard");
    root.add_css_class("page-shell");
    let header = GBox::new(Orientation::Vertical, 8);
    header.add_css_class("dashboard-header");
    header.add_css_class("page-header");
    let title = Label::new(Some("Settings"));
    title.add_css_class("dashboard-title");
    title.set_xalign(0.0);
    let subtitle = Label::new(Some(
        "Repository settings belong here, not buried in Projects.",
    ));
    subtitle.add_css_class("card-meta");
    subtitle.set_xalign(0.0);
    header.append(&title);
    header.append(&subtitle);
    root.append(&header);

    let scroll = ScrolledWindow::new();
    scroll.set_policy(PolicyType::Never, PolicyType::Automatic);
    scroll.set_vexpand(true);
    let body = GBox::new(Orientation::Vertical, 14);
    body.add_css_class("detail-body");
    body.add_css_class("page-body");
    scroll.set_child(Some(&body));
    root.append(&scroll);

    let settings_grid = GBox::new(Orientation::Vertical, 10);
    settings_grid.add_css_class("settings-panel");
    body.append(&settings_grid);

    let settings_top = GBox::new(Orientation::Horizontal, 8);
    let settings_repo_entry = Entry::new();
    settings_repo_entry.set_placeholder_text(Some("repository name"));
    let layer_select = ComboBoxText::new();
    layer_select.append(Some("shared"), "Shared");
    layer_select.append(Some("local"), "Local");
    layer_select.set_active_id(Some("shared"));
    let load_settings_btn = Button::with_label("Load Settings");
    let save_settings_btn = Button::with_label("Save Settings");
    settings_top.append(&settings_repo_entry);
    settings_top.append(&layer_select);
    settings_top.append(&load_settings_btn);
    settings_top.append(&save_settings_btn);
    settings_grid.append(&settings_top);

    let settings_result = Label::new(Some(
        "Shared settings are commit-safe. Use Local for machine secrets and overrides.",
    ));
    settings_result.add_css_class("card-meta");
    settings_result.set_xalign(0.0);
    settings_result.set_wrap(true);
    settings_grid.append(&settings_result);

    let tab_switcher = StackSwitcher::new();
    tab_switcher.add_css_class("settings-tab-strip");
    tab_switcher.set_halign(gtk::Align::Start);
    settings_grid.append(&tab_switcher);

    let tab_stack = Stack::new();
    tab_stack.add_css_class("settings-tab-stack");
    settings_grid.append(&tab_stack);
    tab_switcher.set_stack(Some(&tab_stack));

    let general_panel = settings_tab_panel();
    let prompts_panel = settings_tab_panel();
    let providers_panel = settings_tab_panel();
    let git_panel = settings_tab_panel();
    let advanced_panel = settings_tab_panel();
    tab_stack.add_titled(&general_panel, Some("general"), "General");
    tab_stack.add_titled(&prompts_panel, Some("prompts"), "Prompts");
    tab_stack.add_titled(&providers_panel, Some("providers"), "Providers");
    tab_stack.add_titled(&git_panel, Some("git"), "Git & Workspaces");
    tab_stack.add_titled(&advanced_panel, Some("advanced"), "Advanced");

    let scripts_section = Label::new(Some("Scripts"));
    scripts_section.add_css_class("section-title");
    scripts_section.set_xalign(0.0);
    general_panel.append(&scripts_section);

    let scripts_row = GBox::new(Orientation::Horizontal, 8);
    let setup_entry = Entry::new();
    setup_entry.set_placeholder_text(Some("setup script"));
    let run_entry = Entry::new();
    run_entry.set_placeholder_text(Some("run script"));
    let archive_entry = Entry::new();
    archive_entry.set_placeholder_text(Some("archive script"));
    let run_mode_entry = Entry::new();
    run_mode_entry.set_placeholder_text(Some("run mode: concurrent/nonconcurrent"));
    scripts_row.append(&setup_entry);
    scripts_row.append(&run_entry);
    scripts_row.append(&archive_entry);
    scripts_row.append(&run_mode_entry);
    general_panel.append(&scripts_row);

    let booleans_row = GBox::new(Orientation::Horizontal, 10);
    let spotlight_check = CheckButton::with_label("Spotlight testing");
    let privacy_check = CheckButton::with_label("Enterprise data privacy");
    let archive_on_merge_check = CheckButton::with_label("Archive on merge");
    let delete_branch_check = CheckButton::with_label("Delete branch on archive");
    let auto_upstream_check = CheckButton::with_label("Auto setup upstream");
    booleans_row.append(&spotlight_check);
    booleans_row.append(&privacy_check);
    booleans_row.append(&archive_on_merge_check);
    booleans_row.append(&delete_branch_check);
    booleans_row.append(&auto_upstream_check);
    general_panel.append(&booleans_row);

    let provider_row = GBox::new(Orientation::Horizontal, 8);
    let claude_path_entry = Entry::new();
    claude_path_entry.set_placeholder_text(Some("Claude executable"));
    let codex_path_entry = Entry::new();
    codex_path_entry.set_placeholder_text(Some("Codex executable"));
    let claude_provider_entry = Entry::new();
    claude_provider_entry.set_placeholder_text(Some("Claude provider"));
    let codex_provider_entry = Entry::new();
    codex_provider_entry.set_placeholder_text(Some("Codex provider"));
    provider_row.append(&claude_path_entry);
    provider_row.append(&codex_path_entry);
    provider_row.append(&claude_provider_entry);
    provider_row.append(&codex_provider_entry);
    providers_panel.append(&provider_row);

    let git_row = GBox::new(Orientation::Horizontal, 8);
    let branch_prefix_type_entry = Entry::new();
    branch_prefix_type_entry.set_placeholder_text(Some("branch prefix type"));
    let branch_prefix_entry = Entry::new();
    branch_prefix_entry.set_placeholder_text(Some("branch prefix"));
    let bedrock_region_entry = Entry::new();
    bedrock_region_entry.set_placeholder_text(Some("Bedrock region"));
    let vertex_project_entry = Entry::new();
    vertex_project_entry.set_placeholder_text(Some("Vertex project id"));
    git_row.append(&branch_prefix_type_entry);
    git_row.append(&branch_prefix_entry);
    git_row.append(&bedrock_region_entry);
    git_row.append(&vertex_project_entry);
    git_panel.append(&git_row);

    let files_label = Label::new(Some("Files to copy"));
    files_label.add_css_class("detail-label");
    files_label.set_xalign(0.0);
    git_panel.append(&files_label);
    let file_globs_view = settings_text_view(72);
    git_panel.append(&file_globs_view.0);

    let env_label = Label::new(Some("Environment variables (KEY=value)"));
    env_label.add_css_class("detail-label");
    env_label.set_xalign(0.0);
    general_panel.append(&env_label);
    let env_view = settings_text_view(72);
    general_panel.append(&env_view.0);

    let prompts_section = Label::new(Some("Prompts"));
    prompts_section.add_css_class("section-title");
    prompts_section.set_xalign(0.0);
    prompts_panel.append(&prompts_section);

    let prompt_specs = [
        ("General agent instructions", 84),
        ("Code review", 84),
        ("Create PR", 84),
        ("Fix errors / failing checks", 84),
        ("Resolve merge conflicts", 84),
        ("Rename branch", 84),
        ("Commit message generation", 84),
        ("Test fixing", 84),
        ("Refactor style", 84),
    ];
    let mut prompt_views = Vec::new();
    for (label, height) in prompt_specs {
        let title = Label::new(Some(label));
        title.add_css_class("detail-label");
        title.set_xalign(0.0);
        prompts_panel.append(&title);
        let view = settings_text_view(height);
        prompts_panel.append(&view.0);
        prompt_views.push(view);
    }

    let advanced_label = Label::new(Some(
        "Advanced customization TOML: naming, automation, agent profiles, merge rules, workspace defaults, and view settings",
    ));
    advanced_label.add_css_class("detail-label");
    advanced_label.set_xalign(0.0);
    advanced_label.set_wrap(true);
    advanced_panel.append(&advanced_label);
    let customization_view = settings_text_view(180);
    advanced_panel.append(&customization_view.0);

    let db_path_load_settings = paths.database_path.clone();
    let settings_repo_entry_load = settings_repo_entry.clone();
    let settings_result_load = settings_result.clone();
    let setup_entry_load = setup_entry.clone();
    let run_entry_load = run_entry.clone();
    let archive_entry_load = archive_entry.clone();
    let run_mode_entry_load = run_mode_entry.clone();
    let spotlight_check_load = spotlight_check.clone();
    let privacy_check_load = privacy_check.clone();
    let archive_on_merge_check_load = archive_on_merge_check.clone();
    let delete_branch_check_load = delete_branch_check.clone();
    let auto_upstream_check_load = auto_upstream_check.clone();
    let claude_path_entry_load = claude_path_entry.clone();
    let codex_path_entry_load = codex_path_entry.clone();
    let claude_provider_entry_load = claude_provider_entry.clone();
    let codex_provider_entry_load = codex_provider_entry.clone();
    let bedrock_region_entry_load = bedrock_region_entry.clone();
    let vertex_project_entry_load = vertex_project_entry.clone();
    let branch_prefix_type_entry_load = branch_prefix_type_entry.clone();
    let branch_prefix_entry_load = branch_prefix_entry.clone();
    let file_globs_buffer_load = file_globs_view.1.clone();
    let file_globs_text_load = file_globs_view.2.clone();
    let env_buffer_load = env_view.1.clone();
    let customization_buffer_load = customization_view.1.clone();
    let prompt_buffers_load = prompt_views
        .iter()
        .map(|(_, buffer, _)| buffer.clone())
        .collect::<Vec<_>>();
    load_settings_btn.connect_clicked(move |_| {
        let repo_name = settings_repo_entry_load.text().trim().to_owned();
        if repo_name.is_empty() {
            settings_result_load.set_text("Repository name is required.");
            return;
        }
        match repository_root(&db_path_load_settings, &repo_name)
            .and_then(|repo_path| load_repository_settings(&repo_path).map(|settings| (repo_path, settings)))
            .and_then(|(repo_path, settings)| {
                inspect_repository_settings(&repo_path).map(|inspection| (repo_path, settings, inspection))
            }) {
            Ok((repo_path, settings, inspection)) => {
                setup_entry_load.set_text(settings.scripts.setup.as_deref().unwrap_or(""));
                run_entry_load.set_text(settings.scripts.run.as_deref().unwrap_or(""));
                archive_entry_load.set_text(settings.scripts.archive.as_deref().unwrap_or(""));
                run_mode_entry_load.set_text(settings.scripts.run_mode.as_deref().unwrap_or("concurrent"));
                spotlight_check_load.set_active(settings.spotlight_testing.unwrap_or(false));
                privacy_check_load.set_active(settings.enterprise_data_privacy.unwrap_or(false));
                archive_on_merge_check_load.set_active(settings.git.archive_on_merge.unwrap_or(false));
                delete_branch_check_load.set_active(settings.git.delete_branch_on_archive.unwrap_or(false));
                auto_upstream_check_load.set_active(settings.git.worktree_push_auto_setup_remote.unwrap_or(false));
                claude_path_entry_load.set_text(settings.providers.claude_code_executable_path.as_deref().unwrap_or(""));
                codex_path_entry_load.set_text(settings.providers.codex_executable_path.as_deref().unwrap_or(""));
                claude_provider_entry_load.set_text(settings.providers.claude_provider.as_deref().unwrap_or(""));
                codex_provider_entry_load.set_text(settings.providers.codex_provider.as_deref().unwrap_or(""));
                bedrock_region_entry_load.set_text(settings.providers.bedrock_region.as_deref().unwrap_or(""));
                vertex_project_entry_load.set_text(settings.providers.vertex_project_id.as_deref().unwrap_or(""));
                branch_prefix_type_entry_load.set_text(settings.git.branch_prefix_type.as_deref().unwrap_or(""));
                branch_prefix_entry_load.set_text(settings.git.branch_prefix.as_deref().unwrap_or(""));
                if inspection.worktreeinclude_exists {
                    file_globs_text_load.set_editable(false);
                    file_globs_buffer_load.set_text(&inspection.active_file_patterns.join("\n"));
                } else {
                    file_globs_text_load.set_editable(true);
                    file_globs_buffer_load.set_text(&settings.file_include_globs.join("\n"));
                }
                env_buffer_load.set_text(&settings.environment_variables.iter().map(|(key, value)| format!("{key}={value}")).collect::<Vec<_>>().join("\n"));
                let prompts = settings.prompts.unwrap_or_default();
                let prompt_values = [
                    prompts.general,
                    prompts.code_review,
                    prompts.create_pr,
                    prompts.fix_errors,
                    prompts.resolve_merge_conflicts,
                    prompts.rename_branch,
                    prompts.commit_generation,
                    prompts.test_fixing,
                    prompts.refactor_style,
                ];
                for (buffer, value) in prompt_buffers_load.iter().zip(prompt_values.iter()) {
                    buffer.set_text(value.as_deref().unwrap_or(""));
                }
                customization_buffer_load.set_text(
                    &customization_settings_to_toml(&settings.customization).unwrap_or_default(),
                );
                let source = match inspection.active_file_patterns_source {
                    FilePatternSource::Worktreeinclude => ".worktreeinclude wins; Files to copy is read-only preview for new workspace copying.",
                    FilePatternSource::RepositorySettings => "repository settings provide Files to copy patterns.",
                    FilePatternSource::BuiltInDefault => "built-in default .env* pattern applies until settings are saved.",
                };
                settings_result_load.set_text(&format!(
                    "Loaded {}. Shared={} Local={} Worktreeinclude={} Active files: {} ({})",
                    repo_path.display(),
                    inspection.shared_settings_exists,
                    inspection.local_settings_exists,
                    inspection.worktreeinclude_exists,
                    inspection.active_file_patterns.join(", "),
                    source
                ));
            }
            Err(err) => settings_result_load.set_text(&format!("Load failed: {err:#}")),
        }
    });

    let db_path_save_settings = paths.database_path.clone();
    save_settings_btn.connect_clicked(move |_| {
        let repo_name = settings_repo_entry.text().trim().to_owned();
        if repo_name.is_empty() {
            settings_result.set_text("Repository name is required.");
            return;
        }
        let layer = match layer_select.active_id().as_deref() {
            Some("local") => SettingsLayer::LocalOverride,
            _ => SettingsLayer::RepositoryShared,
        };
        let repo_path = match repository_root(&db_path_save_settings, &repo_name) {
            Ok(path) => path,
            Err(err) => {
                settings_result.set_text(&format!("Save failed: {err:#}"));
                return;
            }
        };
        let current_file_globs = load_repository_settings(&repo_path)
            .map(|settings| settings.file_include_globs)
            .unwrap_or_default();
        let customization =
            match customization_settings_from_toml(&text_buffer_text(&customization_view.1)) {
                Ok(customization) => customization,
                Err(err) => {
                    settings_result
                        .set_text(&format!("Save failed: customization TOML invalid: {err:#}"));
                    return;
                }
            };
        let settings = RepositorySettings {
            file_include_globs: if file_globs_view.2.is_editable() {
                text_buffer_text(&file_globs_view.1)
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .map(str::to_owned)
                    .collect()
            } else {
                current_file_globs
            },
            spotlight_testing: Some(spotlight_check.is_active()),
            enterprise_data_privacy: Some(privacy_check.is_active()),
            scripts: ScriptSettings {
                setup: optional_entry_text(&setup_entry),
                run: optional_entry_text(&run_entry),
                archive: optional_entry_text(&archive_entry),
                run_mode: optional_entry_text(&run_mode_entry)
                    .or_else(|| Some("concurrent".to_owned())),
            },
            environment_variables: parse_environment_lines(&text_buffer_text(&env_view.1)),
            prompts: Some(PromptSettings {
                general: optional_buffer_text(&prompt_views[0].1),
                code_review: optional_buffer_text(&prompt_views[1].1),
                create_pr: optional_buffer_text(&prompt_views[2].1),
                fix_errors: optional_buffer_text(&prompt_views[3].1),
                resolve_merge_conflicts: optional_buffer_text(&prompt_views[4].1),
                rename_branch: optional_buffer_text(&prompt_views[5].1),
                commit_generation: optional_buffer_text(&prompt_views[6].1),
                test_fixing: optional_buffer_text(&prompt_views[7].1),
                refactor_style: optional_buffer_text(&prompt_views[8].1),
            }),
            providers: ProviderSettings {
                claude_code_executable_path: optional_entry_text(&claude_path_entry),
                codex_executable_path: optional_entry_text(&codex_path_entry),
                claude_provider: optional_entry_text(&claude_provider_entry),
                codex_provider: optional_entry_text(&codex_provider_entry),
                bedrock_region: optional_entry_text(&bedrock_region_entry),
                vertex_project_id: optional_entry_text(&vertex_project_entry),
                ssh_key_path: None,
            },
            git: GitSettings {
                delete_branch_on_archive: Some(delete_branch_check.is_active()),
                archive_on_merge: Some(archive_on_merge_check.is_active()),
                worktree_push_auto_setup_remote: Some(auto_upstream_check.is_active()),
                branch_prefix_type: optional_entry_text(&branch_prefix_type_entry),
                branch_prefix: optional_entry_text(&branch_prefix_entry),
            },
            customization,
        };
        match save_repository_settings(&repo_path, layer, &settings) {
            Ok(()) => {
                settings_result.set_text(&format!("Saved settings for {}", repo_path.display()))
            }
            Err(err) => settings_result.set_text(&format!("Save failed: {err:#}")),
        }
    });

    (root, || {})
}

fn repository_root(db_path: &PathBuf, name: &str) -> anyhow::Result<PathBuf> {
    RepositoryStore::open(db_path)?
        .list()?
        .into_iter()
        .find(|repo| repo.name == name)
        .map(|repo| repo.root_path)
        .ok_or_else(|| anyhow::anyhow!("repository {name} not found"))
}

fn settings_text_view(height: i32) -> (ScrolledWindow, gtk::TextBuffer, TextView) {
    let view = TextView::new();
    view.set_monospace(true);
    view.set_wrap_mode(gtk::WrapMode::WordChar);
    view.set_size_request(-1, height);
    let buffer = view.buffer();
    let scroll = ScrolledWindow::new();
    scroll.set_policy(PolicyType::Automatic, PolicyType::Automatic);
    scroll.set_child(Some(&view));
    (scroll, buffer, view)
}

fn settings_tab_panel() -> GBox {
    let panel = GBox::new(Orientation::Vertical, 10);
    panel.add_css_class("settings-tab-panel");
    panel
}

fn optional_entry_text(entry: &Entry) -> Option<String> {
    let value = entry.text().trim().to_owned();
    (!value.is_empty()).then_some(value)
}

fn optional_buffer_text(buffer: &gtk::TextBuffer) -> Option<String> {
    let value = text_buffer_text(buffer);
    (!value.is_empty()).then_some(value)
}

fn text_buffer_text(buffer: &gtk::TextBuffer) -> String {
    buffer
        .text(&buffer.start_iter(), &buffer.end_iter(), true)
        .trim()
        .to_owned()
}

fn parse_environment_lines(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| {
            let (key, value) = line.split_once('=')?;
            let key = key.trim();
            (!key.is_empty()).then(|| (key.to_owned(), value.trim().to_owned()))
        })
        .collect()
}

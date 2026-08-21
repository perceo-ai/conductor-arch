//! Make every agent on this machine agree about skills and MCP servers.
//!
//! The model is a **union**: whatever any provider has, every selected
//! provider should have. There is no designated source of truth, because in
//! practice people install a skill wherever they happen to be and then want it
//! everywhere.
//!
//! Two rules make this safe to run repeatedly:
//!
//! 1. **Add and overwrite only.** Nothing is ever deleted. A provider that has
//!    something the others lack keeps it, and contributes it to the union.
//! 2. **Back up before overwriting.** Any file we replace is copied to
//!    `<name>.archductor-backup` first.
//!
//! Planning and applying are separate so the UI can show exactly what will be
//! written before anything is.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::skills::{list_skills, skill_roots};

/// One thing that will be written, described well enough to preview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncAction {
    /// `skill` or `mcp`.
    pub kind: String,
    /// Skill name or MCP server name.
    pub item: String,
    /// Provider key receiving it.
    pub provider: String,
    /// Absolute path that will be created or modified.
    pub target: String,
    /// True when the target already exists and will be backed up first.
    pub overwrite: bool,
}

/// Everything that could be synced, plus what is already in place.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncPlan {
    /// Provider keys that can receive writes, sorted.
    pub providers: Vec<String>,
    /// Providers with a skills directory. Cursor has MCP config but no skill
    /// root, so a UI that assumes one list would promise writes we never make.
    #[serde(default)]
    pub skill_providers: Vec<String>,
    /// Providers with an MCP config.
    #[serde(default)]
    pub mcp_providers: Vec<String>,
    /// Skill name -> providers that already have it.
    pub skills: BTreeMap<String, Vec<String>>,
    /// MCP server name -> providers that already have it.
    pub mcp_servers: BTreeMap<String, Vec<String>>,
    /// The writes needed to bring every provider up to the union.
    pub actions: Vec<SyncAction>,
}

/// What the caller wants synced. Empty vectors mean "everything in the plan",
/// which is what the one-click path sends.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncSelection {
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub mcp_servers: Vec<String>,
    #[serde(default)]
    pub providers: Vec<String>,
}

impl SyncSelection {
    fn wants_skill(&self, name: &str) -> bool {
        self.skills.is_empty() || self.skills.iter().any(|s| s == name)
    }
    fn wants_mcp(&self, name: &str) -> bool {
        self.mcp_servers.is_empty() || self.mcp_servers.iter().any(|s| s == name)
    }
    fn wants_provider(&self, key: &str) -> bool {
        self.providers.is_empty() || self.providers.iter().any(|s| s == key)
    }
}

/// Where a provider keeps its user-level MCP config, and in which format.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpConfigTarget {
    pub provider_key: String,
    pub path: PathBuf,
    /// `json` (Claude, Cursor) or `toml` (Codex).
    pub format: &'static str,
}

pub fn mcp_targets(home: &Path) -> Vec<McpConfigTarget> {
    vec![
        McpConfigTarget {
            provider_key: "claude".to_owned(),
            path: home.join(".claude.json"),
            format: "json",
        },
        McpConfigTarget {
            provider_key: "codex".to_owned(),
            path: home.join(".codex/config.toml"),
            format: "toml",
        },
        McpConfigTarget {
            provider_key: "cursor".to_owned(),
            path: home.join(".cursor/mcp.json"),
            format: "json",
        },
    ]
}

/// Server name -> its definition, as raw JSON, for one provider.
fn read_json_mcp(path: &Path) -> BTreeMap<String, serde_json::Value> {
    let Ok(contents) = fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return BTreeMap::new();
    };
    value
        .get("mcpServers")
        .and_then(|servers| servers.as_object())
        .map(|servers| {
            servers
                .iter()
                .map(|(name, def)| (name.clone(), def.clone()))
                .collect()
        })
        .unwrap_or_default()
}

fn read_toml_mcp(path: &Path) -> BTreeMap<String, toml::Value> {
    let Ok(contents) = fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    // `str::parse::<toml::Value>()` parses a bare value in this crate version;
    // a config file is a document.
    let Ok(value) = toml::from_str::<toml::Value>(&contents) else {
        return BTreeMap::new();
    };
    value
        .get("mcp_servers")
        .and_then(|servers| servers.as_table())
        .map(|servers| {
            servers
                .iter()
                .map(|(name, def)| (name.clone(), def.clone()))
                .collect()
        })
        .unwrap_or_default()
}

/// Convert a server definition between the two config dialects. Both carry the
/// same shape (`command`, `args`, `env`), so this is a representation change
/// rather than a translation.
fn json_to_toml(value: &serde_json::Value) -> Option<toml::Value> {
    toml::Value::try_from(value).ok()
}

fn toml_to_json(value: &toml::Value) -> Option<serde_json::Value> {
    serde_json::to_value(value).ok()
}

/// Build the union and the writes needed to reach it.
pub fn plan_sync(home: &Path, selection: &SyncSelection) -> Result<SyncPlan> {
    let mut plan = SyncPlan::default();

    let roots = skill_roots(home);
    plan.providers = roots.iter().map(|r| r.provider_key.clone()).collect();
    for target in mcp_targets(home) {
        if !plan.providers.contains(&target.provider_key) {
            plan.providers.push(target.provider_key.clone());
        }
    }
    plan.providers.sort();
    plan.skill_providers = roots.iter().map(|r| r.provider_key.clone()).collect();
    plan.skill_providers.sort();
    plan.mcp_providers = mcp_targets(home)
        .into_iter()
        .map(|t| t.provider_key)
        .collect();
    plan.mcp_providers.sort();

    // --- skills -----------------------------------------------------------
    // Plugin skills are owned by their plugin; copying them into another
    // provider's user dir would fork a managed thing.
    for skill in list_skills(home)?.into_iter().filter(|s| !s.plugin) {
        plan.skills
            .insert(skill.name.clone(), skill.providers.clone());
        if !selection.wants_skill(&skill.name) {
            continue;
        }
        for root in &roots {
            if skill.providers.contains(&root.provider_key) {
                continue;
            }
            if !selection.wants_provider(&root.provider_key) {
                continue;
            }
            plan.actions.push(SyncAction {
                kind: "skill".to_owned(),
                item: skill.name.clone(),
                provider: root.provider_key.clone(),
                target: root.path.join(&skill.name).display().to_string(),
                overwrite: root.path.join(&skill.name).exists(),
            });
        }
    }

    // --- mcp servers ------------------------------------------------------
    let targets = mcp_targets(home);
    let mut union_json: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    let mut present: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();

    for target in &targets {
        let servers: BTreeMap<String, serde_json::Value> = match target.format {
            "toml" => read_toml_mcp(&target.path)
                .iter()
                .filter_map(|(name, def)| Some((name.clone(), toml_to_json(def)?)))
                .collect(),
            _ => read_json_mcp(&target.path),
        };
        for (name, def) in servers {
            present
                .entry(name.clone())
                .or_default()
                .insert(target.provider_key.clone());
            union_json.entry(name).or_insert(def);
        }
    }

    for (name, providers) in &present {
        plan.mcp_servers
            .insert(name.clone(), providers.iter().cloned().collect());
    }

    for (name, _) in union_json.iter() {
        if !selection.wants_mcp(name) {
            continue;
        }
        for target in &targets {
            if present
                .get(name)
                .is_some_and(|set| set.contains(&target.provider_key))
            {
                continue;
            }
            if !selection.wants_provider(&target.provider_key) {
                continue;
            }
            plan.actions.push(SyncAction {
                kind: "mcp".to_owned(),
                item: name.clone(),
                provider: target.provider_key.clone(),
                target: target.path.display().to_string(),
                overwrite: target.path.exists(),
            });
        }
    }

    plan.actions
        .sort_by(|a, b| (&a.kind, &a.item, &a.provider).cmp(&(&b.kind, &b.item, &b.provider)));
    Ok(plan)
}

fn backup_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".archductor-backup");
    path.with_file_name(name)
}

fn backup_if_present(path: &Path) -> Result<()> {
    if path.is_file() {
        fs::copy(path, backup_path(path)).with_context(|| format!("back up {}", path.display()))?;
    }
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Find the directory a skill currently lives in, to copy from.
fn source_skill_dir(home: &Path, name: &str) -> Option<PathBuf> {
    skill_roots(home)
        .into_iter()
        .map(|root| root.path.join(name))
        .find(|path| path.join("SKILL.md").is_file())
}

/// Execute a plan. Returns the actions that were applied.
pub fn apply_sync(home: &Path, plan: &SyncPlan) -> Result<Vec<SyncAction>> {
    let mut applied = Vec::new();

    for action in &plan.actions {
        if action.kind == "skill" {
            let Some(source) = source_skill_dir(home, &action.item) else {
                continue;
            };
            let target = PathBuf::from(&action.target);
            if target == source {
                continue;
            }
            if target.exists() {
                // Directories are replaced wholesale; back up the manifest so
                // the previous version is recoverable.
                backup_if_present(&target.join("SKILL.md"))?;
            }
            copy_dir(&source, &target)
                .with_context(|| format!("copy skill {} to {}", action.item, target.display()))?;
            applied.push(action.clone());
        }
    }

    // MCP writes are grouped per file so one config is rewritten once even when
    // several servers land in it.
    let mut per_target: BTreeMap<String, Vec<&SyncAction>> = BTreeMap::new();
    for action in plan.actions.iter().filter(|a| a.kind == "mcp") {
        per_target
            .entry(action.target.clone())
            .or_default()
            .push(action);
    }

    let targets = mcp_targets(home);
    let union = union_servers(home);
    for (target_path, actions) in per_target {
        let Some(target) = targets
            .iter()
            .find(|t| t.path.display().to_string() == target_path)
        else {
            continue;
        };
        let names: Vec<String> = actions.iter().map(|a| a.item.clone()).collect();
        write_mcp_servers(target, &union, &names)?;
        applied.extend(actions.into_iter().cloned());
    }

    Ok(applied)
}

fn union_servers(home: &Path) -> BTreeMap<String, serde_json::Value> {
    let mut union: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    for target in mcp_targets(home) {
        let servers: BTreeMap<String, serde_json::Value> = match target.format {
            "toml" => read_toml_mcp(&target.path)
                .iter()
                .filter_map(|(name, def)| Some((name.clone(), toml_to_json(def)?)))
                .collect(),
            _ => read_json_mcp(&target.path),
        };
        for (name, def) in servers {
            union.entry(name).or_insert(def);
        }
    }
    union
}

/// Merge servers into one provider's config, preserving everything else in the
/// file. A config we cannot parse is left alone rather than clobbered.
fn write_mcp_servers(
    target: &McpConfigTarget,
    union: &BTreeMap<String, serde_json::Value>,
    names: &[String],
) -> Result<()> {
    if let Some(parent) = target.path.parent() {
        fs::create_dir_all(parent)?;
    }
    backup_if_present(&target.path)?;

    match target.format {
        "toml" => {
            let existing = fs::read_to_string(&target.path).unwrap_or_default();
            let mut doc: toml::Value = if existing.trim().is_empty() {
                toml::Value::Table(toml::map::Map::new())
            } else {
                toml::from_str(&existing)
                    .with_context(|| format!("parse {}", target.path.display()))?
            };
            let table = doc
                .as_table_mut()
                .context("codex config root is not a table")?;
            let servers = table
                .entry("mcp_servers".to_owned())
                .or_insert_with(|| toml::Value::Table(toml::map::Map::new()))
                .as_table_mut()
                .context("mcp_servers is not a table")?;
            for name in names {
                if let Some(value) = union.get(name).and_then(json_to_toml) {
                    servers.insert(name.clone(), value);
                }
            }
            fs::write(&target.path, toml::to_string_pretty(&doc)?)?;
        }
        _ => {
            let existing = fs::read_to_string(&target.path).unwrap_or_default();
            let mut doc: serde_json::Value = if existing.trim().is_empty() {
                serde_json::json!({})
            } else {
                serde_json::from_str(&existing)
                    .with_context(|| format!("parse {}", target.path.display()))?
            };
            if !doc.is_object() {
                doc = serde_json::json!({});
            }
            let servers = doc
                .as_object_mut()
                .expect("checked object")
                .entry("mcpServers".to_owned())
                .or_insert_with(|| serde_json::json!({}));
            if !servers.is_object() {
                *servers = serde_json::json!({});
            }
            let servers = servers.as_object_mut().expect("checked object");
            for name in names {
                if let Some(value) = union.get(name) {
                    servers.insert(name.clone(), value.clone());
                }
            }
            fs::write(&target.path, serde_json::to_string_pretty(&doc)? + "\n")?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(root: &Path, name: &str) {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: A {name} skill\n---\nbody\n"),
        )
        .unwrap();
        fs::write(dir.join("extra.md"), "supporting file\n").unwrap();
    }

    #[test]
    fn the_plan_says_which_providers_accept_each_kind() {
        let temp = tempfile::tempdir().unwrap();
        let plan = plan_sync(temp.path(), &SyncSelection::default()).unwrap();
        // Cursor takes MCP servers but has no skills directory; conflating the
        // two lists makes the UI promise writes that never happen.
        assert_eq!(plan.skill_providers, vec!["claude", "codex"]);
        assert_eq!(plan.mcp_providers, vec!["claude", "codex", "cursor"]);
    }

    #[test]
    fn a_skill_in_one_provider_is_planned_into_the_others() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write_skill(&home.join(".claude/skills"), "solo");

        let plan = plan_sync(home, &SyncSelection::default()).unwrap();

        let skill_actions: Vec<_> = plan.actions.iter().filter(|a| a.kind == "skill").collect();
        assert_eq!(skill_actions.len(), 1, "{:?}", plan.actions);
        assert_eq!(skill_actions[0].provider, "codex");
        assert_eq!(plan.skills.get("solo").unwrap(), &vec!["claude".to_owned()]);
    }

    #[test]
    fn applying_copies_the_whole_skill_directory() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write_skill(&home.join(".claude/skills"), "solo");

        let plan = plan_sync(home, &SyncSelection::default()).unwrap();
        let applied = apply_sync(home, &plan).unwrap();

        assert_eq!(applied.len(), 1);
        let copied = home.join(".codex/skills/solo");
        assert!(copied.join("SKILL.md").is_file());
        assert!(
            copied.join("extra.md").is_file(),
            "a skill is a directory, not just its manifest"
        );
    }

    #[test]
    fn a_skill_both_providers_have_needs_no_work() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write_skill(&home.join(".claude/skills"), "shared");
        write_skill(&home.join(".codex/skills"), "shared");

        let plan = plan_sync(home, &SyncSelection::default()).unwrap();

        assert!(
            plan.actions.iter().all(|a| a.kind != "skill"),
            "{:?}",
            plan.actions
        );
    }

    #[test]
    fn selection_narrows_both_items_and_providers() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write_skill(&home.join(".claude/skills"), "wanted");
        write_skill(&home.join(".claude/skills"), "unwanted");

        let only_wanted = plan_sync(
            home,
            &SyncSelection {
                skills: vec!["wanted".to_owned()],
                ..SyncSelection::default()
            },
        )
        .unwrap();
        let items: Vec<_> = only_wanted
            .actions
            .iter()
            .filter(|a| a.kind == "skill")
            .map(|a| a.item.as_str())
            .collect();
        assert_eq!(items, vec!["wanted"]);

        let no_providers = plan_sync(
            home,
            &SyncSelection {
                providers: vec!["claude".to_owned()],
                ..SyncSelection::default()
            },
        )
        .unwrap();
        assert!(
            no_providers.actions.iter().all(|a| a.kind != "skill"),
            "claude already has both, so restricting to claude means no work"
        );
    }

    #[test]
    fn mcp_servers_cross_the_json_toml_divide() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        fs::write(
            home.join(".claude.json"),
            r#"{"mcpServers":{"fromClaude":{"command":"a","args":["x"]}},"otherKey":42}"#,
        )
        .unwrap();
        fs::create_dir_all(home.join(".codex")).unwrap();
        fs::write(
            home.join(".codex/config.toml"),
            "model = \"gpt\"\n\n[mcp_servers.fromCodex]\ncommand = \"b\"\nargs = []\n",
        )
        .unwrap();

        let plan = plan_sync(home, &SyncSelection::default()).unwrap();
        apply_sync(home, &plan).unwrap();

        // Codex gained the Claude server as a TOML table.
        let codex = fs::read_to_string(home.join(".codex/config.toml")).unwrap();
        assert!(codex.contains("[mcp_servers.fromClaude]"), "{codex}");
        assert!(codex.contains("model = \"gpt\""), "unrelated keys survive");

        // Claude gained the Codex server as JSON, keeping its other keys.
        let claude: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(home.join(".claude.json")).unwrap()).unwrap();
        assert!(claude["mcpServers"]["fromCodex"].is_object(), "{claude}");
        assert_eq!(claude["otherKey"], 42, "unrelated keys survive");
    }

    #[test]
    fn overwriting_a_config_leaves_a_backup() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        fs::write(
            home.join(".claude.json"),
            r#"{"mcpServers":{"a":{"command":"a"}}}"#,
        )
        .unwrap();
        fs::create_dir_all(home.join(".cursor")).unwrap();
        fs::write(home.join(".cursor/mcp.json"), r#"{"mcpServers":{}}"#).unwrap();

        let plan = plan_sync(home, &SyncSelection::default()).unwrap();
        apply_sync(home, &plan).unwrap();

        let backup = home.join(".cursor/mcp.json.archductor-backup");
        assert!(
            backup.is_file(),
            "an overwritten config must be recoverable"
        );
    }

    #[test]
    fn plugin_skills_are_left_to_their_plugin() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write_skill(
            &home.join(".claude/plugins/cache/pack/pack/1.0/skills"),
            "managed",
        );

        let plan = plan_sync(home, &SyncSelection::default()).unwrap();

        assert!(
            plan.actions.iter().all(|a| a.item != "managed"),
            "copying a plugin-managed skill would fork it: {:?}",
            plan.actions
        );
    }

    #[test]
    fn syncing_twice_is_a_no_op_the_second_time() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write_skill(&home.join(".claude/skills"), "solo");

        let first = plan_sync(home, &SyncSelection::default()).unwrap();
        apply_sync(home, &first).unwrap();
        let second = plan_sync(home, &SyncSelection::default()).unwrap();

        assert!(
            second.actions.is_empty(),
            "a settled machine should plan no writes: {:?}",
            second.actions
        );
    }
}

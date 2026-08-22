//! Agent skills as they exist on the daemon's machine.
//!
//! Every supported agent CLI keeps skills as a directory holding a `SKILL.md`
//! with YAML frontmatter, under a per-provider root (`~/.claude/skills`,
//! `~/.codex/skills`). Claude additionally ships plugin skills nested under
//! `~/.claude/plugins/cache/<plugin>/<pack>/<version>/skills`.
//!
//! Discovery lives in core, on the daemon side, for the same reason workspace
//! file listing does: a client can be a different machine, and the skills that
//! matter are the ones the agent process will actually load.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::{Deserialize, Serialize};

/// One skill, merged across every provider that has it installed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Skill {
    /// Directory name, which is also what the user types after `/`.
    pub name: String,
    /// First line of the frontmatter `description`, empty when absent.
    pub description: String,
    /// Provider keys that have this skill (`claude`, `codex`, …), sorted.
    pub providers: Vec<String>,
    /// True when it comes from a plugin cache rather than the user's own dir;
    /// plugin skills are managed by their plugin, so sync leaves them alone.
    pub plugin: bool,
}

/// Where one provider keeps its user-level skills.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillRoot {
    pub provider_key: String,
    pub path: PathBuf,
    /// Plugin caches are read-only for our purposes.
    pub writable: bool,
}

/// The user-level skill directories for the providers we know how to sync.
/// Missing directories are still returned: an absent root is a valid sync
/// target (we create it), and callers need to know where it would go.
pub fn skill_roots(home: &Path) -> Vec<SkillRoot> {
    vec![
        SkillRoot {
            provider_key: "claude".to_owned(),
            path: home.join(".claude/skills"),
            writable: true,
        },
        SkillRoot {
            provider_key: "codex".to_owned(),
            path: home.join(".codex/skills"),
            writable: true,
        },
    ]
}

/// Plugin skill roots, which are discovered but never written.
fn plugin_skill_roots(home: &Path) -> Vec<PathBuf> {
    let cache = home.join(".claude/plugins/cache");
    let Ok(entries) = fs::read_dir(&cache) else {
        return Vec::new();
    };
    let mut roots = Vec::new();
    for plugin in entries.filter_map(|entry| entry.ok()) {
        // <cache>/<plugin>/<pack>/<version>/skills — the middle levels vary, so
        // walk two levels and take any `skills` directory found underneath.
        collect_plugin_skill_dirs(&plugin.path(), 0, &mut roots);
    }
    roots.sort();
    roots
}

fn collect_plugin_skill_dirs(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 3 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(|entry| entry.ok()) {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if path.file_name().is_some_and(|name| name == "skills") {
            out.push(path);
        } else {
            collect_plugin_skill_dirs(&path, depth + 1, out);
        }
    }
}

/// Read `description` out of a `SKILL.md` YAML frontmatter block. Returns an
/// empty string when the file has no frontmatter or no description — a skill
/// without one is still usable, so this is not an error.
pub fn skill_description(skill_md: &str) -> String {
    let mut lines = skill_md.lines();
    if lines.next().map(str::trim) != Some("---") {
        return String::new();
    }
    let mut rest_of_block = Vec::new();
    let mut found = None;
    for line in lines {
        let trimmed = line.trim_end();
        if trimmed.trim() == "---" {
            break;
        }
        if found.is_some() {
            rest_of_block.push(trimmed.to_owned());
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("description:") {
            found = Some(rest.trim().to_owned());
        }
    }
    let Some(value) = found else {
        return String::new();
    };
    // `description: >` / `|` put the text on the following indented lines;
    // taking the value verbatim would render the fold marker as the whole
    // description.
    if value == ">" || value == "|" || value == ">-" || value == "|-" {
        let folded: Vec<&str> = rest_of_block
            .iter()
            .take_while(|line| {
                line.trim().is_empty() || line.starts_with(' ') || line.starts_with('\t')
            })
            .map(|line| line.trim())
            .filter(|line| !line.is_empty())
            .collect();
        return folded.join(" ");
    }
    value.trim_matches('"').trim_matches('\'').to_owned()
}

fn read_skill_dir(root: &Path) -> Vec<(String, String)> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.filter_map(|entry| entry.ok()) {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        // A directory is only a skill if it actually carries a SKILL.md;
        // anything else in these roots is someone's scratch folder.
        let skill_md = path.join("SKILL.md");
        let Ok(contents) = fs::read_to_string(&skill_md) else {
            continue;
        };
        found.push((name.to_owned(), skill_description(&contents)));
    }
    found
}

/// Every skill on this machine, merged by name across providers.
pub fn list_skills(home: &Path) -> Result<Vec<Skill>> {
    let mut merged: BTreeMap<String, Skill> = BTreeMap::new();

    for root in skill_roots(home) {
        for (name, description) in read_skill_dir(&root.path) {
            let entry = merged.entry(name.clone()).or_insert_with(|| Skill {
                name,
                description: description.clone(),
                providers: Vec::new(),
                plugin: false,
            });
            if entry.description.is_empty() {
                entry.description = description;
            }
            if !entry.providers.contains(&root.provider_key) {
                entry.providers.push(root.provider_key.clone());
            }
        }
    }

    for root in plugin_skill_roots(home) {
        for (name, description) in read_skill_dir(&root) {
            let entry = merged.entry(name.clone()).or_insert_with(|| Skill {
                name,
                description: description.clone(),
                providers: Vec::new(),
                plugin: true,
            });
            if entry.description.is_empty() {
                entry.description = description;
            }
            if !entry.providers.contains(&"claude".to_owned()) {
                entry.providers.push("claude".to_owned());
            }
        }
    }

    let mut skills: Vec<Skill> = merged.into_values().collect();
    for skill in &mut skills {
        skill.providers.sort();
    }
    Ok(skills)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(root: &Path, name: &str, description: &str) {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {description}\n---\n\nbody\n"),
        )
        .unwrap();
    }

    #[test]
    fn description_comes_from_frontmatter_and_tolerates_its_absence() {
        assert_eq!(
            skill_description("---\nname: a\ndescription: Does a thing.\n---\nbody"),
            "Does a thing."
        );
        assert_eq!(skill_description("no frontmatter here"), "");
        assert_eq!(skill_description("---\nname: a\n---\nbody"), "");
        // Quoted values are common in these files.
        assert_eq!(
            skill_description("---\ndescription: \"Quoted value\"\n---\n"),
            "Quoted value"
        );
        // A `description:` after the closing fence is body text, not metadata.
        assert_eq!(
            skill_description("---\nname: a\n---\ndescription: not metadata\n"),
            ""
        );
    }

    #[test]
    fn folded_block_descriptions_read_as_prose_not_a_fold_marker() {
        // Real skills in the wild use `description: >`; taking the value
        // verbatim rendered every one of them as ">".
        let folded = "---\nname: a\ndescription: >\n  First line of the summary\n  and its continuation.\nmetadata:\n  x: 1\n---\nbody";
        assert_eq!(
            skill_description(folded),
            "First line of the summary and its continuation."
        );
        assert_eq!(
            skill_description("---\ndescription: |\n  Literal block.\n---\n"),
            "Literal block."
        );
        // The fold must stop at the next unindented key.
        let stops = "---\ndescription: >\n  Only this.\nname: a\n---\n";
        assert_eq!(skill_description(stops), "Only this.");
    }

    #[test]
    fn skills_merge_across_providers_by_name() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        write_skill(&home.join(".claude/skills"), "shared", "In both");
        write_skill(&home.join(".codex/skills"), "shared", "In both");
        write_skill(&home.join(".claude/skills"), "claude-only", "Just claude");

        let skills = list_skills(home).unwrap();
        let shared = skills.iter().find(|s| s.name == "shared").unwrap();
        let only = skills.iter().find(|s| s.name == "claude-only").unwrap();

        assert_eq!(shared.providers, vec!["claude", "codex"]);
        assert_eq!(shared.description, "In both");
        assert_eq!(only.providers, vec!["claude"]);
    }

    #[test]
    fn a_directory_without_a_skill_md_is_not_a_skill() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        fs::create_dir_all(home.join(".claude/skills/not-a-skill")).unwrap();
        write_skill(&home.join(".claude/skills"), "real", "Real one");

        let names: Vec<_> = list_skills(home)
            .unwrap()
            .into_iter()
            .map(|s| s.name)
            .collect();
        assert_eq!(names, vec!["real"]);
    }

    #[test]
    fn plugin_skills_are_found_and_flagged_so_sync_can_skip_them() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let plugin_root = home.join(".claude/plugins/cache/caveman/caveman/abc123/skills");
        write_skill(&plugin_root, "caveman", "Talk like caveman");

        let skills = list_skills(home).unwrap();
        let caveman = skills.iter().find(|s| s.name == "caveman").unwrap();

        assert!(caveman.plugin, "plugin skills are managed by their plugin");
        assert_eq!(caveman.providers, vec!["claude"]);
    }

    #[test]
    fn a_missing_home_yields_no_skills_rather_than_an_error() {
        let temp = tempfile::tempdir().unwrap();
        assert!(list_skills(&temp.path().join("nope")).unwrap().is_empty());
    }
}

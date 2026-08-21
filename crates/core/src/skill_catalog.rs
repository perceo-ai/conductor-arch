//! A catalog of installable skills.
//!
//! The manifest is compiled in so installs work offline and any change to the
//! list shows up in a diff. `catalog_from_json` is separate from the baked-in
//! constant so the same loader can later read a fetched index without changing
//! the install path.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::skills::skill_roots;

const BUILTIN_CATALOG: &str = include_str!("../assets/skill-catalog.json");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogSkill {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub category: String,
    /// Repository to clone.
    pub git: String,
    /// Path inside the repository when it ships several skills.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subdir: Option<String>,
    /// Providers that already have a skill of this name, filled in per machine.
    #[serde(default)]
    pub installed_for: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Catalog {
    #[serde(default)]
    pub skills: Vec<CatalogSkill>,
}

pub fn catalog_from_json(json: &str) -> Result<Catalog> {
    serde_json::from_str(json).context("parse skill catalog")
}

/// The catalog, annotated with what this machine already has.
pub fn catalog(home: &Path) -> Result<Catalog> {
    let mut catalog = catalog_from_json(BUILTIN_CATALOG)?;
    let installed = crate::skills::list_skills(home)?;
    for entry in &mut catalog.skills {
        entry.installed_for = installed
            .iter()
            .find(|skill| skill.name == entry.name)
            .map(|skill| skill.providers.clone())
            .unwrap_or_default();
    }
    Ok(catalog)
}

fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        // A cloned repository carries its own history; the skill is the files.
        if entry.file_name() == ".git" {
            continue;
        }
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Clone a catalog entry and place it in each provider's skills directory.
/// Returns the directories written.
pub fn install_skill(home: &Path, name: &str, providers: &[String]) -> Result<Vec<PathBuf>> {
    let catalog = catalog(home)?;
    let entry = catalog
        .skills
        .iter()
        .find(|s| s.name == name)
        .with_context(|| format!("no catalog skill named {name}"))?;

    let staging = std::env::temp_dir().join(format!("archductor-skill-{name}"));
    let _ = fs::remove_dir_all(&staging);
    let output = Command::new("git")
        .args(["clone", "--depth", "1", "--quiet", &entry.git])
        .arg(&staging)
        .output()
        .context("run git clone")?;
    if !output.status.success() {
        bail!(
            "clone {} failed: {}",
            entry.git,
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let source = match &entry.subdir {
        Some(subdir) => staging.join(subdir),
        None => staging.clone(),
    };
    if !source.join("SKILL.md").is_file() {
        let _ = fs::remove_dir_all(&staging);
        bail!(
            "{} has no SKILL.md at {}",
            entry.git,
            entry.subdir.as_deref().unwrap_or(".")
        );
    }

    let mut written = Vec::new();
    for root in skill_roots(home) {
        if !providers.is_empty() && !providers.contains(&root.provider_key) {
            continue;
        }
        let target = root.path.join(name);
        copy_dir(&source, &target)
            .with_context(|| format!("install {name} into {}", target.display()))?;
        written.push(target);
    }
    let _ = fs::remove_dir_all(&staging);

    if written.is_empty() {
        bail!("no matching provider to install into");
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_builtin_catalog_parses_and_is_well_formed() {
        let catalog = catalog_from_json(BUILTIN_CATALOG).unwrap();
        assert!(!catalog.skills.is_empty());
        for skill in &catalog.skills {
            assert!(!skill.name.trim().is_empty(), "every entry needs a name");
            assert!(
                !skill.description.trim().is_empty(),
                "{} needs a description to be pickable",
                skill.name
            );
            assert!(
                skill.git.starts_with("https://"),
                "{} must clone over https, got {}",
                skill.name,
                skill.git
            );
        }
    }

    #[test]
    fn catalog_names_are_unique() {
        let catalog = catalog_from_json(BUILTIN_CATALOG).unwrap();
        let mut names: Vec<&str> = catalog.skills.iter().map(|s| s.name.as_str()).collect();
        names.sort_unstable();
        let before = names.len();
        names.dedup();
        assert_eq!(before, names.len(), "duplicate catalog entries: {names:?}");
    }

    #[test]
    fn installed_skills_are_marked_so_the_catalog_can_show_state() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let name = catalog_from_json(BUILTIN_CATALOG).unwrap().skills[0]
            .name
            .clone();
        let dir = home.join(".claude/skills").join(&name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), "---\nname: x\n---\n").unwrap();

        let catalog = catalog(home).unwrap();
        let entry = catalog.skills.iter().find(|s| s.name == name).unwrap();

        assert_eq!(entry.installed_for, vec!["claude".to_owned()]);
    }

    /// Network + git. Ignored by default so the suite stays hermetic; run with
    /// `cargo test -p archductor-core -- --ignored install_from_the_catalog`.
    #[test]
    #[ignore]
    fn install_from_the_catalog_places_a_subdir_skill_in_every_provider() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();

        let written = install_skill(home, "mcp-builder", &[]).unwrap();

        assert_eq!(written.len(), 2, "claude and codex both get it");
        for dir in written {
            assert!(dir.join("SKILL.md").is_file(), "{}", dir.display());
            assert!(!dir.join(".git").exists(), "history must not be copied");
        }
        // And the machine now reports it as installed for both.
        let catalog = catalog(home).unwrap();
        let entry = catalog
            .skills
            .iter()
            .find(|s| s.name == "mcp-builder")
            .unwrap();
        assert_eq!(entry.installed_for, vec!["claude", "codex"]);
    }

    #[test]
    fn an_unknown_skill_is_refused_rather_than_cloning_something_random() {
        let temp = tempfile::tempdir().unwrap();
        let err = install_skill(temp.path(), "definitely-not-in-the-catalog", &[]).unwrap_err();
        assert!(err.to_string().contains("no catalog skill"), "{err}");
    }
}

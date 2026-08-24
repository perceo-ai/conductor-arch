use anyhow::{Context, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::workspace::WorkspaceStore;

const MAX_LAYOUT_BYTES: usize = 256 * 1024;
const MAX_HIDDEN_BYTES: usize = 64 * 1024;
const BUILTIN_IDS: [&str; 4] = ["code", "wide", "review", "watch"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LayoutPreset {
    pub id: String,
    pub name: String,
    pub builtin: bool,
    pub layout_json: String,
    pub hidden_json: String,
    pub created_at: String,
    pub updated_at: String,
}

impl WorkspaceStore {
    pub fn list_layout_presets(&self) -> Result<Vec<LayoutPreset>> {
        let mut presets = builtin_presets();
        let mut statement = self.conn.prepare(
            "SELECT id, name, layout_json, hidden_json, created_at, updated_at
             FROM layout_presets ORDER BY name COLLATE NOCASE, id",
        )?;
        presets.extend(
            statement
                .query_map([], |row| {
                    Ok(LayoutPreset {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        builtin: false,
                        layout_json: row.get(2)?,
                        hidden_json: row.get(3)?,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?,
        );
        Ok(presets)
    }

    pub fn save_layout_preset(&self, preset: &LayoutPreset) -> Result<LayoutPreset> {
        validate_preset(preset)?;
        let now = crate::workspace::timestamp();
        self.conn.execute(
            "INSERT INTO layout_presets
               (id, name, layout_json, hidden_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               layout_json = excluded.layout_json,
               hidden_json = excluded.hidden_json,
               updated_at = excluded.updated_at",
            params![
                preset.id,
                preset.name,
                preset.layout_json,
                preset.hidden_json,
                now
            ],
        )?;
        self.conn
            .query_row(
                "SELECT id, name, layout_json, hidden_json, created_at, updated_at
                 FROM layout_presets WHERE id = ?1",
                [&preset.id],
                |row| {
                    Ok(LayoutPreset {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        builtin: false,
                        layout_json: row.get(2)?,
                        hidden_json: row.get(3)?,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                },
            )
            .context("read saved layout preset")
    }

    pub fn delete_layout_preset(&self, id: &str) -> Result<()> {
        anyhow::ensure!(
            !is_builtin_id(id),
            "built-in layout presets cannot be deleted"
        );
        self.conn
            .execute("DELETE FROM layout_presets WHERE id = ?1", [id])?;
        Ok(())
    }
}

fn validate_preset(preset: &LayoutPreset) -> Result<()> {
    anyhow::ensure!(
        !preset.id.trim().is_empty(),
        "layout preset id must not be empty"
    );
    anyhow::ensure!(
        !preset.name.trim().is_empty(),
        "layout preset name must not be empty"
    );
    anyhow::ensure!(
        !is_builtin_id(&preset.id),
        "built-in layout presets cannot be saved"
    );
    anyhow::ensure!(
        preset.layout_json.len() <= MAX_LAYOUT_BYTES,
        "layout preset layout exceeds {MAX_LAYOUT_BYTES} bytes"
    );
    anyhow::ensure!(
        preset.hidden_json.len() <= MAX_HIDDEN_BYTES,
        "layout preset hidden panels exceed {MAX_HIDDEN_BYTES} bytes"
    );
    serde_json::from_str::<Value>(&preset.layout_json)
        .context("parse layout preset layout JSON")?;
    serde_json::from_str::<Value>(&preset.hidden_json)
        .context("parse layout preset hidden JSON")?;
    Ok(())
}

fn is_builtin_id(id: &str) -> bool {
    BUILTIN_IDS
        .iter()
        .any(|builtin| id.eq_ignore_ascii_case(builtin))
}

fn stack(panels: &[&str], strips: &[&str], docks: &[&str], active: usize, size: usize) -> Value {
    json!({
        "panels": panels,
        "strips": strips,
        "docks": docks,
        "active": active,
        "size": size,
        "collapsed": false
    })
}

fn builtin_preset(
    id: &str,
    name: &str,
    left: Value,
    center: Value,
    bottom: Value,
    right: Value,
    hidden: &[&str],
) -> LayoutPreset {
    LayoutPreset {
        id: id.to_owned(),
        name: name.to_owned(),
        builtin: true,
        layout_json: json!({
            "version": 1,
            "regions": { "left": left, "center": center, "bottom": bottom, "right": right }
        })
        .to_string(),
        hidden_json: json!(hidden).to_string(),
        created_at: "0".to_owned(),
        updated_at: "0".to_owned(),
    }
}

fn builtin_presets() -> Vec<LayoutPreset> {
    let empty_left = || stack(&[], &[], &[], 0, 260);
    let empty_bottom = || stack(&[], &[], &[], 0, 280);
    let dead = ["todos", "checkpoints", "processes", "timeline", "context"];
    vec![
        builtin_preset(
            "code",
            "Code",
            empty_left(),
            stack(&["chat"], &[], &[], 0, 0),
            empty_bottom(),
            stack(
                &["summary", "files", "changes", "checks"],
                &["pr"],
                &["terminal"],
                2,
                300,
            ),
            &dead,
        ),
        builtin_preset(
            "wide",
            "Wide",
            stack(&["files"], &[], &[], 0, 260),
            stack(&["chat"], &[], &[], 0, 0),
            stack(&[], &[], &["terminal"], 0, 280),
            stack(&["summary", "changes", "checks"], &["pr"], &[], 0, 300),
            &dead,
        ),
        builtin_preset(
            "review",
            "Review",
            stack(&["files"], &[], &[], 0, 260),
            stack(&["changes"], &[], &[], 0, 0),
            stack(&[], &[], &["terminal"], 0, 280),
            stack(&["checks", "summary", "chat"], &["pr"], &[], 0, 300),
            &dead,
        ),
        builtin_preset(
            "watch",
            "Watch",
            empty_left(),
            stack(&[], &[], &["terminal"], 0, 0),
            stack(&["chat"], &[], &[], 0, 280),
            stack(&["summary", "checks"], &[], &[], 0, 300),
            &[
                "pr",
                "files",
                "changes",
                "todos",
                "checkpoints",
                "processes",
                "timeline",
                "context",
            ],
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::WorkspaceStore;

    const LAYOUT: &str = r#"{"version":1,"regions":{},"docks":[]}"#;
    const HIDDEN: &str = r#"["todos"]"#;

    fn store() -> (tempfile::TempDir, WorkspaceStore) {
        let temp = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::open(temp.path().join("workspace.db")).unwrap();
        (temp, store)
    }

    fn preset(id: &str, name: &str) -> LayoutPreset {
        LayoutPreset {
            id: id.to_owned(),
            name: name.to_owned(),
            builtin: false,
            layout_json: LAYOUT.to_owned(),
            hidden_json: HIDDEN.to_owned(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn builtins_are_first_then_users_by_case_insensitive_name() {
        let (_temp, store) = store();
        store.save_layout_preset(&preset("zebra", "zebra")).unwrap();
        store.save_layout_preset(&preset("alpha", "Alpha")).unwrap();

        let presets = store.list_layout_presets().unwrap();
        assert_eq!(
            presets
                .iter()
                .map(|preset| preset.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Code", "Wide", "Review", "Watch", "Alpha", "zebra"]
        );
        assert!(presets[..4].iter().all(|preset| preset.builtin));
        assert!(presets[..4]
            .iter()
            .all(|preset| serde_json::from_str::<serde_json::Value>(&preset.layout_json).is_ok()));
        assert!(presets[..4]
            .iter()
            .all(|preset| preset.layout_json.contains("\"docks\"")));
    }

    #[test]
    fn save_upserts_and_delete_is_idempotent() {
        let (_temp, store) = store();
        store.save_layout_preset(&preset("mine", "Mine")).unwrap();
        store
            .save_layout_preset(&preset("mine", "Renamed"))
            .unwrap();
        let saved = store
            .list_layout_presets()
            .unwrap()
            .into_iter()
            .find(|preset| preset.id == "mine")
            .unwrap();
        assert_eq!(saved.name, "Renamed");
        assert!(!saved.created_at.is_empty());
        assert!(!saved.updated_at.is_empty());

        store.delete_layout_preset("mine").unwrap();
        store.delete_layout_preset("mine").unwrap();
        assert!(!store
            .list_layout_presets()
            .unwrap()
            .iter()
            .any(|preset| preset.id == "mine"));
    }

    #[test]
    fn validation_rejects_invalid_and_oversized_presets_and_builtin_mutation() {
        let (_temp, store) = store();
        for invalid in [
            preset("", "Name"),
            preset("id", ""),
            LayoutPreset {
                layout_json: "{".to_owned(),
                ..preset("bad-layout", "Bad")
            },
            LayoutPreset {
                hidden_json: "[".to_owned(),
                ..preset("bad-hidden", "Bad")
            },
            LayoutPreset {
                layout_json: "x".repeat(256 * 1024 + 1),
                ..preset("large-layout", "Bad")
            },
            LayoutPreset {
                hidden_json: "x".repeat(64 * 1024 + 1),
                ..preset("large-hidden", "Bad")
            },
            preset("code", "Code edit"),
        ] {
            assert!(
                store.save_layout_preset(&invalid).is_err(),
                "accepted {}",
                invalid.id
            );
        }
        assert!(store.delete_layout_preset("wide").is_err());
    }
}

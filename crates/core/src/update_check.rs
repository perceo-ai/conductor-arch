//! "Is this build behind the latest published release?"
//!
//! Two callers share this: the archcar daemon, which is the only always-on
//! process and so does the periodic network refresh, and the CLI, which reads
//! the cache and never touches the network — a short-lived command must not
//! pay for a GitHub round trip, and must still work offline.
//!
//! The fetch shells out to `gh` (already a hard runtime dependency) and falls
//! back to `curl` when `gh` is missing or unauthenticated. Every failure is
//! silent: not knowing about a new release is not an error worth reporting.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::paths::AppPaths;

/// The repository whose releases define "latest".
pub const RELEASES_REPO: &str = "perceo-ai/conductor-arch";

/// Where a user goes to get the new build.
pub const RELEASES_URL: &str = "https://github.com/perceo-ai/conductor-arch/releases/latest";

/// Matches the desktop app's own update cadence, so both surfaces agree about
/// a new release at roughly the same time.
pub const REFRESH_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// Last answer from GitHub, persisted so every CLI invocation can render the
/// notice without asking the network.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateCheckCache {
    /// Release tag exactly as GitHub reports it (`v0.7.0`). Empty when the
    /// last refresh failed — recorded anyway so a broken network backs off
    /// instead of retrying on every tick.
    #[serde(default)]
    pub latest_tag: String,
    /// Epoch seconds of the last attempt, successful or not.
    #[serde(default)]
    pub checked_at: u64,
}

/// Build-time stamp for the release this binary belongs to.
///
/// The crate versions in `Cargo.toml` are not bumped per release — the git tag
/// is the version of record — so `CARGO_PKG_VERSION` is `0.1.0` in every
/// build, released or not. The release workflows set this variable from the
/// tag; a local `cargo build` leaves it unset.
pub fn current_version() -> &'static str {
    option_env!("ARCHDUCTOR_RELEASE_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
}

/// True only for a binary built by the release pipeline. A dev build has no
/// meaningful version to compare, so it neither nags nor polls GitHub.
pub fn is_release_build() -> bool {
    option_env!("ARCHDUCTOR_RELEASE_VERSION").is_some()
}

pub fn cache_path(paths: &AppPaths) -> PathBuf {
    paths.cache_dir.join("update-check.json")
}

pub fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Missing or unreadable cache reads as "no answer yet", never as an error.
pub fn load_cache(path: &Path) -> Option<UpdateCheckCache> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn save_cache(path: &Path, cache: &UpdateCheckCache) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string(cache).map_err(std::io::Error::other)?;
    std::fs::write(path, json)
}

/// A cache with no entry is stale; so is one older than `interval`. A clock
/// that jumped backwards (checked_at in the future) also counts as stale
/// rather than pinning the refresh off forever.
pub fn is_stale(cache: Option<&UpdateCheckCache>, now: u64, interval: Duration) -> bool {
    let Some(cache) = cache else { return true };
    now.checked_sub(cache.checked_at)
        .map(|age| age >= interval.as_secs())
        .unwrap_or(true)
}

/// Numeric `MAJOR.MINOR.PATCH` comparison, tolerant of a leading `v`. When the
/// triples tie, a prerelease (`0.7.0-rc.1`) sorts below the plain release, so
/// an rc build is never offered as an upgrade over the final.
pub fn compare_versions(left: &str, right: &str) -> Ordering {
    let (a, a_pre) = parse_version(left);
    let (b, b_pre) = parse_version(right);
    for index in 0..3 {
        match a[index].cmp(&b[index]) {
            Ordering::Equal => continue,
            other => return other,
        }
    }
    // false < true, and "is a prerelease" should sort first.
    b_pre.cmp(&a_pre)
}

fn parse_version(value: &str) -> ([u64; 3], bool) {
    let trimmed = value.trim().trim_start_matches(['v', 'V']);
    let core = trimmed
        .split_once(['-', '+'])
        .map(|(core, _)| core)
        .unwrap_or(trimmed);
    let prerelease = trimmed.contains('-');
    let mut parts = [0u64; 3];
    for (index, part) in core.split('.').take(3).enumerate() {
        parts[index] = part.trim().parse().unwrap_or(0);
    }
    (parts, prerelease)
}

/// The one line a CLI command prints when this build is behind. `None` when
/// the latest tag is unknown, malformed, or not newer.
pub fn update_notice(current_version: &str, latest_tag: &str) -> Option<String> {
    if latest_tag.trim().is_empty() {
        return None;
    }
    if compare_versions(latest_tag, current_version) != Ordering::Greater {
        return None;
    }
    Some(format!(
        "update available: v{} \u{2192} {} \u{2014} {}",
        current_version.trim_start_matches('v'),
        latest_tag.trim(),
        RELEASES_URL
    ))
}

/// Extract `tag_name` from a `releases/latest` payload.
pub fn latest_tag_from_release_json(json: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Raw {
        #[serde(default)]
        tag_name: String,
    }
    let raw = serde_json::from_str::<Raw>(json).ok()?;
    let tag = raw.tag_name.trim().to_owned();
    if tag.is_empty() {
        None
    } else {
        Some(tag)
    }
}

/// `gh api repos/<repo>/releases/latest`.
pub fn gh_api_args() -> Vec<String> {
    vec![
        "api".to_owned(),
        format!("repos/{RELEASES_REPO}/releases/latest"),
        "--header".to_owned(),
        "Accept: application/vnd.github+json".to_owned(),
    ]
}

/// Unauthenticated fallback for machines without a usable `gh`.
pub fn curl_args() -> Vec<String> {
    vec![
        "--silent".to_owned(),
        "--show-error".to_owned(),
        "--fail".to_owned(),
        "--location".to_owned(),
        "--max-time".to_owned(),
        "10".to_owned(),
        "--header".to_owned(),
        "Accept: application/vnd.github+json".to_owned(),
        format!("https://api.github.com/repos/{RELEASES_REPO}/releases/latest"),
    ]
}

/// `gh` first, then `curl`. `None` when neither can answer.
pub fn fetch_latest_tag() -> Option<String> {
    for (program, args) in [("gh", gh_api_args()), ("curl", curl_args())] {
        let Ok(output) = Command::new(program).args(&args).output() else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(tag) = latest_tag_from_release_json(&stdout) {
            return Some(tag);
        }
    }
    None
}

/// Daemon-side periodic refresh. Does nothing when the cache is still fresh,
/// so it is safe to call on a short tick. Returns the cache in effect
/// afterwards.
pub fn refresh_if_stale(paths: &AppPaths, now: u64) -> Option<UpdateCheckCache> {
    let path = cache_path(paths);
    let existing = load_cache(&path);
    if !is_stale(existing.as_ref(), now, REFRESH_INTERVAL) {
        return existing;
    }
    // A failed fetch keeps the last known tag but still stamps the attempt:
    // otherwise an offline machine re-tries on every single tick.
    let latest_tag = fetch_latest_tag()
        .or_else(|| existing.as_ref().map(|cache| cache.latest_tag.clone()))
        .unwrap_or_default();
    let cache = UpdateCheckCache {
        latest_tag,
        checked_at: now,
    };
    let _ = save_cache(&path, &cache);
    Some(cache)
}

/// CLI-side read. Cache only — never blocks on the network.
pub fn cached_update_notice(paths: &AppPaths, current_version: &str) -> Option<String> {
    let cache = load_cache(&cache_path(paths))?;
    update_notice(current_version, &cache.latest_tag)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths_in(dir: &Path) -> AppPaths {
        AppPaths {
            config_dir: dir.join("config"),
            data_dir: dir.join("data"),
            state_dir: dir.join("state"),
            cache_dir: dir.join("cache"),
            database_path: dir.join("data/archductor.db"),
            logs_dir: dir.join("state/logs"),
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("archductor-update-check-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn versions_compare_numerically_not_lexically() {
        assert_eq!(compare_versions("v0.10.0", "v0.9.0"), Ordering::Greater);
        assert_eq!(compare_versions("0.6.2", "v0.6.2"), Ordering::Equal);
        assert_eq!(compare_versions("v0.6.2", "0.7.0"), Ordering::Less);
        assert_eq!(compare_versions("v1.0.0", "v0.999.999"), Ordering::Greater);
    }

    #[test]
    fn a_prerelease_sorts_below_the_matching_release() {
        assert_eq!(compare_versions("v0.7.0-rc.1", "v0.7.0"), Ordering::Less);
        assert_eq!(compare_versions("v0.7.0", "v0.7.0-rc.1"), Ordering::Greater);
        // Still newer than the previous release, though.
        assert_eq!(compare_versions("v0.7.0-rc.1", "v0.6.2"), Ordering::Greater);
    }

    #[test]
    fn a_notice_appears_only_when_the_build_is_behind() {
        let notice = update_notice("0.6.2", "v0.7.0").expect("behind should notify");
        assert!(notice.contains("v0.6.2"), "{notice}");
        assert!(notice.contains("v0.7.0"), "{notice}");
        assert!(notice.contains(RELEASES_URL), "{notice}");
        assert_eq!(notice.lines().count(), 1, "notice must be one line");

        assert_eq!(update_notice("0.7.0", "v0.7.0"), None);
        assert_eq!(update_notice("0.8.0", "v0.7.0"), None);
        assert_eq!(update_notice("0.6.2", ""), None);
        assert_eq!(update_notice("0.6.2", "   "), None);
    }

    #[test]
    fn the_tag_is_read_out_of_a_release_payload() {
        let json = r#"{"tag_name":"v0.7.0","html_url":"https://x/1","somethingNew":true}"#;
        assert_eq!(
            latest_tag_from_release_json(json),
            Some("v0.7.0".to_owned())
        );
        assert_eq!(latest_tag_from_release_json("not json"), None);
        assert_eq!(latest_tag_from_release_json(r#"{"tag_name":""}"#), None);
        assert_eq!(latest_tag_from_release_json("{}"), None);
    }

    #[test]
    fn staleness_covers_no_cache_expiry_and_a_backwards_clock() {
        let interval = Duration::from_secs(100);
        assert!(is_stale(None, 1_000, interval));

        let fresh = UpdateCheckCache {
            latest_tag: "v0.7.0".into(),
            checked_at: 950,
        };
        assert!(!is_stale(Some(&fresh), 1_000, interval));

        let old = UpdateCheckCache {
            latest_tag: "v0.7.0".into(),
            checked_at: 900,
        };
        assert!(is_stale(Some(&old), 1_000, interval));

        let future = UpdateCheckCache {
            latest_tag: "v0.7.0".into(),
            checked_at: 5_000,
        };
        assert!(is_stale(Some(&future), 1_000, interval));
    }

    #[test]
    fn the_cache_round_trips_and_a_missing_file_is_not_an_error() {
        let dir = temp_dir("round-trip");
        let paths = paths_in(&dir);
        let path = cache_path(&paths);

        assert_eq!(load_cache(&path), None);

        let cache = UpdateCheckCache {
            latest_tag: "v0.7.0".into(),
            checked_at: 1_234,
        };
        save_cache(&path, &cache).expect("save");
        assert_eq!(load_cache(&path), Some(cache));

        std::fs::write(&path, "not json").expect("write garbage");
        assert_eq!(load_cache(&path), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_cli_notice_reads_the_cache_and_stays_quiet_without_one() {
        let dir = temp_dir("cli-notice");
        let paths = paths_in(&dir);

        assert_eq!(cached_update_notice(&paths, "0.6.2"), None);

        save_cache(
            &cache_path(&paths),
            &UpdateCheckCache {
                latest_tag: "v0.7.0".into(),
                checked_at: 1,
            },
        )
        .expect("save");

        let notice = cached_update_notice(&paths, "0.6.2").expect("behind should notify");
        assert!(notice.contains("v0.7.0"), "{notice}");
        assert_eq!(cached_update_notice(&paths, "0.7.0"), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_fresh_cache_is_left_alone_by_the_refresh() {
        let dir = temp_dir("fresh-refresh");
        let paths = paths_in(&dir);
        let cache = UpdateCheckCache {
            latest_tag: "v0.7.0".into(),
            checked_at: 1_000,
        };
        save_cache(&cache_path(&paths), &cache).expect("save");

        // Would hit the network if it considered this stale.
        let after = refresh_if_stale(&paths, 1_001);
        assert_eq!(after, Some(cache));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_version_stamp_falls_back_to_the_crate_version_in_a_dev_build() {
        // The test binary is never built by the release pipeline.
        assert!(!is_release_build());
        assert_eq!(current_version(), env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn the_fetch_commands_target_the_release_endpoint() {
        let gh = gh_api_args();
        assert_eq!(gh[0], "api");
        assert!(
            gh[1].ends_with("/releases/latest"),
            "{gh:?} should ask for the latest release"
        );
        assert!(gh[1].contains(RELEASES_REPO), "{gh:?}");

        let curl = curl_args();
        assert!(
            curl.iter().any(|arg| arg
                == &format!("https://api.github.com/repos/{RELEASES_REPO}/releases/latest")),
            "{curl:?}"
        );
        assert!(
            curl.iter().any(|arg| arg == "--fail"),
            "curl must not treat an HTTP error body as a payload: {curl:?}"
        );
    }
}

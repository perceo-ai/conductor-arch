# Final Review: Explicit Empty Collection Precedence

## Result

Core Settings now distinguishes an absent collection from an explicitly present
empty `[]` or `{}` while merging built-in, app Shared, repository-committed, and
Local layers. Absent collections inherit. Explicit empty collections clear the
inherited value.

Commits:

- `7f90f41 fix(settings): preserve empty collection overrides`
- `f8dabef fix(settings): preserve empty collection round trips`
- `51e4808 fix(settings): restore inherited collections on reset`
- `fix(settings): preserve advanced collection markers`

## Root Cause

Task 2 kept settings raw until the final effective merge, which fixed presence
for string-encoded Files to Copy values. The remaining collection fields still
discarded presence inside their raw structs:

- `#[serde(default)] Vec<_>` made absent and `[]` identical.
- A bare `BTreeMap` made absent and `{}` identical for view colors.
- Environment-variable and agent-profile maps were already optional, but merge
  eagerly converted both absent and empty maps to `default()`.
- List merges then used `is_empty() => inherit`, so an explicit clear inherited.

The same raw merge serves every layer boundary, so the defect affected Shared,
repository-committed, and Local settings.

### Persistence Re-review Root Cause

The first fix preserved presence only while raw layers were merged. Public
load/edit/save and CLI import/export still projected raw settings into
`RepositorySettings`, whose existing collection types intentionally represent
both absent and empty as an empty collection. Typed-to-raw conversion then
omitted every empty collection, so the next effective load inherited again.

The follow-up keeps the public typed structs unchanged and preserves presence at
the persistence boundary:

- Normal load/edit/save reads the destination raw document and retains an empty
  marker only for a field that was already present or was edited from non-empty
  to empty.
- Fresh CLI imports carry presence from the source TOML through new validated
  raw-source save/export helpers.
- GTK passes a narrow `SettingsCollectionField` list only for edited empty
  fields. Untouched absent fields are not materialized as clears.

### Reset And Exact-Edit Re-review Root Cause

Destination-preserving saves could not distinguish an ordinary typed edit from
an operation whose purpose is to remove an override. Consequently, Local
Recover Defaults re-preserved old empty markers, and deleting a collection key
from Advanced TOML could not remove the marker through the typed save path.

The final fix makes save intent explicit:

- Ordinary saves still preserve destination empty markers.
- Recover Defaults uses an exact replacement save, so default-empty fields are
  absent and inherited values become active again.
- Advanced TOML derives both present and explicitly empty collection fields;
  keys removed from the exact document are passed as targeted unsets.
- Explicit-empty and unset intent is available at both app Shared and repository
  save boundaries without changing public typed settings structs.

### Advanced Editor Baseline Re-review Root Cause

The Advanced editor was still populated by serializing typed customization
settings. That conversion intentionally omits empty collections, so an existing
raw clear marker disappeared from the displayed document before any user edit.
The exact-edit save path then mistook every absent collection for a deliberate
deletion during an unrelated scalar edit.

The editor now loads presence-preserving customization TOML from the current raw
Shared or Local source and retains that displayed document as its baseline.
Unset intent is derived only for collection fields that were present in the
baseline and are absent after the edit. Existing markers that remain displayed
stay explicit; deliberately deleted markers become absent and inherit again.

## Field Inventory

| Typed field | Raw encoding before | Fix |
| --- | --- | --- |
| `file_include_globs` | `Option<String>` | Already presence-aware; unchanged |
| `env_file_refs` | `Option<String>` | Already presence-aware; unchanged |
| `environment_variables` | `Option<BTreeMap<...>>` | Preserve `Some(empty)` during map merge |
| `customization.agent_profiles` | `Option<BTreeMap<...>>` | Preserve `Some(empty)` during profile-map merge |
| `customization.naming.pr_body_sections` | `Vec<String>` | `Option<Vec<String>>` |
| `customization.automation.required_local_files` | `Vec<String>` | `Option<Vec<String>>` |
| `customization.agent_profiles.*.mcp_servers` | `Vec<String>` | `Option<Vec<String>>` |
| `customization.view.colors` | `BTreeMap<String, String>` | `Option<BTreeMap<String, String>>` |
| `customization.view.dashboard_columns` | `Vec<String>` | `Option<Vec<String>>` |
| `customization.view.notification_rules` | `Vec<String>` | `Option<Vec<String>>` |
| `customization.view.command_palette_presets` | `Vec<String>` | `Option<Vec<String>>` |

Non-empty maps retain the existing key-overlay behavior. Explicitly empty maps
replace the inherited map. Scalar `Option<String>` fields still preserve
explicit empty strings.

## TDD Evidence

### RED

Production code was unchanged when these tests were first run:

- `cargo test -p archductor-core raw_shared_empty_collections_clear_builtin_collections -- --nocapture`
  - Exit 101 at `environment_variables`; the Shared `{}` inherited the built-in map.
- `cargo test -p archductor-core effective_settings_repository_empty_collections_clear_shared_collections -- --nocapture`
  - Exit 101 at `environment_variables`; repository `{}` inherited Shared values.
- `cargo test -p archductor-core effective_settings_local_empty_collections_clear_repository_collections -- --nocapture`
  - Exit 101 at `environment_variables`; Local `{}` inherited repository values.

Each test continues through vector, profile-map, MCP-server, color-map,
notification, dashboard, command-preset, PR-section, and local-file assertions
after the first failing map assertion is fixed.

### GREEN

- `cargo test -p archductor-core empty_collections -- --nocapture`
  - 3 passed.
- `cargo test -p archductor-core settings::tests -- --nocapture`
  - 38 passed.
  - Includes absent-collection inheritance and explicit-empty-string compatibility.
- `cargo test -p archductor-core --all-targets`
  - 484 unit tests, 2 PTY fixture tests, and 8 session-event integration tests passed.
- `cargo check -p archductor-core --all-targets`
  - Exit 0.
- `cargo clippy -p archductor-core --all-targets -- -D warnings`
  - Exit 0, no warnings.
- `cargo fmt --all -- --check`
  - Exit 0.
- `cargo test -p archductor --test cli_sessions cli_session_open_applies_app_shared_launch_settings -- --nocapture`
  - 1 passed; app Shared settings reached the CLI launch boundary.
- `cargo test -p archductor-gtk gtk_view_preferences_use_app_shared_settings -- --nocapture`
  - 1 passed; app Shared settings reached the GTK settings-consumer boundary.

No visual GTK launch was required because this changes non-visible core merge
semantics; the focused GTK app-aware boundary test compiled and exercised the
consumer path.

## Persistence Follow-up TDD Evidence

### RED

- `cargo test -p archductor-core load_save_preserves_explicit_empty_collection_presence -- --nocapture`
  - Exit 101 for app Shared, repository, and Local at the first inherited empty
    pattern assertion after public load/save.
- `cargo test -p archductor-core toml_import -- --nocapture`
  - Compile failure for the wished-for source-preserving Shared and repository
    TOML persistence APIs.
- `cargo test -p archductor --test cli_sessions cli_app_shared_import_export_preserves_explicit_empty_collections -- --nocapture`
  - Exit 101 because exported Shared settings omitted `file_include_globs = ""`.
- `cargo test -p archductor --test cli_sessions cli_exports_and_imports_repository_settings -- --nocapture`
  - Exit 101 because repository-to-Local import omitted the empty color map.
- `cargo test -p archductor-core explicit_empty_collection_fields -- --nocapture`
  - Compile failure for the wished-for explicit-empty save-intent API and TOML field parser.
- `cargo test -p archductor-gtk dirty_empty_collection_fields_are_forwarded_to_settings_save -- --nocapture`
  - Compile failure for the wished-for GTK dirty-field forwarding helper.

### GREEN

- `cargo test -p archductor-core settings::tests -- --nocapture`
  - 45 passed.
- `cargo test -p archductor-core --all-targets`
  - 495 unit tests, 2 PTY fixture tests, and 8 session-event integration tests passed.
- `cargo test -p archductor --all-targets`
  - 26 CLI unit tests and 9 CLI integration tests passed, including Shared and
    repository/Local explicit-empty import/export round trips.
- `cargo test -p archductor-gtk settings::tests -- --nocapture`
  - 21 passed, including dirty inherited-empty forwarding.
- `cargo check -p archductor-core -p archductor -p archductor-gtk --all-targets`
  - Exit 0, no warnings.
- `cargo clippy -p archductor-core -p archductor -p archductor-gtk --all-targets -- -D warnings`
  - Exit 0, no warnings.
- `cargo fmt --all -- --check`
  - Exit 0.
- Isolated `xvfb-run` GTK Settings launch
  - Exit 0.

## Compatibility And Risks

- Public typed settings structs and TOML field names are unchanged.
- Existing non-empty serialization and map-overlay semantics are unchanged.
- Standalone typed serializers continue omitting default empty collections,
  preserving existing output. File-backed save and import/export paths preserve
  explicit empty syntax from their raw destination/source document.
- Callers that create a new empty override from a typed value must provide the
  narrow explicit-empty field list. GTK does this only for dirty fields; absent
  untouched values still inherit.
- No database or settings schema migration was required.

## Reset And Removal Follow-up TDD Evidence

### RED

- `cargo test -p archductor-core repository_replacement_save_removes_collection_overrides -- --nocapture`
  - Compile failure for the wished-for exact replacement and collection-unset
    save APIs.
- `cargo test -p archductor-core present_collection_fields_parse_from_advanced_toml -- --nocapture`
  - Compile failure for the wished-for collection-presence parser.
- `cargo test -p archductor-gtk recover_defaults_removes_prior_empty_collection_markers -- --nocapture`
  - Compile failure for the wished-for GTK recovery replacement boundary.
- GTK Advanced TOML removal coverage was added before the new collection-intent
  helper existed; it required an `unset` result in addition to explicit-empty
  fields.

### GREEN

- `cargo test -p archductor-core settings::tests -- --nocapture`
  - 48 passed, including exact replacement, targeted unset, effective
    inheritance restoration, and Advanced TOML presence parsing.
- `cargo test -p archductor-gtk settings::tests -- --nocapture`
  - 23 passed, including Recover Defaults marker removal and exact Advanced TOML
    unset intent.
- `cargo test -p archductor-core -p archductor -p archductor-gtk --all-targets`
  - 498 core unit tests, 26 CLI unit tests, 9 CLI integration tests, and 443 GTK
    unit tests passed, plus core integration targets.
- CLI smoke: the full CLI integration target passed, including Shared and
  repository/Local explicit-empty import/export round trips.
- GTK smoke: isolated `xvfb-run` launch directly to the Settings page passed.
- `cargo check -p archductor-core -p archductor -p archductor-gtk --all-targets`
  - Exit 0, no warnings.
- `cargo clippy -p archductor-core -p archductor -p archductor-gtk --all-targets -- -D warnings`
  - Exit 0, no warnings.
- `cargo fmt --all -- --check`
  - Exit 0.

## Advanced Editor Baseline Follow-up TDD Evidence

### RED

- `cargo test -p archductor-core customization_source_toml_preserves_collection_presence -- --nocapture`
  - Compile failure for the wished-for app Shared and repository raw
    customization-source APIs.
- `cargo test -p archductor-gtk unrelated_advanced_scalar_edit_preserves_existing_empty_marker -- --nocapture`
  - Compile failure for the raw-source API and baseline-aware collection-intent
    helper.

### GREEN

- `cargo test -p archductor-core settings::tests -- --nocapture`
  - 49 passed, including presence-preserving customization source output.
- `cargo test -p archductor-gtk settings::tests -- --nocapture`
  - 24 passed, including unrelated scalar edits preserving raw clear markers,
    deliberate marker deletion restoring inherited values, Recover Defaults,
    and dirty-empty intent.
- `cargo test -p archductor-core -p archductor -p archductor-gtk --all-targets`
  - 499 core unit tests, 26 CLI unit tests, 9 CLI integration tests, and 444 GTK
    unit tests passed, plus core integration targets.
- CLI smoke: the full CLI integration target passed, including Shared and
  repository/Local explicit-empty import/export round trips.
- GTK smoke: isolated `xvfb-run` launch directly to the Settings page passed.
- `cargo check -p archductor-core -p archductor -p archductor-gtk --all-targets`
  - Exit 0, no warnings.
- `cargo clippy -p archductor-core -p archductor -p archductor-gtk --all-targets -- -D warnings`
  - Exit 0, no warnings.
- `cargo fmt --all -- --check`
  - Exit 0.

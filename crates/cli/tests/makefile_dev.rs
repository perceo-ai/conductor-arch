use std::fs;
use std::path::PathBuf;

#[test]
fn make_dev_cleanup_does_not_signal_its_own_process_group() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let makefile = fs::read_to_string(repo_root.join("Makefile")).expect("read root Makefile");

    assert!(
        !makefile.contains("kill 0"),
        "make dev cleanup must not signal the whole process group"
    );
    assert!(
        makefile.contains("cleanup_dev()"),
        "make dev should use an explicit cleanup function"
    );
    assert!(
        makefile.contains("archcar_pid") && makefile.contains("gtk_pid"),
        "make dev should terminate only the child processes it started"
    );
}

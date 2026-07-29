use std::fs;
use std::path::PathBuf;

fn makefile() -> String {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    fs::read_to_string(repo_root.join("Makefile")).expect("read root Makefile")
}

// The GTK `make dev`/`gtk`/`run` targets were retired with crates/gtk-app; the
// desktop UI dev loop is now `make desktop-dev` (the Electron app auto-spawns
// archcar). These assertions cover what remains.

#[test]
fn make_does_not_reference_the_retired_gtk_app() {
    let makefile = makefile();
    assert!(
        !makefile.contains("archductor-gtk") && !makefile.contains("--run-dev"),
        "Makefile should not reference the retired GTK app or its dev runner"
    );
}

#[test]
fn make_advertises_the_desktop_dev_target() {
    assert!(
        makefile().contains("desktop-dev"),
        "make help should advertise the Electron desktop dev target"
    );
}

#[test]
fn make_uses_msys2_bash_for_windows_dev_recipes() {
    let makefile = makefile();
    assert!(
        makefile.contains("ifeq ($(OS),Windows_NT)")
            && makefile.contains("SHELL := C:/msys64/usr/bin/bash.exe")
            && makefile
                .contains("DEV_ENV := C:/msys64/usr/bin/bash.exe scripts/dev-instance-env.sh"),
        "Windows make targets should use the required MSYS2 toolchain"
    );
}

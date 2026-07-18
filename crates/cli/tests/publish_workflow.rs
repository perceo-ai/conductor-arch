use std::fs;
use std::path::PathBuf;

#[test]
fn publish_build_uses_ci_verified_release_packaging() {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let publish = fs::read_to_string(repo_root.join(".github/workflows/publish.yml")).unwrap();
    let ci = fs::read_to_string(repo_root.join(".github/workflows/ci.yml")).unwrap();

    assert!(
        publish.contains("Verify Windows GTK pkg-config"),
        "Windows release should smoke-test pkgconf before cargo build"
    );
    assert!(
        !publish.contains("continue-on-error: true"),
        "publish should stay strict; CI should catch package failures before release"
    );
    assert!(
        ci.contains("linux-release-packages:"),
        "CI should build Linux release artifacts before publish"
    );
    assert!(
        ci.contains("windows-release-package:"),
        "CI should build the Windows portable ZIP before publish"
    );
    assert!(
        ci.contains("      - linux-release-packages")
            && ci.contains("      - windows-release-package")
            && ci.contains("linux-release-packages=${{ needs.linux-release-packages.result }}")
            && ci.contains("windows-release-package=${{ needs.windows-release-package.result }}"),
        "release package preview jobs should be required by ci-gate"
    );
    assert!(
        ci.contains("Build .deb") && ci.contains("Build .rpm") && ci.contains("Build AppImage"),
        "CI should exercise Linux package creation before publish"
    );
    assert!(
        ci.contains("Assemble portable Windows bundle") && ci.contains("Compress-Archive"),
        "CI should exercise Windows ZIP assembly before publish"
    );
    assert!(
        ci.contains("Scan release artifacts with Trivy"),
        "CI should scan generated release artifacts before publish"
    );
    assert!(
        publish.contains("\"PKG_CONFIG=$pkgconf\"") && ci.contains("\"PKG_CONFIG=$pkgconf\""),
        "Windows workflows should use pkgconf from the actual MSYS2 install"
    );
    assert!(
        publish.contains("steps.msys2.outputs.msys2-location")
            && ci.contains("steps.msys2.outputs.msys2-location"),
        "Windows workflows should derive MSYS2 paths from setup-msys2 output"
    );
    assert!(
        publish.contains("CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER: gcc"),
        "Windows release should use the PATH-resolved UCRT64 gcc executable"
    );
    assert!(
        !publish.contains("PKG_CONFIG: C:\\msys64\\ucrt64\\bin\\pkgconf.exe")
            && !ci.contains("PKG_CONFIG: C:\\msys64\\ucrt64\\bin\\pkgconf.exe"),
        "absolute MSYS pkgconf paths failed to spawn in GitHub Actions"
    );
    assert!(
        !publish.contains("C:\\msys64\\ucrt64") && !ci.contains("C:\\msys64\\ucrt64"),
        "Windows workflows should not assume setup-msys2 installs under C:\\msys64"
    );
}

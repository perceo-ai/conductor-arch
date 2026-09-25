#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$repo_root/scripts/release-readiness.sh"
aur_script="$repo_root/scripts/update-aur-checksum.sh"
homebrew_script="$repo_root/scripts/update-homebrew-formula.sh"
public_repo_script="$repo_root/scripts/check-public-repository-listing.sh"
required_docs=(
    docs/conductor-gui-mvp-handoff.md
    docs/mvp-scope.md
    docs/manual-testing-checklist.md
    docs/archductor-docs-parity-map.md
    packaging/public-repositories.md
    README.md
)
required_public_repo_files=(
    packaging/apt/archductor.sources
    packaging/rpm/archductor.repo
    packaging/official/debian-itp.md
    packaging/official/fedora-package-review.md
    packaging/official/homebrew-core-pr.md
)

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

file_mode() {
    if stat -c '%a' "$1" >/dev/null 2>&1; then
        stat -c '%a' "$1"
    else
        stat -f '%Lp' "$1"
    fi
}

for doc in "${required_docs[@]}"; do
    [ -s "$repo_root/$doc" ] || fail "required repository guidance doc missing or empty: $doc"
done

for path in "${required_public_repo_files[@]}"; do
    [ -s "$repo_root/$path" ] || fail "public repository listing file missing or empty: $path"
done

grep -Fxq "vendor: Perceo" "$repo_root/nfpm.yaml" \
    || fail "nfpm vendor must be Perceo"
grep -Fxq "homepage: https://github.com/perceo-ai/conductor-arch" "$repo_root/nfpm.yaml" \
    || fail "nfpm homepage must point at the public Perceo repository"
grep -Fq "Signed-By: /usr/share/keyrings/archductor-archive-keyring.gpg" "$repo_root/packaging/apt/archductor.sources" \
    || fail "APT source template must use a scoped signed-by keyring"
grep -Fq "repo_gpgcheck=1" "$repo_root/packaging/rpm/archductor.repo" \
    || fail "DNF repo template must require signed repository metadata"

output="$("$script" --help)"
[[ "$output" == *"Usage: scripts/release-readiness.sh"* ]] \
    || fail "help output did not include usage"

set +e
output="$("$script" --version main --skip-tests 2>&1)"
status=$?
set -e
[[ "$status" -eq 2 ]] || fail "invalid version exited $status, expected 2"
[[ "$output" == *"version must look like MAJOR.MINOR.PATCH"* ]] \
    || fail "invalid version output did not explain version format"

if [ "$(uname -s)" != "Linux" ]; then
    rm -rf "$repo_root/dist"
    output="$("$script" --version 0.1.0 --skip-tests --skip-doctor --skip-deny --package)"
    [[ "$output" == *"Linux release artifacts must be built on Linux or by CI"* ]] \
        || fail "non-Linux package mode did not explain package skip"
    [ ! -e "$repo_root/dist" ] || fail "non-Linux package mode created dist"
fi

output="$("$aur_script" --help)"
[[ "$output" == *"Usage: scripts/update-aur-checksum.sh"* ]] \
    || fail "AUR helper help output did not include usage"

set +e
output="$("$aur_script" 0.1.0 not-a-checksum 2>&1)"
status=$?
set -e
[[ "$status" -eq 2 ]] || fail "invalid AUR checksum exited $status, expected 2"
[[ "$output" == *"64-character SHA-256"* ]] \
    || fail "invalid AUR checksum output did not explain checksum format"

output="$("$public_repo_script" --help)"
[[ "$output" == *"Usage: scripts/check-public-repository-listing.sh"* ]] \
    || fail "public repository helper help output did not include usage"

set +e
output="$("$public_repo_script" --version nope 2>&1)"
status=$?
set -e
[[ "$status" -eq 2 ]] || fail "invalid public repository version exited $status, expected 2"
[[ "$output" == *"version must look like MAJOR.MINOR.PATCH"* ]] \
    || fail "invalid public repository version output did not explain version format"

output="$("$public_repo_script" --version 0.1.0 --metadata-only)"
[[ "$output" == *"public repository listing metadata: ok"* ]] \
    || fail "public repository metadata check did not pass"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
mkdir -p "$tmpdir/cli-dist" "$tmpdir/desktop-dist"
touch \
    "$tmpdir/cli-dist/archductor_0.1.0_amd64.deb" \
    "$tmpdir/cli-dist/archductor-0.1.0-1.x86_64.rpm" \
    "$tmpdir/cli-dist/SHA256SUMS" \
    "$tmpdir/desktop-dist/archductor-desktop_0.1.0_amd64.deb" \
    "$tmpdir/desktop-dist/archductor-desktop-0.1.0.x86_64.rpm"
output="$("$public_repo_script" --version 0.1.0 --require-artifacts \
    --cli-dist "$tmpdir/cli-dist" \
    --desktop-dist "$tmpdir/desktop-dist")"
[[ "$output" == *"public repository listing artifacts: ok"* ]] \
    || fail "public repository artifact check did not pass"

mkdir -p "$tmpdir/scripts" "$tmpdir/packaging/homebrew/Formula"
cp "$homebrew_script" "$tmpdir/scripts/update-homebrew-formula.sh"
cp "$repo_root/packaging/homebrew/Formula/archductor.rb" \
    "$tmpdir/packaging/homebrew/Formula/archductor.rb"
chmod 600 "$tmpdir/packaging/homebrew/Formula/archductor.rb"
(
    cd "$tmpdir"
    scripts/update-homebrew-formula.sh \
        0.1.1 \
        0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
        >/dev/null
)
formula_mode="$(file_mode "$tmpdir/packaging/homebrew/Formula/archductor.rb")"
[[ "$formula_mode" == "644" ]] \
    || fail "Homebrew formula update wrote mode $formula_mode, expected 644"

echo "release-readiness-test: ok"

#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'USAGE'
Usage: scripts/check-public-repository-listing.sh --version VERSION [options]

Checks local materials needed before publishing or submitting Archductor package
repository listings.

Options:
  --version VERSION      Release version without leading v, for example 0.1.0.
  --metadata-only        Check templates, docs, and package metadata only.
  --require-artifacts    Also require release .deb/.rpm artifacts and checksums.
  --cli-dist DIR         Directory containing CLI release artifacts. Default: dist.
  --desktop-dist DIR     Directory containing Electron desktop artifacts. Default: desktop/release.
  -h, --help             Show this help.
USAGE
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version=""
metadata_only=0
require_artifacts=0
cli_dist="dist"
desktop_dist="desktop/release"

fail() {
    echo "error: $*" >&2
    exit 1
}

while [ $# -gt 0 ]; do
    case "$1" in
        --version)
            [ $# -ge 2 ] || fail "--version requires a value"
            version="$2"
            shift 2
            ;;
        --metadata-only)
            metadata_only=1
            shift
            ;;
        --require-artifacts)
            require_artifacts=1
            shift
            ;;
        --cli-dist)
            [ $# -ge 2 ] || fail "--cli-dist requires a value"
            cli_dist="$2"
            shift 2
            ;;
        --desktop-dist)
            [ $# -ge 2 ] || fail "--desktop-dist requires a value"
            desktop_dist="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "error: unknown argument: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

if [ -z "$version" ]; then
    echo "error: --version is required" >&2
    usage >&2
    exit 2
fi

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
    echo "error: version must look like MAJOR.MINOR.PATCH, got: $version" >&2
    exit 2
fi

check_file() {
    local path="$1"
    [ -s "$repo_root/$path" ] || fail "missing or empty: $path"
}

check_contains() {
    local path="$1"
    local needle="$2"
    grep -Fq "$needle" "$repo_root/$path" || fail "$path does not contain: $needle"
}

check_glob() {
    local pattern="$1"
    compgen -G "$pattern" >/dev/null || fail "missing artifact matching: $pattern"
}

abs_dir() {
    case "$1" in
        /*) printf '%s\n' "$1" ;;
        *) printf '%s/%s\n' "$repo_root" "$1" ;;
    esac
}

check_file packaging/public-repositories.md
check_file packaging/apt/archductor.sources
check_file packaging/rpm/archductor.repo
check_file packaging/official/debian-itp.md
check_file packaging/official/fedora-package-review.md
check_file packaging/official/homebrew-core-pr.md
check_file packaging/homebrew/Formula/archductor.rb
check_file nfpm.yaml

check_contains nfpm.yaml "vendor: Perceo"
check_contains nfpm.yaml "homepage: https://github.com/perceo-ai/conductor-arch"
check_contains packaging/apt/archductor.sources "Signed-By: /usr/share/keyrings/archductor-archive-keyring.gpg"
check_contains packaging/rpm/archductor.repo "repo_gpgcheck=1"
check_contains packaging/public-repositories.md "Agents must not open official Debian, Ubuntu, Fedora, or Homebrew/core package"

if [ "$metadata_only" -eq 1 ] && [ "$require_artifacts" -eq 0 ]; then
    echo "public repository listing metadata: ok"
    exit 0
fi

if [ "$require_artifacts" -eq 0 ]; then
    echo "public repository listing metadata: ok"
    echo "artifact checks skipped; pass --require-artifacts after release packaging"
    exit 0
fi

cli_dist_abs="$(abs_dir "$cli_dist")"
desktop_dist_abs="$(abs_dir "$desktop_dist")"

check_glob "$cli_dist_abs/archductor_${version}_amd64.deb"
check_glob "$cli_dist_abs/archductor-${version}-1.x86_64.rpm"
check_glob "$cli_dist_abs/SHA256SUMS"
check_glob "$desktop_dist_abs/archductor-desktop_${version}_amd64.deb"
check_glob "$desktop_dist_abs/archductor-desktop-${version}.x86_64.rpm"

echo "public repository listing artifacts: ok"

#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'USAGE'
Usage: scripts/update-aur-checksum.sh VERSION SHA256

Updates packaging/aur/PKGBUILD with a release version and source checksum.

Example:
  scripts/update-aur-checksum.sh 0.1.0 \
    0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
USAGE
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
    usage
    exit 0
fi

if [ $# -ne 2 ]; then
    usage >&2
    exit 2
fi

version="$1"
checksum="$2"
pkgbuild="packaging/aur/PKGBUILD"

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
    echo "error: version must look like MAJOR.MINOR.PATCH, got: $version" >&2
    exit 2
fi

if [[ ! "$checksum" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "error: checksum must be a 64-character SHA-256 hex digest" >&2
    exit 2
fi

tmp="$(mktemp)"
sed -E \
    -e "s/^pkgver=.*/pkgver=$version/" \
    -e "s/^sha256sums=\\('.*'\\)/sha256sums=('$checksum')/" \
    "$pkgbuild" > "$tmp"
mv "$tmp" "$pkgbuild"

echo "Updated $pkgbuild to pkgver=$version"

#!/usr/bin/env bash
# Regenerate build/icon.icns from build/icon-macos.png.
#
# build/icon-macos.png is the macOS master: 1024x1024, fully opaque, artwork
# drawn edge to edge with no rounded corners of its own. macOS 26 and newer
# apply their own squircle mask to the app icon, and any transparency in the
# .icns makes the system treat the artwork as a loose logo and mount it on a
# light rounded plate -- the pale outline this master exists to avoid. The
# rounded build/icon.png is still the right source for Linux and Windows,
# which do not mask app icons.
#
# macOS only: needs sips and iconutil.
set -euo pipefail

build_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../build" && pwd)"
master="$build_dir/icon-macos.png"
iconset="$(mktemp -d)/icon.iconset"
trap 'rm -rf "$(dirname "$iconset")"' EXIT

mkdir -p "$iconset"

for spec in \
  16:icon_16x16 \
  32:icon_16x16@2x \
  32:icon_32x32 \
  64:icon_32x32@2x \
  128:icon_128x128 \
  256:icon_128x128@2x \
  256:icon_256x256 \
  512:icon_256x256@2x \
  512:icon_512x512 \
  1024:icon_512x512@2x; do
  size="${spec%%:*}"
  name="${spec##*:}"
  cp "$master" "$iconset/$name.png"
  sips -z "$size" "$size" "$iconset/$name.png" >/dev/null
done

iconutil -c icns "$iconset" -o "$build_dir/icon.icns"
echo "wrote $build_dir/icon.icns"

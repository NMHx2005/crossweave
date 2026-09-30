#!/bin/sh
# Regenerates build/icon.png and build/icon.icns from build/icon.svg (macOS: rsvg-convert from librsvg, iconutil).
# The SVG is the source of truth; its colours are the design tokens (src/ui/tokens.ts).
set -eu
cd "$(dirname "$0")/.."
work="$(mktemp -d)"
set="$work/icon.iconset"
mkdir -p "$set"
for size in 16 32 128 256 512; do
  rsvg-convert -w "$size" -h "$size" build/icon.svg -o "$set/icon_${size}x${size}.png"
  rsvg-convert -w "$((size * 2))" -h "$((size * 2))" build/icon.svg -o "$set/icon_${size}x${size}@2x.png"
done
rsvg-convert -w 1024 -h 1024 build/icon.svg -o build/icon.png
iconutil -c icns "$set" -o build/icon.icns
echo "wrote build/icon.png and build/icon.icns"

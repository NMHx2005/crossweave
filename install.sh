#!/bin/sh
set -eu

REPO="NMHx2005/crossweave"
INSTALL_DIR="${CW_INSTALL_DIR:-$HOME/.local/bin}"

os() {
  case "$(uname -s)" in
    Darwin) echo darwin ;;
    Linux) echo linux ;;
    *) echo "crossweave: unsupported OS: $(uname -s)" >&2; exit 1 ;;
  esac
}

arch() {
  case "$(uname -m)" in
    arm64|aarch64)
      if [ "$(os)" = "linux" ]; then
        echo "crossweave: unsupported arch on Linux: $(uname -m) (only linux-x64 is published)" >&2
        exit 1
      fi
      echo arm64 ;;
    x86_64|amd64) echo x64 ;;
    *) echo "crossweave: unsupported arch: $(uname -m)" >&2; exit 1 ;;
  esac
}

TARGET="$(os)-$(arch)"
VERSION="${CW_INSTALL_VERSION:-}"

api_url="https://api.github.com/repos/$REPO/releases/latest"
if [ -n "$VERSION" ]; then
  base_url="https://github.com/$REPO/releases/download/$VERSION"
else
  base_url=$(curl -fsSL "$api_url" | grep -o '"browser_download_url": *"[^"]*checksums.txt"' | sed -E 's/.*"(https:[^"]*)checksums.txt"/\1/')
  if [ -z "$base_url" ]; then
    echo "crossweave: could not resolve the latest release" >&2
    exit 1
  fi
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "crossweave: downloading for $TARGET..."
curl -fsSL -o "$tmp/cw-$TARGET" "${base_url}cw-$TARGET"
curl -fsSL -o "$tmp/cwd-$TARGET" "${base_url}cwd-$TARGET"
curl -fsSL -o "$tmp/checksums.txt" "${base_url}checksums.txt"

echo "crossweave: verifying checksums..."
(cd "$tmp" && grep "cw-$TARGET\$" checksums.txt | sha256sum -c -) || {
  echo "crossweave: checksum verification FAILED for cw-$TARGET — aborting, nothing installed" >&2
  exit 1
}
(cd "$tmp" && grep "cwd-$TARGET\$" checksums.txt | sha256sum -c -) || {
  echo "crossweave: checksum verification FAILED for cwd-$TARGET — aborting, nothing installed" >&2
  exit 1
}

mkdir -p "$INSTALL_DIR"
mv "$tmp/cw-$TARGET" "$INSTALL_DIR/cw"
mv "$tmp/cwd-$TARGET" "$INSTALL_DIR/cwd"
chmod +x "$INSTALL_DIR/cw" "$INSTALL_DIR/cwd"

mkdir -p "$HOME/.crossweave"
installed_version="${VERSION:-$("$INSTALL_DIR/cw" --version)}"
existing_update_check=true
if [ -f "$HOME/.crossweave/config.json" ]; then
  existing_update_check=$(grep -o '"updateCheck": *[a-z]*' "$HOME/.crossweave/config.json" | grep -o '[a-z]*$' || echo true)
fi
printf '{"installedVersion":"%s","updateCheck":%s,"lastCheckedAt":null,"lastKnownLatest":null,"lastNotifiedVersion":null}\n' \
  "$installed_version" "$existing_update_check" > "$HOME/.crossweave/config.json"

echo "crossweave: installed to $INSTALL_DIR/cw"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "crossweave: add this to your shell profile: export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac

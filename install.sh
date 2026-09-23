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
if [ -n "${CW_INSTALL_BASE_URL:-}" ]; then
  base_url="$CW_INSTALL_BASE_URL"
elif [ -n "$VERSION" ]; then
  base_url="https://github.com/$REPO/releases/download/$VERSION/"
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
curl -fsSL -o "$tmp/checksums.txt" "${base_url}checksums.txt"
curl -fsSL -o "$tmp/cw-$TARGET" "${base_url}cw-$TARGET"
curl -fsSL -o "$tmp/cwd-$TARGET" "${base_url}cwd-$TARGET"

cockpit_available=false
if [ "$TARGET" = "darwin-arm64" ] && awk '$2 == "cockpit-darwin-arm64.zip" { found=1 } END { exit !found }' "$tmp/checksums.txt"; then
  cockpit_available=true
  curl -fsSL -o "$tmp/cockpit-darwin-arm64.zip" "${base_url}cockpit-darwin-arm64.zip"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256_check() { sha256sum -c -; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_check() { shasum -a 256 -c -; }
else
  echo "crossweave: neither sha256sum nor shasum found — cannot verify checksums, aborting" >&2
  exit 1
fi

verify_one() {
  entry_name="$1"
  line=$(awk -v n="$entry_name" '$2 == n { print }' "$tmp/checksums.txt")
  if [ -z "$line" ]; then
    echo "crossweave: no checksum entry for $entry_name in checksums.txt — aborting, nothing installed" >&2
    exit 1
  fi
  printf '%s\n' "$line" | (cd "$tmp" && sha256_check) || {
    echo "crossweave: checksum verification FAILED for $entry_name — aborting, nothing installed" >&2
    exit 1
  }
}

echo "crossweave: verifying checksums..."
verify_one "cw-$TARGET"
verify_one "cwd-$TARGET"

staged_cockpit=""
if [ "$cockpit_available" = true ]; then
  verify_one "cockpit-darwin-arm64.zip"
  if ! command -v unzip >/dev/null 2>&1; then
    echo "crossweave: unzip is required to install Cockpit — aborting, nothing installed" >&2
    exit 1
  fi
  mkdir -p "$tmp/cockpit"
  unzip -q "$tmp/cockpit-darwin-arm64.zip" -d "$tmp/cockpit"
  staged_cockpit="$tmp/cockpit/crossweave Cockpit.app"
  cockpit_executable="$staged_cockpit/Contents/MacOS/crossweave Cockpit"
  if [ ! -d "$staged_cockpit" ] || [ ! -x "$cockpit_executable" ]; then
    echo "crossweave: Cockpit archive has an invalid app bundle — aborting, nothing installed" >&2
    exit 1
  fi
fi

mkdir -p "$INSTALL_DIR"
cw_target="$INSTALL_DIR/cw"
cwd_target="$INSTALL_DIR/cwd"
previous_cw="$tmp/previous-cw"
previous_cwd="$tmp/previous-cwd"
cockpit_target=""
previous_cockpit="$tmp/previous-crossweave-Cockpit.app"
config_dir="$HOME/.crossweave"
config_target="$config_dir/config.json"
previous_config="$tmp/previous-config.json"
staged_config="$tmp/config.json"
cw_installed=false
cwd_installed=false
cockpit_installed=false
config_installed=false
transaction_active=false
transaction_committed=false

rollback_install() {
  rollback_ok=true
  if [ "$config_installed" = true ] && [ -e "$config_target" ]; then
    mv "$config_target" "$tmp/failed-config.json" || rollback_ok=false
  fi
  if [ "$cockpit_installed" = true ] && [ -e "$cockpit_target" ]; then
    mv "$cockpit_target" "$tmp/failed-crossweave-Cockpit.app" || rollback_ok=false
  fi
  if [ "$cwd_installed" = true ] && [ -e "$cwd_target" ]; then
    mv "$cwd_target" "$tmp/failed-cwd" || rollback_ok=false
  fi
  if [ "$cw_installed" = true ] && [ -e "$cw_target" ]; then
    mv "$cw_target" "$tmp/failed-cw" || rollback_ok=false
  fi
  if [ -e "$previous_cw" ]; then mv "$previous_cw" "$cw_target" || rollback_ok=false; fi
  if [ -e "$previous_cwd" ]; then mv "$previous_cwd" "$cwd_target" || rollback_ok=false; fi
  if [ -n "$cockpit_target" ] && [ -e "$previous_cockpit" ]; then
    mv "$previous_cockpit" "$cockpit_target" || rollback_ok=false
  fi
  if [ -e "$previous_config" ]; then mv "$previous_config" "$config_target" || rollback_ok=false; fi
  [ "$rollback_ok" = true ]
}

cleanup() {
  status=$?
  trap - EXIT
  if [ "$transaction_active" = true ] && [ "$transaction_committed" != true ]; then
    if ! rollback_install; then
      echo "crossweave: rollback incomplete; recovery files retained at $tmp" >&2
      exit "$status"
    fi
  fi
  rm -rf "$tmp"
  exit "$status"
}
trap cleanup EXIT

# Prepare every destination and the next config before moving the current install.
# Once transaction_active flips, the EXIT trap restores every staged previous file.
if [ -n "$staged_cockpit" ]; then
  cockpit_install_dir="${CW_COCKPIT_INSTALL_DIR:-$HOME/Applications}"
  cockpit_target="$cockpit_install_dir/crossweave Cockpit.app"
  if ! mkdir -p "$cockpit_install_dir"; then
    echo "crossweave: could not create Cockpit destination — aborting, nothing installed" >&2
    exit 1
  fi
fi
if ! mkdir -p "$config_dir"; then
  echo "crossweave: could not create config directory — aborting, nothing installed" >&2
  exit 1
fi
if ! chmod +x "$tmp/cw-$TARGET" "$tmp/cwd-$TARGET"; then
  echo "crossweave: could not prepare the CLI and daemon — aborting, nothing installed" >&2
  exit 1
fi
installed_version="${VERSION:-$("$tmp/cw-$TARGET" --version)}"
existing_update_check=true
if [ -f "$config_target" ]; then
  existing_update_check=$(grep -o '"updateCheck": *[a-z]*' "$config_target" | grep -o '[a-z]*$' || echo true)
fi
printf '{"installedVersion":"%s","updateCheck":%s,"lastCheckedAt":null,"lastKnownLatest":null,"lastNotifiedVersion":null}\n' \
  "$installed_version" "$existing_update_check" > "$staged_config"

transaction_active=true
if [ -e "$cw_target" ] && ! mv "$cw_target" "$previous_cw"; then
  echo "crossweave: could not stage the existing CLI — previous install restored" >&2
  exit 1
fi
if [ -e "$cwd_target" ] && ! mv "$cwd_target" "$previous_cwd"; then
  echo "crossweave: could not stage the existing daemon — previous install restored" >&2
  exit 1
fi
if [ -n "$cockpit_target" ] && [ -e "$cockpit_target" ] && ! mv "$cockpit_target" "$previous_cockpit"; then
  echo "crossweave: could not stage the existing Cockpit — previous install restored" >&2
  exit 1
fi
if [ -e "$config_target" ] && ! mv "$config_target" "$previous_config"; then
  echo "crossweave: could not stage the existing config — previous install restored" >&2
  exit 1
fi

if ! mv "$tmp/cw-$TARGET" "$cw_target"; then
  echo "crossweave: could not install the CLI — previous install restored" >&2
  exit 1
fi
cw_installed=true
if ! mv "$tmp/cwd-$TARGET" "$cwd_target"; then
  echo "crossweave: could not install the daemon — previous install restored" >&2
  exit 1
fi
cwd_installed=true
if [ -n "$staged_cockpit" ]; then
  if ! mv "$staged_cockpit" "$cockpit_target"; then
    echo "crossweave: could not install Cockpit to $cockpit_target — previous install restored" >&2
    exit 1
  fi
  cockpit_installed=true
fi
if ! mv "$staged_config" "$config_target"; then
  echo "crossweave: could not install config — previous install restored" >&2
  exit 1
fi
config_installed=true
transaction_committed=true

if [ -n "$staged_cockpit" ]; then
  echo "crossweave: installed Cockpit to $cockpit_target"
fi

if [ "$(os)" = "linux" ] && ! command -v bwrap >/dev/null 2>&1; then
  echo "crossweave: bwrap not found — Linux sandbox will run unconfined until you install bubblewrap" >&2
fi
echo "crossweave: installed to $INSTALL_DIR/cw"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "crossweave: add this to your shell profile: export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac

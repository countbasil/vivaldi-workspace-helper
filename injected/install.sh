#!/usr/bin/env bash
# install.sh
# Installs workspace-route-watcher.js (into main.html) and window-toast.js
# (into window.html) into Vivaldi's app bundle. Run after any Vivaldi update.
#
# Mirrors vivaldi-theme-switcher/install-vivaldi-mods.sh -- same injection
# technique. Each script only checks for/inserts its own <script> tag, so
# this coexists with that project's custom.js tag if both are installed.
#
# Source files live in $MODS_DIR (default: directory of this script).
# Target is auto-detected from the newest version inside Vivaldi.app.

set -euo pipefail

MODS_DIR="${MODS_DIR:-$(cd "$(dirname "$0")" && pwd)}"
# Override e.g. VIVALDI_APP="/Applications/Vivaldi Snapshot.app" when running a snapshot build.
VIVALDI_APP="${VIVALDI_APP:-/Applications/Vivaldi.app}"
FRAMEWORK_VERSIONS="$VIVALDI_APP/Contents/Frameworks/Vivaldi Framework.framework/Versions"

for f in workspace-route-watcher.js window-toast.js; do
  if [[ ! -f "$MODS_DIR/$f" ]]; then
    echo "Error: $MODS_DIR/$f not found." >&2
    exit 1
  fi
done

if [[ ! -d "$FRAMEWORK_VERSIONS" ]]; then
  echo "Error: Vivaldi framework directory not found at:" >&2
  echo "  $FRAMEWORK_VERSIONS" >&2
  exit 1
fi

# Pick the newest version directory (skip "Current" symlink).
version=$(
  /bin/ls "$FRAMEWORK_VERSIONS" \
    | grep -E '^[0-9]+\.' \
    | sort -V \
    | tail -1
)
if [[ -z "$version" ]]; then
  echo "Error: no numeric version directory under $FRAMEWORK_VERSIONS" >&2
  exit 1
fi

DEST="$FRAMEWORK_VERSIONS/$version/Resources/vivaldi"
if [[ ! -d "$DEST" ]]; then
  echo "Error: resources dir not found: $DEST" >&2
  exit 1
fi

echo "Installing into Vivaldi $version"
echo "  Source: $MODS_DIR"
echo "  Dest:   $DEST"
echo

# Copies $1 (a script filename) into $DEST and patches $2 (an HTML filename
# in $DEST) to load it, idempotently (checks for its own tag only).
install_script() {
  local script_file="$1"
  local html_file="$2"

  cp -v "$MODS_DIR/$script_file" "$DEST/$script_file"

  local html_path="$DEST/$html_file"
  if [[ ! -f "$html_path" ]]; then
    echo "Error: $html_path missing (unexpected Vivaldi layout change)." >&2
    exit 1
  fi

  if grep -q "src=\"$script_file\"" "$html_path"; then
    echo "$html_file: already references $script_file (skipping patch)"
  else
    cp "$html_path" "$html_path.vwh.bak"
    /usr/bin/sed -i '' "s|</body>|    <script src=\"$script_file\"></script>\\
</body>|" "$html_path"
    if grep -q "src=\"$script_file\"" "$html_path"; then
      echo "$html_file: patched (backup at $html_file.vwh.bak)"
    else
      echo "Error: $html_file patch failed; restoring backup." >&2
      mv "$html_path.vwh.bak" "$html_path"
      exit 1
    fi
  fi
}

# 1) Detection logic -> main.html (the invisible host document).
install_script "workspace-route-watcher.js" "main.html"

# 2) Toast UI -> window.html (the visible per-window chrome document).
install_script "window-toast.js" "window.html"

echo
echo "Done. Restart Vivaldi to apply."

#!/bin/sh
EXT_NAME="praya@blankonlinux.id"
SRC="/usr/share/gnome-shell/extensions/$EXT_NAME"
DEST="$HOME/.local/share/gnome-shell/extensions/$EXT_NAME"
VERSION_FILE="$DEST/.installed-version"

# Exit if source doesn't exist (package removed)
[ -d "$SRC" ] || exit 0

# Get package version
PKG_VERSION=$(dpkg-query -W -f='${Version}' praya-gnome-shell-extension 2>/dev/null || echo "unknown")

# Check if already up to date
if [ -f "$VERSION_FILE" ] && [ "$(cat "$VERSION_FILE")" = "$PKG_VERSION" ]; then
    exit 0
fi

# Install or update
mkdir -p "$DEST"
cp -r "$SRC"/* "$DEST"/
echo "$PKG_VERSION" > "$VERSION_FILE"
gnome-extensions enable "$EXT_NAME" 2>/dev/null || true

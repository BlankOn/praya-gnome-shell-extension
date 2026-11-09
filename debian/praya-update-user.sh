#!/bin/sh
EXT_NAME="praya@blankonlinux.id"
# Overridable so the script can be exercised by the test suite without
# touching the real system extension or the user's home.
SRC="${PRAYA_EXT_SRC:-/usr/share/gnome-shell/extensions/$EXT_NAME}"
DEST="${PRAYA_EXT_DEST:-$HOME/.local/share/gnome-shell/extensions/$EXT_NAME}"
VERSION_FILE="$DEST/.installed-version"
AUTOSTART_FILE="$HOME/.config/autostart/praya-extension-update.desktop"

# If package source is gone, clean up user files and exit
if [ ! -d "$SRC" ]; then
    gnome-extensions disable "$EXT_NAME" 2>/dev/null || true
    rm -rf "$DEST"
    rm -f "$AUTOSTART_FILE"
    exit 0
fi

# Get package version
PKG_VERSION=$(dpkg-query -W -f='${Version}' praya-gnome-shell-extension 2>/dev/null || echo "unknown")

# Check if already up to date
if [ -f "$VERSION_FILE" ] && [ "$(cat "$VERSION_FILE")" = "$PKG_VERSION" ]; then
    exit 0
fi

# Install into a fresh directory and swap it into place instead of copying
# over the live extension.
INSTALL_DIR=$(dirname "$DEST")
STAGE="$INSTALL_DIR/.$EXT_NAME.new.$$"
OLD="$INSTALL_DIR/.$EXT_NAME.old.$$"

mkdir -p "$INSTALL_DIR" || exit 1

# Clean up a previous attempt of *this* process (there should be none).
rm -rf "$STAGE" "$OLD" || exit 1

if ! mkdir -p "$STAGE" || ! cp -a "$SRC/." "$STAGE/"; then
    echo "praya-update-user: failed to stage extension in $STAGE" >&2
    rm -rf "$STAGE"
    exit 1
fi

# Keep the old tree until the new one is in place, so a failed rename can be
# rolled back. `mv` of the symlink itself is fine: it never touches its target.
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
    if ! mv "$DEST" "$OLD"; then
        echo "praya-update-user: failed to move old extension out of the way" >&2
        rm -rf "$STAGE"
        exit 1
    fi
fi

if ! mv "$STAGE" "$DEST"; then
    echo "praya-update-user: failed to install extension into $DEST" >&2
    [ -e "$OLD" ] && mv "$OLD" "$DEST"
    rm -rf "$STAGE"
    exit 1
fi

rm -rf "$OLD"

# Only recorded after a complete, successful install, so a failed or
# interrupted update is retried on the next login.
echo "$PKG_VERSION" > "$VERSION_FILE"
gnome-extensions enable "$EXT_NAME" 2>/dev/null || true

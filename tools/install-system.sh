#!/bin/sh
# Install the working tree over the files the Debian package installed, for
# trying a build system-wide without rebuilding the .deb.
#
# Usage (as your normal user, NOT under sudo; it calls sudo itself):
#   tools/install-system.sh        # BlankOn variant
#   PRAYA_GENERIC=1 tools/install-system.sh
#
# The extension is staged with debian/install-extension.sh, so the file set is
# exactly what the package ships. The next package upgrade overwrites it.
set -e

GENERIC="${PRAYA_GENERIC:-0}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

if [ "$(id -u)" = 0 ]; then
	echo "install-system: run this as your normal user; it calls sudo itself." >&2
	echo "(Under sudo it cannot refresh your per-user copy of the extension.)" >&2
	exit 1
fi

UUID="$(PRAYA_GENERIC="$GENERIC" tools/gen-distro.sh --print-uuid)"
SYS_PARENT=/usr/share/gnome-shell/extensions
SYS_EXT="$SYS_PARENT/$UUID"

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# Stage as the user: nothing here needs root.
debian/install-extension.sh "$SCRATCH" "$GENERIC" >/dev/null
STAGED="$SCRATCH/usr/share/gnome-shell/extensions/$UUID"

echo "Installing $UUID into $SYS_EXT (sudo)..."
# Swap a fresh directory into place rather than copying over the live one:
# GNOME Shell mmaps the gettext catalog, and overwriting it in place corrupts
# translated strings in the running shell.
NEW="$SYS_PARENT/.$UUID.new.$$"
OLD="$SYS_PARENT/.$UUID.old.$$"
sudo sh -e -c '
	rm -rf "$2" "$3"
	cp -r "$1" "$2"
	chown -R root:root "$2"
	if [ -e "$4" ]; then mv "$4" "$3"; fi
	mv "$2" "$4"
	rm -rf "$3"
' sh "$STAGED" "$NEW" "$OLD" "$SYS_EXT"

if [ "$GENERIC" != 1 ]; then
	# BlankOn integration files, as debian/rules installs them.
	sudo install -d /usr/lib/praya-extension /usr/share/glib-2.0/schemas
	sudo install -m 755 debian/praya-update-user.sh /usr/lib/praya-extension/
	sudo install -m 644 debian/10_praya.gschema.override /usr/share/glib-2.0/schemas/
	sudo glib-compile-schemas /usr/share/glib-2.0/schemas

	# GNOME Shell prefers ~/.local over /usr/share, and the BlankOn updater
	# keeps a per-user copy there. Refresh it now from the new system files,
	# so the next login runs this build instead of the old copy.
	USER_EXT="$HOME/.local/share/gnome-shell/extensions/$UUID"
	rm -f "$USER_EXT/.installed-version"
	PRAYA_EXT_SRC="$SYS_EXT" PRAYA_EXT_DEST="$USER_EXT" sh debian/praya-update-user.sh
	echo "Refreshed your per-user copy in $USER_EXT"
else
	USER_EXT="$HOME/.local/share/gnome-shell/extensions/$UUID"
	if [ -e "$USER_EXT" ]; then
		echo "Note: $USER_EXT exists and takes precedence over the system copy." >&2
		echo "Remove it to use the system-wide install." >&2
	fi
fi

echo "Installed working tree to $SYS_EXT. Log out and back in to load it."

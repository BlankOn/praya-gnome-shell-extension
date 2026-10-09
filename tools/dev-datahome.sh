# Shared by run-rdp.sh and run-devkit.sh.
#
# Run the extension straight from the working tree, without installing it
# into ~/.local/share. GNOME Shell loads user extensions from
# $XDG_DATA_HOME/gnome-shell/extensions, so point that at a throwaway tree
# whose Praya entry is a symlink to this checkout.
#
# Only that one entry is overridden: everything else in the real data home is
# symlinked through, so user .desktop files, icons, fonts and the other
# installed extensions still resolve exactly as they normally would.
#
# The caller must set REPO_DIR and UUID before sourcing this file.

REAL_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
DEV_DATA_HOME="${XDG_RUNTIME_DIR:-/tmp}/praya-dev-datahome"

link_through() {
	# link_through <source dir> <target dir> <name to skip>
	local src="$1" dest="$2" skip="$3" entry name
	mkdir -p "$dest"
	for entry in "$src"/* "$src"/.[!.]*; do
		[ -e "$entry" ] || continue
		name="$(basename "$entry")"
		[ "$name" = "$skip" ] && continue
		ln -sfn "$entry" "$dest/$name"
	done
}

rm -rf "$DEV_DATA_HOME"
link_through "$REAL_DATA_HOME" "$DEV_DATA_HOME" gnome-shell
link_through "$REAL_DATA_HOME/gnome-shell" "$DEV_DATA_HOME/gnome-shell" extensions
link_through "$REAL_DATA_HOME/gnome-shell/extensions" \
	"$DEV_DATA_HOME/gnome-shell/extensions" "$UUID"
ln -sfn "$REPO_DIR" "$DEV_DATA_HOME/gnome-shell/extensions/$UUID"
export XDG_DATA_HOME="$DEV_DATA_HOME"

echo "==> Loading $UUID from $REPO_DIR (nothing installed to $REAL_DATA_HOME)"

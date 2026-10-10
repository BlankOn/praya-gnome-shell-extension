#!/bin/sh
# Stage the Praya extension into a Debian package tree for one variant.
#
# Usage:
#   debian/install-extension.sh <dest-dir> <PRAYA_GENERIC 0|1>
#
# Generates distro.js / distro.py / metadata.json for the variant into a
# scratch directory (so the working tree is left untouched), resolves the
# uuid, and installs the extension under
# <dest-dir>/usr/share/gnome-shell/extensions/<uuid>/.
set -e

DEST="$1"
GENERIC="$2"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

PRAYA_GENERIC="$GENERIC" PRAYA_DISTRO_OUT="$SCRATCH" tools/gen-distro.sh >/dev/null
UUID="$(cd "$SCRATCH" && node -e "import('./distro.js').then(m => console.log(m.UUID))")"

EXT="$DEST/usr/share/gnome-shell/extensions/$UUID"
install -d "$EXT"

# Variant-agnostic sources.
for f in extension.js indicator.js constants.js chatbot.js taskbar.js \
	translations.js touch-helper.js startButton.js stylesheet.css; do
	install -m 644 "$f" "$EXT/"
done
install -m 755 praya-preferences.py lowspec-dialog.py "$EXT/"

# Generated per-variant files.
install -m 644 "$SCRATCH/distro.js" "$SCRATCH/distro.py" "$SCRATCH/metadata.json" "$EXT/"

# Assets and translations.
install -d "$EXT/assets"
install -m 644 assets/logo-white.png "$EXT/assets/"
install -d "$EXT/locale"
for lang in $(cat po/LINGUAS); do
	install -d "$EXT/locale/$lang/LC_MESSAGES"
	install -m 644 "locale/$lang/LC_MESSAGES/praya.mo" "$EXT/locale/$lang/LC_MESSAGES/"
done

echo "Staged $UUID into $DEST"

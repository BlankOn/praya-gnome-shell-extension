#!/bin/sh
# Generate the variant-specific files (distro.js, distro.py, metadata.json)
# from their .in templates.
#
# Variant selection: set PRAYA_GENERIC=1 for the generic (other-distro) build.
# Any other value (or unset) builds the BlankOn variant.
#
# Output directory: defaults to the repo root. Override with PRAYA_DISTRO_OUT
# (used by the tests to generate into a scratch directory).
#
# Usage:
#   tools/gen-distro.sh            # BlankOn variant
#   PRAYA_GENERIC=1 tools/gen-distro.sh
#   PRAYA_DISTRO_OUT=/tmp/x tools/gen-distro.sh
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${PRAYA_DISTRO_OUT:-$REPO_DIR}"
mkdir -p "$OUT_DIR"
cd "$REPO_DIR"

if [ "${PRAYA_GENERIC:-0}" = "1" ]; then
    IS_GENERIC=true
    UUID="praya-generic@blankonlinux.id"
    HAS_BLANKON_ABOUT=false
    JS_MODES="['image', 'icon', 'text', 'icon_text']"
    PY_MODES="['image', 'icon', 'text', 'icon_text']"
    JS_DEFAULT="{ mode: 'icon_text', iconName: 'start-here-symbolic', text: 'Applications', imageHeight: 16 }"
    PY_DEFAULT="{'mode': 'icon_text', 'iconName': 'start-here-symbolic', 'text': 'Applications', 'imageHeight': 16}"
else
    IS_GENERIC=false
    UUID="praya@blankonlinux.id"
    HAS_BLANKON_ABOUT=true
    JS_MODES="['default', 'image', 'icon', 'text', 'icon_text']"
    PY_MODES="['default', 'image', 'icon', 'text', 'icon_text']"
    JS_DEFAULT="{ mode: 'default', iconName: 'start-here-symbolic', text: 'Start', imageHeight: 16 }"
    PY_DEFAULT="{'mode': 'default', 'iconName': 'start-here-symbolic', 'text': 'Start', 'imageHeight': 16}"
fi

# Python uses True/False, JavaScript uses true/false.
if [ "$IS_GENERIC" = "true" ]; then
    PY_IS_GENERIC=True
else
    PY_IS_GENERIC=False
fi
if [ "$HAS_BLANKON_ABOUT" = "true" ]; then
    PY_HAS_BLANKON_ABOUT=True
else
    PY_HAS_BLANKON_ABOUT=False
fi

subst() {
    # subst <template> <output>
    tpl="$1"; out="$2"
    sed \
        -e "s|@IS_GENERIC@|$IS_GENERIC|g" \
        -e "s|@IS_GENERIC_PY@|$PY_IS_GENERIC|g" \
        -e "s|@UUID@|$UUID|g" \
        -e "s|@HAS_BLANKON_ABOUT@|$HAS_BLANKON_ABOUT|g" \
        -e "s|@HAS_BLANKON_ABOUT_PY@|$PY_HAS_BLANKON_ABOUT|g" \
        -e "s|@START_BUTTON_MODES@|$JS_MODES|g" \
        -e "s|@START_BUTTON_MODES_PY@|$PY_MODES|g" \
        -e "s|@DEFAULT_START_BUTTON@|$JS_DEFAULT|g" \
        -e "s|@DEFAULT_START_BUTTON_PY@|$PY_DEFAULT|g" \
        "$tpl" > "$out"
}

subst distro.js.in "$OUT_DIR/distro.js"
subst distro.py.in "$OUT_DIR/distro.py"
subst metadata.json.in "$OUT_DIR/metadata.json"

echo "==> Generated distro.js, distro.py, metadata.json in $OUT_DIR (variant: $UUID)"

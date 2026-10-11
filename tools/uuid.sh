#!/bin/sh
# Print the extension uuid for the current variant by reading the generated
# distro.js. If distro.js is missing, generate it first (BlankOn variant
# unless PRAYA_GENERIC=1).
#
# Usage:
#   UUID="$(tools/uuid.sh)"
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -f "$REPO_DIR/distro.js" ]; then
    "$REPO_DIR/tools/gen-distro.sh" >/dev/null
fi

cd "$REPO_DIR"
node -e "import('./distro.js').then(m => console.log(m.UUID))"

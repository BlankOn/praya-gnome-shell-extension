#!/bin/sh
# Print the extension uuid for the current variant.
#
# The uuid is derived from the variant by tools/gen-distro.sh, which knows the
# mapping. Query it with --print-uuid so no generated file (and no JavaScript
# runtime) is needed.
#
# Usage:
#   UUID="$(tools/uuid.sh)"
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

exec "$REPO_DIR/tools/gen-distro.sh" --print-uuid

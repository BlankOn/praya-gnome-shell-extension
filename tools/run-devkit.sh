#!/bin/bash
# Run a nested GNOME Shell using GNOME 50's `--devkit` (the replacement for
# the removed `--nested`), loading the Praya extension straight from the
# working tree and enabling it. No RDP involved.
#
# Invoked by `make run-mutter-devkit`, which wraps it in dbus-run-session so
# the nested shell gets its own session bus instead of registering its
# services on the one your real desktop is using.
set -e

UUID="praya@blankonlinux.id"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Load the extension from the working tree via a throwaway data home.
source "$REPO_DIR/tools/dev-datahome.sh"

SHELL_PID=""
cleanup() {
	trap - EXIT INT TERM
	echo
	echo "==> Shutting down"
	[ -n "$SHELL_PID" ] && kill "$SHELL_PID" 2>/dev/null
	wait 2>/dev/null
	exit 0
}
trap cleanup EXIT INT TERM

echo "==> Starting nested GNOME Shell (devkit)"
gnome-shell --devkit --wayland &
SHELL_PID=$!

# A brand new data home carries no enabled-extensions state of its own, so
# wait for the shell's extension service and enable Praya explicitly.
echo "==> Waiting for GNOME Shell to come up"
for _ in $(seq 60); do
	if gnome-extensions list 2>/dev/null | grep -qx "$UUID"; then
		echo "==> Enabling $UUID"
		gnome-extensions enable "$UUID" || true
		break
	fi
	sleep 0.5
done

wait "$SHELL_PID"

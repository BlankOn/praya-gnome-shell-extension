#!/bin/bash
# Inner half of tests/test-session-menu.sh — runs inside dbus-run-session.
# Expects DATA_HOME, UUID, LOG and TIMEOUT in the environment.
set -u

export XDG_DATA_HOME="$DATA_HOME"

gnome-shell --devkit --wayland >"$LOG" 2>&1 &
SHELL_PID=$!

# Wait for the shell's extension service, then enable Praya so it loads from the
# throwaway data home the test set up.
for _ in $(seq 60); do
    gnome-extensions list 2>/dev/null | grep -qx "$UUID" && break
    sleep 0.5
done
gnome-extensions enable "$UUID" 2>/dev/null || true

# Wait for the harness sentinel.
for _ in $(seq $((TIMEOUT * 2))); do
    grep -q 'PRAYA-TEST DONE' "$LOG" 2>/dev/null && break
    sleep 0.5
done

kill "$SHELL_PID" 2>/dev/null
wait 2>/dev/null

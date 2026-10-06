#!/bin/bash
#
# Integration test for the Praya session menu (the Profile | Lock | Power
# footer). It runs a nested GNOME Shell (GNOME 50 `--devkit`) against a
# throwaway copy of the extension whose extension.js runs
# tests/selftest-harness.js, then reports the results.
#
# Usage:
#     tests/test-session-menu.sh
#
# Requirements: gnome-shell 50+ with /usr/libexec/mutter-devkit, plus
# dbus-run-session and gnome-extensions on PATH, and a graphical session to
# open the nested shell window. Exit status is 0 when every check passes.
#
set -u

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
UUID="praya@blankonlinux.id"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/praya-selftest.XXXXXX")"
EXT_DIR="$WORK/ext"
DATA_HOME="$WORK/data"
LOG="$WORK/shell.log"
TIMEOUT=45

SHELL_PID=""
cleanup() {
    [ -n "$SHELL_PID" ] && kill "$SHELL_PID" 2>/dev/null
    rm -rf "$WORK"
}
trap cleanup EXIT

# 1. Copy the extension files (the same set the Makefile installs).
mkdir -p "$EXT_DIR"
for f in extension.js indicator.js constants.js chatbot.js taskbar.js \
         translations.js touch-helper.js metadata.json stylesheet.css \
         lowspec-dialog.py praya-preferences.py assets locale; do
    cp -r "$REPO_DIR/$f" "$EXT_DIR/"
done

# 2. Append the self-test harness so it runs when the shell loads the extension.
cat "$REPO_DIR/tests/selftest-harness.js" >> "$EXT_DIR/extension.js"

# 3. Point a throwaway data home at the copy.
mkdir -p "$DATA_HOME/gnome-shell/extensions"
ln -sfn "$EXT_DIR" "$DATA_HOME/gnome-shell/extensions/$UUID"

# 4. Run the nested shell in its own session bus and wait for the harness.
#    The shell's own output (with the PRAYA-TEST lines) goes to $LOG; the private
#    bus/portal chatter goes to session.log so the report stays readable.
export DATA_HOME UUID LOG TIMEOUT
dbus-run-session -- bash "$REPO_DIR/tests/selftest-run.sh" \
    >"$WORK/session.log" 2>&1 || true

# 5. Report.
echo
echo "==== Praya session-menu self-test ===="
if [ -f "$LOG" ]; then
    grep 'PRAYA-TEST' "$LOG" | sed 's/.*PRAYA-TEST //'
fi
echo "====================================="

if [ ! -f "$LOG" ] || ! grep -q 'PRAYA-TEST DONE' "$LOG"; then
    echo "RESULT: FAIL (the test did not finish)"
    echo "---- last shell output ----"
    tail -n 20 "$LOG" 2>/dev/null
    echo "---- last session output ----"
    tail -n 20 "$WORK/session.log" 2>/dev/null
    exit 1
fi

if grep -q 'PRAYA-TEST FAIL' "$LOG"; then
    echo "RESULT: FAIL"
    exit 1
fi

echo "RESULT: PASS"

#!/bin/bash
# Run GNOME Shell headless + gnome-remote-desktop on a private D-Bus session,
# so the Praya extension can be tested from an RDP client.
#
# GNOME 50 removed `gnome-shell --nested`; its replacement, `--devkit`, needs
# /usr/libexec/mutter-devkit, which Debian/BlankOn does not ship. This is the
# workaround: a headless shell you view over RDP.
#
# Invoked by `make run`, which wraps it in dbus-run-session.
set -e

RDP_PORT="${RDP_PORT:-3390}"
RDP_USER="${RDP_USER:-praya}"
RDP_PASS="${RDP_PASS:-praya}"
RDP_SIZE="${RDP_SIZE:-1920x1080}"
# Set RDP_CLIENT=0 to only serve, and connect yourself (Remmina, another host).
RDP_CLIENT="${RDP_CLIENT:-1}"
CERT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/praya-test-rdp"
UUID="praya@blankonlinux.id"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Run the extension straight from the working tree, without installing it
# into ~/.local/share. GNOME Shell loads user extensions from
# $XDG_DATA_HOME/gnome-shell/extensions, so point that at a throwaway tree
# whose Praya entry is a symlink to this checkout.
#
# Only that one entry is overridden: everything else in the real data home is
# symlinked through, so user .desktop files, icons, fonts and the other
# installed extensions still resolve exactly as they normally would.
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

# grdctl writes *global* per-user configuration, which a running daemon watches.
# A second instance would therefore reconfigure the first one out from under
# itself and kill the session you are using. Take a lock instead.
LOCK="${XDG_RUNTIME_DIR:-/tmp}/praya-run-rdp.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
	echo "!!! Another $(basename "$0") is already running."
	echo "!!! Stop it first - gnome-remote-desktop config is per-user and global,"
	echo "!!! so a second session would break the one you are already using."
	exit 1
fi

# gnome-remote-desktop refuses to start its RDP backend without a TLS cert.
if [ ! -f "$CERT_DIR/rdp.crt" ] || [ ! -f "$CERT_DIR/rdp.key" ]; then
	echo "==> Generating self-signed TLS certificate in $CERT_DIR"
	mkdir -p "$CERT_DIR"
	openssl req -new -newkey rsa:4096 -days 3650 -nodes -x509 \
		-subj "/C=ID/ST=./L=./O=praya-test/CN=localhost" \
		-keyout "$CERT_DIR/rdp.key" -out "$CERT_DIR/rdp.crt" >/dev/null 2>&1
	chmod 600 "$CERT_DIR/rdp.key"
fi

# Filter gnome-remote-desktop's TPM/FreeRDP startup noise.
grd_quiet() { grdctl "$@" 2>&1 | grep -viE "Init TPM credentials|freerdp|certificate is invalid" || true; }

echo "==> Configuring gnome-remote-desktop (port $RDP_PORT, user $RDP_USER)"
grd_quiet --headless rdp set-tls-cert "$CERT_DIR/rdp.crt"
grd_quiet --headless rdp set-tls-key "$CERT_DIR/rdp.key"
grd_quiet --headless rdp set-port "$RDP_PORT"
grd_quiet --headless rdp disable-port-negotiation
grd_quiet --headless rdp set-credentials "$RDP_USER" "$RDP_PASS"
grd_quiet --headless rdp enable

# `grdctl enable` D-Bus-activates the user's own gnome-remote-desktop units.
# Those belong to the real desktop session and would steal $RDP_PORT, so the
# daemon we start below could not bind it. Stop them and wait for the release.
systemctl --user stop gnome-remote-desktop-headless.service \
	gnome-remote-desktop.service >/dev/null 2>&1 || true
# Also reap a daemon left behind by a previous run that did not exit cleanly.
pkill -u "$USER" -f "gnome-remote-desktop-daemon --headless --rdp-port $RDP_PORT" \
	>/dev/null 2>&1 || true
for _ in $(seq 20); do
	ss -ltn 2>/dev/null | grep -q ":$RDP_PORT " || break
	sleep 0.25
done

SHELL_PID=""
GRD_PID=""
CLIENT_PID=""
cleanup() {
	trap - EXIT INT TERM
	echo
	echo "==> Shutting down"
	[ -n "$CLIENT_PID" ] && kill "$CLIENT_PID" 2>/dev/null
	[ -n "$GRD_PID" ] && kill "$GRD_PID" 2>/dev/null
	[ -n "$SHELL_PID" ] && kill "$SHELL_PID" 2>/dev/null
	wait 2>/dev/null
	exit 0
}
trap cleanup EXIT INT TERM

echo "==> Starting headless GNOME Shell"
gnome-shell --headless --wayland &
SHELL_PID=$!
sleep 5

echo "==> Starting gnome-remote-desktop"
/usr/libexec/gnome-remote-desktop-daemon --headless --rdp-port "$RDP_PORT" &
GRD_PID=$!
sleep 3

# Wait for the RDP server to actually accept connections before dialling it.
for _ in $(seq 40); do
	ss -ltn 2>/dev/null | grep -q ":$RDP_PORT " && break
	sleep 0.25
done

if [ "$RDP_CLIENT" = "1" ] && command -v xfreerdp3 >/dev/null 2>&1; then
	echo "==> Connecting with xfreerdp3 ($RDP_SIZE)"
	xfreerdp3 "/v:localhost:$RDP_PORT" "/u:$RDP_USER" "/p:$RDP_PASS" \
		"/size:$RDP_SIZE" /cert:ignore &
	CLIENT_PID=$!
fi

cat <<MSG

=====================================================================
 RDP server on localhost:$RDP_PORT  --  user $RDP_USER / password $RDP_PASS

 Reconnect (or connect from elsewhere) with:
   xfreerdp3 /v:localhost:$RDP_PORT /u:$RDP_USER /p:$RDP_PASS \\
             /size:$RDP_SIZE /cert:ignore
   remmina  -> server localhost:$RDP_PORT, resolution $RDP_SIZE

 Closing the client window leaves the server up, so you can reconnect.
 Ctrl+C here stops the shell, the RDP server and the client together.
=====================================================================

MSG

# If either process dies, fall through to cleanup and take the other with it.
wait -n "$SHELL_PID" "$GRD_PID"

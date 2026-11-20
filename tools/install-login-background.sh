#!/bin/sh
set -eu

SRC=$(cd "$(dirname "$0")" && pwd)
HELPER=/usr/lib/praya-extension/blankon-login-background
POLICY=/usr/share/polkit-1/actions/id.blankon.loginbackground.policy

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }

if ! command -v glib-compile-resources >/dev/null 2>&1; then
    apt-get install -y libglib2.0-dev-bin
fi

install -d -m 0755 "$(dirname "$HELPER")"
install -m 0755 -o root -g root "$SRC/blankon-login-background" "$HELPER"
install -m 0644 -o root -g root "$SRC/id.blankon.loginbackground.policy" "$POLICY"

echo "Installed $HELPER and $POLICY"
pkaction --action-id id.blankon.loginbackground.set --verbose >/dev/null

# Test for the Praya session menu

`test-session-menu.sh` verifies the footer session menu — the
`Profile | Lock | Power` row in `indicator.js` — by running it inside a real
nested GNOME Shell and asserting on the live widget tree.

It covers the behaviour of the menu rework:

- The profile row has a **Lock button** and a **Power toggle**.
- **Lock has no dropdown** (it locks the screen directly).
- The **Power dropdown** lists 6 rows — Suspend, Restart, Power Off, a
  horizontal separator, Log Out, and Switch User.
- The dropdown starts closed and contributes no height.
- Toggling Power opens the dropdown to exactly its measured height, the last
  row is **not clipped**, and the bottom section grows to fit.
- Toggling again closes it and restores the collapsed height.

## Requirements

- GNOME Shell 50+ with `/usr/libexec/mutter-devkit` (GNOME 50 replaced
  `gnome-shell --nested` with `--devkit`).
- `dbus-run-session` and `gnome-extensions` on `PATH`.
- A graphical session, since the nested shell opens a window.

## Running

```bash
tests/test-session-menu.sh
```

Exit status is `0` when every check passes and `1` otherwise. Example:

```
==== Praya session-menu self-test ====
PASS bottom section was built
PASS Lock button exists in the profile row
PASS Power toggle exists in the profile row
PASS Lock has no dropdown (it locks directly)
PASS Power dropdown exists
PASS Power dropdown lists 6 rows (got 6)
PASS row 4 is a horizontal separator
PASS last row is Switch User (got "Switch User")
PASS dropdown starts closed
PASS closed dropdown contributes no height
PASS dropdown opens when toggled
PASS open dropdown height matches target (285 vs 285)
PASS last row is fully visible, not clipped (bottom 279.0 <= box 285)
PASS bottom section height accounts for the open dropdown
PASS dropdown closes on second toggle
PASS dropdown height returns to 0
PASS bottom section returns to its collapsed height
PASS summary: 17/17 checks passed
DONE
=====================================
RESULT: PASS
```

## How it works

1. `test-session-menu.sh` copies the extension files into a temporary directory
   (the repo is never modified) and points a throwaway
   `XDG_DATA_HOME/gnome-shell/extensions/praya@blankonlinux.id` symlink at it.
2. `tests/selftest-harness.js` is appended to that copy's `extension.js`, so it
   runs when the shell loads the extension. It waits for the `praya-indicator`
   status area, opens the panel, then toggles the Power dropdown and logs
   `PRAYA-TEST PASS|FAIL <message>` lines.
3. `tests/selftest-run.sh` runs once inside `dbus-run-session`: it starts
   `gnome-shell --devkit --wayland`, enables the extension, and waits for the
   `PRAYA-TEST DONE` sentinel.
4. The outer script parses the log and prints a pass/fail summary.

The harness uses `GLib` and `Main`, which are already imported by
`extension.js`, so it needs no imports of its own.

## Adding checks

Add `_prayaTestCheck(condition, 'message')` calls to the relevant step in
`tests/selftest-harness.js`. Steps that need the layout to settle should be
nested inside a `GLib.timeout_add(..., 500, ...)` like the existing ones.

## Limitations

- This is an integration test, not a unit test: it needs a GNOME Shell with
  `mutter-devkit`, so it is skipped on setups without them (e.g. Debian/BlankOn,
  where the project uses the RDP path instead).
- It only exercises layout and state. The actual Lock/Suspend/Restart/Power Off
  actions depend on the real session (`gnome-session`/login manager) and cannot
  take effect from a nested session, so they are not invoked here.

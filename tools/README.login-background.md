# Login background setting for Praya

Adds a **Login Screen** page to Praya Preferences where a user can pick a
picture for the GDM login screen and adjust blur and opacity.

## Architecture

The GDM greeter runs as a separate user before any user session, so the
preferences GUI (which runs as the user) cannot change it directly. The
feature is therefore split:

```
Praya Preferences (user)
  └─ pkexec → blankon-login-background (root, polkit-protected)
       ├─ re-encode picture (fit 1920x1080, Gaussian blur, alpha/opacity)
       ├─ write /usr/share/backgrounds/blankon-login/user-<uid>.png  (0644)
       ├─ set picture-uri / picture-uri-dark in greeter dconf
       └─ rebuild /usr/share/gnome-shell/gnome-shell-theme.gresource
          with a #lockDialogGroup background-image CSS rule
```

GNOME Shell 50 skips creating a background manager in greeter mode
(`layout.js`: `if (Main.sessionMode.isGreeter) return`), so the
`org.gnome.desktop.background` dconf keys are **not** used on the login
screen. The visible background comes from the shell CSS theme, which is
why the theme bundle has to be rebuilt. Both changes are applied so the
setting also works if upstream ever restores dconf-based greeter
backgrounds.

The image is copied out of the home directory because `/home/<user>` is
mode `0700` and the greeter cannot read it. Backups are made on first use:

- `/etc/gdm3/greeter.dconf-defaults.praya-backup`
- `/usr/share/gnome-shell/gnome-shell-theme.gresource.praya-backup`

**Reset** restores both. Rebuilding the theme requires
`glib-compile-resources` (package `libglib2.0-dev-bin`).

## Files

| File | Purpose |
|---|---|
| `tools/blankon-login-background` | Root helper (system Python 3 + Pillow) |
| `tools/id.blankon.loginbackground.policy` | polkit action tied to the helper path |
| `tools/install-login-background.sh` | Manual install for development/testing |
| `../examples/login-background/` | Example pictures used in the PR |
| `praya-preferences.py` | Adds the Login Screen tab |

## Install

The BlankOn Debian package installs the helper and policy automatically
(see `debian/rules`). For a development checkout:

```sh
sudo tools/install-login-background.sh
make install-user
```

Verify the polkit action with:

```sh
pkaction --action-id id.blankon.loginbackground.set --verbose
```

## Known limitations

- GDM has **one** background for the whole greeter. This sets it globally;
  with multiple users, whoever changes it last wins. True per-user
  login backgrounds need greeter-side code (gnome-shell patch/extension)
  reading `org.freedesktop.DisplayManager.AccountsService.BackgroundFile`.
- The theme bundle is read at shell startup; **log out and back in**
  (or reboot) to see the change on the login screen.
- The user is authenticated by polkit (`auth_admin_keep`) before the helper
  runs.
- Rebuilding the theme requires `glib-compile-resources`
  (`libglib2.0-dev-bin`) and `gresource` (`libglib2.0-bin`).

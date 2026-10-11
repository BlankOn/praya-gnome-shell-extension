# Praya GNOME Shell Extension

## Version Bumping

When bumping the version, update **all three** places:

1. **`constants.js`** — `export const VERSION = 'x.y.z';`
2. **`debian/changelog`** — add a new entry at the top with the new version `praya-gnome-shell-extension (x.y.z-1)`
3. **`praya-preferences.py`** — `VERSION = 'x.y.z'`

## Translations

When adding or modifying UI strings, always maintain both **English** and **Bahasa Indonesia** translations:

- Wrap strings with `_('...')` for translation support
- Update **`po/id.po`** with the corresponding Bahasa Indonesia translation

## Tests

Run the unit tests with:

```
make test
```

This runs the Node tests for the JS helpers (`*.test.js` via `node --test`)
and the Python `unittest` suite (`test_*.py`). The pure start-button logic
lives in **`startButton.js`** so it can be tested without GNOME Shell.

## Build variants

The extension ships in two variants built from one source tree:

- **BlankOn** (default) — uuid `praya@blankonlinux.id`, keeps the BlankOn
  branding, the "Default logo" start-button option, and the distro-specific
  packaging (gschema override, per-user updater, autostart).
- **Generic** — uuid `praya-generic@blankonlinux.id`, no BlankOn branding, no
  "Default logo" option, start button defaults to an "Applications" icon+text.

Select the variant at build time with the `PRAYA_GENERIC=1` environment flag.

The variant is baked in by the generator **`tools/gen-distro.sh`**, which
renders the templates **`distro.js.in`**, **`distro.py.in`** and
**`metadata.json.in`** into the git-ignored **`distro.js`**, **`distro.py`**
and **`metadata.json`**. Source files import the variant values
(`IS_GENERIC`, `UUID`, `HAS_BLANKON_ABOUT`, `START_BUTTON_MODES`,
`DEFAULT_START_BUTTON`) from those generated modules.

Local development targets have `-generic` counterparts that set
`PRAYA_GENERIC=1`:

```
make run-generic
make run-mutter-devkit-generic
make install-user-generic
make test-generic
make distro / distro-generic
```

Always run `make distro` (or `distro-generic`) before the `run*`/`install*`/
`test*` targets; they depend on it. Debian builds two binary packages
(`praya-gnome-shell-extension` and `praya-gnome-shell-extension-generic`) from
the same source via `debian/install-extension.sh`.
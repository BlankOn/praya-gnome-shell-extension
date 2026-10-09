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
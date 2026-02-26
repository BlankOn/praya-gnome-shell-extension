# Praya GNOME Shell Extension

## Version Bumping

When bumping the version, update **all three** places:

1. **`constants.js`** — `export const VERSION = 'x.y.z';`
2. **`debian/changelog`** — add a new entry at the top with the new version `praya-gnome-shell-extension (x.y.z-1)`
3. **`praya-preferences.py`** — `VERSION = 'x.y.z'`
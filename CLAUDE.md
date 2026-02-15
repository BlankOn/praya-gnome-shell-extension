# Praya GNOME Shell Extension

## Version Bumping

When bumping the version, update **both** places:

1. **`constants.js`** — `export const VERSION = 'x.y.z';`
2. **`debian/changelog`** — add a new entry at the top with the new version `praya-gnome-shell-extension (x.y.z-1)`

Also update the debian package copy at `debian/praya-gnome-shell-extension/usr/share/gnome-shell/extensions/praya@blankonlinux.id/constants.js`.

#!/usr/bin/env python3
"""Tests for the per-user extension updater (debian/praya-update-user.sh).

Run with:

    python3 -m unittest -v test_praya_update_user
    make test

The updater must never write through the extension directory that a running
GNOME Shell has loaded: gettext memory-maps the catalog, so an in-place copy
of ``praya.mo`` makes the shell read the new catalog through the old mapping
and return shifted strings (the first letter of every translation goes
missing). These tests pin down the staging/rename behaviour.
"""
import os
import shutil
import subprocess
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_UPDATER = os.path.join(_HERE, 'debian', 'praya-update-user.sh')

_MO_REL = os.path.join('locale', 'id', 'LC_MESSAGES', 'praya.mo')


def _write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)


def _read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()


class UpdateUserTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='praya-updater-')
        self.addCleanup(shutil.rmtree, self.tmp, True)

        self.home = os.path.join(self.tmp, 'home')
        self.src = os.path.join(self.tmp, 'src')
        self.dest = os.path.join(
            self.home, '.local', 'share', 'gnome-shell', 'extensions',
            'praya@blankonlinux.id')
        self.bin = os.path.join(self.tmp, 'bin')
        os.makedirs(self.bin)

        # A minimal extension tree.
        _write(os.path.join(self.src, 'metadata.json'), '{"uuid": "new"}')
        _write(os.path.join(self.src, 'translations.js'), 'new translations')
        _write(os.path.join(self.src, _MO_REL), 'new catalog')

        # A destination from an older install with both a stale file and an
        # old catalog.
        _write(os.path.join(self.dest, 'metadata.json'), '{"uuid": "old"}')
        _write(os.path.join(self.dest, _MO_REL), 'old catalog')
        _write(os.path.join(self.dest, 'obsolete.js'), 'old file')

        # The updater calls these; stub them so the test does not touch the
        # real package database or session bus.
        _write(os.path.join(self.bin, 'dpkg-query'), '#!/bin/sh\necho 9.9.9-1\n')
        _write(os.path.join(self.bin, 'gnome-extensions'), '#!/bin/sh\nexit 0\n')
        for name in ('dpkg-query', 'gnome-extensions'):
            os.chmod(os.path.join(self.bin, name), 0o755)

    def _run(self, limit_file_size=False, **env_overrides):
        env = dict(os.environ)
        env['HOME'] = self.home
        env['PATH'] = self.bin + os.pathsep + env.get('PATH', '')
        env['PRAYA_EXT_SRC'] = self.src
        env['PRAYA_EXT_DEST'] = self.dest
        env.update(env_overrides)
        if limit_file_size:
            # Make any write fail, as a full disk would. This works even when
            # the test suite runs as root, unlike a read-only directory.
            argv = ['/bin/sh', '-c', 'ulimit -f 0; exec /bin/sh "$1"',
                    'sh', _UPDATER]
        else:
            argv = ['/bin/sh', _UPDATER]
        return subprocess.run(
            argv, env=env, capture_output=True, text=True)

    def test_replaces_tree_and_records_version(self):
        result = self._run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(_read(os.path.join(self.dest, 'metadata.json')),
                         '{"uuid": "new"}')
        self.assertEqual(_read(os.path.join(self.dest, _MO_REL)),
                         'new catalog')
        self.assertFalse(os.path.exists(os.path.join(self.dest, 'obsolete.js')))
        self.assertEqual(
            _read(os.path.join(self.dest, '.installed-version')).strip(),
            '9.9.9-1')

    def test_live_catalog_is_not_written_in_place(self):
        """An open descriptor keeps the old bytes while the new tree appears.

        This is the updater-side equivalent of GNOME Shell having the old
        ``praya.mo`` mapped: replacing the directory must leave that inode
        untouched.
        """
        live_path = os.path.join(self.dest, _MO_REL)
        with open(live_path, 'rb') as live:
            old_inode = os.fstat(live.fileno()).st_ino

            result = self._run()
            self.assertEqual(result.returncode, 0, result.stderr)

            self.assertEqual(live.read(), b'old catalog')
            self.assertEqual(_read(live_path), 'new catalog')
            self.assertNotEqual(os.stat(live_path).st_ino, old_inode)

    def test_symlinked_destination_is_replaced_not_followed(self):
        target = os.path.join(self.tmp, 'system-extension')
        _write(os.path.join(target, 'sentinel'), 'system')
        shutil.rmtree(self.dest)
        os.symlink(target, self.dest)

        result = self._run()
        self.assertEqual(result.returncode, 0, result.stderr)

        # The package tree was untouched; the user path is now a real
        # directory holding the new files.
        self.assertEqual(_read(os.path.join(target, 'sentinel')), 'system')
        self.assertFalse(os.path.islink(self.dest))
        self.assertEqual(_read(os.path.join(self.dest, 'metadata.json')),
                         '{"uuid": "new"}')

    def test_failed_install_leaves_version_untouched(self):
        _write(os.path.join(self.dest, '.installed-version'), '0.0.1')

        result = self._run(limit_file_size=True)

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(
            _read(os.path.join(self.dest, '.installed-version')), '0.0.1')
        self.assertEqual(_read(os.path.join(self.dest, 'metadata.json')),
                         '{"uuid": "old"}')
        # The failed staging directory is cleaned up.
        leftovers = [
            name for name in os.listdir(os.path.dirname(self.dest))
            if name.startswith('.praya')
        ]
        self.assertEqual(leftovers, [])


if __name__ == '__main__':
    unittest.main()

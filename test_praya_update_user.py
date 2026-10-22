#!/usr/bin/env python3
"""Tests for the per-user extension updater (debian/praya-update-user.sh).

Run with:

    python3 -m unittest -v test_praya_update_user
    make test

The updater must never write through the extension directory that a running
GNOME Shell has loaded: gettext memory-maps the catalog, so an in-place copy
of ``praya.mo`` makes the shell read the new catalog through the old mapping
and return shifted strings (the first letter of every translation goes
missing). These tests pin down the staging/rename behaviour and assert the
exact gettext result: ``Aplikasi`` becomes ``plikasi`` with the old updater,
while the staged update keeps ``Aplikasi``.
"""
import json
import locale
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_UPDATER = os.path.join(_HERE, 'debian', 'praya-update-user.sh')
_PO = os.path.join(_HERE, 'po', 'id.po')

_MO_REL = os.path.join('locale', 'id', 'LC_MESSAGES', 'praya.mo')

# Locales that are likely to be generated on a developer machine. C/C.UTF-8
# are deliberately excluded: glibc does not load catalogs for them.
_LOCALES = ('id_ID.UTF-8', 'id_ID.utf8', 'en_US.UTF-8', 'en_US.utf8')

# Run in a subprocess so a SIGBUS/SIGSEGV caused by the corrupted mapping
# cannot take down the test runner. The child loads the old catalog, runs one
# of the two update strategies, and prints the before/after value as JSON.
_GETTEXT_CHILD = textwrap.dedent(r'''
    import ctypes
    import json
    import locale
    import os
    import subprocess
    import sys

    (old_ext, new_ext, bindir, loc, mode,
     new_updater, old_updater) = sys.argv[1:]

    libc = ctypes.CDLL("libc.so.6")
    libc.setlocale.restype = ctypes.c_char_p
    libc.setlocale.argtypes = [ctypes.c_int, ctypes.c_char_p]
    libc.bindtextdomain.restype = ctypes.c_char_p
    libc.bindtextdomain.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
    libc.dgettext.restype = ctypes.c_char_p
    libc.dgettext.argtypes = [ctypes.c_char_p, ctypes.c_char_p]

    if not libc.setlocale(locale.LC_ALL, loc.encode()):
        sys.exit(4)

    # The catalog is named after the domain, i.e. praya.mo.
    libc.bindtextdomain(b"praya", os.path.join(old_ext, "locale").encode())
    before = libc.dgettext(b"praya", b"Applications")
    if before != b"Aplikasi":
        sys.exit(3)

    if mode == "inplace":
        # The old updater did exactly this: cp -r over the live tree, which
        # truncates and rewrites the .mo inode that gettext has mapped.
        subprocess.run(["/bin/sh", old_updater, new_ext, old_ext],
                       check=True)
    elif mode == "atomic":
        # The new updater stages the new tree and renames it into place,
        # leaving the old inode (and therefore the old mapping) untouched.
        env = os.environ.copy()
        env["PRAYA_EXT_SRC"] = new_ext
        env["PRAYA_EXT_DEST"] = old_ext
        env["PATH"] = bindir + os.pathsep + env.get("PATH", "")
        subprocess.run(["/bin/sh", new_updater], env=env, check=True)
    else:
        sys.exit(4)

    after = libc.dgettext(b"praya", b"Applications")

    def text(value):
        return None if value is None else value.decode("utf-8", "backslashreplace")

    print(json.dumps({"before": text(before), "after": text(after)}))
    sys.exit(0)
''')


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

    # ------------------------------------------------------------------
    # Gettext mapping tests.
    #
    # These load a real .mo through glibc, then either overwrite it in place
    # (the old updater) or swap the directory (the new updater), and call
    # dgettext() again. They reproduce the actual string corruption rather
    # than only checking file inodes.
    # ------------------------------------------------------------------
    @staticmethod
    def _available_locale():
        previous = locale.setlocale(locale.LC_ALL)
        try:
            for candidate in _LOCALES:
                try:
                    locale.setlocale(locale.LC_ALL, candidate)
                    return candidate
                except locale.Error:
                    continue
        finally:
            locale.setlocale(locale.LC_ALL, previous)
        return None

    def _prepare_gettext_case(self):
        """Build old/new extension trees and the updater scripts."""
        if not sys.platform.startswith('linux'):
            self.skipTest('needs glibc gettext')
        if not shutil.which('msgfmt'):
            self.skipTest('msgfmt is required to build the test catalogs')

        loc = self._available_locale()
        if loc is None:
            self.skipTest('no usable UTF-8 locale for gettext')

        # The old catalog is the shipped one. The new catalog changes one
        # translation *before* Applications by one byte, which shifts every
        # following translation one byte earlier. Reading the old offset then
        # starts one byte into "Aplikasi", i.e. at "plikasi".
        old_po = _PO
        new_po = os.path.join(self.tmp, 'new.po')
        source = _read(_PO)
        old_msgstr = 'msgstr "(Eksperimental)"'
        if source.count(old_msgstr) != 1:
            self.skipTest('po/id.po no longer contains the expected entry')
        _write(new_po, source.replace(
            old_msgstr, 'msgstr "(Eksperimenta)"', 1))

        lang = loc.split('.')[0]
        old_ext = os.path.join(self.tmp, 'old-ext')
        new_ext = os.path.join(self.tmp, 'new-ext')
        old_mo = os.path.join(
            old_ext, 'locale', lang, 'LC_MESSAGES', 'praya.mo')
        new_mo = os.path.join(
            new_ext, 'locale', lang, 'LC_MESSAGES', 'praya.mo')
        os.makedirs(os.path.dirname(old_mo), exist_ok=True)
        os.makedirs(os.path.dirname(new_mo), exist_ok=True)

        old_result = subprocess.run(
            ['msgfmt', old_po, '-o', old_mo], capture_output=True, text=True)
        if old_result.returncode:
            self.fail(f'msgfmt failed for the old catalog: {old_result.stderr}')

        new_result = subprocess.run(
            ['msgfmt', new_po, '-o', new_mo], capture_output=True, text=True)
        if new_result.returncode:
            self.fail(f'msgfmt failed for the new catalog: {new_result.stderr}')

        if os.path.getsize(new_mo) != os.path.getsize(old_mo) - 1:
            self.skipTest('the new catalog is not exactly one byte smaller')

        _write(os.path.join(old_ext, 'metadata.json'), '{"uuid": "old"}')
        _write(os.path.join(new_ext, 'metadata.json'), '{"uuid": "new"}')

        # The old updater's install step, kept verbatim: cp -r over the live
        # tree. This truncates and rewrites the .mo inode in place.
        old_updater = os.path.join(self.tmp, 'old-updater.sh')
        _write(old_updater, '#!/bin/sh\nset -e\ncp -r "$1"/* "$2"/\n')

        child = os.path.join(self.tmp, 'gettext_child.py')
        _write(child, _GETTEXT_CHILD)

        return child, old_ext, new_ext, self.bin, loc, _UPDATER, old_updater

    def _run_gettext_child(self, setup, mode):
        (child, old_ext, new_ext, bindir, loc,
         new_updater, old_updater) = setup
        return subprocess.run(
            [sys.executable, child, old_ext, new_ext, bindir, loc, mode,
             new_updater, old_updater],
            capture_output=True, text=True)

    def _gettext_payload(self, result):
        if result.returncode < 0:
            self.fail(
                f'gettext child died with signal {-result.returncode}: '
                f'{result.stdout} {result.stderr}')
        self.assertEqual(
            result.returncode, 0,
            f'gettext child failed (rc={result.returncode}): '
            f'{result.stdout} {result.stderr}')
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError:
            self.fail(
                f'unexpected gettext child output: '
                f'{result.stdout!r} {result.stderr}')

    @unittest.skipUnless(sys.platform.startswith('linux'),
                         'needs glibc gettext')
    def test_old_inplace_update_drops_first_letter(self):
        """The old `cp -r` updater turns "Aplikasi" into "plikasi"."""
        setup = self._prepare_gettext_case()
        result = self._run_gettext_child(setup, 'inplace')
        payload = self._gettext_payload(result)

        self.assertEqual(payload['before'], 'Aplikasi')
        self.assertEqual(payload['after'], 'plikasi')

    @unittest.skipUnless(sys.platform.startswith('linux'),
                         'needs glibc gettext')
    def test_staged_swap_preserves_first_letter(self):
        """The new staging/rename updater keeps "Aplikasi" intact."""
        setup = self._prepare_gettext_case()
        result = self._run_gettext_child(setup, 'atomic')
        payload = self._gettext_payload(result)

        self.assertEqual(payload['before'], 'Aplikasi')
        self.assertEqual(payload['after'], 'Aplikasi')


if __name__ == '__main__':
    unittest.main()

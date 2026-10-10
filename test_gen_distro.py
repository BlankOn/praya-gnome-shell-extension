#!/usr/bin/env python3
"""Tests for the distro variant generator (tools/gen-distro.sh).

Run with:

    python3 -m unittest -v test_gen_distro
    make test

Each test generates the variant files into a scratch directory via
PRAYA_DISTRO_OUT and checks the contents.
"""
import json
import os
import re
import subprocess
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_GEN = os.path.join(_HERE, 'tools', 'gen-distro.sh')


def _generate(generic):
    """Run the generator for a variant; return the output directory."""
    tmp = tempfile.mkdtemp(prefix='praya-distro-')
    env = dict(os.environ)
    env['PRAYA_DISTRO_OUT'] = tmp
    if generic:
        env['PRAYA_GENERIC'] = '1'
    else:
        env.pop('PRAYA_GENERIC', None)
    subprocess.run([_GEN], check=True, env=env, cwd=_HERE,
                   stdout=subprocess.DEVNULL)
    return tmp


def _read(path):
    with open(path) as f:
        return f.read()


def _py_value(text, name):
    """Extract a simple Python literal assignment value."""
    match = re.search(rf'^{name}\s*=\s*(.+)$', text, re.MULTILINE)
    return match.group(1).strip() if match else None


class GenDistroTest(unittest.TestCase):
    def test_blankon_variant(self):
        out = _generate(generic=False)

        js = _read(os.path.join(out, 'distro.js'))
        py = _read(os.path.join(out, 'distro.py'))
        meta = json.loads(_read(os.path.join(out, 'metadata.json')))

        self.assertIn('export const IS_GENERIC = false;', js)
        self.assertIn("export const UUID = 'praya@blankonlinux.id';", js)
        self.assertIn('export const HAS_BLANKON_ABOUT = true;', js)
        self.assertIn("'default'", js)

        self.assertEqual(_py_value(py, 'IS_GENERIC'), 'False')
        self.assertEqual(_py_value(py, 'UUID'), "'praya@blankonlinux.id'")
        self.assertEqual(_py_value(py, 'HAS_BLANKON_ABOUT'), 'True')

        self.assertEqual(meta['uuid'], 'praya@blankonlinux.id')

    def test_generic_variant(self):
        out = _generate(generic=True)

        js = _read(os.path.join(out, 'distro.js'))
        py = _read(os.path.join(out, 'distro.py'))
        meta = json.loads(_read(os.path.join(out, 'metadata.json')))

        self.assertIn('export const IS_GENERIC = true;', js)
        self.assertIn("export const UUID = 'praya-generic@blankonlinux.id';", js)
        self.assertIn('export const HAS_BLANKON_ABOUT = false;', js)

        self.assertEqual(_py_value(py, 'IS_GENERIC'), 'True')
        self.assertEqual(_py_value(py, 'UUID'), "'praya-generic@blankonlinux.id'")
        self.assertEqual(_py_value(py, 'HAS_BLANKON_ABOUT'), 'False')

        self.assertEqual(meta['uuid'], 'praya-generic@blankonlinux.id')

    def test_generic_has_no_default_logo_mode(self):
        out = _generate(generic=True)
        js = _read(os.path.join(out, 'distro.js'))
        py = _read(os.path.join(out, 'distro.py'))
        # The generic build must not offer the BlankOn "default" logo mode.
        self.assertNotIn("'default'", _py_value(py, 'START_BUTTON_MODES'))
        self.assertNotIn("mode: 'default'", js)
        # Default becomes icon + text with Applications.
        self.assertIn("mode: 'icon_text'", js)
        self.assertIn("text: 'Applications'", js)
        self.assertEqual(
            _py_value(py, 'DEFAULT_START_BUTTON'),
            "{'mode': 'icon_text', 'iconName': 'start-here-symbolic', "
            "'text': 'Applications', 'imageHeight': 16}",
        )

    def test_generated_files_are_valid_python_and_js(self):
        for generic in (False, True):
            out = _generate(generic)
            # Python must be importable.
            subprocess.run(
                ['python3', '-c', 'import distro'],
                check=True, cwd=out, stdout=subprocess.DEVNULL,
            )
            # Node must be able to parse the ES module.
            subprocess.run(
                ['node', '--check', os.path.join(out, 'distro.js')],
                check=True, stdout=subprocess.DEVNULL,
            )


if __name__ == '__main__':
    unittest.main()

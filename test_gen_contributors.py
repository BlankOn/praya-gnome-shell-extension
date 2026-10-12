#!/usr/bin/env python3
"""Tests for the contributor generator (tools/gen-contributors.py).

Run with:

    python3 -m unittest -v test_gen_contributors
    make test

The generator reads the repository's own git history; each test writes the
output to a scratch directory via PRAYA_CONTRIB_OUT and checks the result.
"""
import os
import subprocess
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_GEN = os.path.join(_HERE, 'tools', 'gen-contributors.py')


def _generate():
    """Run the generator; return the output directory."""
    tmp = tempfile.mkdtemp(prefix='praya-contrib-')
    env = dict(os.environ)
    env['PRAYA_CONTRIB_OUT'] = tmp
    subprocess.run([sys.executable, _GEN], check=True, env=env, cwd=_HERE,
                   stdout=subprocess.DEVNULL)
    return tmp


def _load(out):
    """Import the generated contributors.py from its scratch directory."""
    sys.path.insert(0, out)
    try:
        import contributors
        return contributors.CONTRIBUTORS
    finally:
        sys.path.remove(out)
        sys.modules.pop('contributors', None)


class GenContributorsTest(unittest.TestCase):
    def test_generates_valid_python(self):
        out = _generate()
        self.assertTrue(os.path.exists(os.path.join(out, 'contributors.py')))
        subprocess.run(
            [sys.executable, '-c', 'import contributors'],
            check=True, cwd=out, stdout=subprocess.DEVNULL,
        )

    def test_entries_are_well_formed(self):
        entries = _load(_generate())
        self.assertGreater(len(entries), 0)
        for person in entries:
            self.assertIsInstance(person['name'], str)
            self.assertTrue(person['name'])
            self.assertIsInstance(person['email'], str)
            self.assertIsInstance(person['commits'], int)
            self.assertGreater(person['commits'], 0)

    def test_entries_are_sorted_by_commits_descending(self):
        entries = _load(_generate())
        counts = [person['commits'] for person in entries]
        self.assertEqual(counts, sorted(counts, reverse=True))

    def test_entries_are_unique_by_name_and_email(self):
        entries = _load(_generate())
        keys = [(person['name'], person['email']) for person in entries]
        self.assertEqual(len(keys), len(set(keys)))


if __name__ == '__main__':
    unittest.main()

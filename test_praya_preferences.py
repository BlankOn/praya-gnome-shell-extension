#!/usr/bin/env python3
"""Unit tests for the Praya preferences start button config.

Run with:

    python3 -m unittest -v
    make test

The GTK/libadwaita imports are only used to build the window; the pure
config helpers tested here can run under any environment that has
PyGObject + GTK4 available (the same requirement as the preferences app
itself).
"""
import importlib.util
import json
import os
import re
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

# The module name contains a hyphen, so load it from its path.
_spec = importlib.util.spec_from_file_location(
    'praya_preferences', os.path.join(_HERE, 'praya-preferences.py'))
prefs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(prefs)


class StartButtonDefaultsTest(unittest.TestCase):
    def test_default_services_has_start_button(self):
        self.assertIn('startButton', prefs.DEFAULT_SERVICES_CONFIG)

    def test_start_button_defaults_are_well_formed(self):
        sb = prefs.DEFAULT_SERVICES_CONFIG['startButton']
        self.assertEqual(sb['mode'], 'default')
        self.assertEqual(sb['imagePath'], '')
        self.assertEqual(sb['iconName'], 'start-here-symbolic')
        self.assertEqual(sb['text'], 'Start')
        self.assertIsInstance(sb['imageHeight'], int)
        self.assertGreater(sb['imageHeight'], 0)

    def test_start_button_modes_match_indicator(self):
        # The preferences and the shell-side module must agree on the modes.
        js_path = os.path.join(_HERE, 'startButton.js')
        with open(js_path) as f:
            js = f.read()
        match = re.search(r'START_BUTTON_MODES\s*=\s*\[([^\]]*)\]', js)
        self.assertIsNotNone(match, 'START_BUTTON_MODES not found in startButton.js')
        js_modes = [s.strip().strip("'\"") for s in match.group(1).split(',') if s.strip()]
        self.assertEqual(prefs.START_BUTTON_MODES, js_modes)

    def test_start_button_icons_are_unique(self):
        icons = prefs.START_BUTTON_ICONS
        self.assertGreater(len(icons), 0)
        self.assertEqual(len(icons), len(set(icons)))

    def test_start_button_icons_are_valid_icon_names(self):
        for name in prefs.START_BUTTON_ICONS:
            self.assertRegex(name, r'^[a-z0-9-]+$')
            self.assertTrue(name.endswith('-symbolic'), name)


class LoadJsonTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def _path(self, name):
        return os.path.join(self.tmp.name, name)

    def test_missing_file_returns_defaults(self):
        defaults = {'a': 1, 'b': 2}
        self.assertEqual(prefs._load_json(self._path('nope.json'), defaults), defaults)

    def test_existing_file_merges_new_default_keys(self):
        path = self._path('services.json')
        with open(path, 'w') as f:
            json.dump({'a': 10}, f)
        # 'startButton' is a new key missing from the stored file: it must be
        # added from the defaults so the window always has a full config.
        defaults = {'a': 1, 'startButton': {'mode': 'default'}}
        merged = prefs._load_json(path, defaults)
        self.assertEqual(merged['a'], 10)
        self.assertEqual(merged['startButton'], {'mode': 'default'})

    def test_corrupt_file_returns_defaults(self):
        path = self._path('broken.json')
        with open(path, 'w') as f:
            f.write('{ not valid json')
        defaults = {'a': 1}
        self.assertEqual(prefs._load_json(path, defaults), defaults)

    def test_save_then_load_round_trips(self):
        path = self._path('out.json')
        data = prefs.DEFAULT_SERVICES_CONFIG.copy()
        data = dict(data)
        data['startButton'] = dict(data['startButton'])
        data['startButton']['mode'] = 'icon'
        prefs._save_json(path, data)
        loaded = prefs._load_json(path, prefs.DEFAULT_SERVICES_CONFIG)
        self.assertEqual(loaded['startButton']['mode'], 'icon')
        self.assertEqual(loaded['startButton']['iconName'],
                         prefs.DEFAULT_SERVICES_CONFIG['startButton']['iconName'])


class StartButtonMergeTest(unittest.TestCase):
    def test_partial_stored_start_button_merges_with_defaults(self):
        # Simulate an older config that only stored the mode.
        stored = {'startButton': {'mode': 'text'}}
        defaults = prefs.DEFAULT_SERVICES_CONFIG
        merged = dict(defaults)
        merged.update(stored)
        sb = merged['startButton']
        # Note: dict.update replaces the whole nested dict, which is why the
        # window builds its own full start-button dict from .get() defaults.
        self.assertEqual(sb['mode'], 'text')
        self.assertNotIn('iconName', sb)


if __name__ == '__main__':
    unittest.main()

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
        self.assertIn(sb['mode'], prefs.START_BUTTON_MODES)
        self.assertEqual(sb['imagePath'], '')
        self.assertIsInstance(sb['iconName'], str)
        self.assertIsInstance(sb['text'], str)
        self.assertIsInstance(sb['imageHeight'], int)
        self.assertGreater(sb['imageHeight'], 0)

    def test_start_button_defaults_match_distro_module(self):
        sb = prefs.DEFAULT_SERVICES_CONFIG['startButton']
        for key, value in prefs.DEFAULT_START_BUTTON.items():
            self.assertEqual(sb[key], value)

    def test_start_button_modes_match_indicator(self):
        # The preferences and the shell-side module must agree on the modes.
        js_path = os.path.join(_HERE, 'startButton.js')
        with open(js_path) as f:
            js = f.read()
        # startButton.js re-exports the modes from the generated distro.js.
        self.assertIn("from './distro.js'", js)
        distro_path = os.path.join(_HERE, 'distro.py')
        with open(distro_path) as f:
            distro_py = f.read()
        match = re.search(r'START_BUTTON_MODES\s*=\s*\[([^\]]*)\]', distro_py)
        self.assertIsNotNone(match, 'START_BUTTON_MODES not found in distro.py')
        py_modes = [s.strip().strip("'\"") for s in match.group(1).split(',') if s.strip()]
        self.assertEqual(prefs.START_BUTTON_MODES, py_modes)

    def test_start_button_icons_are_unique(self):
        icons = prefs.START_BUTTON_ICONS
        self.assertGreater(len(icons), 0)
        self.assertEqual(len(icons), len(set(icons)))

    def test_start_button_icons_are_valid_icon_names(self):
        for name in prefs.START_BUTTON_ICONS:
            self.assertRegex(name, r'^[a-z0-9-]+$')
            self.assertTrue(name.endswith('-symbolic'), name)


class ContributorsTest(unittest.TestCase):
    def test_contributors_are_well_formed(self):
        self.assertGreater(len(prefs.CONTRIBUTORS), 0)
        for person in prefs.CONTRIBUTORS:
            self.assertTrue(person['name'])
            self.assertTrue(person['email'])
            self.assertGreater(person['commits'], 0)

    def test_contributors_are_sorted_by_commits_descending(self):
        counts = [person['commits'] for person in prefs.CONTRIBUTORS]
        self.assertEqual(counts, sorted(counts, reverse=True))


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


class AtomicSaveTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def _path(self, name):
        return os.path.join(self._tmp.name, name)

    def test_save_leaves_no_temporary_files(self):
        path = self._path('chatbot.json')
        for i in range(3):
            prefs._save_json(path, {'n': i})
        self.assertEqual(os.listdir(self._tmp.name), ['chatbot.json'])
        with open(path) as f:
            self.assertEqual(json.load(f), {'n': 2})

    def test_save_replaces_the_file_instead_of_truncating_it(self):
        # A reader holding the old file must still see complete content.
        path = self._path('chatbot.json')
        prefs._save_json(path, {'old': True})
        with open(path) as reader:
            prefs._save_json(path, {'new': True})
            self.assertEqual(json.load(reader), {'old': True})
        with open(path) as f:
            self.assertEqual(json.load(f), {'new': True})

    def test_save_sets_the_requested_mode(self):
        path = self._path('chatbot.json')
        prefs._save_json(path, {}, prefs.CHATBOT_CONFIG_MODE)
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        other = self._path('services.json')
        prefs._save_json(other, {})
        self.assertEqual(os.stat(other).st_mode & 0o777, prefs.DEFAULT_CONFIG_MODE)

    def test_chatbot_config_is_private(self):
        self.assertEqual(prefs.CHATBOT_CONFIG_MODE & 0o077, 0)

    def test_save_follows_a_symlinked_config(self):
        target = self._path('real.json')
        link = self._path('chatbot.json')
        prefs._save_json(target, {'a': 1})
        os.symlink(target, link)
        prefs._save_json(link, {'a': 2})
        self.assertTrue(os.path.islink(link))
        with open(target) as f:
            self.assertEqual(json.load(f), {'a': 2})

    def test_failed_save_keeps_the_old_file(self):
        path = self._path('chatbot.json')
        prefs._save_json(path, {'ok': True})
        with self.assertRaises(TypeError):
            prefs._save_json(path, {'bad': object()})
        self.assertEqual(os.listdir(self._tmp.name), ['chatbot.json'])
        with open(path) as f:
            self.assertEqual(json.load(f), {'ok': True})


class SearchEngineDefaultsTest(unittest.TestCase):
    def test_default_services_has_search_engine(self):
        self.assertEqual(prefs.DEFAULT_SERVICES_CONFIG['searchEngine'],
                         prefs.DEFAULT_SEARCH_ENGINE)
        self.assertEqual(prefs.DEFAULT_SERVICES_CONFIG['searchEngineCustomUrl'], '')

    def test_default_engine_is_offered(self):
        self.assertIn(prefs.DEFAULT_SEARCH_ENGINE, prefs.SEARCH_ENGINE_ORDER)
        self.assertIn(prefs.DEFAULT_SEARCH_ENGINE, prefs.SEARCH_ENGINES)

    def test_custom_engine_is_offered(self):
        self.assertIn(prefs.CUSTOM_SEARCH_ENGINE, prefs.SEARCH_ENGINE_ORDER)
        self.assertNotIn(prefs.CUSTOM_SEARCH_ENGINE, prefs.SEARCH_ENGINES)

    def test_engine_order_has_no_duplicates(self):
        self.assertEqual(len(prefs.SEARCH_ENGINE_ORDER),
                         len(set(prefs.SEARCH_ENGINE_ORDER)))

    def test_engines_match_search_engine_js(self):
        # The preferences and the shell-side module must agree on the engines
        # and their URL templates.
        js_path = os.path.join(_HERE, 'searchEngine.js')
        with open(js_path) as f:
            js = f.read()

        block = re.search(r'SEARCH_ENGINES\s*=\s*\{(.*?)\}', js, re.S)
        self.assertIsNotNone(block, 'SEARCH_ENGINES not found in searchEngine.js')
        js_engines = dict(re.findall(
            r"^\s*([A-Za-z0-9_]+)\s*:\s*'([^']*)'", block.group(1), re.M))
        self.assertEqual(js_engines, prefs.SEARCH_ENGINES)

        default = re.search(r"DEFAULT_SEARCH_ENGINE\s*=\s*'([^']*)'", js)
        self.assertIsNotNone(default, 'DEFAULT_SEARCH_ENGINE not found in searchEngine.js')
        self.assertEqual(default.group(1), prefs.DEFAULT_SEARCH_ENGINE)

        custom = re.search(r"CUSTOM_SEARCH_ENGINE\s*=\s*'([^']*)'", js)
        self.assertIsNotNone(custom, 'CUSTOM_SEARCH_ENGINE not found in searchEngine.js')
        self.assertEqual(custom.group(1), prefs.CUSTOM_SEARCH_ENGINE)


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


class ChatbotApiKeyTest(unittest.TestCase):
    def test_default_chatbot_stores_keys_per_provider(self):
        self.assertEqual(prefs.DEFAULT_CHATBOT_CONFIG['apiKeys'], {})
        self.assertNotIn('apiKey', prefs.DEFAULT_CHATBOT_CONFIG)

    def test_migrate_moves_legacy_key_to_active_provider(self):
        migrated = prefs._migrate_chatbot_config({
            'provider': 'openai',
            'model': 'gpt-4o',
            'apiKey': 'sk-legacy',
        })
        self.assertEqual(migrated['apiKeys'], {'openai': 'sk-legacy'})
        self.assertNotIn('apiKey', migrated)

    def test_migrate_does_not_overwrite_existing_provider_key(self):
        migrated = prefs._migrate_chatbot_config({
            'provider': 'openai',
            'apiKeys': {'openai': 'sk-new', 'anthropic': 'sk-ant'},
            'apiKey': 'sk-legacy',
        })
        self.assertEqual(migrated['apiKeys']['openai'], 'sk-new')
        self.assertEqual(migrated['apiKeys']['anthropic'], 'sk-ant')

    def test_migrate_without_legacy_key_is_a_noop(self):
        migrated = prefs._migrate_chatbot_config({
            'provider': 'anthropic',
            'apiKeys': {'anthropic': 'sk-ant'},
        })
        self.assertEqual(migrated['apiKeys'], {'anthropic': 'sk-ant'})

    def test_migrate_handles_missing_or_corrupt_api_keys(self):
        migrated = prefs._migrate_chatbot_config({'provider': 'anthropic', 'apiKeys': 'nope'})
        self.assertEqual(migrated['apiKeys'], {})
        self.assertNotIn('apiKey', migrated)

    def test_provider_api_key_is_scoped_to_provider(self):
        config = {'apiKeys': {'anthropic': 'sk-ant', 'openai': 'sk-oai'}}
        self.assertEqual(prefs._provider_api_key(config, 'anthropic'), 'sk-ant')
        self.assertEqual(prefs._provider_api_key(config, 'openai'), 'sk-oai')
        self.assertEqual(prefs._provider_api_key(config, 'deepseek'), '')

    def test_provider_api_key_tolerates_missing_map(self):
        self.assertEqual(prefs._provider_api_key({'provider': 'anthropic'}, 'anthropic'), '')


class ChatbotProvidersSyncTest(unittest.TestCase):
    def _js_providers(self):
        js_path = os.path.join(_HERE, 'chatbotEndpoint.js')
        with open(js_path) as f:
            js = f.read()
        block = re.search(r'export const PROVIDERS\s*=\s*\{(.*?)\n\};', js, re.S)
        self.assertIsNotNone(block, 'PROVIDERS not found in chatbotEndpoint.js')
        providers = {}
        for key, body in re.findall(
                r"^ {4}'?([A-Za-z0-9_-]+)'?\s*:\s*\{(.*?)^ {4}\}",
                block.group(1), re.M | re.S):
            name = re.search(r"name:\s*'([^']*)'", body)
            protocol = re.search(r"protocol:\s*'([^']*)'", body)
            models = re.search(r'models:\s*\[(.*?)\]', body, re.S)
            providers[key] = {
                'name': name.group(1) if name else None,
                'protocol': protocol.group(1) if protocol else None,
                'custom': bool(re.search(r'custom:\s*true', body)),
                'models': re.findall(r"'([^']*)'", models.group(1)) if models else [],
            }
        return providers

    def test_providers_match_chatbot_endpoint_js(self):
        # The preferences and the shell-side module must agree on the
        # providers, their protocols and their model lists.
        js = self._js_providers()
        self.assertEqual(list(js), list(prefs.PROVIDERS))
        for key, config in prefs.PROVIDERS.items():
            self.assertEqual(js[key]['name'], config['name'], key)
            self.assertEqual(js[key]['protocol'], config['protocol'], key)
            self.assertEqual(js[key]['custom'], bool(config.get('custom')), key)
            self.assertEqual(js[key]['models'], config['models'], key)

    def test_custom_providers_have_no_fixed_models(self):
        for key, config in prefs.PROVIDERS.items():
            if config.get('custom'):
                self.assertEqual(config['models'], [], key)
            else:
                self.assertTrue(config['models'], key)


class ChatbotCustomEndpointTest(unittest.TestCase):
    def test_default_has_no_custom_endpoints(self):
        self.assertEqual(prefs.DEFAULT_CHATBOT_CONFIG['customEndpoints'], {})

    def test_migrate_adds_missing_custom_endpoints(self):
        migrated = prefs._migrate_chatbot_config({'provider': 'openai', 'apiKeys': {}})
        self.assertEqual(migrated['customEndpoints'], {})

    def test_migrate_drops_corrupt_custom_endpoints(self):
        migrated = prefs._migrate_chatbot_config({'customEndpoints': 'nope'})
        self.assertEqual(migrated['customEndpoints'], {})
        migrated = prefs._migrate_chatbot_config({'customEndpoints': {
            'openai-compatible': {'baseUrl': 'http://localhost:8080/v1', 'model': 'm'},
            'anthropic-compatible': 'nope',
        }})
        self.assertEqual(migrated['customEndpoints'], {
            'openai-compatible': {'baseUrl': 'http://localhost:8080/v1', 'model': 'm'},
        })

    def test_custom_endpoint_reads_and_trims(self):
        config = {'customEndpoints': {
            'openai-compatible': {'baseUrl': ' http://localhost:8080/v1 ', 'model': ' m '},
        }}
        self.assertEqual(prefs._custom_endpoint(config, 'openai-compatible'),
                         {'baseUrl': 'http://localhost:8080/v1', 'model': 'm'})
        self.assertEqual(prefs._custom_endpoint(config, 'anthropic-compatible'),
                         {'baseUrl': '', 'model': ''})
        self.assertEqual(prefs._custom_endpoint({}, 'openai-compatible'),
                         {'baseUrl': '', 'model': ''})

    def test_is_custom_provider(self):
        self.assertTrue(prefs._is_custom_provider('openai-compatible'))
        self.assertTrue(prefs._is_custom_provider('anthropic-compatible'))
        self.assertFalse(prefs._is_custom_provider('anthropic'))
        self.assertFalse(prefs._is_custom_provider('nope'))

    def test_valid_base_url(self):
        for url in ['http://localhost:8080/v1', 'https://api.example.com/v1',
                    ' https://api.example.com ']:
            self.assertTrue(prefs._is_valid_base_url(url), url)
        for url in ['', '   ', None, 'localhost:8080', 'ftp://example.com',
                    'http://', 'https://exa mple.com', 'http://[::1']:
            self.assertFalse(prefs._is_valid_base_url(url), url)

    def test_insecure_remote_url(self):
        self.assertTrue(prefs._is_insecure_remote_url('http://192.168.1.10:8080/v1'))
        self.assertTrue(prefs._is_insecure_remote_url('http://api.example.com/v1'))
        for url in ['http://localhost:8080/v1', 'http://127.0.0.1:8080/v1',
                    'http://[::1]:8080/v1', 'https://api.example.com/v1', 'nope', '']:
            self.assertFalse(prefs._is_insecure_remote_url(url), url)


if __name__ == '__main__':
    unittest.main()

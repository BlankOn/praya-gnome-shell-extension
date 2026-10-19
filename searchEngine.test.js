/* searchEngine.test.js
 *
 * Unit tests for the pure search-engine URL helpers. Run with:
 *
 *     node --test
 *     make test
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    SEARCH_ENGINES,
    DEFAULT_SEARCH_ENGINE,
    CUSTOM_SEARCH_ENGINE,
    SEARCH_ENGINE_ORDER,
    resolveSearchUrl,
} from './searchEngine.js';

test('resolveSearchUrl fills the preset templates', () => {
    assert.equal(resolveSearchUrl('google', '', 'hello world'),
        'https://www.google.com/search?q=hello%20world');
    assert.equal(resolveSearchUrl('duckduckgo', '', 'hello'),
        'https://duckduckgo.com/?q=hello');
    assert.equal(resolveSearchUrl('bing', '', 'hello'),
        'https://www.bing.com/search?q=hello');
    assert.equal(resolveSearchUrl('yahoo', '', 'hello'),
        'https://search.yahoo.com/search?p=hello');
});

test('resolveSearchUrl encodes special characters', () => {
    assert.equal(resolveSearchUrl('google', '', 'a&b=c d'),
        'https://www.google.com/search?q=a%26b%3Dc%20d');
});

test('resolveSearchUrl substitutes %s in a custom template', () => {
    assert.equal(
        resolveSearchUrl(CUSTOM_SEARCH_ENGINE, 'https://example.org/find?q=%s', 'hi there'),
        'https://example.org/find?q=hi%20there');
});

test('resolveSearchUrl substitutes every %s occurrence', () => {
    assert.equal(
        resolveSearchUrl(CUSTOM_SEARCH_ENGINE, 'https://x.test/%s?q=%s', 'a'),
        'https://x.test/a?q=a');
});

test('resolveSearchUrl appends the query when a custom URL has no %s', () => {
    assert.equal(
        resolveSearchUrl(CUSTOM_SEARCH_ENGINE, 'https://example.org/search?q=', 'hi'),
        'https://example.org/search?q=hi');
});

test('resolveSearchUrl trims a custom URL', () => {
    assert.equal(
        resolveSearchUrl(CUSTOM_SEARCH_ENGINE, '  https://example.org/?q=%s  ', 'x'),
        'https://example.org/?q=x');
});

test('resolveSearchUrl falls back to the default engine', () => {
    const fallback = SEARCH_ENGINES[DEFAULT_SEARCH_ENGINE].replace('%s', 'x');
    // Empty custom URL.
    assert.equal(resolveSearchUrl(CUSTOM_SEARCH_ENGINE, '', 'x'), fallback);
    // Unknown engine.
    assert.equal(resolveSearchUrl('nope', '', 'x'), fallback);
    // Missing engine value entirely.
    assert.equal(resolveSearchUrl(undefined, undefined, 'x'), fallback);
});

test('resolveSearchUrl tolerates an empty query', () => {
    assert.equal(resolveSearchUrl('google', '', ''),
        'https://www.google.com/search?q=');
    assert.equal(resolveSearchUrl('google', '', undefined),
        'https://www.google.com/search?q=');
});

test('the engine order covers every preset plus custom', () => {
    assert.deepEqual(
        Object.keys(SEARCH_ENGINES),
        SEARCH_ENGINE_ORDER.filter(k => k !== CUSTOM_SEARCH_ENGINE));
    assert.ok(SEARCH_ENGINE_ORDER.includes(CUSTOM_SEARCH_ENGINE));
    assert.ok(SEARCH_ENGINE_ORDER.includes(DEFAULT_SEARCH_ENGINE));
});

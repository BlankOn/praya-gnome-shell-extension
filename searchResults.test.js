/* searchResults.test.js
 *
 * Unit tests for the pure search-result helpers. Run with:
 *
 *     node --test
 *     make test
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    MAX_APP_RESULTS,
    MAX_RESULTS_PER_PROVIDER,
    queryTerms,
    isAppResultId,
    flattenSections,
} from './searchResults.js';

test('queryTerms trims and splits on whitespace', () => {
    assert.deepEqual(queryTerms('  fire fox  '), ['fire', 'fox']);
    assert.deepEqual(queryTerms('calc'), ['calc']);
    assert.deepEqual(queryTerms('a\tb\nc'), ['a', 'b', 'c']);
});

test('queryTerms returns an empty list for empty input', () => {
    assert.deepEqual(queryTerms(''), []);
    assert.deepEqual(queryTerms('   '), []);
    assert.deepEqual(queryTerms(null), []);
    assert.deepEqual(queryTerms(undefined), []);
});

test('isAppResultId recognises desktop-file ids', () => {
    assert.equal(isAppResultId('org.gnome.Calculator.desktop'), true);
    assert.equal(isAppResultId('calculator'), false);
    assert.equal(isAppResultId(null), false);
    assert.equal(isAppResultId(42), false);
});

test('flattenSections preserves order and tags each result', () => {
    const sections = [
        {
            providerId: 'system-actions',
            providerName: 'System',
            isSystemAction: true,
            results: [{id: 'restart', name: 'Restart'}],
        },
        {
            providerId: 'org.gnome.Settings',
            providerName: 'Settings',
            provider: {id: 'org.gnome.Settings'},
            results: [{id: 'wifi', name: 'Wi-Fi'}],
        },
    ];

    const flat = flattenSections(sections);

    assert.deepEqual(flat.map(r => r.id), ['restart', 'wifi']);
    assert.equal(flat[0].providerId, 'system-actions');
    assert.equal(flat[0].providerName, 'System');
    assert.equal(flat[0].isSystemAction, true);
    assert.equal(flat[1].provider.id, 'org.gnome.Settings');
    assert.equal(flat[1].isSystemAction, false);
});

test('flattenSections drops duplicate provider+id pairs', () => {
    const sections = [
        {
            providerId: 'org.gnome.Settings',
            results: [
                {id: 'wifi', name: 'Wi-Fi'},
                {id: 'wifi', name: 'Wi-Fi again'},
            ],
        },
    ];

    const flat = flattenSections(sections);
    assert.deepEqual(flat.map(r => r.id), ['wifi']);
    assert.equal(flat[0].name, 'Wi-Fi');
});

test('flattenSections keeps the same id from different providers', () => {
    const sections = [
        {providerId: 'a', results: [{id: 'x', name: 'A'}]},
        {providerId: 'b', results: [{id: 'x', name: 'B'}]},
    ];

    assert.deepEqual(flattenSections(sections).map(r => r.name), ['A', 'B']);
});

test('flattenSections caps non-application providers', () => {
    const results = Array.from(
        {length: MAX_RESULTS_PER_PROVIDER + 3},
        (_, i) => ({id: `r${i}`, name: `Result ${i}`}));

    const flat = flattenSections([{providerId: 'files', results}]);
    assert.equal(flat.length, MAX_RESULTS_PER_PROVIDER);
});

test('flattenSections allows a larger application cap', () => {
    const results = Array.from(
        {length: MAX_APP_RESULTS + 3},
        (_, i) => ({id: `app${i}.desktop`, name: `App ${i}`}));

    const flat = flattenSections([{providerId: 'applications', isApp: true, results}]);
    assert.equal(flat.length, MAX_APP_RESULTS);
    assert.equal(flat[0].isApp, true);
});

test('flattenSections tolerates malformed input', () => {
    assert.deepEqual(flattenSections(null), []);
    assert.deepEqual(flattenSections(undefined), []);
    assert.deepEqual(flattenSections([null, {}, {results: 'nope'}]), []);
    // Entries without an id are skipped.
    assert.deepEqual(flattenSections([{providerId: 'a', results: [{name: 'x'}]}]), []);
});

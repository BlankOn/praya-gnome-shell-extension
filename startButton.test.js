/* startButton.test.js
 *
 * Unit tests for the pure start button helpers. Run with:
 *
 *     node --test
 *     make test
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_START_BUTTON_CONFIG,
    MIN_START_BUTTON_HEIGHT,
    MAX_START_BUTTON_HEIGHT,
    DEFAULT_MAX_IMAGE_WIDTH,
    normalizeStartButtonConfig,
    clampStartButtonHeight,
    maxImageWidth,
    imageWidthForHeight,
    escapeCssUrl,
    startButtonRenderKind,
    startButtonShowsText,
} from './startButton.js';

test('normalizeStartButtonConfig fills missing keys with defaults', () => {
    assert.deepEqual(normalizeStartButtonConfig(null), DEFAULT_START_BUTTON_CONFIG);
    assert.deepEqual(normalizeStartButtonConfig(undefined), DEFAULT_START_BUTTON_CONFIG);

    const merged = normalizeStartButtonConfig({ mode: 'image', text: 'Halo' });
    assert.equal(merged.mode, 'image');
    assert.equal(merged.text, 'Halo');
    // Missing keys fall back to the default.
    assert.equal(merged.iconName, DEFAULT_START_BUTTON_CONFIG.iconName);
    assert.equal(merged.imageHeight, DEFAULT_START_BUTTON_CONFIG.imageHeight);
});

test('normalizeStartButtonConfig does not mutate the input', () => {
    const input = { mode: 'text' };
    const out = normalizeStartButtonConfig(input);
    assert.notEqual(out, input);
    assert.equal(input.iconName, undefined);
});

test('clampStartButtonHeight uses the default for invalid values', () => {
    for (const value of [undefined, null, '', 0, -5, 'abc', NaN]) {
        assert.equal(clampStartButtonHeight(value), DEFAULT_START_BUTTON_CONFIG.imageHeight);
    }
});

test('clampStartButtonHeight clamps to the supported range', () => {
    assert.equal(clampStartButtonHeight(1), MIN_START_BUTTON_HEIGHT);
    assert.equal(clampStartButtonHeight(1000), MAX_START_BUTTON_HEIGHT);
    assert.equal(clampStartButtonHeight(16), 16);
    assert.equal(clampStartButtonHeight('24'), 24);
});

test('maxImageWidth uses a quarter of the monitor width, never below 32px', () => {
    assert.equal(maxImageWidth(1920), 480);
    assert.equal(maxImageWidth(800), 200);
    // Tiny monitors still get at least 32px.
    assert.equal(maxImageWidth(100), 32);
    // Unknown monitor falls back to a fixed cap.
    assert.equal(maxImageWidth(undefined), DEFAULT_MAX_IMAGE_WIDTH);
    assert.equal(maxImageWidth(0), DEFAULT_MAX_IMAGE_WIDTH);
});

test('imageWidthForHeight preserves the aspect ratio', () => {
    // Square image.
    assert.deepEqual(imageWidthForHeight(100, 100, 16, 480), { width: 16, height: 16 });
    // Wide 20:1 image keeps its width.
    assert.deepEqual(imageWidthForHeight(400, 20, 16, 480), { width: 320, height: 16 });
    // Tall image is constrained by the height.
    assert.deepEqual(imageWidthForHeight(20, 200, 16, 480), { width: 2, height: 16 });
});

test('imageWidthForHeight scales the height down when capped', () => {
    // Very wide 40:1 image would be 640px at height 16; capped at 480px it
    // must scale the height down so the aspect ratio stays exact.
    const size = imageWidthForHeight(2000, 50, 16, 480);
    assert.equal(size.width, 480);
    assert.equal(size.height, 12);
    assert.equal(size.width / size.height, 40);
});

test('imageWidthForHeight never returns zero', () => {
    const size = imageWidthForHeight(1, 1, 0, 0);
    assert.ok(size.width >= 1);
    assert.ok(size.height >= 1);
});

test('escapeCssUrl escapes backslashes and quotes', () => {
    assert.equal(escapeCssUrl('/home/a/b.png'), '/home/a/b.png');
    assert.equal(escapeCssUrl('/home/a "quoted".png'), '/home/a \\"quoted\\".png');
    assert.equal(escapeCssUrl('C:\\\\path\\\\img.png'), 'C:\\\\\\\\path\\\\\\\\img.png');
});

test('startButtonRenderKind maps modes to render kinds (BlankOn)', () => {
    assert.equal(startButtonRenderKind({ mode: 'default' }, false), 'logo');
    assert.equal(startButtonRenderKind({ mode: 'text' }, false), 'text');
    assert.equal(startButtonRenderKind({ mode: 'icon' }, false), 'icon');
    assert.equal(startButtonRenderKind({ mode: 'icon_text' }, false), 'icon_text');
    assert.equal(startButtonRenderKind({ mode: 'image', imagePath: '/a.png' }, false), 'image');
    // Image mode without a file falls back to the logo.
    assert.equal(startButtonRenderKind({ mode: 'image', imagePath: '' }, false), 'logo');
    // Unknown mode falls back to the logo.
    assert.equal(startButtonRenderKind({ mode: 'nonsense' }, false), 'logo');
});

test('startButtonRenderKind falls back to icon_text in the generic build', () => {
    // No BlankOn logo in the generic build: "default" and a file-less image
    // mode render as icon + text.
    assert.equal(startButtonRenderKind({ mode: 'default' }, true), 'icon_text');
    assert.equal(startButtonRenderKind({ mode: 'image', imagePath: '' }, true), 'icon_text');
    assert.equal(startButtonRenderKind({ mode: 'nonsense' }, true), 'icon_text');
    // Explicit modes are unaffected.
    assert.equal(startButtonRenderKind({ mode: 'text' }, true), 'text');
    assert.equal(startButtonRenderKind({ mode: 'image', imagePath: '/a.png' }, true), 'image');
});

test('startButtonShowsText is true for text and icon_text only', () => {
    assert.equal(startButtonShowsText({ mode: 'text' }), true);
    assert.equal(startButtonShowsText({ mode: 'icon_text' }), true);
    assert.equal(startButtonShowsText({ mode: 'icon' }), false);
    assert.equal(startButtonShowsText({ mode: 'image', imagePath: '/a.png' }), false);
});

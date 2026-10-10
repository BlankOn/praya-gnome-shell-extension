/* startButton.js
 *
 * Pure helpers for the Praya panel start button.
 *
 * This module deliberately has no `gi://…` imports so its logic can be
 * unit tested with plain Node. The GNOME Shell-side code in indicator.js
 * imports these helpers and adds the St/Clutter drawing on top.
 *
 * The variant defaults come from the generated distro.js module.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { DEFAULT_START_BUTTON, START_BUTTON_MODES, IS_GENERIC } from './distro.js';

// Shared config fields, independent of the variant. `imagePath` is not part
// of the variant default in distro.js, so it lives here.
const BASE_START_BUTTON_CONFIG = {
    imagePath: '',
};

// The full default config for the current build variant.
export const DEFAULT_START_BUTTON_CONFIG = Object.assign(
    { imageHeight: 16 },
    BASE_START_BUTTON_CONFIG,
    DEFAULT_START_BUTTON || {}
);

// Modes supported by this build. Re-exported for convenience.
export { START_BUTTON_MODES, IS_GENERIC };

export const MIN_START_BUTTON_HEIGHT = 8;
export const MAX_START_BUTTON_HEIGHT = 64;
export const DEFAULT_START_BUTTON_HEIGHT = 16;

// Fallback width cap (px) when the monitor size is unknown.
export const DEFAULT_MAX_IMAGE_WIDTH = 256;

// Merge a possibly partial config over the defaults. `defaults` can be
// overridden in tests to exercise another variant.
export function normalizeStartButtonConfig(config, defaults = DEFAULT_START_BUTTON_CONFIG) {
    return Object.assign({}, defaults, config || {});
}

// Clamp the requested icon/image height into the supported range.
export function clampStartButtonHeight(value) {
    let height = parseInt(value, 10);
    if (isNaN(height) || height <= 0)
        height = DEFAULT_START_BUTTON_HEIGHT;
    return Math.max(MIN_START_BUTTON_HEIGHT, Math.min(MAX_START_BUTTON_HEIGHT, height));
}

// Maximum width the start button image may occupy. Uses a quarter of the
// monitor width, never below 32px, with a fixed fallback.
export function maxImageWidth(monitorWidth) {
    if (typeof monitorWidth === 'number' && monitorWidth > 0)
        return Math.max(32, Math.floor(monitorWidth * 0.25));
    return DEFAULT_MAX_IMAGE_WIDTH;
}

// Derive the on-panel width from an image's aspect ratio. When the width
// would exceed the cap, the height is scaled down too so the widget keeps
// the image's exact aspect ratio (no empty space around the image).
export function imageWidthForHeight(imageWidth, imageHeight, targetHeight, maxWidth) {
    let height = clampStartButtonHeight(targetHeight);
    let ratio = imageWidth / Math.max(1, imageHeight);
    let width = Math.round(height * ratio);
    if (width > maxWidth) {
        height = Math.max(1, Math.round(maxWidth / ratio));
        width = maxWidth;
    }
    return { width: Math.max(1, width), height: Math.max(1, height) };
}

// Escape a filesystem path so it can be embedded in a CSS url("…") token.
export function escapeCssUrl(path) {
    return String(path).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Which part of the button a given mode should render. Keeps the branching
// logic testable without instantiating any widgets.
//
// `isGeneric` lets tests exercise either variant; it defaults to the build's
// generated distro flag. In a generic build the BlankOn "default" logo mode
// is not offered, so a stored `mode: 'default'` (or an image mode without a
// file) falls back to the variant default (icon + text) instead of the logo.
export function startButtonRenderKind(config, isGeneric = IS_GENERIC) {
    let cfg = normalizeStartButtonConfig(config);

    // In the generic build there is no BlankOn logo, so anything that would
    // otherwise render the logo becomes icon + text.
    const fallback = () => (isGeneric ? 'icon_text' : 'logo');

    let mode = cfg.mode;
    if (mode === 'default')
        return fallback();
    if (mode === 'image')
        return cfg.imagePath ? 'image' : fallback();
    if (mode === 'text')
        return 'text';
    if (mode === 'icon' || mode === 'icon_text')
        return mode; // 'icon' or 'icon_text'
    return fallback();
}

// True when the text label is part of the rendered button.
export function startButtonShowsText(config) {
    let kind = startButtonRenderKind(config);
    return kind === 'text' || kind === 'icon_text';
}

export default {
    DEFAULT_START_BUTTON_CONFIG,
    START_BUTTON_MODES,
    MIN_START_BUTTON_HEIGHT,
    MAX_START_BUTTON_HEIGHT,
    DEFAULT_START_BUTTON_HEIGHT,
    DEFAULT_MAX_IMAGE_WIDTH,
    normalizeStartButtonConfig,
    clampStartButtonHeight,
    maxImageWidth,
    imageWidthForHeight,
    escapeCssUrl,
    startButtonRenderKind,
    startButtonShowsText,
};

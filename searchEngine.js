/* searchEngine.js
 *
 * Pure helpers for the "search the web" fallback in the Praya search box.
 *
 * This module deliberately has no `gi://…` imports so its logic can be
 * unit tested with plain Node. The preference that selects the engine lives
 * in services.json and is edited from praya-preferences.py, which keeps the
 * same engine keys (see test_praya_preferences.py).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

// Preset engines, as URL templates. `%s` marks where the encoded query goes.
// The keys must stay in sync with SEARCH_ENGINES in praya-preferences.py.
export const SEARCH_ENGINES = {
    google: 'https://www.google.com/search?q=%s',
    duckduckgo: 'https://duckduckgo.com/?q=%s',
    bing: 'https://www.bing.com/search?q=%s',
    yahoo: 'https://search.yahoo.com/search?p=%s',
};

export const DEFAULT_SEARCH_ENGINE = 'google';
export const CUSTOM_SEARCH_ENGINE = 'custom';

// Display order used by the preferences combo box.
export const SEARCH_ENGINE_ORDER = [
    'google',
    'duckduckgo',
    'bing',
    'yahoo',
    CUSTOM_SEARCH_ENGINE,
];

/**
 * Build the URL to open for a web search.
 *
 * A custom URL is used as-is when it contains a `%s` placeholder; otherwise
 * the encoded query is appended. An empty custom URL (or an unknown engine)
 * falls back to the default engine so the fallback always works.
 *
 * @param {string} engine - engine key from services.json
 * @param {string} customUrl - custom URL template
 * @param {string} query - the raw search query
 * @returns {string} the URL to open
 */
export function resolveSearchUrl(engine, customUrl, query) {
    const encoded = encodeURIComponent(query || '');

    let template = engine === CUSTOM_SEARCH_ENGINE
        ? String(customUrl || '').trim()
        : SEARCH_ENGINES[engine];

    if (!template)
        template = SEARCH_ENGINES[DEFAULT_SEARCH_ENGINE];

    if (template.includes('%s'))
        return template.split('%s').join(encoded);

    return template + encoded;
}

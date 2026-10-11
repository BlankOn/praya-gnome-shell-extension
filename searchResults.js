/* searchResults.js
 *
 * Pure helpers for shaping the results returned by GNOME Shell's search
 * providers (applications, system actions, remote D-Bus providers) into a
 * single ordered list that the Praya panel can render and navigate.
 *
 * This module deliberately has no `gi://…` imports so its logic can be
 * unit tested with plain Node. The GNOME Shell glue lives in
 * searchProviders.js.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

// Applications are the main reason people open the menu, so keep a
// generous number of them. Other providers are capped so a single source
// (e.g. a file index) cannot flood the narrow panel.
export const MAX_APP_RESULTS = 12;
export const MAX_RESULTS_PER_PROVIDER = 5;

// Split a raw search string into the non-empty terms GNOME Shell hands to
// its providers (`setTerms()` does the same: trim, then split on whitespace).
export function queryTerms(searchString) {
    const trimmed = (searchString || '').trim();
    return trimmed === '' ? [] : trimmed.split(/\s+/);
}

// Application results use desktop-file ids; every other provider uses an
// opaque id of its own (a system action name, a file uri, …).
export function isAppResultId(id) {
    return typeof id === 'string' && id.endsWith('.desktop');
}

// Flatten the per-provider sections into one list, preserving provider
// order and dropping duplicates (same provider + id). Each returned item is
// a shallow copy of the provider meta tagged with the section it came from.
export function flattenSections(sections, {
    appLimit = MAX_APP_RESULTS,
    perProviderLimit = MAX_RESULTS_PER_PROVIDER,
} = {}) {
    const flat = [];
    const seen = new Set();

    for (const section of sections || []) {
        if (!section || !Array.isArray(section.results))
            continue;

        const limit = section.isApp ? appLimit : perProviderLimit;
        let taken = 0;

        for (const meta of section.results) {
            if (taken >= limit)
                break;
            if (!meta || meta.id === undefined || meta.id === null)
                continue;

            const key = `${section.providerId}\u0000${meta.id}`;
            if (seen.has(key))
                continue;
            seen.add(key);

            flat.push(Object.assign({}, meta, {
                providerId: section.providerId,
                providerName: section.providerName || null,
                provider: section.provider || null,
                isApp: !!section.isApp,
                isSystemAction: !!section.isSystemAction,
            }));
            taken++;
        }
    }

    return flat;
}

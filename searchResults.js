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

// Fold a string for loose matching: lower case, accents removed.
function foldForMatch(text) {
    return String(text || '')
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase();
}

// True when every term of @query starts one of the words of @name, the way
// people type the beginning of an app's name ("fil" → "Files",
// "text ed" → "Text Editor"). Case and accents are ignored.
export function nameMatchesQuery(name, query) {
    const terms = queryTerms(foldForMatch(query));
    if (terms.length === 0)
        return false;

    const words = foldForMatch(name).split(/[^\p{L}\p{N}]+/u).filter(w => w);
    return terms.every(term => words.some(word => word.startsWith(term)));
}

// Merge the system's app search results (which only know the names in the
// current language) with apps whose untranslated English name matches, so
// "Fil" still finds "Files" when it is shown as "Berkas".
//
// @nativeMatches: app entries ({id, name}) in the order the system ranked
//   them; it also matches on keywords and executable names.
// @candidates: every visible app as {id, englishName, ...}.
//
// Order: native results whose shown or English name matches, then other
// English-name matches, then the remaining (keyword/executable) native
// results.
export function rankAppMatches(nativeMatches, candidates, query) {
    const native = nativeMatches || [];
    const seen = new Set(native.map(app => app.id));

    const englishNames = new Map();
    for (const app of candidates || []) {
        if (app && app.englishName)
            englishNames.set(app.id, app.englishName);
    }

    const strong = [];
    const weak = [];
    for (const app of native) {
        const matches = nameMatchesQuery(app.name, query) ||
            nameMatchesQuery(englishNames.get(app.id), query);
        (matches ? strong : weak).push(app);
    }

    const english = [];
    for (const app of candidates || []) {
        if (!app || seen.has(app.id) || !app.englishName)
            continue;
        if (!nameMatchesQuery(app.englishName, query))
            continue;
        seen.add(app.id);
        english.push(app);
    }

    return [...strong, ...english, ...weak];
}

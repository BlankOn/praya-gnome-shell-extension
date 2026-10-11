/* searchProviders.js
 *
 * Bridges GNOME Shell's search provider API to the Praya panel.
 *
 * GNOME Shell exposes its search results through `SearchProvider`-style
 * objects (see `resource:///org/gnome/shell/ui/remoteSearch.js` and the
 * `AppSearchProvider` in `ui/appDisplay.js`). Each provider knows how to
 * turn search terms into result ids, turn ids into display metadata, and
 * activate a result.
 *
 * This module loads the same providers the Activities overview uses –
 * the enabled remote D-Bus providers (Settings, Files, Calculator, …) plus
 * the shell's own system actions – and adapts them into the plain sections
 * the panel renders. Applications keep using Praya's own app search, so
 * pinning and the context menu continue to work.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as RemoteSearch from 'resource:///org/gnome/shell/ui/remoteSearch.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

import { _ } from './translations.js';

// Same schema the overview watches to know which providers are enabled.
const SEARCH_PROVIDERS_SCHEMA = 'org.gnome.desktop.search-providers';

// The settings keys that change the set of providers (or their order).
const PROVIDER_SETTINGS_KEYS = ['disabled', 'enabled', 'disable-external', 'sort-order'];

// Drop a provider that takes longer than this to answer, so a stalled
// provider (or one that cannot be autostarted) cannot leave the panel stuck
// on "Searching". Slow results are dropped; faster providers already showed.
const PROVIDER_TIMEOUT_MS = 4000;

/**
 * SearchProviders loads the shell's search providers and queries them.
 *
 * It is intentionally UI-agnostic: `query()` returns plain result objects
 * (see searchResults.js) and `activate()` runs them, leaving the panel free
 * to render them however it wants.
 */
export class SearchProviders {
    constructor() {
        this._settings = new Gio.Settings({schema_id: SEARCH_PROVIDERS_SCHEMA});
        this._systemActions = SystemActions.getDefault();
        this._remoteProviders = [];
        this._settingsIds = [];

        this._loadRemoteProviders();

        // The user can change which providers are enabled (and their order)
        // from GNOME Settings while the panel is open.
        for (const key of PROVIDER_SETTINGS_KEYS) {
            this._settingsIds.push(this._settings.connect(`changed::${key}`, () => {
                this._loadRemoteProviders();
            }));
        }
    }

    _loadRemoteProviders() {
        try {
            this._remoteProviders = RemoteSearch.loadRemoteSearchProviders(this._settings);
        } catch (e) {
            log(`Praya: could not load search providers: ${e.message}`);
            this._remoteProviders = [];
        }
    }

    /**
     * Run a search across the shell's providers.
     *
     * Providers are queried in parallel and each section is handed to
     * @onSection as soon as it arrives, so a slow provider does not hold up
     * the rest. The returned promise resolves once every provider has either
     * answered or timed out.
     *
     * @param {string[]} terms - search terms, already split on whitespace
     * @param {Gio.Cancellable} [cancellable] - cancel a superseded search
     * @param {Function} [onSection] - called with each non-empty section
     * @returns {Promise<void>}
     */
    async query(terms, cancellable = null, onSection = null) {
        if (!terms || terms.length === 0)
            return;

        const emit = section => {
            if (section && onSection)
                onSection(section);
        };

        // The shell's built-in actions (Restart, Lock Screen, …) behave like
        // a provider of their own and are available synchronously.
        emit(this._systemActionSection(terms));

        // Query every remote provider in parallel and stream results.
        await Promise.all(this._remoteProviders.map(async provider => {
            const section = await this._queryProviderWithTimeout(
                provider, terms, cancellable);
            emit(section);
        }));
    }

    _systemActionSection(terms) {
        const actionIds = this._systemActions.getMatchingActions(terms);
        if (actionIds.length === 0)
            return null;

        return {
            providerId: 'system-actions',
            providerName: _('System'),
            isApp: false,
            isSystemAction: true,
            results: actionIds.map(id => ({
                id,
                name: this._systemActions.getName(id),
                description: null,
                createIcon: size => new St.Icon({
                    icon_name: this._systemActions.getIconName(id),
                    icon_size: size,
                }),
            })),
        };
    }

    _queryProviderWithTimeout(provider, terms, cancellable) {
        return new Promise(resolve => {
            let settled = false;
            let timeoutId = 0;

            const finish = section => {
                if (settled)
                    return;
                settled = true;
                if (timeoutId) {
                    GLib.source_remove(timeoutId);
                    timeoutId = 0;
                }
                resolve(section);
            };

            timeoutId = GLib.timeout_add_once(
                GLib.PRIORITY_DEFAULT, PROVIDER_TIMEOUT_MS, () => {
                    timeoutId = 0;
                    log(`Praya: search provider ${provider.id} timed out`);
                    finish(null);
                    return GLib.SOURCE_REMOVE;
                });

            this._queryProvider(provider, terms, cancellable).then(
                section => finish(section),
                () => finish(null));
        });
    }

    async _queryProvider(provider, terms, cancellable) {
        try {
            const ids = await provider.getInitialResultSet(terms, cancellable);
            if (!ids || ids.length === 0 || this._isCancelled(cancellable))
                return null;

            const metas = await provider.getResultMetas(ids, cancellable);
            if (!metas || metas.length === 0 || this._isCancelled(cancellable))
                return null;

            return {
                providerId: provider.id,
                providerName: provider.appInfo ? provider.appInfo.get_name() : null,
                provider,
                isApp: false,
                isSystemAction: false,
                results: metas,
            };
        } catch (e) {
            // A provider that is not running or not implemented must not
            // break the whole search.
            log(`Praya: search provider ${provider.id} failed: ${e.message}`);
            return null;
        }
    }

    _isCancelled(cancellable) {
        return cancellable ? cancellable.is_cancelled() : false;
    }

    /**
     * Activate a result produced by query().
     *
     * @param {object} result - a flattened result
     * @param {string[]} terms - the terms that produced it
     */
    activate(result, terms = []) {
        if (!result)
            return;

        if (result.isSystemAction) {
            try {
                this._systemActions.activateAction(result.id);
            } catch (e) {
                log(`Praya: could not activate system action ${result.id}: ${e.message}`);
            }
            return;
        }

        const provider = result.provider;
        if (!provider)
            return;

        // Some providers (e.g. clipboard/emoji pickers) also want to place
        // their result on the clipboard.
        if (result.clipboardText) {
            try {
                St.Clipboard.get_default().set_text(
                    St.ClipboardType.CLIPBOARD, result.clipboardText);
            } catch (e) {
                log(`Praya: could not copy search result to clipboard: ${e.message}`);
            }
        }

        try {
            provider.activateResult(result.id, terms);
        } catch (e) {
            log(`Praya: could not activate search result ${result.id}: ${e.message}`);
        }
    }

    /**
     * Ask a provider to open its full search UI for @terms, when it supports
     * it (e.g. GNOME Settings showing all matching panels).
     *
     * @returns {boolean} true when the provider handled the request
     */
    launchSearch(result, terms = []) {
        const provider = result && result.provider;
        if (!provider || !provider.canLaunchSearch)
            return false;

        try {
            provider.launchSearch(terms);
            return true;
        } catch (e) {
            log(`Praya: could not launch search for ${provider.id}: ${e.message}`);
            return false;
        }
    }

    destroy() {
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._remoteProviders = [];
        this._settings = null;
        this._systemActions = null;
    }
}

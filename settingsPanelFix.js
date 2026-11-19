/*
 * Restore a minimized GNOME Settings window when a settings-panel menu
 * entry (desktop background menu, quick settings Bluetooth, etc.) is
 * activated again.
 *
 * GNOME Shell's menu items activate a panel-specific .desktop file such as
 * gnome-background-panel.desktop. The shell considers that app "stopped"
 * even while the main Settings window is running but minimized, so it
 * launches a fresh gnome-control-center process. That instance only calls
 * gtk_window_present(), which cannot undo a Wayland minimize, so the user
 * only sees a "Settings is ready" notification.
 *
 * The desktop menu is built at shell startup, before extensions load, so
 * patching PopupMenu.addSettingsAction() is not enough. Intercept
 * Shell.App.activate() at click time instead.
 */

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SETTINGS_APP = 'org.gnome.Settings.desktop';
const SETTINGS_APP_IDS = ['org.gnome.Settings', 'gnome-control-center'];

let originalActivate = null;

function isSettingsWindow(win) {
    const gtkAppId = win.get_gtk_application_id?.();
    const wmClass = win.get_wm_class?.();
    return SETTINGS_APP_IDS.includes(gtkAppId) ||
        SETTINGS_APP_IDS.includes(wmClass);
}

function activateSettingsWindows() {
    for (const actor of global.get_window_actors()) {
        const win = actor.meta_window;
        if (win && win.minimized && isSettingsWindow(win)) {
            win.unminimize(global.get_current_time());
            Main.activateWindow(win);
        }
    }
}

function getPanelArgs(desktopFile) {
    const info = GioUnix.DesktopAppInfo.new(desktopFile);
    if (!info)
        return null;

    const exec = info.get_string('Exec');
    if (!exec)
        return null;

    const tokens = exec.trim().split(/\s+/);
    if (tokens.shift()?.split('/').pop() !== 'gnome-control-center')
        return null;

    return tokens.length ? tokens : null;
}

function activateSettingsPanel(app, original, args) {
    const panelArgs = getPanelArgs(app.get_id());
    const settingsApp = Shell.AppSystem.get_default().lookup_app(SETTINGS_APP);

    if (!panelArgs || !settingsApp) {
        original.apply(app, args);
        return;
    }

    activateSettingsWindows();

    /* Activating the main app makes the shell un-minimize/focus its window. */
    settingsApp.activate();

    const [panel, ...params] = panelArgs;

    /* Empty platform data avoids an uncompleted startup notification that
     * would otherwise leave a busy cursor behind. */
    Gio.DBus.session.call(
        'org.gnome.Settings',
        '/org/gnome/Settings',
        'org.freedesktop.Application',
        'ActivateAction',
        new GLib.Variant('(sava{sv})', [
            'launch-panel',
            [new GLib.Variant('(sav)', [
                panel,
                params.map(value => new GLib.Variant('s', value)),
            ])],
            {},
        ]),
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (connection, res) => {
            try {
                connection.call_finish(res);
            } catch (e) {
                console.warn(`Praya: failed to launch Settings panel ${panel}: ${e.message}`);
            }
        },
    );
}

function isSettingsPanelApp(app) {
    const id = app.get_id?.();
    return typeof id === 'string' &&
        id.startsWith('gnome-') &&
        id.endsWith('-panel.desktop');
}

export class SettingsPanelFix {
    enable() {
        if (originalActivate)
            return;

        originalActivate = Shell.App.prototype.activate;
        Shell.App.prototype.activate = function (...args) {
            if (isSettingsPanelApp(this)) {
                activateSettingsPanel(this, originalActivate, args);
                return;
            }
            return originalActivate.apply(this, args);
        };
    }

    disable() {
        if (!originalActivate)
            return;

        Shell.App.prototype.activate = originalActivate;
        originalActivate = null;
    }
}

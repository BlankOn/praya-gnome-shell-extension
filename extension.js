/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { _ } from './translations.js';
import { PrayaIndicator } from './indicator.js';
import { PrayaTaskbar } from './taskbar.js';

// D-Bus constants for posture service
const POSTURE_BUS_NAME = 'com.github.blankon.praya';
const POSTURE_SERVICE_INTERFACE = 'com.github.blankon.Praya.Posture';
const POSTURE_SERVICE_PATH = '/com/github/blankon/Praya/Posture';

export default class PrayaExtension extends Extension {
    enable() {
        // Load services configuration
        this._loadServicesConfig();

        // Save and apply gsettings
        this._applySettings();

        this._indicator = new PrayaIndicator();
        // Add to the left side of the panel
        Main.panel.addToStatusArea('praya-indicator', this._indicator, 0, 'left');

        // Apply panel position (top or bottom)
        this._applyPanelPosition(this._servicesConfig.panelPosition || 'top');
        this._setupWorkAreaMargins();
        this._setupIconGeometryTracking();
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._applyPanelPosition(this._panelPosition || 'top');
            this._removeWorkAreaMargins();
            this._setupWorkAreaMargins();
            this._updateAllWindowsIconGeometry();
        });
        // Defer services start and panel re-apply to after GNOME Shell
        // startup completes.  At that point display env vars
        // (WAYLAND_DISPLAY, DISPLAY, …) are guaranteed to be set, so
        // the systemd environment import succeeds on the first try and
        // apps launched via systemd scopes can connect to the compositor.
        // Launch lowspec check immediately
        this._launchLowspecDialog();

        if (!Main.layoutManager._startingUp) {
            // Already started up (e.g. extension enabled from prefs)
            this._startPrayaServices();
        } else {
            this._startupCompleteId = Main.layoutManager.connect('startup-complete', () => {
                Main.layoutManager.disconnect(this._startupCompleteId);
                this._startupCompleteId = null;
                this._applyPanelPosition(this._panelPosition || 'top');
                this._removeWorkAreaMargins();
                this._setupWorkAreaMargins();
                this._updateAllWindowsIconGeometry();
                this._startPrayaServices();
                this._scheduleLowspecCheck();
                // Hide the overview/workspace view on startup
                Main.overview.hide();
            });
        }

        // Hide activities button
        this._hideActivities();

        // Add taskbar to the left box, after indicator (index 1)
        this._taskbar = new PrayaTaskbar();
        Main.panel._leftBox.insert_child_at_index(this._taskbar, 1);

        // Add show desktop button to far right of panel
        // Outer: black hover area, no margin, fills panel height
        this._showDesktopHoverArea = new St.Bin({
            style_class: 'praya-show-desktop-hover-area',
            reactive: true,
            track_hover: true,
        });
        // Inner: wallpaper thumbnail with margin
        this._showDesktopButton = new St.Bin({
            style_class: 'praya-show-desktop-button',
            reactive: false,
        });
        this._showDesktopOverlay = new St.Widget({
            style_class: 'praya-show-desktop-overlay',
            x_expand: true,
            y_expand: true,
            reactive: false,
        });
        this._showDesktopButton.add_child(this._showDesktopOverlay);
        this._showDesktopHoverArea.set_child(this._showDesktopButton);
        this._showDesktopActive = false;
        this._showDesktopHoverHandled = false;
        this._showDesktopHoverActivate = this._servicesConfig.showDesktopHoverActivate || false;
        this._showDesktopHoverArea.connect('notify::hover', (actor) => {
            if (!this._showDesktopHoverActivate) return;
            if (actor.hover && !this._showDesktopHoverHandled) {
                this._showDesktopHoverHandled = true;
                this._toggleShowDesktop();
                this._showDesktopOverlay.ease({
                    opacity: this._showDesktopActive ? 0 : 76,
                    duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else if (!actor.hover) {
                this._showDesktopHoverHandled = false;
                this._showDesktopOverlay.ease({
                    opacity: this._showDesktopActive ? 0 : 76,
                    duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
        });
        // Click handler for show desktop (works regardless of hover setting)
        this._showDesktopHoverArea.connect('button-press-event', () => {
            this._toggleShowDesktop();
            this._showDesktopOverlay.ease({
                opacity: this._showDesktopActive ? 0 : 76,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            return Clutter.EVENT_STOP;
        });
        Main.panel._rightBox.add_child(this._showDesktopHoverArea);
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._setShowDesktopWallpaper();
            return GLib.SOURCE_REMOVE;
        });

        // Listen for wallpaper changes
        this._bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
        this._bgChangedId = this._bgSettings.connect('changed::picture-uri', () => {
            this._setShowDesktopWallpaper();
        });
        this._bgDarkChangedId = this._bgSettings.connect('changed::picture-uri-dark', () => {
            this._setShowDesktopWallpaper();
        });

        // Move date/time to the right (left of quick settings)
        this._moveDateTimeToRight();

        // Setup hover trigger for quick settings
        this._setupQuickSettingsHover();

        // Setup stage-level hover handler for calendar and quick settings
        this._setupPanelHoverHandler();

        // Hide the bottom dock when extension is enabled
        this._dock = null;
        this._hideDock();

        // Override hot corner to open our panel instead of overview
        this._setupHotCorner();

        // Override Super key to open Praya panel instead of Activities
        this._setupSuperKey();

        // Setup Meta+Space keybinding to toggle panel
        this._setupKeybinding();

        // Initialize blur overlays array
        this._blurOverlays = [];

        // Auto-close tracking
        this._autoCloseAnimating = false;
        this._autoCloseTimeoutId = null;
        this._autoCloseTolerance = 0.1; // Cancel auto-close if score exceeds this

        // Only initialize posture features if enabled in config
        if (this._servicesConfig.posture) {
            // Setup D-Bus connection for posture status
            this._initPostureDBus();

            // Pause posture evaluation during initial delay
            this._postureEvalPaused = true;

            // Start posture polling loop (similar to Praya Preferences)
            this._startPosturePolling();
        }
    }

    _loadServicesConfig() {
        let homeDir = GLib.get_home_dir();
        let configDir = GLib.build_filenamev([homeDir, '.config', 'praya']);
        let configPath = GLib.build_filenamev([configDir, 'services.json']);

        // Default config
        let defaultConfig = {
            ai: false,
            posture: false,
            mainMenuHoverActivate: false,
            taskbarHoverActivate: false,
            showDesktopHoverActivate: false,
            calendarHoverActivate: false,
            quickAccessHoverActivate: false,
            floatingPanel: true,
            panelPosition: 'top',
        };

        try {
            // Ensure config directory exists
            let dir = Gio.File.new_for_path(configDir);
            if (!dir.query_exists(null)) {
                dir.make_directory_with_parents(null);
            }

            let configFile = Gio.File.new_for_path(configPath);

            if (!configFile.query_exists(null)) {
                // Create default config file
                let content = JSON.stringify(defaultConfig, null, 2) + '\n';
                configFile.replace_contents(
                    content,
                    null,
                    false,
                    Gio.FileCreateFlags.NONE,
                    null
                );
                this._servicesConfig = defaultConfig;
            } else {
                // Load existing config
                let [success, contents] = configFile.load_contents(null);
                if (success) {
                    let decoder = new TextDecoder('utf-8');
                    let jsonStr = decoder.decode(contents);
                    this._servicesConfig = JSON.parse(jsonStr);
                } else {
                    this._servicesConfig = defaultConfig;
                }
            }
        } catch (e) {
            log(`Praya: Error loading services config: ${e.message}`);
            this._servicesConfig = defaultConfig;
        }
    }

    _checkLowspec() {
        try {
            let cpuFile = Gio.File.new_for_path('/proc/cpuinfo');
            let [cpuSuccess, cpuContents] = cpuFile.load_contents(null);
            let cpuCores = 0;
            if (cpuSuccess) {
                let decoder = new TextDecoder('utf-8');
                let cpuText = decoder.decode(cpuContents);
                for (let line of cpuText.split('\n')) {
                    if (line.startsWith('processor'))
                        cpuCores++;
                }
            }

            let memFile = Gio.File.new_for_path('/proc/meminfo');
            let [memSuccess, memContents] = memFile.load_contents(null);
            let ramMB = 0;
            if (memSuccess) {
                let decoder = new TextDecoder('utf-8');
                let memText = decoder.decode(memContents);
                for (let line of memText.split('\n')) {
                    if (line.startsWith('MemTotal')) {
                        let kB = parseInt(line.split(/\s+/)[1], 10);
                        ramMB = kB / 1024;
                        break;
                    }
                }
            }

            return cpuCores < 3 && ramMB < 5000;
        } catch (e) {
            log(`Praya: Error checking lowspec: ${e.message}`);
            return false;
        }
    }

    _scheduleLowspecCheck() {
        log('Praya: Scheduling lowspec check in 10 seconds');
        this._lowspecTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
            this._lowspecTimeoutId = null;
            let isLowspec = this._checkLowspec();
            let dismissed = this._servicesConfig.lowspecDismissed;
            log(`Praya: Lowspec check: isLowspec=${isLowspec}, dismissed=${dismissed}`);
            if (isLowspec && !dismissed) {
                log('Praya: Launching lowspec dialog');
                this._launchLowspecDialog();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _launchLowspecDialog() {
        if (this._lowspecProc) return;

        let scriptPath = GLib.build_filenamev([this.path, 'lowspec-dialog.py']);

        try {
            let launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDERR_PIPE,
            });
            // Ensure display env vars are set for the subprocess
            let waylandDisplay = GLib.getenv('WAYLAND_DISPLAY');
            let display = GLib.getenv('DISPLAY');
            let xdgRuntime = GLib.getenv('XDG_RUNTIME_DIR');
            if (waylandDisplay) launcher.setenv('WAYLAND_DISPLAY', waylandDisplay, true);
            if (display) launcher.setenv('DISPLAY', display, true);
            if (xdgRuntime) launcher.setenv('XDG_RUNTIME_DIR', xdgRuntime, true);
            launcher.setenv('GDK_BACKEND', waylandDisplay ? 'wayland' : 'x11', true);

            log(`Praya: Launching lowspec dialog: WAYLAND_DISPLAY=${waylandDisplay}, DISPLAY=${display}`);
            this._lowspecProc = launcher.spawnv(['python3', scriptPath]);

            this._lowspecProc.wait_async(null, (proc, result) => {
                try {
                    proc.wait_finish(result);
                    let exitCode = proc.get_exit_status();
                    log(`Praya: Lowspec dialog exited with code ${exitCode}`);

                    // Write stderr to file for debugging
                    try {
                        let stderrStream = proc.get_stderr_pipe();
                        let stderrData = stderrStream.read_bytes(8192, null);
                        if (stderrData && stderrData.get_size() > 0) {
                            let decoder = new TextDecoder('utf-8');
                            let errText = decoder.decode(stderrData.get_data());
                            log(`Praya: Lowspec stderr: ${errText}`);
                            let errFile = Gio.File.new_for_path('/tmp/praya-lowspec-error.log');
                            errFile.replace_contents(errText, null, false, Gio.FileCreateFlags.NONE, null);
                        }
                    } catch (e) {
                        log(`Praya: Error reading lowspec stderr: ${e.message}`);
                    }

                    if (exitCode === 1) {
                        // Disable GNOME animations
                        try {
                            let ifaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
                            ifaceSettings.set_boolean('enable-animations', false);
                        } catch (e) {
                            log(`Praya: Error disabling animations: ${e.message}`);
                        }

                        // Disable tilingshell extension
                        try {
                            let shellSettings = new Gio.Settings({schema_id: 'org.gnome.shell'});
                            let tilingId = 'tilingshell@ferrarodomenico.com';
                            let enabled = shellSettings.get_strv('enabled-extensions');
                            enabled = enabled.filter(id => id !== tilingId);
                            shellSettings.set_strv('enabled-extensions', enabled);
                            let disabled = shellSettings.get_strv('disabled-extensions');
                            if (!disabled.includes(tilingId)) {
                                disabled.push(tilingId);
                                shellSettings.set_strv('disabled-extensions', disabled);
                            }
                        } catch (e) {
                            log(`Praya: Error disabling tilingshell: ${e.message}`);
                        }

                        // Update menu layout to list
                        this._servicesConfig.appMenuLayout = 'list';
                        this._servicesConfig.lowspecEnabled = true;
                    }

                    // Only mark as dismissed if user actually chose (0=Ignore, 1=Apply)
                    // Exit code 2 means crash/error — don't dismiss, try again next time
                    if (exitCode === 0 || exitCode === 1) {
                        this._servicesConfig.lowspecDismissed = true;
                        this._saveLowspecConfig();
                    }
                } catch (e) {
                    log(`Praya: Error in lowspec dialog: ${e.message}`);
                }
                this._lowspecProc = null;
            });
        } catch (e) {
            log(`Praya: Error launching lowspec dialog: ${e.message}`);
            this._lowspecProc = null;
        }
    }

    _saveLowspecConfig() {
        let homeDir = GLib.get_home_dir();
        let configDir = GLib.build_filenamev([homeDir, '.config', 'praya']);
        let configPath = GLib.build_filenamev([configDir, 'services.json']);

        try {
            let dir = Gio.File.new_for_path(configDir);
            if (!dir.query_exists(null)) {
                dir.make_directory_with_parents(null);
            }

            let configFile = Gio.File.new_for_path(configPath);
            let content = JSON.stringify(this._servicesConfig, null, 2) + '\n';
            configFile.replace_contents(
                content,
                null,
                false,
                Gio.FileCreateFlags.NONE,
                null
            );
        } catch (e) {
            log(`Praya: Error saving services config: ${e.message}`);
        }
    }

    _applyPanelPosition(position) {
        this._panelPosition = position;
        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        let panelBox = Main.layoutManager.panelBox;

        // Apply floating style via CSS (keeps panelBox struts correct)
        if (this._servicesConfig.floatingPanel) {
            Main.panel.add_style_class_name('praya-floating-panel');
        } else {
            Main.panel.remove_style_class_name('praya-floating-panel');
        }

        if (position === 'bottom') {
            // Defer so panelBox.height reflects CSS margins after layout settles
            if (this._panelPositionIdleId) {
                GLib.source_remove(this._panelPositionIdleId);
            }
            this._panelPositionIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._panelPositionIdleId = null;
                let m = Main.layoutManager.primaryMonitor;
                if (m) {
                    panelBox.set_position(m.x, m.y + m.height - panelBox.height);
                }
                return GLib.SOURCE_REMOVE;
            });
        } else {
            panelBox.set_position(monitor.x, monitor.y);
        }
    }

    setPanelPosition(position) {
        this._applyPanelPosition(position);
        this._removeWorkAreaMargins();
        this._setupWorkAreaMargins();
        this._updateAllWindowsIconGeometry();
    }

    _setupWorkAreaMargins() {
        if (!this._servicesConfig.floatingPanel) return;

        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;

        let margin = 5;
        let isBottom = this._panelPosition === 'bottom';
        this._marginStruts = [];

        // Left edge strut
        let leftStrut = new St.Widget({
            x: monitor.x, y: monitor.y,
            width: margin, height: monitor.height,
            reactive: false,
        });
        Main.layoutManager.addTopChrome(leftStrut, { affectsStruts: true, affectsInputRegion: false });
        this._marginStruts.push(leftStrut);

        // Right edge strut
        let rightStrut = new St.Widget({
            x: monitor.x + monitor.width - margin, y: monitor.y,
            width: margin, height: monitor.height,
            reactive: false,
        });
        Main.layoutManager.addTopChrome(rightStrut, { affectsStruts: true, affectsInputRegion: false });
        this._marginStruts.push(rightStrut);

        // Opposite side of panel
        if (isBottom) {
            let topStrut = new St.Widget({
                x: monitor.x, y: monitor.y,
                width: monitor.width, height: margin,
                reactive: false,
            });
            Main.layoutManager.addTopChrome(topStrut, { affectsStruts: true, affectsInputRegion: false });
            this._marginStruts.push(topStrut);
        } else {
            let bottomStrut = new St.Widget({
                x: monitor.x, y: monitor.y + monitor.height - margin,
                width: monitor.width, height: margin,
                reactive: false,
            });
            Main.layoutManager.addTopChrome(bottomStrut, { affectsStruts: true, affectsInputRegion: false });
            this._marginStruts.push(bottomStrut);
        }
    }

    _removeWorkAreaMargins() {
        if (this._marginStruts) {
            for (let strut of this._marginStruts) {
                Main.layoutManager.removeChrome(strut);
                strut.destroy();
            }
            this._marginStruts = null;
        }
    }

    _setWindowIconGeometry(window) {
        if (!window || window.get_window_type() !== Meta.WindowType.NORMAL)
            return;
        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;

        let rect = new Mtk.Rectangle();
        rect.x = monitor.x;
        rect.width = Main.panel.width;
        rect.height = Main.layoutManager.panelBox.height;
        if (this._panelPosition === 'bottom') {
            rect.y = monitor.y + monitor.height - rect.height;
        } else {
            rect.y = monitor.y;
        }
        window.set_icon_geometry(rect);
    }

    _updateAllWindowsIconGeometry() {
        let windows = global.get_window_actors()
            .map(a => a.meta_window);
        for (let w of windows) {
            this._setWindowIconGeometry(w);
        }
    }

    _setupIconGeometryTracking() {
        this._windowCreatedId = global.display.connect('window-created', (_display, window) => {
            this._setWindowIconGeometry(window);
        });
        this._updateAllWindowsIconGeometry();
    }

    _removeIconGeometryTracking() {
        if (this._windowCreatedId) {
            global.display.disconnect(this._windowCreatedId);
            this._windowCreatedId = null;
        }
        let windows = global.get_window_actors()
            .map(a => a.meta_window);
        for (let w of windows) {
            if (w.get_window_type() === Meta.WindowType.NORMAL)
                w.set_icon_geometry(null);
        }
    }

    _startPrayaServices() {
        // Import display environment variables into systemd user session
        // immediately. Without this, apps launched via systemd scopes
        // (which is how GNOME Shell launches apps) won't have
        // WAYLAND_DISPLAY/DISPLAY and will fail to connect to the
        // display server.
        this._importEnvironment();

        // Start praya systemd user service after a short delay
        // to let import-environment complete first
        this._startPrayaServiceTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._startPrayaServiceTimeoutId = null;
            try {
                Gio.Subprocess.new(
                    ['systemctl', '--user', 'start', 'praya'],
                    Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
                );
            } catch (e) {
                // Silent failure
            }
            return GLib.SOURCE_REMOVE;
        });

        // Enable feature services based on config
        try {
            let connection = Gio.bus_get_sync(Gio.BusType.SESSION, null);

            // Enable posture service if configured
            if (this._servicesConfig.posture) {
                connection.call(
                    'com.github.blankon.praya',
                    '/com/github/blankon/Praya',
                    'com.github.blankon.Praya',
                    'EnableService',
                    new GLib.Variant('(s)', ['posture']),
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (conn, result) => {
                        try {
                            conn.call_finish(result);
                        } catch (e) {
                            // Silent failure
                        }
                    }
                );
            }

            // Enable AI service if configured
            if (this._servicesConfig.ai) {
                connection.call(
                    'com.github.blankon.praya',
                    '/com/github/blankon/Praya',
                    'com.github.blankon.Praya',
                    'EnableService',
                    new GLib.Variant('(s)', ['ai']),
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (conn, result) => {
                        try {
                            conn.call_finish(result);
                        } catch (e) {
                            // Silent failure
                        }
                    }
                );
            }
        } catch (e) {
            // Silent failure
        }
    }

    _importEnvironment() {
        // Build the list of env vars to import
        let envVars = ['WAYLAND_DISPLAY', 'DISPLAY', 'XDG_RUNTIME_DIR',
                       'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP'];

        // Filter to only vars that are actually set in our process
        let availableVars = envVars.filter(v => GLib.getenv(v) !== null);

        if (availableVars.length === 0) {
            // No display vars available yet - schedule a retry
            this._importEnvRetries = 0;
            this._importEnvTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this._importEnvRetries++;
                if (this._importEnvRetries >= 30) {
                    this._importEnvTimeoutId = null;
                    return GLib.SOURCE_REMOVE;
                }
                let ready = envVars.some(v => GLib.getenv(v) !== null);
                if (ready) {
                    this._doImportEnvironment(envVars.filter(v => GLib.getenv(v) !== null));
                    this._importEnvTimeoutId = null;
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
            return;
        }

        this._doImportEnvironment(availableVars);
    }

    _doImportEnvironment(vars) {
        // Use systemctl import-environment
        try {
            let args = ['systemctl', '--user', 'import-environment', ...vars];
            let proc = Gio.Subprocess.new(
                args,
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
            );
            // Wait async to ensure it completes
            proc.wait_async(null, (proc, result) => {
                try {
                    proc.wait_finish(result);
                } catch (e) {
                    // Silent failure
                }
            });
        } catch (e) {
            // Silent failure
        }

        // Also update D-Bus activation environment for portal-launched apps
        try {
            let args = ['dbus-update-activation-environment', '--systemd', ...vars];
            let proc = Gio.Subprocess.new(
                args,
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
            );
            proc.wait_async(null, (proc, result) => {
                try {
                    proc.wait_finish(result);
                } catch (e) {
                    // Silent failure
                }
            });
        } catch (e) {
            // Silent failure
        }
    }

    _setupSuperKey() {
        // Ensure the overlay-key is set to Super_L so that
        // Super (not Alt) triggers the overview toggle.
        this._mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        this._originalOverlayKey = this._mutterSettings.get_string('overlay-key');
        this._mutterSettings.set_string('overlay-key', 'Super_L');

        // Override the overview toggle so pressing the Super key
        // opens the Praya panel instead of GNOME Activities Overview.
        this._originalOverviewToggle = Main.overview.toggle.bind(Main.overview);
        Main.overview.toggle = () => {
            if (this._indicator) {
                this._indicator._togglePanel();
            }
        };

        // Setup Alt key tap to open GNOME workspace view (Activities Overview)
        this._setupAltOverview();
    }

    _setupAltOverview() {
        this._altTapState = null;

        this._altCapturedEventId = global.stage.connect('captured-event', (actor, event) => {
            let type = event.type();

            if (type === Clutter.EventType.KEY_PRESS) {
                let symbol = event.get_key_symbol();
                if (symbol === Clutter.KEY_Alt_L || symbol === Clutter.KEY_Alt_R) {
                    if (!this._altTapState) {
                        this._altTapState = 'pressed';
                    }
                } else {
                    // Another key was pressed, cancel Alt tap
                    this._altTapState = null;
                }
            } else if (type === Clutter.EventType.KEY_RELEASE) {
                let symbol = event.get_key_symbol();
                if ((symbol === Clutter.KEY_Alt_L || symbol === Clutter.KEY_Alt_R) &&
                    this._altTapState === 'pressed') {
                    this._altTapState = null;
                    // Open GNOME Activities Overview (workspace view)
                    if (this._originalOverviewToggle) {
                        this._originalOverviewToggle();
                    }
                } else {
                    this._altTapState = null;
                }
            }

            return Clutter.EVENT_PROPAGATE;
        });
    }

    _removeAltOverview() {
        if (this._altCapturedEventId) {
            global.stage.disconnect(this._altCapturedEventId);
            this._altCapturedEventId = null;
        }
        this._altTapState = null;
    }

    _restoreSuperKey() {
        // Remove Alt overview handler
        this._removeAltOverview();

        // Restore original overlay-key
        if (this._mutterSettings && this._originalOverlayKey !== undefined) {
            this._mutterSettings.set_string('overlay-key', this._originalOverlayKey);
            this._mutterSettings = null;
            this._originalOverlayKey = undefined;
        }

        if (this._originalOverviewToggle) {
            Main.overview.toggle = this._originalOverviewToggle;
            this._originalOverviewToggle = null;
        }
    }

    _setupKeybinding() {
        // Grab the Super+Space accelerator
        this._acceleratorAction = global.display.grab_accelerator('<Super>space', Meta.KeyBindingFlags.NONE);

        // Grab Super+1 through Super+9 for taskbar window switching
        this._numberAcceleratorActions = [];
        for (let i = 1; i <= 9; i++) {
            let action = global.display.grab_accelerator(`<Super>${i}`, Meta.KeyBindingFlags.NONE);
            if (action !== Meta.KeyBindingAction.NONE) {
                let name = Meta.external_binding_name_for_action(action);
                Main.wm.allowKeybinding(name, Shell.ActionMode.ALL);
                this._numberAcceleratorActions.push({ action, index: i - 1 });
            }
        }

        if (this._acceleratorAction !== Meta.KeyBindingAction.NONE) {
            let name = Meta.external_binding_name_for_action(this._acceleratorAction);
            Main.wm.allowKeybinding(name, Shell.ActionMode.ALL);
        }

        this._acceleratorActivatedId = global.display.connect('accelerator-activated', (display, action) => {
            if (action === this._acceleratorAction) {
                if (this._indicator) {
                    this._indicator._togglePanel();
                }
                return;
            }

            // Check Super+number actions
            for (let entry of this._numberAcceleratorActions) {
                if (action === entry.action) {
                    this._activateTaskbarWindow(entry.index);
                    return;
                }
            }
        });
    }

    _activateTaskbarWindow(index) {
        if (!this._taskbar) return;
        let windows = this._taskbar.getWindows();
        if (index < windows.length) {
            let window = windows[index];
            if (window.minimized)
                window.unminimize();
            window.activate(global.get_current_time());
        }
    }

    _removeKeybinding() {
        if (this._acceleratorActivatedId) {
            global.display.disconnect(this._acceleratorActivatedId);
            this._acceleratorActivatedId = null;
        }

        if (this._acceleratorAction && this._acceleratorAction !== Meta.KeyBindingAction.NONE) {
            global.display.ungrab_accelerator(this._acceleratorAction);
            this._acceleratorAction = null;
        }

        if (this._numberAcceleratorActions) {
            for (let entry of this._numberAcceleratorActions) {
                global.display.ungrab_accelerator(entry.action);
            }
            this._numberAcceleratorActions = [];
        }
    }

    _initPostureDBus() {
        try {
            this._dbusConnection = Gio.bus_get_sync(Gio.BusType.SESSION, null);
        } catch (e) {
            log(`Praya: Error initializing posture D-Bus: ${e.message}`);
            this._dbusConnection = null;
        }
    }

    _startPosturePolling() {
        // Postpone the main loop of bad posture detection to 10 seconds on first load
        this._postureStartDelayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
            this._postureStartDelayId = null;

            // Enable posture evaluation after the delay
            this._postureEvalPaused = false;

            // Poll every 500ms for posture data (similar to Praya Preferences)
            this._posturePollingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                this._fetchUserPosture();
                return GLib.SOURCE_CONTINUE;
            });

            // Fetch immediately after delay
            this._fetchUserPosture();

            return GLib.SOURCE_REMOVE;
        });
    }

    _stopPosturePolling() {
        if (this._postureStartDelayId) {
            GLib.source_remove(this._postureStartDelayId);
            this._postureStartDelayId = null;
        }
        if (this._posturePollingId) {
            GLib.source_remove(this._posturePollingId);
            this._posturePollingId = null;
        }
    }

    // Public methods to pause/resume polling (called when preferences dialog opens/closes)
    pausePosturePolling() {
        this._posturePollingPaused = true;
    }

    resumePosturePolling() {
        this._posturePollingPaused = false;
    }

    _fetchUserPosture() {
        if (!this._dbusConnection) {
            return;
        }

        // Skip if polling is paused (e.g., preferences dialog is open)
        if (this._posturePollingPaused) {
            return;
        }

        this._dbusConnection.call(
            POSTURE_BUS_NAME,
            POSTURE_SERVICE_PATH,
            POSTURE_SERVICE_INTERFACE,
            'GetUserPosture',
            null,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (conn, result) => {
                try {
                    let reply = conn.call_finish(result);
                    this._handlePostureResult(reply);
                } catch (e) {
                    // Service might not be running or method not available
                    // Hide overlay if service is unavailable
                    this._hideBlurOverlay();
                }
            }
        );
    }

    _handlePostureResult(reply) {
        try {
            // GetUserPosture returns (sdd) - tuple of (status_string, score, tolerance)
            // score is 0.0 to 1.0 where 0 = good posture, 1 = bad posture
            let status = reply.get_child_value(0).get_string()[0];
            let score = reply.get_child_value(1).get_double();
            let tolerance = reply.get_child_value(2).get_double();

            // Store current posture data for overlay display
            this._currentPostureStatus = status;
            this._currentPostureScore = score;
            this._currentPostureTolerance = tolerance;

            // Show overlay when posture is not good
            // User must manually click to dismiss - overlay does not auto-close when posture improves
            if (status !== 'good' && !this._postureEvalPaused) {
                this._showBlurOverlay();
            }

            // Update overlay display if it's visible (continuously update score and bar)
            this._updateOverlayDisplay();
        } catch (e) {
            log(`Praya: Error parsing user posture: ${e.message}`);
        }
    }

    _updateOverlayDisplay() {
        // Update status labels and bar fills if overlay is visible
        if (!this._blurOverlays || this._blurOverlays.length === 0) {
            return;
        }

        let status = this._currentPostureStatus || 'unknown';
        let score = this._currentPostureScore || 0;

        // Update all status labels
        if (this._overlayStatusLabels) {
            // Use green for good posture, red for bad
            let textColor = status === 'good' ? '#8ff0a4' : '#f66151';
            for (let label of this._overlayStatusLabels) {
                if (label) {
                    label.text = `${status} (${score.toFixed(2)})`;
                    label.set_style(`font-size: 14px; color: ${textColor}; margin-top: 20px; font-family: monospace;`);
                }
            }
        }

        // Check for auto-close logic - use tolerance from GetUserPosture
        let tolerance = this._currentPostureTolerance || 0;
        if (score <= tolerance && !this._autoCloseAnimating) {
            // Start auto-close animation: grow green bar to full width over 1 second
            this._autoCloseAnimating = true;

            if (this._overlayBarFills) {
                for (let barFill of this._overlayBarFills) {
                    if (barFill) {
                        // Set to green color
                        barFill.set_style(`background-color: #26a269; border-radius: 6px; height: 16px;`);
                        // Animate to full width over 1 second
                        barFill.ease({
                            width: 200,
                            duration: 1000,
                            mode: Clutter.AnimationMode.LINEAR,
                        });
                    }
                }
            }

            // Set timeout to auto-close after 1 second
            this._autoCloseTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                this._autoCloseTimeoutId = null;
                if (this._autoCloseAnimating) {
                    this._autoCloseAnimating = false;
                    this._dismissWithPause();
                }
                return GLib.SOURCE_REMOVE;
            });
        } else if (score > tolerance && this._autoCloseAnimating) {
            // Score increased above tolerance, cancel auto-close
            this._cancelAutoClose();

            // Reset bar to current score state
            if (this._overlayBarFills) {
                let adjustedScore = Math.max(0.1, score);
                let fillWidth = Math.round(200 * adjustedScore);
                let r = Math.round(38 + (224 - 38) * score);
                let g = Math.round(162 + (27 - 162) * score);
                let b = Math.round(105 + (36 - 105) * score);

                for (let barFill of this._overlayBarFills) {
                    if (barFill) {
                        barFill.remove_all_transitions();
                        barFill.set_style(`background-color: rgb(${r}, ${g}, ${b}); border-radius: 6px; height: 16px;`);
                        barFill.ease({
                            width: fillWidth,
                            duration: 200,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        });
                    }
                }
            }
        } else if (!this._autoCloseAnimating) {
            // Normal update when not auto-closing
            if (this._overlayBarFills) {
                // Minimum width of 0.1 (10%) even when score is 0
                let adjustedScore = Math.max(0.1, score);
                let fillWidth = Math.round(200 * adjustedScore);
                let r = Math.round(38 + (224 - 38) * score);
                let g = Math.round(162 + (27 - 162) * score);
                let b = Math.round(105 + (36 - 105) * score);

                for (let barFill of this._overlayBarFills) {
                    if (barFill) {
                        // Update color immediately
                        barFill.set_style(`background-color: rgb(${r}, ${g}, ${b}); border-radius: 6px; height: 16px;`);
                        // Animate width change
                        barFill.ease({
                            width: fillWidth,
                            duration: 200,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        });
                    }
                }
            }
        }
    }

    _cancelAutoClose() {
        this._autoCloseAnimating = false;
        if (this._autoCloseTimeoutId) {
            GLib.source_remove(this._autoCloseTimeoutId);
            this._autoCloseTimeoutId = null;
        }
    }

    _cleanupPostureDBus() {
        this._stopPosturePolling();
        this._dbusConnection = null;
        this._postureEvalPaused = false;
        this._posturePollingPaused = false;

        // Clean up pause timeout
        if (this._pauseTimeoutId) {
            GLib.source_remove(this._pauseTimeoutId);
            this._pauseTimeoutId = null;
        }

        // Clean up auto-close timeout
        if (this._autoCloseTimeoutId) {
            GLib.source_remove(this._autoCloseTimeoutId);
            this._autoCloseTimeoutId = null;
        }
        this._autoCloseAnimating = false;
    }

    _logPostureEvent() {
        try {
            // Get home directory and construct log path
            let homeDir = GLib.get_home_dir();
            let logDir = GLib.build_filenamev([homeDir, '.local', 'share', 'praya']);
            let logPath = GLib.build_filenamev([logDir, 'posture.log']);

            // Ensure directory exists
            let dir = Gio.File.new_for_path(logDir);
            if (!dir.query_exists(null)) {
                dir.make_directory_with_parents(null);
            }

            // Check if file exists to determine if we need to write header
            let logFile = Gio.File.new_for_path(logPath);
            let needsHeader = !logFile.query_exists(null);

            // Open file in append mode
            let stream = logFile.append_to(Gio.FileCreateFlags.NONE, null);

            // Write header if file is new
            if (needsHeader) {
                let header = 'timestamp,status,score,tolerance,delay\n';
                stream.write(header, null);
            }

            // Get current timestamp in ISO format
            let now = GLib.DateTime.new_now_local();
            let timestamp = now.format('%Y-%m-%d %H:%M:%S');

            // Get posture data
            let status = this._currentPostureStatus || 'unknown';
            let score = this._currentPostureScore || 0;
            let tolerance = this._currentPostureTolerance || 0;
            let delay = 10000; // The pause delay in ms

            // Write CSV line
            let line = `${timestamp},${status},${score.toFixed(4)},${tolerance.toFixed(4)},${delay}\n`;
            stream.write(line, null);
            stream.close(null);
        } catch (e) {
            log(`Praya: Error logging posture event: ${e.message}`);
        }
    }

    _showBlurOverlay() {
        // Don't create duplicates if already showing
        if (this._blurOverlays && this._blurOverlays.length > 0) {
            return;
        }

        // Log the posture event to CSV
        this._logPostureEvent();

        // Close the panel if it's open - users shouldn't browse apps with bad posture
        if (this._indicator && this._indicator._panelVisible) {
            this._indicator._hidePanel();
        }

        this._blurOverlays = [];
        this._overlayStatusLabels = [];
        this._overlayBarFills = [];

        // Get current posture data
        let status = this._currentPostureStatus || 'unknown';
        let score = this._currentPostureScore || 0;

        // Create blur overlay on each monitor
        for (let monitor of Main.layoutManager.monitors) {
            let overlay = new St.Widget({
                style_class: 'praya-blur-overlay',
                layout_manager: new Clutter.BinLayout(),
                x: monitor.x,
                y: monitor.y,
                width: monitor.width,
                height: monitor.height,
                reactive: true,
                opacity: 0,
                style: 'background-color: rgba(0, 30, 100, 0.3);',
            });

            // Add blur effect to the overlay
            let blurEffect = new Shell.BlurEffect({
                radius: 25,
                brightness: 0.5,
                mode: Shell.BlurMode.BACKGROUND,
            });
            overlay.add_effect_with_name('blur', blurEffect);

            // Add warning icon and text - centered via BinLayout
            let contentBox = new St.BoxLayout({
                vertical: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                y_expand: true,
            });

            let icon = new St.Icon({
                icon_name: 'dialog-warning-symbolic',
                icon_size: 64,
                style: 'color: #ff6b6b; margin-bottom: 20px;',
                x_align: Clutter.ActorAlign.CENTER,
            });

            let label = new St.Label({
                text: _('Bad Posture Detected'),
                style: 'font-size: 24px; font-weight: bold; color: white;',
                x_align: Clutter.ActorAlign.CENTER,
            });

            let sublabel = new St.Label({
                text: _('Please correct your posture'),
                style: 'font-size: 16px; color: #cccccc; margin-top: 10px;',
                x_align: Clutter.ActorAlign.CENTER,
            });

            // Posture status and score display (like in Praya Preferences)
            let statusLabel = new St.Label({
                text: `${status} (${score.toFixed(2)})`,
                style: 'font-size: 14px; color: #f66151; margin-top: 20px; font-family: monospace;',
                x_align: Clutter.ActorAlign.CENTER,
            });
            this._overlayStatusLabels.push(statusLabel);

            // Posture bar container
            let barContainer = new St.BoxLayout({
                style_class: 'praya-overlay-bar-container',
                x_align: Clutter.ActorAlign.CENTER,
                style: 'background-color: rgba(255, 255, 255, 0.2); border-radius: 6px; width: 200px; height: 16px; margin-top: 10px;',
            });

            // Calculate bar fill width and color based on score
            // Minimum width of 0.1 (10%) even when score is 0
            let adjustedScore = Math.max(0.1, score);
            let fillWidth = Math.round(200 * adjustedScore);
            let r = Math.round(38 + (224 - 38) * score);
            let g = Math.round(162 + (27 - 162) * score);
            let b = Math.round(105 + (36 - 105) * score);

            let barFill = new St.Widget({
                style: `background-color: rgb(${r}, ${g}, ${b}); border-radius: 6px; height: 16px;`,
                width: fillWidth,
            });
            barContainer.add_child(barFill);
            this._overlayBarFills.push(barFill);

            let dismissLabel = new St.Label({
                text: _('Click anywhere to dismiss (10s pause)'),
                style: 'font-size: 12px; color: #888888; margin-top: 30px;',
                x_align: Clutter.ActorAlign.CENTER,
            });

            contentBox.add_child(icon);
            contentBox.add_child(label);
            contentBox.add_child(sublabel);
            contentBox.add_child(statusLabel);
            contentBox.add_child(barContainer);
            contentBox.add_child(dismissLabel);
            overlay.add_child(contentBox);

            // Button container at bottom
            let buttonContainer = new St.BoxLayout({
                vertical: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.END,
                x_expand: true,
                y_expand: true,
                style: 'spacing: 8px; margin-bottom: 40px;',
            });

            // Recalibrate button
            let recalibrateButton = new St.Button({
                style_class: 'praya-overlay-recalibrate-btn',
                label: _('Recalibrate'),
                style: 'background-color: rgba(255, 255, 255, 0.15); color: #cccccc; border-radius: 6px; padding: 8px 16px; font-size: 12px;',
            });
            recalibrateButton.connect('clicked', () => {
                this._recalibratePosture();
                return Clutter.EVENT_STOP;
            });
            buttonContainer.add_child(recalibrateButton);

            // Disable Posture Monitoring button
            let disableButton = new St.Button({
                style_class: 'praya-overlay-disable-btn',
                label: _('Disable Posture Monitoring Service'),
                style: 'background-color: rgba(255, 255, 255, 0.15); color: #cccccc; border-radius: 6px; padding: 8px 16px; font-size: 12px;',
            });
            disableButton.connect('clicked', () => {
                this._disablePostureService();
                return Clutter.EVENT_STOP;
            });
            buttonContainer.add_child(disableButton);

            overlay.add_child(buttonContainer);

            // Allow clicking to dismiss the overlay with 10-second pause
            overlay.connect('button-press-event', (actor, event) => {
                // Don't dismiss if clicking the button container
                let [x, y] = event.get_coords();
                let [cx, cy] = buttonContainer.get_transformed_position();
                let [cw, ch] = buttonContainer.get_size();
                if (x >= cx && x <= cx + cw && y >= cy && y <= cy + ch) {
                    return Clutter.EVENT_PROPAGATE;
                }
                this._dismissWithPause();
                return Clutter.EVENT_STOP;
            });

            // Add to UI chrome (above everything)
            Main.layoutManager.addTopChrome(overlay);
            this._blurOverlays.push(overlay);

            // Fade in over 1 second
            overlay.ease({
                opacity: 255,
                duration: 1000,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    _disablePostureService() {
        if (!this._dbusConnection) return;

        this._dbusConnection.call(
            POSTURE_BUS_NAME,
            '/com/github/blankon/Praya',
            'com.github.blankon.Praya',
            'DisableService',
            new GLib.Variant('(s)', ['posture']),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (conn, result) => {
                try {
                    conn.call_finish(result);
                    // Hide overlay after disabling the service
                    this._hideBlurOverlay();
                } catch (e) {
                    log(`Praya: Error disabling posture service: ${e.message}`);
                }
            }
        );
    }

    _recalibratePosture() {
        if (!this._dbusConnection) return;

        this._dbusConnection.call(
            POSTURE_BUS_NAME,
            POSTURE_SERVICE_PATH,
            POSTURE_SERVICE_INTERFACE,
            'Recalibrate',
            null,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (conn, result) => {
                try {
                    conn.call_finish(result);
                    // Dismiss overlay with pause after recalibration
                    this._dismissWithPause();
                } catch (e) {
                    log(`Praya: Error recalibrating posture: ${e.message}`);
                }
            }
        );
    }

    _dismissWithPause() {
        // Hide the overlay
        this._hideBlurOverlay();

        // Pause posture evaluation for 10 seconds
        this._postureEvalPaused = true;

        // Clear any existing pause timeout
        if (this._pauseTimeoutId) {
            GLib.source_remove(this._pauseTimeoutId);
        }

        // Resume evaluation after 10 seconds
        this._pauseTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => {
            this._postureEvalPaused = false;
            this._pauseTimeoutId = null;
            return GLib.SOURCE_REMOVE;
        });
    }

    _hideBlurOverlay() {
        if (!this._blurOverlays || this._blurOverlays.length === 0) {
            return;
        }

        // Cancel any pending auto-close
        this._cancelAutoClose();

        // Clear references immediately to prevent updates during fade out
        let overlaysToRemove = this._blurOverlays;
        this._blurOverlays = [];
        this._overlayStatusLabels = [];
        this._overlayBarFills = [];

        // Fade out fast then destroy
        for (let overlay of overlaysToRemove) {
            if (overlay) {
                overlay.ease({
                    opacity: 0,
                    duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        Main.layoutManager.removeChrome(overlay);
                        overlay.destroy();
                    },
                });
            }
        }
    }

    _applySettings() {
        // Extension's modified values - used to detect if we're reading our own changes
        const EXTENSION_BUTTON_LAYOUT = ':minimize,maximize,close';

        // GNOME default values - used as fallback
        const DEFAULT_BUTTON_LAYOUT = 'appmenu:close';

        // Get settings objects
        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._wmSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});

        // Save original values, but check if they're our own modified values
        // (can happen after shell restart while extension was enabled)
        this._originalHotCorner = this._interfaceSettings.get_boolean('enable-hot-corners');

        let currentButtonLayout = this._wmSettings.get_string('button-layout');
        if (currentButtonLayout === EXTENSION_BUTTON_LAYOUT) {
            // We're reading our own modified value, use default
            this._originalButtonLayout = DEFAULT_BUTTON_LAYOUT;
        } else {
            this._originalButtonLayout = currentButtonLayout;
        }

        // Apply new settings
        this._interfaceSettings.set_boolean('enable-hot-corners', false);
        this._wmSettings.set_string('button-layout', EXTENSION_BUTTON_LAYOUT);
    }

    _restoreSettings() {
        // GNOME default values - used as fallback
        const DEFAULT_BUTTON_LAYOUT = 'appmenu:close';

        // Restore original values (create settings objects if needed)
        if (!this._interfaceSettings) {
            this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        }
        if (!this._wmSettings) {
            this._wmSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
        }

        // Restore hot corners
        if (this._originalHotCorner !== undefined) {
            this._interfaceSettings.set_boolean('enable-hot-corners', this._originalHotCorner);
        }

        // Restore button layout (hide minimize button)
        let buttonLayoutToRestore = this._originalButtonLayout !== undefined
            ? this._originalButtonLayout
            : DEFAULT_BUTTON_LAYOUT;
        this._wmSettings.set_string('button-layout', buttonLayoutToRestore);

        this._interfaceSettings = null;
        this._wmSettings = null;
    }

    _findDock() {
        // Try to find Dash to Dock or Ubuntu Dock
        let start = Main.extensionManager?.lookup('dash-to-dock@micxgx.gmail.com');
        if (start && start.stateObj && start.stateObj.dockManager) {
            return start.stateObj.dockManager._allDocks[0]?.dash;
        }

        // Try Ubuntu Dock
        start = Main.extensionManager?.lookup('ubuntu-dock@ubuntu.com');
        if (start && start.stateObj && start.stateObj.dockManager) {
            return start.stateObj.dockManager._allDocks[0]?.dash;
        }

        // Fallback to overview dash
        return Main.overview.dash;
    }

    _hideDock() {
        if (!this._dock) {
            this._dock = this._findDock();
        }
        if (this._dock) {
            this._dock.hide();
        }
    }

    _showDock() {
        if (this._dock) {
            this._dock.show();
        }
    }

    _hideActivities() {
        let activities = Main.panel.statusArea.activities;
        if (!activities)
            return;

        this._originalActivitiesVisible = activities.container.visible;
        activities.container.visible = false;
    }

    _restoreActivities() {
        let activities = Main.panel.statusArea.activities;
        if (!activities)
            return;

        if (this._originalActivitiesVisible !== undefined) {
            activities.container.visible = this._originalActivitiesVisible;
            this._originalActivitiesVisible = undefined;
        }
    }

    _moveDateTimeToRight() {
        let dateMenu = Main.panel.statusArea.dateMenu;
        if (!dateMenu)
            return;

        // Remove from center box
        let centerBox = Main.panel._centerBox;
        let rightBox = Main.panel._rightBox;

        if (centerBox.contains(dateMenu.container)) {
            centerBox.remove_child(dateMenu.container);
            // Add to position 0 (left of quick settings)
            rightBox.insert_child_at_index(dateMenu.container, 0);
        }

        // Remove center box from panel so left box can expand freely
        let panelBox = centerBox.get_parent();
        if (panelBox && panelBox.contains(centerBox)) {
            this._centerBoxParent = panelBox;
            this._centerBoxIndex = panelBox.get_children().indexOf(centerBox);
            panelBox.remove_child(centerBox);
            this._removedCenterBox = centerBox;
        }

        this._calendarHoverActivate = this._servicesConfig.calendarHoverActivate || false;
    }

    _setupQuickSettingsHover() {
        let quickSettings = Main.panel.statusArea.quickSettings;
        if (!quickSettings)
            return;

        this._quickAccessHoverActivate = this._servicesConfig.quickAccessHoverActivate || false;
    }

    _setupPanelHoverHandler() {
        // Stage motion handler for hover-to-open (only when enabled)
        this._stageMotionId = global.stage.connect('captured-event', (actor, event) => {
            if (event.type() !== Clutter.EventType.MOTION)
                return Clutter.EVENT_PROPAGATE;

            let [px, py] = event.get_coords();

            // Calendar hover-to-open
            if (this._calendarHoverActivate) {
                let dateMenu = Main.panel.statusArea.dateMenu;
                if (dateMenu) {
                    let nearButton = this._isPointInArea(px, py, dateMenu.container, 10);
                    if (nearButton && !dateMenu.menu.isOpen) {
                        this._cancelDateMenuClose();
                        dateMenu.menu.open();
                    }
                }
            }

            // Quick settings hover-to-open
            if (this._quickAccessHoverActivate) {
                let quickSettings = Main.panel.statusArea.quickSettings;
                if (quickSettings) {
                    let nearButton = this._isPointInArea(px, py, quickSettings.container, 10);
                    if (nearButton && !quickSettings.menu.isOpen) {
                        this._cancelQuickSettingsClose();
                        quickSettings.menu.open();
                    }
                }
            }

            return Clutter.EVENT_PROPAGATE;
        });

        // Unified poll to close popups when pointer leaves their area
        this._popupLeavePollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            // Calendar close-on-leave
            let dateMenu = Main.panel.statusArea.dateMenu;
            if (dateMenu && dateMenu.menu.isOpen) {
                let nearButton = this._isPointerInArea(dateMenu.container, 10);
                let nearPopup = this._isPointerInArea(dateMenu.menu.actor, 20);
                if (!nearButton && !nearPopup) {
                    if (!this._dateMenuCloseTimeoutId)
                        this._scheduleDateMenuClose();
                } else {
                    this._cancelDateMenuClose();
                }
            }

            // Quick settings close-on-leave
            let quickSettings = Main.panel.statusArea.quickSettings;
            if (quickSettings && quickSettings.menu.isOpen) {
                let nearButton = this._isPointerInArea(quickSettings.container, 10);
                let nearPopup = this._isPointerNearQuickSettingsPopup(quickSettings, 7);
                if (!nearButton && !nearPopup) {
                    if (!this._quickSettingsCloseTimeoutId)
                        this._scheduleQuickSettingsClose();
                } else {
                    this._cancelQuickSettingsClose();
                }
            }

            return GLib.SOURCE_CONTINUE;
        });
    }

    _removePanelHoverHandler() {
        if (this._stageMotionId) {
            global.stage.disconnect(this._stageMotionId);
            this._stageMotionId = null;
        }

        if (this._popupLeavePollId) {
            GLib.source_remove(this._popupLeavePollId);
            this._popupLeavePollId = null;
        }

        this._cancelDateMenuClose();
        this._cancelQuickSettingsClose();
    }

    _setupHotCorner() {
        // Store original hot corner functions to restore later
        this._originalHotCorners = [];

        // Disable all existing hot corners and override with our behavior
        for (let hotCorner of Main.layoutManager.hotCorners) {
            if (hotCorner) {
                // Store original _toggleOverview function
                this._originalHotCorners.push({
                    corner: hotCorner,
                    originalToggle: hotCorner._toggleOverview.bind(hotCorner)
                });

                // Override to open our panel instead
                hotCorner._toggleOverview = () => {
                    if (this._indicator && !this._indicator._panelVisible) {
                        this._indicator._showPanel();
                    }
                };
            }
        }
    }

    _restoreHotCorner() {
        // Restore original hot corner behavior
        if (this._originalHotCorners) {
            for (let item of this._originalHotCorners) {
                if (item.corner && item.originalToggle) {
                    item.corner._toggleOverview = item.originalToggle;
                }
            }
            this._originalHotCorners = null;
        }
    }

    _restoreDateTimePosition() {
        let dateMenu = Main.panel.statusArea.dateMenu;
        if (!dateMenu)
            return;

        this._cancelDateMenuClose();

        let centerBox = Main.panel._centerBox;
        let rightBox = Main.panel._rightBox;

        // Restore center box to panel
        if (this._removedCenterBox && this._centerBoxParent) {
            this._centerBoxParent.insert_child_at_index(this._removedCenterBox, this._centerBoxIndex);
            this._removedCenterBox = null;
            this._centerBoxParent = null;
            this._centerBoxIndex = undefined;
        }

        if (rightBox.contains(dateMenu.container)) {
            rightBox.remove_child(dateMenu.container);
            centerBox.add_child(dateMenu.container);
        }
    }

    _removeQuickSettingsHover() {
        this._cancelQuickSettingsClose();
    }

    _isPointerNearQuickSettingsPopup(quickSettings, margin) {
        let [px, py] = global.get_pointer();
        // Check the BoxPointer (the visible popup container with arrow)
        let boxPointer = quickSettings.menu._boxPointer;
        if (boxPointer && this._isPointInArea(px, py, boxPointer, margin))
            return true;
        // Fallback: check menu.actor
        if (this._isPointInArea(px, py, quickSettings.menu.actor, margin))
            return true;
        return false;
    }

    _isPointInArea(px, py, actor, margin) {
        let [ax, ay] = actor.get_transformed_position();
        let [aw, ah] = actor.get_size();
        return px >= ax - margin && px <= ax + aw + margin &&
               py >= ay - margin && py <= ay + ah + margin;
    }

    _isPointerInArea(actor, margin) {
        let [px, py] = global.get_pointer();
        return this._isPointInArea(px, py, actor, margin);
    }

    _scheduleDateMenuClose() {
        this._cancelDateMenuClose();
        this._dateMenuCloseTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._dateMenuCloseTimeoutId = null;
            let dateMenu = Main.panel.statusArea.dateMenu;
            if (!dateMenu || !dateMenu.menu.isOpen) return GLib.SOURCE_REMOVE;

            if (this._isPointerInArea(dateMenu.container, 10) ||
                this._isPointerInArea(dateMenu.menu.actor, 20)) {
                this._scheduleDateMenuClose();
                return GLib.SOURCE_REMOVE;
            }

            dateMenu.menu.close();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelDateMenuClose() {
        if (this._dateMenuCloseTimeoutId) {
            GLib.source_remove(this._dateMenuCloseTimeoutId);
            this._dateMenuCloseTimeoutId = null;
        }
    }

    _scheduleQuickSettingsClose() {
        this._cancelQuickSettingsClose();
        this._quickSettingsCloseTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._quickSettingsCloseTimeoutId = null;
            let quickSettings = Main.panel.statusArea.quickSettings;
            if (!quickSettings || !quickSettings.menu.isOpen) return GLib.SOURCE_REMOVE;

            if (this._isPointerInArea(quickSettings.container, 10) ||
                this._isPointerNearQuickSettingsPopup(quickSettings, 7)) {
                this._scheduleQuickSettingsClose();
                return GLib.SOURCE_REMOVE;
            }

            quickSettings.menu.close();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelQuickSettingsClose() {
        if (this._quickSettingsCloseTimeoutId) {
            GLib.source_remove(this._quickSettingsCloseTimeoutId);
            this._quickSettingsCloseTimeoutId = null;
        }
    }

    setCalendarHoverActivate(enabled) {
        this._calendarHoverActivate = enabled;
    }

    setQuickAccessHoverActivate(enabled) {
        this._quickAccessHoverActivate = enabled;
    }

    setFloatingPanel(enabled) {
        this._servicesConfig.floatingPanel = enabled;
        if (enabled) {
            Main.panel.add_style_class_name('praya-floating-panel');
        } else {
            Main.panel.remove_style_class_name('praya-floating-panel');
        }
        this._removeWorkAreaMargins();
        this._setupWorkAreaMargins();
        // Re-apply panel position to account for changed margins
        this._applyPanelPosition(this._panelPosition || 'top');
    }

    _setShowDesktopWallpaper() {
        try {
            let settings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
            let uri = settings.get_string('picture-uri-dark') || settings.get_string('picture-uri');
            if (uri) {
                let path = uri.replace('file://', '');
                this._showDesktopButton.set_style(
                    `background-image: url("${path}"); background-size: cover; background-position: center;`
                );
            }
        } catch (e) {
            log(`Praya: Error setting wallpaper on show desktop button: ${e.message}`);
        }
    }

    setShowDesktopHoverActivate(enabled) {
        this._showDesktopHoverActivate = enabled;
    }

    _toggleShowDesktop() {
        let workspace = global.workspace_manager.get_active_workspace();
        let windows = global.get_window_actors()
            .map(a => a.meta_window)
            .filter(w => {
                return w.get_workspace() === workspace &&
                       !w.is_skip_taskbar() &&
                       w.get_window_type() === Meta.WindowType.NORMAL;
            });

        // Determine state from actual window states:
        // If any window is visible (not minimized), treat as "not minimized" -> minimize all
        // If all windows are minimized, treat as "minimized" -> restore all
        let hasVisibleWindow = windows.some(w => !w.minimized);

        if (hasVisibleWindow) {
            // Minimize all windows
            for (let w of windows) {
                if (!w.minimized) {
                    w.minimize();
                }
            }
            this._showDesktopActive = true;
        } else {
            // Restore all windows
            for (let w of windows) {
                w.unminimize();
            }
            this._showDesktopActive = false;
        }
    }

    disable() {
        // Cancel lowspec timeout and kill dialog if running
        if (this._lowspecTimeoutId) {
            GLib.source_remove(this._lowspecTimeoutId);
            this._lowspecTimeoutId = null;
        }
        if (this._lowspecProc) {
            this._lowspecProc.force_exit();
            this._lowspecProc = null;
        }

        // Cancel pending timeouts
        if (this._importEnvTimeoutId) {
            GLib.source_remove(this._importEnvTimeoutId);
            this._importEnvTimeoutId = null;
        }
        if (this._startPrayaServiceTimeoutId) {
            GLib.source_remove(this._startPrayaServiceTimeoutId);
            this._startPrayaServiceTimeoutId = null;
        }
        if (this._panelPositionIdleId) {
            GLib.source_remove(this._panelPositionIdleId);
            this._panelPositionIdleId = null;
        }
        if (this._startupCompleteId) {
            Main.layoutManager.disconnect(this._startupCompleteId);
            this._startupCompleteId = null;
        }

        // Restore panel to default state
        this._removeIconGeometryTracking();
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }
        this._removeWorkAreaMargins();
        Main.panel.remove_style_class_name('praya-floating-panel');
        let monitor = Main.layoutManager.primaryMonitor;
        let panelBox = Main.layoutManager.panelBox;
        if (monitor && panelBox) {
            panelBox.set_position(monitor.x, monitor.y);
        }

        // Restore gsettings
        this._restoreSettings();

        // Restore Super key to default overview behavior
        this._restoreSuperKey();

        // Remove keybinding
        this._removeKeybinding();

        // Stop posture polling and cleanup D-Bus
        this._cleanupPostureDBus();

        // Remove blur overlays
        this._hideBlurOverlay();

        // Restore hot corner behavior
        this._restoreHotCorner();

        // Show the dock again when extension is disabled
        this._showDock();
        this._dock = null;

        if (this._bgChangedId && this._bgSettings) {
            this._bgSettings.disconnect(this._bgChangedId);
            this._bgChangedId = null;
        }
        if (this._bgDarkChangedId && this._bgSettings) {
            this._bgSettings.disconnect(this._bgDarkChangedId);
            this._bgDarkChangedId = null;
        }
        this._bgSettings = null;

        if (this._showDesktopHoverArea) {
            this._showDesktopHoverArea.destroy();
            this._showDesktopHoverArea = null;
            this._showDesktopButton = null;
            this._showDesktopOverlay = null;
        }

        if (this._taskbar) {
            this._taskbar.destroy();
            this._taskbar = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }


        // Remove panel hover handler
        this._removePanelHoverHandler();

        // Remove quick settings hover
        this._removeQuickSettingsHover();

        // Restore date/time to center
        this._restoreDateTimePosition();

        // Restore activities button
        this._restoreActivities();
    }
}

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
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { PrayaIndicator } from './indicator.js';
import { PrayaTaskbar } from './taskbar.js';

// D-Bus constants for posture service
const POSTURE_BUS_NAME = 'com.github.blankon.praya';
const POSTURE_SERVICE_INTERFACE = 'com.github.blankon.Praya.Posture';
const POSTURE_SERVICE_PATH = '/com/github/blankon/Praya/Posture';

export default class PrayaExtension extends Extension {
    enable() {
        // Start praya services
        this._startPrayaServices();

        // Save and apply gsettings
        this._applySettings();

        this._indicator = new PrayaIndicator();
        // Add to the left side of the panel
        Main.panel.addToStatusArea('praya-indicator', this._indicator, 0, 'left');

        // Hide activities button
        this._hideActivities();

        // Add taskbar to the left box, after indicator (index 1)
        this._taskbar = new PrayaTaskbar();
        Main.panel._leftBox.insert_child_at_index(this._taskbar, 1);

        // Move date/time to the right (left of quick settings)
        this._moveDateTimeToRight();

        // Setup hover trigger for quick settings
        this._setupQuickSettingsHover();

        // Hide the bottom dock when extension is enabled
        this._dock = null;
        this._hideDock();

        // Override hot corner to open our panel instead of overview
        this._setupHotCorner();

        // Setup Meta+Space keybinding to toggle panel
        this._setupKeybinding();

        // Initialize blur overlays array
        this._blurOverlays = [];

        // Auto-close tracking
        this._autoCloseAnimating = false;
        this._autoCloseTimeoutId = null;
        this._autoCloseTolerance = 0.1; // Cancel auto-close if score exceeds this

        // Setup D-Bus connection for posture status
        this._initPostureDBus();

        // Pause posture evaluation during initial delay
        this._postureEvalPaused = true;

        // Start posture polling loop (similar to Praya Preferences)
        this._startPosturePolling();
    }

    _startPrayaServices() {
        // Start praya systemd user service silently
        try {
            let proc = Gio.Subprocess.new(
                ['systemctl', '--user', 'start', 'praya'],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
            );
            // Don't wait for the result - fire and forget
        } catch (e) {
            // Silent failure as requested
        }

        // Enable posture service via D-Bus
        try {
            let connection = Gio.bus_get_sync(Gio.BusType.SESSION, null);
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
        } catch (e) {
            // Silent failure
        }
    }

    _setupKeybinding() {
        // Grab the Super+Space accelerator
        this._acceleratorAction = global.display.grab_accelerator('<Super>space', Meta.KeyBindingFlags.NONE);

        if (this._acceleratorAction !== Meta.KeyBindingAction.NONE) {
            let name = Meta.external_binding_name_for_action(this._acceleratorAction);
            Main.wm.allowKeybinding(name, Shell.ActionMode.ALL);

            this._acceleratorActivatedId = global.display.connect('accelerator-activated', (display, action) => {
                if (action === this._acceleratorAction) {
                    if (this._indicator) {
                        this._indicator._togglePanel();
                    }
                }
            });
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

    _showBlurOverlay() {
        // Don't create duplicates if already showing
        if (this._blurOverlays && this._blurOverlays.length > 0) {
            return;
        }

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
                text: 'Bad Posture Detected',
                style: 'font-size: 24px; font-weight: bold; color: white;',
                x_align: Clutter.ActorAlign.CENTER,
            });

            let sublabel = new St.Label({
                text: 'Please correct your posture',
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
                text: 'Click anywhere to dismiss (10s pause)',
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
                label: 'Recalibrate',
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
                label: 'Disable Posture Monitoring Service',
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
        const EXTENSION_OVERLAY_KEY = 'Alt_L';
        const EXTENSION_BUTTON_LAYOUT = ':minimize,maximize,close';

        // GNOME default values - used as fallback
        const DEFAULT_OVERLAY_KEY = 'Super_L';
        const DEFAULT_BUTTON_LAYOUT = 'appmenu:close';

        // Get settings objects
        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        this._wmSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});

        // Save original values, but check if they're our own modified values
        // (can happen after shell restart while extension was enabled)
        this._originalHotCorner = this._interfaceSettings.get_boolean('enable-hot-corners');

        let currentOverlayKey = this._mutterSettings.get_string('overlay-key');
        if (currentOverlayKey === EXTENSION_OVERLAY_KEY) {
            // We're reading our own modified value, use default
            this._originalOverlayKey = DEFAULT_OVERLAY_KEY;
        } else {
            this._originalOverlayKey = currentOverlayKey;
        }

        let currentButtonLayout = this._wmSettings.get_string('button-layout');
        if (currentButtonLayout === EXTENSION_BUTTON_LAYOUT) {
            // We're reading our own modified value, use default
            this._originalButtonLayout = DEFAULT_BUTTON_LAYOUT;
        } else {
            this._originalButtonLayout = currentButtonLayout;
        }

        // Apply new settings
        this._interfaceSettings.set_boolean('enable-hot-corners', false);
        this._mutterSettings.set_string('overlay-key', EXTENSION_OVERLAY_KEY);
        this._wmSettings.set_string('button-layout', EXTENSION_BUTTON_LAYOUT);
    }

    _restoreSettings() {
        // GNOME default values - used as fallback
        const DEFAULT_OVERLAY_KEY = 'Super_L';
        const DEFAULT_BUTTON_LAYOUT = 'appmenu:close';

        // Restore original values (create settings objects if needed)
        if (!this._interfaceSettings) {
            this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        }
        if (!this._mutterSettings) {
            this._mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        }
        if (!this._wmSettings) {
            this._wmSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
        }

        // Restore hot corners
        if (this._originalHotCorner !== undefined) {
            this._interfaceSettings.set_boolean('enable-hot-corners', this._originalHotCorner);
        }

        // Restore overlay key (Meta key behavior)
        let overlayKeyToRestore = this._originalOverlayKey !== undefined
            ? this._originalOverlayKey
            : DEFAULT_OVERLAY_KEY;
        this._mutterSettings.set_string('overlay-key', overlayKeyToRestore);

        // Restore button layout (hide minimize button)
        let buttonLayoutToRestore = this._originalButtonLayout !== undefined
            ? this._originalButtonLayout
            : DEFAULT_BUTTON_LAYOUT;
        this._wmSettings.set_string('button-layout', buttonLayoutToRestore);

        this._interfaceSettings = null;
        this._mutterSettings = null;
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

        // Add hover trigger for dateMenu
        this._dateMenuHoverId = dateMenu.container.connect('enter-event', () => {
            if (!dateMenu.menu.isOpen) {
                dateMenu.menu.open();
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _setupQuickSettingsHover() {
        let quickSettings = Main.panel.statusArea.quickSettings;
        if (!quickSettings)
            return;

        // Add hover trigger for quick settings
        this._quickSettingsHoverId = quickSettings.container.connect('enter-event', () => {
            if (!quickSettings.menu.isOpen) {
                quickSettings.menu.open();
            }
            return Clutter.EVENT_PROPAGATE;
        });
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

        // Disconnect hover handler
        if (this._dateMenuHoverId) {
            dateMenu.container.disconnect(this._dateMenuHoverId);
            this._dateMenuHoverId = null;
        }

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
        let quickSettings = Main.panel.statusArea.quickSettings;
        if (!quickSettings)
            return;

        if (this._quickSettingsHoverId) {
            quickSettings.container.disconnect(this._quickSettingsHoverId);
            this._quickSettingsHoverId = null;
        }
    }

    disable() {
        // Restore gsettings
        this._restoreSettings();

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

        if (this._taskbar) {
            this._taskbar.destroy();
            this._taskbar = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        // Remove quick settings hover
        this._removeQuickSettingsHover();

        // Restore date/time to center
        this._restoreDateTimePosition();

        // Restore activities button
        this._restoreActivities();
    }
}

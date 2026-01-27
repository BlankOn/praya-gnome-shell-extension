/* preferences.js
 *
 * Preferences dialog for Praya extension
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import { ChatbotSettings } from './chatbot.js';
import { PROVIDERS } from './constants.js';

// D-Bus constants for posture service
const POSTURE_BUS_NAME = 'com.github.blankon.praya';
const POSTURE_MAIN_INTERFACE = 'com.github.blankon.Praya';
const POSTURE_MAIN_PATH = '/com/github/blankon/Praya';
const POSTURE_SERVICE_INTERFACE = 'com.github.blankon.Praya.Posture';
const POSTURE_SERVICE_PATH = '/com/github/blankon/Praya/Posture';

export const PrayaPreferencesDialog = GObject.registerClass(
class PrayaPreferencesDialog extends ModalDialog.ModalDialog {
    _init() {
        super._init({
            styleClass: 'praya-preferences-dialog',
            destroyOnClose: true,
        });

        this._chatbotSettings = new ChatbotSettings();

        // Load services configuration
        this._loadServicesConfig();

        // Build content box
        let contentBox = new St.BoxLayout({
            vertical: true,
            style_class: 'praya-preferences-box',
            x_expand: true,
            y_expand: true,
        });

        // Header row with title and close button
        let headerBox = new St.BoxLayout({
            style_class: 'praya-preferences-header',
            x_expand: true,
        });

        let titleLabel = new St.Label({
            text: 'Praya Preferences',
            style_class: 'praya-preferences-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerBox.add_child(titleLabel);

        this._closeButton = new St.Button({
            style_class: 'praya-preferences-close-btn',
            child: new St.Icon({
                icon_name: 'window-close-symbolic',
                icon_size: 16,
            }),
        });
        this._closeButton.connect('clicked', () => this._saveAndClose());
        headerBox.add_child(this._closeButton);

        contentBox.add_child(headerBox);

        // Praya Service Status section header
        let serviceHeader = new St.Label({
            text: 'Praya Service',
            style_class: 'praya-preferences-section-header',
        });
        contentBox.add_child(serviceHeader);

        // Service status row
        let serviceStatusBox = new St.BoxLayout({
            style_class: 'praya-preferences-row',
            x_expand: true,
        });
        let serviceStatusLabel = new St.Label({
            text: 'Status:',
            style_class: 'praya-preferences-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        serviceStatusBox.add_child(serviceStatusLabel);

        this._serviceStatusValue = new St.Label({
            text: 'Checking...',
            style_class: 'praya-preferences-record-value',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        serviceStatusBox.add_child(this._serviceStatusValue);

        // Refresh button
        this._refreshServiceButton = new St.Button({
            style_class: 'praya-preferences-toggle-btn',
            child: new St.Icon({
                icon_name: 'view-refresh-symbolic',
                icon_size: 16,
            }),
        });
        this._refreshServiceButton.connect('clicked', () => {
            this._checkPrayaServiceStatus();
        });
        serviceStatusBox.add_child(this._refreshServiceButton);
        contentBox.add_child(serviceStatusBox);

        // Check initial service status
        this._checkPrayaServiceStatus();

        // AI Chatbot section header
        let chatbotHeader = new St.Label({
            text: 'Artificial Intelligence',
            style_class: 'praya-preferences-section-header',
        });
        contentBox.add_child(chatbotHeader);

        // Provider selection
        let providerBox = new St.BoxLayout({
            style_class: 'praya-preferences-row',
            x_expand: true,
        });
        let providerLabel = new St.Label({
            text: 'Provider:',
            style_class: 'praya-preferences-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        providerBox.add_child(providerLabel);

        this._providerCombo = new St.Button({
            style_class: 'praya-preferences-combo',
            label: PROVIDERS[this._chatbotSettings.provider]?.name || 'Anthropic',
            x_expand: true,
        });
        this._currentProvider = this._chatbotSettings.provider;
        this._providerCombo.connect('clicked', () => {
            // Toggle between providers
            this._currentProvider = this._currentProvider === 'anthropic' ? 'openai' : 'anthropic';
            this._providerCombo.label = PROVIDERS[this._currentProvider].name;
            this._updateModelCombo();
        });
        providerBox.add_child(this._providerCombo);
        contentBox.add_child(providerBox);

        // Model selection
        let modelBox = new St.BoxLayout({
            style_class: 'praya-preferences-row',
            x_expand: true,
        });
        let modelLabel = new St.Label({
            text: 'Model:',
            style_class: 'praya-preferences-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        modelBox.add_child(modelLabel);

        this._modelCombo = new St.Button({
            style_class: 'praya-preferences-combo',
            label: this._chatbotSettings.model,
            x_expand: true,
        });
        this._currentModelIndex = 0;
        let models = PROVIDERS[this._currentProvider].models;
        for (let i = 0; i < models.length; i++) {
            if (models[i] === this._chatbotSettings.model) {
                this._currentModelIndex = i;
                break;
            }
        }
        this._modelCombo.connect('clicked', () => {
            let models = PROVIDERS[this._currentProvider].models;
            this._currentModelIndex = (this._currentModelIndex + 1) % models.length;
            this._modelCombo.label = models[this._currentModelIndex];
        });
        modelBox.add_child(this._modelCombo);
        contentBox.add_child(modelBox);

        // API Key input
        let apiKeyBox = new St.BoxLayout({
            style_class: 'praya-preferences-row',
            x_expand: true,
        });
        let apiKeyLabel = new St.Label({
            text: 'API Key:',
            style_class: 'praya-preferences-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        apiKeyBox.add_child(apiKeyLabel);

        this._apiKeyEntry = new St.Entry({
            style_class: 'praya-preferences-entry',
            hint_text: 'Enter your API key',
            can_focus: true,
            x_expand: true,
        });
        this._apiKeyEntry.clutter_text.set_password_char('\u25cf');
        if (this._chatbotSettings.apiKey) {
            this._apiKeyEntry.set_text(this._chatbotSettings.apiKey);
        }
        apiKeyBox.add_child(this._apiKeyEntry);

        // Show/hide toggle button
        this._showKeyButton = new St.Button({
            style_class: 'praya-preferences-toggle-btn',
            child: new St.Icon({
                icon_name: 'view-reveal-symbolic',
                icon_size: 16,
            }),
        });
        this._keyVisible = false;
        this._showKeyButton.connect('clicked', () => {
            this._keyVisible = !this._keyVisible;
            this._apiKeyEntry.clutter_text.set_password_char(this._keyVisible ? '' : '\u25cf');
            this._showKeyButton.child.icon_name = this._keyVisible ? 'view-conceal-symbolic' : 'view-reveal-symbolic';
        });
        apiKeyBox.add_child(this._showKeyButton);
        contentBox.add_child(apiKeyBox);

        // Posture section header
        let postureHeader = new St.Label({
            text: 'Posture Monitoring',
            style_class: 'praya-preferences-section-header',
        });
        contentBox.add_child(postureHeader);

        // Initialize posture D-Bus connection
        this._initPostureDBus();

        // Enable/Disable toggle
        let postureEnableBox = new St.BoxLayout({
            style_class: 'praya-preferences-row',
            x_expand: true,
        });
        let postureEnableLabel = new St.Label({
            text: 'Enabled:',
            style_class: 'praya-preferences-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        postureEnableBox.add_child(postureEnableLabel);

        this._postureEnabled = false;
        this._postureToggleButton = new St.Button({
            style_class: 'praya-preferences-combo praya-posture-toggle',
            label: 'Disabled',
            x_expand: true,
        });
        this._postureToggleButton.connect('clicked', () => {
            this._postureEnabled = !this._postureEnabled;
            this._updatePostureToggleUI();
            this._setPostureEnabled(this._postureEnabled);
        });
        postureEnableBox.add_child(this._postureToggleButton);
        contentBox.add_child(postureEnableBox);

        // Recalibrate button
        let recalibrateBox = new St.BoxLayout({
            style_class: 'praya-preferences-row',
            x_expand: true,
        });
        let recalibrateLabel = new St.Label({
            text: 'Calibration:',
            style_class: 'praya-preferences-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        recalibrateBox.add_child(recalibrateLabel);

        this._recalibrateButton = new St.Button({
            style_class: 'praya-preferences-combo',
            label: 'Recalibrate',
            x_expand: true,
        });
        this._recalibrateButton.connect('clicked', () => {
            this._recalibrate();
        });
        recalibrateBox.add_child(this._recalibrateButton);
        contentBox.add_child(recalibrateBox);

        // Posture record display
        let recordBox = new St.BoxLayout({
            style_class: 'praya-preferences-row',
            x_expand: true,
        });
        let recordLabel = new St.Label({
            text: 'Current:',
            style_class: 'praya-preferences-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        recordBox.add_child(recordLabel);

        this._postureRecordLabel = new St.Label({
            text: 'Waiting for data...',
            style_class: 'praya-preferences-record-value',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        recordBox.add_child(this._postureRecordLabel);
        contentBox.add_child(recordBox);

        // Posture value bar (0 = green/good, 1 = red/bad)
        let barRow = new St.BoxLayout({
            style_class: 'praya-preferences-row',
            x_expand: true,
        });
        let barLabel = new St.Label({
            text: 'Level:',
            style_class: 'praya-preferences-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        barRow.add_child(barLabel);

        this._postureBarContainer = new St.BoxLayout({
            style_class: 'praya-posture-bar-container',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._postureBarFill = new St.Widget({
            style_class: 'praya-posture-bar-fill',
            x_expand: false,
            width: 0,
        });
        this._postureBarContainer.add_child(this._postureBarFill);
        barRow.add_child(this._postureBarContainer);
        contentBox.add_child(barRow);

        // Start posture polling
        this._startPosturePolling();

        // Set initial posture enabled state from services config
        this._postureEnabled = this._servicesConfig.posture || false;
        this._updatePostureToggleUI();

        this.contentLayout.add_child(contentBox);
    }

    _updateModelCombo() {
        let models = PROVIDERS[this._currentProvider].models;
        this._currentModelIndex = 0;
        this._modelCombo.label = models[0];
    }

    _saveAndClose() {
        this._chatbotSettings.provider = this._currentProvider;
        this._chatbotSettings.model = PROVIDERS[this._currentProvider].models[this._currentModelIndex];
        this._chatbotSettings.apiKey = this._apiKeyEntry.get_text();
        this._chatbotSettings.save();
        this.close();
    }

    _checkPrayaServiceStatus() {
        this._serviceStatusValue.text = 'Checking...';
        this._serviceStatusValue.remove_style_class_name('praya-posture-good');
        this._serviceStatusValue.remove_style_class_name('praya-posture-bad');

        try {
            let proc = Gio.Subprocess.new(
                ['systemctl', '--user', 'is-active', 'praya'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
            );

            proc.communicate_utf8_async(null, null, (proc, result) => {
                try {
                    let [ok, stdout, stderr] = proc.communicate_utf8_finish(result);
                    let status = stdout.trim();

                    if (status === 'active') {
                        this._serviceStatusValue.text = 'Running';
                        this._serviceStatusValue.add_style_class_name('praya-posture-good');
                    } else if (status === 'inactive') {
                        this._serviceStatusValue.text = 'Stopped';
                        this._serviceStatusValue.add_style_class_name('praya-posture-bad');
                    } else {
                        this._serviceStatusValue.text = status || 'Unknown';
                    }
                } catch (e) {
                    this._serviceStatusValue.text = 'Error checking status';
                }
            });
        } catch (e) {
            this._serviceStatusValue.text = 'Service not found';
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

    _loadServicesConfig() {
        let homeDir = GLib.get_home_dir();
        let configDir = GLib.build_filenamev([homeDir, '.config', 'praya']);
        let configPath = GLib.build_filenamev([configDir, 'services.json']);

        // Default config
        let defaultConfig = {
            ai: false,
            posture: false
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

    _saveServicesConfig() {
        let homeDir = GLib.get_home_dir();
        let configDir = GLib.build_filenamev([homeDir, '.config', 'praya']);
        let configPath = GLib.build_filenamev([configDir, 'services.json']);

        try {
            // Ensure config directory exists
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

    _updatePostureToggleUI() {
        if (this._postureEnabled) {
            this._postureToggleButton.label = 'Enabled';
            this._postureToggleButton.add_style_class_name('praya-posture-toggle-enabled');
        } else {
            this._postureToggleButton.label = 'Disabled';
            this._postureToggleButton.remove_style_class_name('praya-posture-toggle-enabled');
        }
    }

    _setPostureEnabled(enabled) {
        // Update services config
        this._servicesConfig.posture = enabled;
        this._saveServicesConfig();

        if (!this._dbusConnection) return;

        let methodName = enabled ? 'EnableService' : 'DisableService';

        this._dbusConnection.call(
            POSTURE_BUS_NAME,
            POSTURE_MAIN_PATH,
            POSTURE_MAIN_INTERFACE,
            methodName,
            new GLib.Variant('(s)', ['posture']),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (conn, result) => {
                try {
                    conn.call_finish(result);
                } catch (e) {
                    log(`Praya: Error setting posture enabled: ${e.message}`);
                    // Revert UI state and config on error
                    this._postureEnabled = !enabled;
                    this._servicesConfig.posture = !enabled;
                    this._saveServicesConfig();
                    this._updatePostureToggleUI();
                }
            }
        );
    }

    _recalibrate() {
        if (!this._dbusConnection) return;

        // Store connection reference before closing (close() calls _cleanup())
        let connection = this._dbusConnection;

        // Close the dialog first
        this.close();

        // Then call the D-Bus method
        connection.call(
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
                } catch (e) {
                    log(`Praya: Error recalibrating posture: ${e.message}`);
                }
            }
        );
    }

    _startPosturePolling() {
        // Poll every 200ms for posture data
        this._posturePollingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._fetchUserPosture();
            return GLib.SOURCE_CONTINUE;
        });

        // Fetch immediately
        this._fetchUserPosture();
    }

    _stopPosturePolling() {
        if (this._posturePollingId) {
            GLib.source_remove(this._posturePollingId);
            this._posturePollingId = null;
        }
    }

    _fetchUserPosture() {
        if (!this._dbusConnection) {
            this._postureRecordLabel.text = 'D-Bus not available';
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
                    this._displayUserPosture(reply);
                } catch (e) {
                    // Service might not be running or method not available
                    this._postureRecordLabel.text = 'Service unavailable';
                    this._postureRecordLabel.remove_style_class_name('praya-posture-good');
                    this._postureRecordLabel.remove_style_class_name('praya-posture-bad');
                    // Reset bar
                    this._postureBarFill.width = 0;
                    this._postureBarFill.set_style('background-color: #26a269;');
                }
            }
        );
    }

    _displayUserPosture(reply) {
        try {
            // GetUserPosture returns (sd) - tuple of (status_string, score)
            // score is 0.0 to 1.0 where 0 = good posture, 1 = bad posture
            let status = reply.get_child_value(0).get_string()[0];
            let score = reply.get_child_value(1).get_double();

            this._postureRecordLabel.text = `${status} (${score.toFixed(2)})`;

            // Update label color based on status
            if (status === 'good') {
                this._postureRecordLabel.remove_style_class_name('praya-posture-bad');
                this._postureRecordLabel.add_style_class_name('praya-posture-good');
            } else if (status === 'bad') {
                this._postureRecordLabel.remove_style_class_name('praya-posture-good');
                this._postureRecordLabel.add_style_class_name('praya-posture-bad');
            } else {
                this._postureRecordLabel.remove_style_class_name('praya-posture-good');
                this._postureRecordLabel.remove_style_class_name('praya-posture-bad');
            }

            // Update posture bar
            this._updatePostureBar(score);
        } catch (e) {
            this._postureRecordLabel.text = 'Error parsing data';
            log(`Praya: Error parsing user posture: ${e.message}`);
        }
    }

    _updatePostureBar(value) {
        // Clamp value between 0 and 1
        value = Math.max(0, Math.min(1, value));

        // Calculate bar width as percentage of container
        // Minimum width of 0.1 (10%) even when score is 0
        let containerWidth = this._postureBarContainer.width;
        if (containerWidth > 0) {
            let adjustedValue = Math.max(0.1, value);
            let fillWidth = Math.round(containerWidth * adjustedValue);
            // Animate width change smoothly
            this._postureBarFill.ease({
                width: fillWidth,
                duration: 200,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        // Calculate color: 0 = green (#26a269), 1 = red (#e01b24)
        // Interpolate between green and red based on value
        let r = Math.round(38 + (224 - 38) * value);   // 38 -> 224
        let g = Math.round(162 + (27 - 162) * value);  // 162 -> 27
        let b = Math.round(105 + (36 - 105) * value);  // 105 -> 36

        this._postureBarFill.set_style(`background-color: rgb(${r}, ${g}, ${b});`);
    }

    _getVariantValue(dict, key, defaultValue) {
        try {
            let value = dict.lookup_value(key, null);
            if (value === null) return defaultValue;

            // Get the actual value from the variant
            let typeStr = value.get_type_string();
            if (typeStr === 's') {
                return value.get_string()[0];
            } else if (typeStr === 'd') {
                return value.get_double();
            } else if (typeStr === 'i') {
                return value.get_int32();
            } else if (typeStr === 'b') {
                return value.get_boolean();
            }
            return defaultValue;
        } catch (e) {
            return defaultValue;
        }
    }

    _cleanup() {
        this._stopPosturePolling();
        this._dbusConnection = null;
    }

    close() {
        this._cleanup();
        super.close();
    }
});

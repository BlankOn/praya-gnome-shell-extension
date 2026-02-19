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

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import { _ } from './translations.js';
import { ChatbotSettings } from './chatbot.js';
import { PROVIDERS, VERSION } from './constants.js';

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

        // Service running state - assume not running until checked
        this._serviceRunning = false;

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
            text: _('Praya Preferences'),
            style_class: 'praya-preferences-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerBox.add_child(titleLabel);

        let versionLabel = new St.Label({
            text: `v${VERSION}`,
            style_class: 'praya-preferences-version',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerBox.add_child(versionLabel);

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

        // Two-column layout
        let columnsBox = new St.BoxLayout({
            style_class: 'praya-preferences-columns',
            x_expand: true,
        });

        // === LEFT COLUMN: App Menu Option, Taskbar Behaviour ===
        let leftColumn = new St.BoxLayout({
            vertical: true,
            style_class: 'praya-preferences-column',
            x_expand: true,
        });

        // -- Panel Option --
        let panelOptionHeader = new St.Label({
            text: _('Panel Option'),
            style_class: 'praya-preferences-section-header',
        });
        leftColumn.add_child(panelOptionHeader);

        let layoutBox = new St.BoxLayout({
            style_class: 'praya-preferences-row',
            x_expand: true,
        });
        let layoutLabel = new St.Label({
            text: _('App menu layout:'),
            style_class: 'praya-preferences-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        layoutBox.add_child(layoutLabel);

        this._appMenuLayout = this._servicesConfig.appMenuLayout || 'grid';
        this._layoutToggleButton = new St.Button({
            style_class: 'praya-preferences-combo',
            label: this._appMenuLayout === 'grid' ? _('Grid') : _('List'),
            x_expand: true,
        });
        this._layoutToggleButton.connect('clicked', () => {
            this._appMenuLayout = this._appMenuLayout === 'list' ? 'grid' : 'list';
            this._layoutToggleButton.label = this._appMenuLayout === 'grid' ? _('Grid') : _('List');
            this._servicesConfig.appMenuLayout = this._appMenuLayout;
            this._saveServicesConfig();
        });
        layoutBox.add_child(this._layoutToggleButton);
        leftColumn.add_child(layoutBox);

        let panelPositionBox = new St.BoxLayout({
            style_class: 'praya-preferences-row',
            x_expand: true,
        });
        let panelPositionLabel = new St.Label({
            text: _('Position:'),
            style_class: 'praya-preferences-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        panelPositionBox.add_child(panelPositionLabel);

        this._panelPosition = this._servicesConfig.panelPosition || 'top';
        this._panelPositionToggle = new St.Button({
            style_class: 'praya-preferences-combo',
            label: this._panelPosition === 'bottom' ? _('Bottom') : _('Top'),
            x_expand: true,
        });
        this._panelPositionToggle.connect('clicked', () => {
            this._panelPosition = this._panelPosition === 'top' ? 'bottom' : 'top';
            this._panelPositionToggle.label = this._panelPosition === 'bottom' ? _('Bottom') : _('Top');
            this._servicesConfig.panelPosition = this._panelPosition;
            this._saveServicesConfig();

            // Update extension live
            let ext = Main.extensionManager.lookup('praya@blankonlinux.id');
            if (ext?.stateObj) {
                ext.stateObj.setPanelPosition(this._panelPosition);
            }
        });
        panelPositionBox.add_child(this._panelPositionToggle);
        leftColumn.add_child(panelPositionBox);

        // Floating panel toggle
        let floatingPanelBox = new St.BoxLayout({
            style_class: 'praya-preferences-row',
            x_expand: true,
        });
        let floatingPanelLabel = new St.Label({
            text: _('Floating panel:'),
            style_class: 'praya-preferences-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        floatingPanelBox.add_child(floatingPanelLabel);

        this._floatingPanel = this._servicesConfig.floatingPanel || false;
        this._floatingPanelToggle = new St.Button({
            style_class: 'praya-preferences-combo praya-posture-toggle',
            label: this._floatingPanel ? _('Enabled') : _('Disabled'),
            x_expand: true,
        });
        if (this._floatingPanel) {
            this._floatingPanelToggle.add_style_class_name('praya-posture-toggle-enabled');
        }
        this._floatingPanelToggle.connect('clicked', () => {
            this._floatingPanel = !this._floatingPanel;
            this._floatingPanelToggle.label = this._floatingPanel ? _('Enabled') : _('Disabled');
            if (this._floatingPanel) {
                this._floatingPanelToggle.add_style_class_name('praya-posture-toggle-enabled');
            } else {
                this._floatingPanelToggle.remove_style_class_name('praya-posture-toggle-enabled');
            }
            this._servicesConfig.floatingPanel = this._floatingPanel;
            this._saveServicesConfig();

            // Update extension live
            let ext = Main.extensionManager.lookup('praya@blankonlinux.id');
            if (ext?.stateObj) {
                ext.stateObj.setFloatingPanel(this._floatingPanel);
            }
        });
        floatingPanelBox.add_child(this._floatingPanelToggle);
        leftColumn.add_child(floatingPanelBox);

        // -- Activate on Hover --
        let hoverHeader = new St.Label({
            text: _('Activate on Hover'),
            style_class: 'praya-preferences-section-header',
        });
        leftColumn.add_child(hoverHeader);

        // Main menu hover toggle
        let mainMenuHoverBox = new St.BoxLayout({
            style_class: 'praya-preferences-row',
            x_expand: true,
        });
        let mainMenuHoverLabel = new St.Label({
            text: _('Main menu:'),
            style_class: 'praya-preferences-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        mainMenuHoverBox.add_child(mainMenuHoverLabel);

        this._mainMenuHoverActivate = this._servicesConfig.mainMenuHoverActivate || false;
        this._mainMenuHoverToggle = new St.Button({
            style_class: 'praya-preferences-combo praya-posture-toggle',
            label: this._mainMenuHoverActivate ? _('Enabled') : _('Disabled'),
            x_expand: true,
        });
        if (this._mainMenuHoverActivate) {
            this._mainMenuHoverToggle.add_style_class_name('praya-posture-toggle-enabled');
        }
        this._mainMenuHoverToggle.connect('clicked', () => {
            this._mainMenuHoverActivate = !this._mainMenuHoverActivate;
            this._mainMenuHoverToggle.label = this._mainMenuHoverActivate ? _('Enabled') : _('Disabled');
            if (this._mainMenuHoverActivate) {
                this._mainMenuHoverToggle.add_style_class_name('praya-posture-toggle-enabled');
            } else {
                this._mainMenuHoverToggle.remove_style_class_name('praya-posture-toggle-enabled');
            }
            this._servicesConfig.mainMenuHoverActivate = this._mainMenuHoverActivate;
            this._saveServicesConfig();

            // Update indicator live
            let ext = Main.extensionManager.lookup('praya@blankonlinux.id');
            if (ext?.stateObj?._indicator) {
                ext.stateObj._indicator.setMainMenuHoverActivate(this._mainMenuHoverActivate);
            }
        });
        mainMenuHoverBox.add_child(this._mainMenuHoverToggle);
        leftColumn.add_child(mainMenuHoverBox);

        // Taskbar hover toggle
        let taskbarHoverBox = new St.BoxLayout({
            style_class: 'praya-preferences-row',
            x_expand: true,
        });
        let taskbarHoverLabel = new St.Label({
            text: _('Taskbar:'),
            style_class: 'praya-preferences-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        taskbarHoverBox.add_child(taskbarHoverLabel);

        this._taskbarHoverActivate = this._servicesConfig.taskbarHoverActivate || false;
        this._taskbarHoverToggle = new St.Button({
            style_class: 'praya-preferences-combo praya-posture-toggle',
            label: this._taskbarHoverActivate ? _('Enabled') : _('Disabled'),
            x_expand: true,
        });
        if (this._taskbarHoverActivate) {
            this._taskbarHoverToggle.add_style_class_name('praya-posture-toggle-enabled');
        }
        this._taskbarHoverToggle.connect('clicked', () => {
            this._taskbarHoverActivate = !this._taskbarHoverActivate;
            this._taskbarHoverToggle.label = this._taskbarHoverActivate ? _('Enabled') : _('Disabled');
            if (this._taskbarHoverActivate) {
                this._taskbarHoverToggle.add_style_class_name('praya-posture-toggle-enabled');
            } else {
                this._taskbarHoverToggle.remove_style_class_name('praya-posture-toggle-enabled');
            }
            this._servicesConfig.taskbarHoverActivate = this._taskbarHoverActivate;
            this._saveServicesConfig();

            // Update taskbar live
            let ext = Main.extensionManager.lookup('praya@blankonlinux.id');
            if (ext?.stateObj?._taskbar) {
                ext.stateObj._taskbar.setHoverActivate(this._taskbarHoverActivate);
            }
        });
        taskbarHoverBox.add_child(this._taskbarHoverToggle);
        leftColumn.add_child(taskbarHoverBox);

        // Show Desktop hover toggle
        let showDesktopHoverBox = new St.BoxLayout({
            style_class: 'praya-preferences-row',
            x_expand: true,
        });
        let showDesktopHoverLabel = new St.Label({
            text: _('Show Desktop:'),
            style_class: 'praya-preferences-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        showDesktopHoverBox.add_child(showDesktopHoverLabel);

        this._showDesktopHoverActivate = this._servicesConfig.showDesktopHoverActivate || false;
        this._showDesktopHoverToggle = new St.Button({
            style_class: 'praya-preferences-combo praya-posture-toggle',
            label: this._showDesktopHoverActivate ? _('Enabled') : _('Disabled'),
            x_expand: true,
        });
        if (this._showDesktopHoverActivate) {
            this._showDesktopHoverToggle.add_style_class_name('praya-posture-toggle-enabled');
        }
        this._showDesktopHoverToggle.connect('clicked', () => {
            this._showDesktopHoverActivate = !this._showDesktopHoverActivate;
            this._showDesktopHoverToggle.label = this._showDesktopHoverActivate ? _('Enabled') : _('Disabled');
            if (this._showDesktopHoverActivate) {
                this._showDesktopHoverToggle.add_style_class_name('praya-posture-toggle-enabled');
            } else {
                this._showDesktopHoverToggle.remove_style_class_name('praya-posture-toggle-enabled');
            }
            this._servicesConfig.showDesktopHoverActivate = this._showDesktopHoverActivate;
            this._saveServicesConfig();

            // Update extension live
            let ext = Main.extensionManager.lookup('praya@blankonlinux.id');
            if (ext?.stateObj) {
                ext.stateObj.setShowDesktopHoverActivate(this._showDesktopHoverActivate);
            }
        });
        showDesktopHoverBox.add_child(this._showDesktopHoverToggle);
        leftColumn.add_child(showDesktopHoverBox);

        // Calendar hover toggle
        let calendarHoverBox = new St.BoxLayout({
            style_class: 'praya-preferences-row',
            x_expand: true,
        });
        let calendarHoverLabel = new St.Label({
            text: _('Calendar:'),
            style_class: 'praya-preferences-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        calendarHoverBox.add_child(calendarHoverLabel);

        this._calendarHoverActivate = this._servicesConfig.calendarHoverActivate || false;
        this._calendarHoverToggle = new St.Button({
            style_class: 'praya-preferences-combo praya-posture-toggle',
            label: this._calendarHoverActivate ? _('Enabled') : _('Disabled'),
            x_expand: true,
        });
        if (this._calendarHoverActivate) {
            this._calendarHoverToggle.add_style_class_name('praya-posture-toggle-enabled');
        }
        this._calendarHoverToggle.connect('clicked', () => {
            this._calendarHoverActivate = !this._calendarHoverActivate;
            this._calendarHoverToggle.label = this._calendarHoverActivate ? _('Enabled') : _('Disabled');
            if (this._calendarHoverActivate) {
                this._calendarHoverToggle.add_style_class_name('praya-posture-toggle-enabled');
            } else {
                this._calendarHoverToggle.remove_style_class_name('praya-posture-toggle-enabled');
            }
            this._servicesConfig.calendarHoverActivate = this._calendarHoverActivate;
            this._saveServicesConfig();

            // Update extension live
            let ext = Main.extensionManager.lookup('praya@blankonlinux.id');
            if (ext?.stateObj) {
                ext.stateObj.setCalendarHoverActivate(this._calendarHoverActivate);
            }
        });
        calendarHoverBox.add_child(this._calendarHoverToggle);
        leftColumn.add_child(calendarHoverBox);

        // Quick Access hover toggle
        let quickAccessHoverBox = new St.BoxLayout({
            style_class: 'praya-preferences-row',
            x_expand: true,
        });
        let quickAccessHoverLabel = new St.Label({
            text: _('Quick Access:'),
            style_class: 'praya-preferences-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        quickAccessHoverBox.add_child(quickAccessHoverLabel);

        this._quickAccessHoverActivate = this._servicesConfig.quickAccessHoverActivate || false;
        this._quickAccessHoverToggle = new St.Button({
            style_class: 'praya-preferences-combo praya-posture-toggle',
            label: this._quickAccessHoverActivate ? _('Enabled') : _('Disabled'),
            x_expand: true,
        });
        if (this._quickAccessHoverActivate) {
            this._quickAccessHoverToggle.add_style_class_name('praya-posture-toggle-enabled');
        }
        this._quickAccessHoverToggle.connect('clicked', () => {
            this._quickAccessHoverActivate = !this._quickAccessHoverActivate;
            this._quickAccessHoverToggle.label = this._quickAccessHoverActivate ? _('Enabled') : _('Disabled');
            if (this._quickAccessHoverActivate) {
                this._quickAccessHoverToggle.add_style_class_name('praya-posture-toggle-enabled');
            } else {
                this._quickAccessHoverToggle.remove_style_class_name('praya-posture-toggle-enabled');
            }
            this._servicesConfig.quickAccessHoverActivate = this._quickAccessHoverActivate;
            this._saveServicesConfig();

            // Update extension live
            let ext = Main.extensionManager.lookup('praya@blankonlinux.id');
            if (ext?.stateObj) {
                ext.stateObj.setQuickAccessHoverActivate(this._quickAccessHoverActivate);
            }
        });
        quickAccessHoverBox.add_child(this._quickAccessHoverToggle);
        leftColumn.add_child(quickAccessHoverBox);

        columnsBox.add_child(leftColumn);

        // Vertical separator between columns
        let columnSeparator = new St.Widget({
            style: 'background-color: rgba(255, 255, 255, 0.15); width: 1px; margin: 0 12px;',
            y_expand: true,
        });
        columnsBox.add_child(columnSeparator);

        // === RIGHT COLUMN: Praya Service, Posture Monitoring, Artificial Intelligence ===
        let rightColumn = new St.BoxLayout({
            vertical: true,
            style_class: 'praya-preferences-column',
            x_expand: true,
        });

        // -- Praya Service Status --
        let serviceHeader = new St.Label({
            text: _('Praya Service'),
            style_class: 'praya-preferences-section-header',
        });
        rightColumn.add_child(serviceHeader);

        let serviceStatusBox = new St.BoxLayout({
            style_class: 'praya-preferences-row',
            x_expand: true,
        });
        let serviceStatusLabel = new St.Label({
            text: _('Status:'),
            style_class: 'praya-preferences-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        serviceStatusBox.add_child(serviceStatusLabel);

        this._serviceStatusValue = new St.Label({
            text: _('Checking...'),
            style_class: 'praya-preferences-record-value',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        serviceStatusBox.add_child(this._serviceStatusValue);

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
        rightColumn.add_child(serviceStatusBox);

        this._checkPrayaServiceStatus();

        // Initialize posture D-Bus connection
        this._initPostureDBus();

        // -- Posture Monitoring --
        let postureHeaderBox = new St.BoxLayout({
            style_class: 'praya-preferences-section-header-box',
            x_expand: true,
        });
        let postureHeader = new St.Label({
            text: _('Posture Monitoring'),
            style_class: 'praya-preferences-section-header',
        });
        postureHeaderBox.add_child(postureHeader);
        let postureExperimentalLabel = new St.Label({
            text: _('(Experimental)'),
            style_class: 'praya-preferences-experimental-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        postureHeaderBox.add_child(postureExperimentalLabel);
        rightColumn.add_child(postureHeaderBox);

        let postureEnableBox = new St.BoxLayout({
            style_class: 'praya-preferences-row',
            x_expand: true,
        });
        let postureEnableLabel = new St.Label({
            text: _('Status:'),
            style_class: 'praya-preferences-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        postureEnableBox.add_child(postureEnableLabel);

        this._postureEnabled = false;
        this._postureToggleButton = new St.Button({
            style_class: 'praya-preferences-combo praya-posture-toggle praya-toggle-disabled',
            label: _('Disabled'),
            x_expand: true,
            reactive: false,
        });
        this._postureToggleButton.connect('clicked', () => {
            if (!this._serviceRunning) return;
            this._postureEnabled = !this._postureEnabled;
            this._updatePostureToggleUI();
            this._setPostureEnabled(this._postureEnabled);
        });
        postureEnableBox.add_child(this._postureToggleButton);
        rightColumn.add_child(postureEnableBox);

        let recalibrateBox = new St.BoxLayout({
            style_class: 'praya-preferences-row',
            x_expand: true,
        });
        let recalibrateLabel = new St.Label({
            text: _('Calibration:'),
            style_class: 'praya-preferences-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        recalibrateBox.add_child(recalibrateLabel);

        this._recalibrateButton = new St.Button({
            style_class: 'praya-preferences-combo',
            label: _('Recalibrate'),
            x_expand: true,
        });
        this._recalibrateButton.connect('clicked', () => {
            this._recalibrate();
        });
        recalibrateBox.add_child(this._recalibrateButton);
        rightColumn.add_child(recalibrateBox);

        let recordBox = new St.BoxLayout({
            style_class: 'praya-preferences-row',
            x_expand: true,
        });
        let recordLabel = new St.Label({
            text: _('Current:'),
            style_class: 'praya-preferences-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        recordBox.add_child(recordLabel);

        this._postureRecordLabel = new St.Label({
            text: _('Waiting for data...'),
            style_class: 'praya-preferences-record-value',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        recordBox.add_child(this._postureRecordLabel);
        rightColumn.add_child(recordBox);

        let barRow = new St.BoxLayout({
            style_class: 'praya-preferences-row',
            x_expand: true,
        });
        let barLabel = new St.Label({
            text: _('Level:'),
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
        rightColumn.add_child(barRow);

        this._startPosturePolling();

        this._postureEnabled = this._servicesConfig.posture || false;
        this._updatePostureToggleUI();

        // -- Artificial Intelligence --
        let chatbotHeaderBox = new St.BoxLayout({
            style_class: 'praya-preferences-section-header-box',
            x_expand: true,
        });
        let chatbotHeader = new St.Label({
            text: _('Artificial Intelligence'),
            style_class: 'praya-preferences-section-header',
        });
        chatbotHeaderBox.add_child(chatbotHeader);
        let experimentalLabel = new St.Label({
            text: _('(Experimental)'),
            style_class: 'praya-preferences-experimental-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        chatbotHeaderBox.add_child(experimentalLabel);
        rightColumn.add_child(chatbotHeaderBox);

        let aiEnableBox = new St.BoxLayout({
            style_class: 'praya-preferences-row',
            x_expand: true,
        });
        let aiEnableLabel = new St.Label({
            text: _('Status:'),
            style_class: 'praya-preferences-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        aiEnableBox.add_child(aiEnableLabel);

        this._aiEnabled = this._servicesConfig.ai || false;
        this._aiToggleButton = new St.Button({
            style_class: 'praya-preferences-combo praya-posture-toggle praya-toggle-disabled',
            label: this._aiEnabled ? _('Enabled') : _('Disabled'),
            x_expand: true,
            reactive: false,
        });
        if (this._aiEnabled) {
            this._aiToggleButton.add_style_class_name('praya-posture-toggle-enabled');
        }
        this._aiToggleButton.connect('clicked', () => {
            if (!this._serviceRunning) return;
            this._aiEnabled = !this._aiEnabled;
            this._updateAIToggleUI();
            this._setAIEnabled(this._aiEnabled);
        });
        aiEnableBox.add_child(this._aiToggleButton);
        rightColumn.add_child(aiEnableBox);

        let providerBox = new St.BoxLayout({
            style_class: 'praya-preferences-row',
            x_expand: true,
        });
        let providerLabel = new St.Label({
            text: _('Provider:'),
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
            this._currentProvider = this._currentProvider === 'anthropic' ? 'openai' : 'anthropic';
            this._providerCombo.label = PROVIDERS[this._currentProvider].name;
            this._updateModelCombo();
        });
        providerBox.add_child(this._providerCombo);
        rightColumn.add_child(providerBox);

        let modelBox = new St.BoxLayout({
            style_class: 'praya-preferences-row',
            x_expand: true,
        });
        let modelLabel = new St.Label({
            text: _('Model:'),
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
        rightColumn.add_child(modelBox);

        let apiKeyBox = new St.BoxLayout({
            style_class: 'praya-preferences-row',
            x_expand: true,
        });
        let apiKeyLabel = new St.Label({
            text: _('API Key:'),
            style_class: 'praya-preferences-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        apiKeyBox.add_child(apiKeyLabel);

        this._apiKeyEntry = new St.Entry({
            style_class: 'praya-preferences-entry',
            hint_text: _('Enter your API key'),
            can_focus: true,
            x_expand: true,
        });
        this._apiKeyEntry.clutter_text.set_password_char('\u25cf');
        if (this._chatbotSettings.apiKey) {
            this._apiKeyEntry.set_text(this._chatbotSettings.apiKey);
        }
        apiKeyBox.add_child(this._apiKeyEntry);

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
        rightColumn.add_child(apiKeyBox);

        columnsBox.add_child(rightColumn);

        contentBox.add_child(columnsBox);
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
        this._serviceStatusValue.text = _('Checking...');
        this._serviceStatusValue.remove_style_class_name('praya-posture-good');
        this._serviceStatusValue.remove_style_class_name('praya-posture-bad');
        this._serviceRunning = false;

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
                        this._serviceStatusValue.text = _('Running');
                        this._serviceStatusValue.add_style_class_name('praya-posture-good');
                        this._serviceRunning = true;
                    } else if (status === 'inactive') {
                        this._serviceStatusValue.text = _('Stopped');
                        this._serviceStatusValue.add_style_class_name('praya-posture-bad');
                        this._serviceRunning = false;
                    } else {
                        this._serviceStatusValue.text = status || 'Unknown';
                        this._serviceRunning = false;
                    }
                    this._updateFeatureTogglesState();
                } catch (e) {
                    this._serviceStatusValue.text = _('Error checking status');
                    this._serviceRunning = false;
                    this._updateFeatureTogglesState();
                }
            });
        } catch (e) {
            this._serviceStatusValue.text = _('Service not found');
            this._serviceRunning = false;
            this._updateFeatureTogglesState();
        }
    }

    _updateFeatureTogglesState() {
        if (this._serviceRunning) {
            // Enable toggles
            this._postureToggleButton.reactive = true;
            this._postureToggleButton.remove_style_class_name('praya-toggle-disabled');
            this._aiToggleButton.reactive = true;
            this._aiToggleButton.remove_style_class_name('praya-toggle-disabled');
        } else {
            // Disable toggles and show as disabled
            this._postureToggleButton.reactive = false;
            this._postureToggleButton.add_style_class_name('praya-toggle-disabled');
            this._aiToggleButton.reactive = false;
            this._aiToggleButton.add_style_class_name('praya-toggle-disabled');
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
            posture: false,
            appMenuLayout: 'grid',
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
            this._postureToggleButton.label = _('Enabled');
            this._postureToggleButton.add_style_class_name('praya-posture-toggle-enabled');
        } else {
            this._postureToggleButton.label = _('Disabled');
            this._postureToggleButton.remove_style_class_name('praya-posture-toggle-enabled');
        }
    }

    _updateAIToggleUI() {
        if (this._aiEnabled) {
            this._aiToggleButton.label = _('Enabled');
            this._aiToggleButton.add_style_class_name('praya-posture-toggle-enabled');
        } else {
            this._aiToggleButton.label = _('Disabled');
            this._aiToggleButton.remove_style_class_name('praya-posture-toggle-enabled');
        }
    }

    _setAIEnabled(enabled) {
        // Update services config
        this._servicesConfig.ai = enabled;
        this._saveServicesConfig();
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
            this._postureRecordLabel.text = _('D-Bus not available');
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
                    this._postureRecordLabel.text = _('Service unavailable');
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
            this._postureRecordLabel.text = _('Error parsing data');
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

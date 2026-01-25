/* preferences.js
 *
 * Preferences dialog for Praya extension
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import { ChatbotSettings } from './chatbot.js';
import { PROVIDERS } from './constants.js';

export const PrayaPreferencesDialog = GObject.registerClass(
class PrayaPreferencesDialog extends ModalDialog.ModalDialog {
    _init() {
        super._init({
            styleClass: 'praya-preferences-dialog',
            destroyOnClose: true,
        });

        this._chatbotSettings = new ChatbotSettings();

        // Dialog title
        let titleLabel = new St.Label({
            text: 'Praya Preferences',
            style_class: 'praya-preferences-title',
            x_align: Clutter.ActorAlign.CENTER,
        });

        // Build content box
        let contentBox = new St.BoxLayout({
            vertical: true,
            style_class: 'praya-preferences-box',
            x_expand: true,
            y_expand: true,
        });
        contentBox.add_child(titleLabel);

        // AI Chatbot section header
        let chatbotHeader = new St.Label({
            text: 'AI Chatbot Settings',
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

        this.contentLayout.add_child(contentBox);

        // Add Save and Cancel buttons
        this.addButton({
            label: 'Cancel',
            action: () => this.close(),
        });
        this.addButton({
            label: 'Save',
            action: () => this._save(),
            default: true,
        });
    }

    _updateModelCombo() {
        let models = PROVIDERS[this._currentProvider].models;
        this._currentModelIndex = 0;
        this._modelCombo.label = models[0];
    }

    _save() {
        this._chatbotSettings.provider = this._currentProvider;
        this._chatbotSettings.model = PROVIDERS[this._currentProvider].models[this._currentModelIndex];
        this._chatbotSettings.apiKey = this._apiKeyEntry.get_text();
        this._chatbotSettings.save();
        this.close();
    }
});

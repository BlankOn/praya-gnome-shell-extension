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
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import AccountsService from 'gi://AccountsService';
import Soup from 'gi://Soup?version=3.0';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

const FAVOURITES_FILE = GLib.build_filenamev([GLib.get_user_config_dir(), 'praya', 'favourites.json']);
const CHATBOT_SETTINGS_FILE = GLib.build_filenamev([GLib.get_user_config_dir(), 'praya', 'chatbot.json']);
const CHATBOT_PANEL_WIDTH = 400;
const PROVIDERS = {
    anthropic: {
        name: 'Anthropic',
        models: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-3-5-haiku-20241022'],
        endpoint: 'https://api.anthropic.com/v1/messages'
    },
    openai: {
        name: 'ChatGPT',
        models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
        endpoint: 'https://api.openai.com/v1/chat/completions'
    }
};

const PANEL_WIDTH = 325;
const HEADER_HEIGHT = 50;
const ANIMATION_DURATION = 200;
const MARGIN_LEFT = 8;
const MARGIN_TOP = 8;
const MARGIN_BOTTOM = 8;

// ChatbotSettings class for managing chatbot configuration
class ChatbotSettings {
    constructor() {
        this._settings = {
            provider: 'anthropic',
            model: 'claude-sonnet-4-20250514',
            apiKey: ''
        };
        this._load();
    }

    _load() {
        try {
            let file = Gio.File.new_for_path(CHATBOT_SETTINGS_FILE);
            if (file.query_exists(null)) {
                let [success, contents] = file.load_contents(null);
                if (success) {
                    let decoder = new TextDecoder('utf-8');
                    let json = decoder.decode(contents);
                    let parsed = JSON.parse(json);
                    this._settings = {...this._settings, ...parsed};
                }
            }
        } catch (e) {
            log(`Praya: Error loading chatbot settings: ${e.message}`);
        }
    }

    save() {
        try {
            let file = Gio.File.new_for_path(CHATBOT_SETTINGS_FILE);
            let parent = file.get_parent();
            if (!parent.query_exists(null)) {
                parent.make_directory_with_parents(null);
            }
            let json = JSON.stringify(this._settings);
            let encoder = new TextEncoder();
            let contents = encoder.encode(json);
            file.replace_contents(contents, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            log(`Praya: Error saving chatbot settings: ${e.message}`);
        }
    }

    get provider() { return this._settings.provider; }
    set provider(value) { this._settings.provider = value; }

    get model() { return this._settings.model; }
    set model(value) { this._settings.model = value; }

    get apiKey() { return this._settings.apiKey; }
    set apiKey(value) { this._settings.apiKey = value; }

    isConfigured() {
        return this._settings.apiKey && this._settings.apiKey.length > 0;
    }

    reload() {
        this._load();
    }
}

// ChatbotAPI class for making API calls
class ChatbotAPI {
    constructor(settings) {
        this._settings = settings;
        this._session = new Soup.Session();
    }

    sendMessage(messages, callback) {
        let provider = this._settings.provider;
        let providerConfig = PROVIDERS[provider];

        if (!providerConfig) {
            callback(null, 'Invalid provider');
            return;
        }

        let message = new Soup.Message({
            method: 'POST',
            uri: GLib.Uri.parse(providerConfig.endpoint, GLib.UriFlags.NONE),
        });

        let requestBody;
        if (provider === 'anthropic') {
            requestBody = JSON.stringify({
                model: this._settings.model,
                max_tokens: 1024,
                messages: messages.map(m => ({
                    role: m.role === 'user' ? 'user' : 'assistant',
                    content: m.content
                }))
            });
            message.request_headers.append('x-api-key', this._settings.apiKey);
            message.request_headers.append('anthropic-version', '2023-06-01');
            message.request_headers.append('content-type', 'application/json');
        } else {
            requestBody = JSON.stringify({
                model: this._settings.model,
                messages: messages.map(m => ({
                    role: m.role,
                    content: m.content
                }))
            });
            message.request_headers.append('Authorization', `Bearer ${this._settings.apiKey}`);
            message.request_headers.append('Content-Type', 'application/json');
        }

        message.set_request_body_from_bytes('application/json',
            new GLib.Bytes(new TextEncoder().encode(requestBody)));

        this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, result) => {
            try {
                let bytes = session.send_and_read_finish(result);
                let decoder = new TextDecoder('utf-8');
                let responseText = decoder.decode(bytes.get_data());
                let response = JSON.parse(responseText);

                if (message.get_status() !== Soup.Status.OK) {
                    let errorMsg = response.error?.message || `HTTP ${message.get_status()}`;
                    callback(null, errorMsg);
                    return;
                }

                let content;
                if (provider === 'anthropic') {
                    content = response.content?.[0]?.text || '';
                } else {
                    content = response.choices?.[0]?.message?.content || '';
                }
                callback(content, null);
            } catch (e) {
                callback(null, e.message);
            }
        });
    }
}

const PrayaPreferencesDialog = GObject.registerClass(
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

// PrayaChatbotPanel - Full chat interface
const CHATBOT_HEADER_HEIGHT = 60;
const CHATBOT_INPUT_HEIGHT = 80; // Height for 2-line textarea

const PrayaChatbotPanel = GObject.registerClass(
class PrayaChatbotPanel extends St.BoxLayout {
    _init(settings, onClose, panelHeight) {
        super._init({
            style_class: 'praya-chatbot-panel',
            vertical: true,
            x_expand: true,
            y_expand: true,
        });

        this._settings = settings;
        this._onClose = onClose;
        this._api = new ChatbotAPI(settings);
        this._messages = [];
        this._isWaiting = false;
        this._panelHeight = panelHeight || 600;

        // Header with fixed height
        let header = new St.BoxLayout({
            style_class: 'praya-chatbot-header',
            x_expand: true,
            height: CHATBOT_HEADER_HEIGHT,
        });

        let titleBox = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        let aiIcon = new St.Icon({
            icon_name: 'user-available-symbolic',
            icon_size: 20,
            style_class: 'praya-chatbot-icon',
        });
        titleBox.add_child(aiIcon);

        let titleContainer = new St.BoxLayout({
            vertical: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        let titleLabel = new St.Label({
            text: 'Artificial Intelligence',
            style_class: 'praya-chatbot-title',
        });
        titleContainer.add_child(titleLabel);

        let modelLabel = new St.Label({
            text: settings.model,
            style_class: 'praya-chatbot-model',
        });
        titleContainer.add_child(modelLabel);

        titleBox.add_child(titleContainer);
        header.add_child(titleBox);

        let closeButton = new St.Button({
            style_class: 'praya-chatbot-close-btn',
            child: new St.Icon({
                icon_name: 'window-close-symbolic',
                icon_size: 16,
            }),
        });
        closeButton.connect('clicked', () => {
            // Defer the callback to allow click event to complete before destroying UI
            if (this._onClose) {
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._onClose();
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
        header.add_child(closeButton);

        this.add_child(header);

        // Calculate scroll view height (total height - header - input)
        let scrollHeight = this._panelHeight - CHATBOT_HEADER_HEIGHT - CHATBOT_INPUT_HEIGHT;

        // Create a container for the scroll view with fixed height
        let scrollContainer = new St.Widget({
            style_class: 'praya-chatbot-scroll-container',
            x_expand: true,
            y_expand: false,
            height: scrollHeight,
            clip_to_allocation: true,
        });

        // Message history scroll view
        this._scrollView = new St.ScrollView({
            style_class: 'praya-chatbot-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
            enable_mouse_scrolling: true,
        });
        this._scrollView.set_size(CHATBOT_PANEL_WIDTH, scrollHeight);

        this._messagesBox = new St.BoxLayout({
            style_class: 'praya-chatbot-messages',
            vertical: true,
            x_expand: true,
            y_expand: false,
        });

        this._scrollView.set_child(this._messagesBox);
        scrollContainer.add_child(this._scrollView);
        this.add_child(scrollContainer);

        // Input area with fixed height for 2-line textarea
        let inputArea = new St.BoxLayout({
            style_class: 'praya-chatbot-input-area',
            x_expand: true,
            height: CHATBOT_INPUT_HEIGHT,
        });

        this._inputEntry = new St.Entry({
            style_class: 'praya-chatbot-input',
            hint_text: 'Type a message... (Shift+Enter for new line)',
            can_focus: true,
            x_expand: true,
        });
        // Enable multi-line input
        this._inputEntry.clutter_text.set_single_line_mode(false);
        this._inputEntry.clutter_text.set_line_wrap(true);
        this._inputEntry.clutter_text.set_line_wrap_mode(0); // WORD
        this._inputEntry.clutter_text.connect('key-press-event', (actor, event) => {
            let symbol = event.get_key_symbol();
            let state = event.get_state();
            let shiftPressed = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;

            if ((symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) && !shiftPressed) {
                // Enter without Shift sends the message
                this._sendCurrentMessage();
                return Clutter.EVENT_STOP;
            }
            // Shift+Enter allows new line (default behavior)
            return Clutter.EVENT_PROPAGATE;
        });
        inputArea.add_child(this._inputEntry);

        let sendButton = new St.Button({
            style_class: 'praya-chatbot-send-btn',
            child: new St.Icon({
                icon_name: 'mail-send-symbolic',
                icon_size: 16,
            }),
            y_align: Clutter.ActorAlign.END,
        });
        sendButton.connect('clicked', () => this._sendCurrentMessage());
        inputArea.add_child(sendButton);

        this.add_child(inputArea);
    }

    sendInitialMessage(message) {
        if (message && message.trim() !== '') {
            this._addMessage('user', message);
            this._sendToAPI();

            // Focus input after initial message
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._inputEntry.grab_key_focus();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    focusInput() {
        this._inputEntry.grab_key_focus();
    }

    getMessages() {
        return [...this._messages];
    }

    restoreMessages(messages) {
        if (!messages || messages.length === 0) return;

        // Restore messages to both internal array and UI
        this._messages = [...messages];

        for (let msg of messages) {
            this._addMessageToUI(msg.role, msg.content);
        }
    }

    _addMessageToUI(role, content) {
        // Calculate max width for message bubble (panel width - margins)
        let maxWidth = CHATBOT_PANEL_WIDTH - 80;

        let messageContainer = new St.BoxLayout({
            x_expand: true,
            y_expand: false,
            x_align: role === 'user' ? Clutter.ActorAlign.END : Clutter.ActorAlign.START,
        });

        let messageBox = new St.BoxLayout({
            style_class: role === 'user' ? 'praya-chatbot-message-user' : 'praya-chatbot-message-assistant',
            vertical: true,
            x_expand: false,
            y_expand: false,
        });
        messageBox.set_style(`max-width: ${maxWidth}px;`);

        // Parse markdown to Pango markup for styling
        let formattedContent = this._parseMarkdown(content);

        let messageLabel = new St.Label({
            style_class: 'praya-chatbot-message-text',
            x_expand: false,
            y_expand: false,
        });
        // Use markup for styled text
        messageLabel.clutter_text.set_markup(formattedContent);
        messageLabel.clutter_text.set_line_wrap(true);
        messageLabel.clutter_text.set_line_wrap_mode(0); // WORD
        // Allow text selection and copying
        messageLabel.clutter_text.set_selectable(true);
        messageLabel.clutter_text.set_reactive(true);
        messageBox.add_child(messageLabel);

        messageContainer.add_child(messageBox);
        this._messagesBox.add_child(messageContainer);

        // Scroll to bottom after layout update
        this._scrollToBottom();
    }

    _scrollToBottom() {
        // Use multiple attempts to ensure scroll happens after layout
        let attempts = 0;
        let scrollFunc = () => {
            if (this._scrollView && this._scrollView.vscroll) {
                let adjustment = this._scrollView.vscroll.adjustment;
                let maxScroll = adjustment.upper - adjustment.page_size;
                if (maxScroll > 0) {
                    adjustment.set_value(maxScroll);
                }
            }
            attempts++;
            // Try a few times to ensure layout is complete
            if (attempts < 3) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, scrollFunc);
            }
            return GLib.SOURCE_REMOVE;
        };
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, scrollFunc);
    }

    _parseMarkdown(text) {
        // Escape special Pango markup characters first
        let escaped = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        // Parse code blocks (```code```) - must be done before inline code
        escaped = escaped.replace(/```([\s\S]*?)```/g, '<tt>$1</tt>');

        // Parse inline code (`code`)
        escaped = escaped.replace(/`([^`]+)`/g, '<tt>$1</tt>');

        // Parse bold (**text** or __text__) - must be done before italic
        escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
        escaped = escaped.replace(/__(.+?)__/g, '<b>$1</b>');

        // Parse italic (*text* or _text_)
        escaped = escaped.replace(/\*(.+?)\*/g, '<i>$1</i>');
        escaped = escaped.replace(/\b_(.+?)_\b/g, '<i>$1</i>');

        return escaped;
    }

    _sendCurrentMessage() {
        if (this._isWaiting) return;

        let text = this._inputEntry.get_text().trim();
        if (text === '') return;

        this._inputEntry.set_text('');
        this._addMessage('user', text);
        this._sendToAPI();
    }

    _addMessage(role, content) {
        this._messages.push({role, content});
        this._addMessageToUI(role, content);
    }

    _addTypingIndicator() {
        this._typingContainer = new St.BoxLayout({
            x_expand: true,
            y_expand: false,
            x_align: Clutter.ActorAlign.START,
        });

        this._typingBox = new St.BoxLayout({
            style_class: 'praya-chatbot-message-assistant praya-chatbot-typing',
            x_expand: false,
            y_expand: false,
        });

        this._typingLabel = new St.Label({
            text: 'Thinking.',
            style_class: 'praya-chatbot-message-text praya-chatbot-typing-text',
        });
        this._typingBox.add_child(this._typingLabel);

        this._typingContainer.add_child(this._typingBox);
        this._messagesBox.add_child(this._typingContainer);

        // Animate the dots
        this._typingDotCount = 1;
        this._typingAnimationId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            if (!this._typingLabel) {
                this._typingAnimationId = null;
                return GLib.SOURCE_REMOVE;
            }
            this._typingDotCount = (this._typingDotCount % 3) + 1;
            let dots = '.'.repeat(this._typingDotCount);
            this._typingLabel.set_text(`Thinking${dots}`);
            return GLib.SOURCE_CONTINUE;
        });

        // Scroll to bottom
        this._scrollToBottom();
    }

    _removeTypingIndicator() {
        // Stop the animation timer
        if (this._typingAnimationId) {
            GLib.source_remove(this._typingAnimationId);
            this._typingAnimationId = null;
        }
        this._typingLabel = null;
        this._typingBox = null;
        if (this._typingContainer) {
            this._typingContainer.destroy();
            this._typingContainer = null;
        }
    }

    _sendToAPI() {
        this._isWaiting = true;
        this._addTypingIndicator();

        this._api.sendMessage(this._messages, (response, error) => {
            this._removeTypingIndicator();
            this._isWaiting = false;

            if (error) {
                this._addMessage('assistant', `Error: ${error}`);
            } else if (response) {
                this._addMessage('assistant', response);
            }
        });
    }
});

const PrayaTaskbar = GObject.registerClass(
class PrayaTaskbar extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'praya-taskbar',
            reactive: true,
            track_hover: true,
            x_expand: true,
        });

        this._windowTracker = Shell.WindowTracker.get_default();
        this._appSystem = Shell.AppSystem.get_default();

        // Track window signals
        this._windowSignals = [];
        this._workspaceSignals = [];
        this._titleSignals = [];

        // Connect to window events
        this._windowAddedId = global.display.connect('window-created', () => {
            this._updateTaskbar();
        });

        this._windowRemovedId = global.window_manager.connect('destroy', () => {
            this._updateTaskbar();
        });

        this._minimizeId = global.window_manager.connect('minimize', () => {
            this._updateTaskbar();
        });

        this._unminimizeId = global.window_manager.connect('unminimize', () => {
            this._updateTaskbar();
        });

        this._focusWindowId = global.display.connect('notify::focus-window', () => {
            this._updateTaskbar();
        });

        // Connect to workspace switch
        this._workspaceSwitchId = global.workspace_manager.connect('active-workspace-changed', () => {
            this._updateTaskbar();
        });

        // Initial update with delay to ensure windows are loaded
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._updateTaskbar();
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateTaskbar() {
        // Disconnect existing title signals
        for (let sig of this._titleSignals) {
            sig.window.disconnect(sig.id);
        }
        this._titleSignals = [];

        // Remove all existing children
        this.destroy_all_children();

        // Get all windows on current workspace
        let workspace = global.workspace_manager.get_active_workspace();
        let windows = global.get_window_actors()
            .map(a => a.meta_window)
            .filter(w => {
                return w.get_workspace() === workspace &&
                       !w.is_skip_taskbar() &&
                       w.get_window_type() === Meta.WindowType.NORMAL;
            });

        // Sort by user_time (most recently used first) or stable order
        windows.sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());

        let focusedWindow = global.display.focus_window;

        for (let window of windows) {
            let app = this._windowTracker.get_window_app(window);
            let button = this._createWindowButton(window, app, window === focusedWindow);
            this.add_child(button);

            // Connect to title changes
            let titleId = window.connect('notify::title', () => {
                this._updateTaskbar();
            });
            this._titleSignals.push({ window: window, id: titleId });
        }
    }

    _createWindowButton(window, app, isFocused) {
        // Outer container - black background, no margin, handles clicks
        let button = new St.BoxLayout({
            style_class: 'praya-taskbar-button',
            reactive: true,
            track_hover: true,
        });

        // Inner visual component - 4px border radius
        let innerBox = new St.BoxLayout({
            style_class: 'praya-taskbar-button-inner',
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
        });

        if (isFocused) {
            innerBox.add_style_class_name('praya-taskbar-button-inner-focused');
        }

        if (window.minimized) {
            button.add_style_class_name('praya-taskbar-button-minimized');
        }

        // App icon
        let icon;
        if (app) {
            icon = app.create_icon_texture(20);
        } else {
            icon = new St.Icon({
                icon_name: 'application-x-executable-symbolic',
                icon_size: 20,
            });
        }
        icon.style_class = 'praya-taskbar-icon';
        innerBox.add_child(icon);

        // Window title - show for all windows
        let title = window.get_title() || (app ? app.get_name() : 'Window');
        // Truncate long titles
        let displayTitle = title;
        if (displayTitle.length > 20) {
            displayTitle = displayTitle.substring(0, 18) + '...';
        }
        let label = new St.Label({
            text: displayTitle,
            style_class: 'praya-taskbar-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        innerBox.add_child(label);

        button.add_child(innerBox);

        // Click handler
        button.connect('button-press-event', (actor, event) => {
            if (event.get_button() === 1) {
                // Left click - focus or unminimize
                if (window.minimized) {
                    window.unminimize();
                    window.activate(global.get_current_time());
                } else if (window === global.display.focus_window) {
                    // If already focused, minimize it
                    window.minimize();
                } else {
                    window.activate(global.get_current_time());
                }
                return Clutter.EVENT_STOP;
            } else if (event.get_button() === 2) {
                // Middle click - close window
                window.delete(global.get_current_time());
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        return button;
    }

    destroy() {
        // Disconnect title signals
        for (let sig of this._titleSignals) {
            sig.window.disconnect(sig.id);
        }
        this._titleSignals = [];

        if (this._windowAddedId) {
            global.display.disconnect(this._windowAddedId);
            this._windowAddedId = null;
        }
        if (this._windowRemovedId) {
            global.window_manager.disconnect(this._windowRemovedId);
            this._windowRemovedId = null;
        }
        if (this._minimizeId) {
            global.window_manager.disconnect(this._minimizeId);
            this._minimizeId = null;
        }
        if (this._unminimizeId) {
            global.window_manager.disconnect(this._unminimizeId);
            this._unminimizeId = null;
        }
        if (this._focusWindowId) {
            global.display.disconnect(this._focusWindowId);
            this._focusWindowId = null;
        }
        if (this._workspaceSwitchId) {
            global.workspace_manager.disconnect(this._workspaceSwitchId);
            this._workspaceSwitchId = null;
        }
        super.destroy();
    }
});

const PrayaIndicator = GObject.registerClass(
class PrayaIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Praya Menu');

        // Create a box to hold the logo
        let box = new St.BoxLayout({style_class: 'panel-status-menu-box'});

        // Add logo using St.Widget with CSS background
        let logo = new St.Widget({
            style_class: 'praya-panel-logo',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(logo);

        this.add_child(box);

        // Track panel visibility
        this._panelVisible = false;
        this._panel = null;
        this._hoverZone = null;
        this._navigationStack = [];
        this._isAnimating = false;
        this._hoverTimeoutId = null;
        this._isSearchActive = false;
        this._searchEntry = null;
        this._keyPressId = null;

        // Keyboard navigation
        this._focusedIndex = -1;
        this._menuItems = [];
        this._menuBox = null;

        // Load applications data
        this._categories = {};
        this._appSystem = Shell.AppSystem.get_default();

        // Favourites
        this._favourites = [];
        this._loadFavourites();

        // Context menu for right-click
        this._contextMenu = null;

        // System actions for power menu
        this._systemActions = SystemActions.getDefault();

        // Chatbot state
        this._chatbotSettings = new ChatbotSettings();
        this._isChatbotMode = false;
        this._chatbotPanel = null;
        this._chatbotMessages = []; // Preserve messages across panel hide/show
        this._isTransitioningChatbot = false; // Prevent panel hide during transition

        // Delay initial load to ensure shell is ready (1 second)
        this._loadAppsTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._loadApplicationsData();
            this._loadAppsTimeoutId = null;
            return GLib.SOURCE_REMOVE;
        });

        // Reload apps when installed apps change
        this._installedChangedId = this._appSystem.connect('installed-changed', () => {
            this._loadApplicationsData();
        });

        // Connect hover handler to show panel
        this.connect('enter-event', () => {
            if (this._hoverTimeoutId) {
                GLib.source_remove(this._hoverTimeoutId);
                this._hoverTimeoutId = null;
            }
            if (!this._panelVisible) {
                this._showPanel();
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Prevent click from hiding the panel - just keep it open
        this.connect('button-press-event', () => {
            // Cancel any pending hide timeout
            if (this._hoverTimeoutId) {
                GLib.source_remove(this._hoverTimeoutId);
                this._hoverTimeoutId = null;
            }
            // Show panel if not visible, but don't hide if already visible
            if (!this._panelVisible) {
                this._showPanel();
            }
            return Clutter.EVENT_STOP;
        });

        // Disable the default menu
        this.menu.actor.hide();
    }

    _loadApplicationsData() {
        this._categories = {};
        this._appSystem = Shell.AppSystem.get_default();

        // Use Gio.AppInfo.get_all() which reliably returns all desktop apps
        let allAppInfos = Gio.AppInfo.get_all();

        for (let appInfo of allAppInfos) {
            if (!appInfo)
                continue;

            // Skip apps that shouldn't be displayed
            if (typeof appInfo.should_show === 'function' && !appInfo.should_show())
                continue;

            // Get the app ID
            let appId = appInfo.get_id();
            if (!appId)
                continue;

            // Try to get Shell.App for icon support
            let app = this._appSystem.lookup_app(appId);

            // Get categories (only works on DesktopAppInfo)
            let categoriesStr = '';
            if (typeof appInfo.get_categories === 'function') {
                categoriesStr = appInfo.get_categories() || '';
            }

            let category = this._getMainCategory(categoriesStr);

            if (!this._categories[category])
                this._categories[category] = [];

            // Store both app and appInfo for flexibility
            this._categories[category].push({
                app: app,
                appInfo: appInfo,
                name: appInfo.get_name() || appId,
                id: appId,
            });
        }

        // Sort apps in each category
        for (let category in this._categories) {
            this._categories[category].sort((a, b) =>
                a.name.localeCompare(b.name));
        }
    }

    _loadFavourites() {
        try {
            let file = Gio.File.new_for_path(FAVOURITES_FILE);
            if (file.query_exists(null)) {
                let [success, contents] = file.load_contents(null);
                if (success) {
                    let decoder = new TextDecoder('utf-8');
                    let json = decoder.decode(contents);
                    this._favourites = JSON.parse(json);
                }
            } else {
                // Create file with default favourites
                this._favourites = [
                    'firefox.desktop',
                    'org.gnome.Nautilus.desktop',
                    'org.gnome.Ptyxis.desktop'
                ];
                this._saveFavourites();
            }
        } catch (e) {
            log(`Praya: Error loading favourites: ${e.message}`);
            this._favourites = [];
        }
    }

    _saveFavourites() {
        try {
            let file = Gio.File.new_for_path(FAVOURITES_FILE);
            let parent = file.get_parent();
            if (!parent.query_exists(null)) {
                parent.make_directory_with_parents(null);
            }
            let json = JSON.stringify(this._favourites);
            let encoder = new TextEncoder();
            let contents = encoder.encode(json);
            file.replace_contents(contents, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            log(`Praya: Error saving favourites: ${e.message}`);
        }
    }

    _isFavourite(appId) {
        return this._favourites.includes(appId);
    }

    _addFavourite(appId) {
        if (!this._favourites.includes(appId)) {
            this._favourites.push(appId);
            this._saveFavourites();
        }
    }

    _removeFavourite(appId) {
        let index = this._favourites.indexOf(appId);
        if (index !== -1) {
            this._favourites.splice(index, 1);
            this._saveFavourites();
        }
    }

    _showContextMenu(appData, sourceActor) {
        // Destroy existing context menu
        if (this._contextMenu) {
            this._contextMenu.destroy();
            this._contextMenu = null;
        }

        // Cancel any pending hide timeout
        if (this._hoverTimeoutId) {
            GLib.source_remove(this._hoverTimeoutId);
            this._hoverTimeoutId = null;
        }

        let isFav = this._isFavourite(appData.id);

        // Create context menu container
        this._contextMenu = new St.BoxLayout({
            style_class: 'praya-context-menu',
            vertical: true,
            reactive: true,
            track_hover: true,
        });

        // Add hover handlers to keep panel open while interacting with context menu
        this._contextMenu.connect('enter-event', () => {
            if (this._hoverTimeoutId) {
                GLib.source_remove(this._hoverTimeoutId);
                this._hoverTimeoutId = null;
            }
            // Cancel context menu close timeout
            if (this._contextMenuTimeoutId) {
                GLib.source_remove(this._contextMenuTimeoutId);
                this._contextMenuTimeoutId = null;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._contextMenu.connect('leave-event', () => {
            // Close context menu when mouse leaves it
            // Use a small delay to allow clicking on items
            if (this._contextMenuTimeoutId) {
                GLib.source_remove(this._contextMenuTimeoutId);
            }
            this._contextMenuTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                this._contextMenuTimeoutId = null;
                this._closeContextMenu();
                return GLib.SOURCE_REMOVE;
            });
            return Clutter.EVENT_PROPAGATE;
        });

        // Create menu item
        let menuItemText = isFav ? 'Unpin' : 'Pin to Menu';
        let menuItemIcon = isFav ? 'view-pin-symbolic' : 'view-pin-symbolic';

        let menuItem = new St.BoxLayout({
            style_class: 'praya-context-menu-item',
            reactive: true,
            track_hover: true,
        });

        let icon = new St.Icon({
            icon_name: menuItemIcon,
            icon_size: 16,
            style_class: 'praya-context-menu-icon',
        });
        menuItem.add_child(icon);

        let label = new St.Label({
            text: menuItemText,
            y_align: Clutter.ActorAlign.CENTER,
        });
        menuItem.add_child(label);

        menuItem.connect('button-press-event', () => {
            if (isFav) {
                this._removeFavourite(appData.id);
            } else {
                this._addFavourite(appData.id);
            }
            this._closeContextMenu();
            // Always reset to main menu after pin/unpin
            this._navigationStack = [];
            this._isSearchActive = false;
            if (this._searchEntry) {
                this._searchEntry.set_text('');
            }
            this._showMainMenu(false);
            return Clutter.EVENT_STOP;
        });

        this._contextMenu.add_child(menuItem);

        // Position the context menu near the source actor
        let [x, y] = sourceActor.get_transformed_position();
        let [width, height] = sourceActor.get_size();

        this._contextMenu.set_position(x + width - 150, y + height / 2);

        Main.layoutManager.addTopChrome(this._contextMenu);

        // Close context menu when clicking elsewhere
        this._contextMenuCaptureId = global.stage.connect('captured-event', (actor, event) => {
            if (event.type() === Clutter.EventType.BUTTON_PRESS) {
                let [eventX, eventY] = event.get_coords();
                let dominated = this._contextMenu.contains(global.stage.get_actor_at_pos(Clutter.PickMode.ALL, eventX, eventY));
                if (!dominated) {
                    this._closeContextMenu();
                }
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _closeContextMenu() {
        if (this._contextMenuTimeoutId) {
            GLib.source_remove(this._contextMenuTimeoutId);
            this._contextMenuTimeoutId = null;
        }
        if (this._contextMenuCaptureId) {
            global.stage.disconnect(this._contextMenuCaptureId);
            this._contextMenuCaptureId = null;
        }
        if (this._contextMenu) {
            Main.layoutManager.removeChrome(this._contextMenu);
            this._contextMenu.destroy();
            this._contextMenu = null;
        }
    }

    _getFavouriteApps() {
        let favouriteApps = [];
        for (let appId of this._favourites) {
            let appInfo = GioUnix.DesktopAppInfo.new(appId);
            if (appInfo) {
                let app = this._appSystem.lookup_app(appId);
                favouriteApps.push({
                    app: app,
                    appInfo: appInfo,
                    name: appInfo.get_name() || appId,
                    id: appId,
                });
            }
        }
        return favouriteApps;
    }

    _getMainCategory(categoriesStr) {
        let categories = categoriesStr.split(';');

        const mainCategories = [
            'AudioVideo', 'Audio', 'Video', 'Development', 'Education',
            'Game', 'Graphics', 'Network', 'Office', 'Science', 'Settings',
            'System', 'Utility'
        ];

        for (let cat of categories) {
            if (mainCategories.includes(cat))
                return cat;
        }

        return 'Other';
    }

    _togglePanel() {
        if (this._panelVisible) {
            this._hidePanel();
        } else {
            this._showPanel();
        }
    }

    _showPanel() {
        // Clean up any existing hover zone first to prevent orphaned zones
        if (this._hoverZone) {
            try {
                Main.layoutManager.removeChrome(this._hoverZone);
            } catch (e) {
                // Ignore if already removed
            }
            this._hoverZone.destroy();
            this._hoverZone = null;
        }

        if (this._panel) {
            try {
                Main.layoutManager.removeChrome(this._panel);
            } catch (e) {
                // Ignore if already removed
            }
            this._panel.destroy();
            this._panel = null;
        }

        let monitor = Main.layoutManager.primaryMonitor;
        let panelHeight = Main.panel.height;
        let availableHeight = monitor.height - panelHeight - MARGIN_TOP - MARGIN_BOTTOM;

        // Create invisible hover zone that includes margins
        this._hoverZone = new St.Widget({
            reactive: true,
            track_hover: true,
            x: 0,
            y: panelHeight,
            width: PANEL_WIDTH + MARGIN_LEFT * 2,
            height: availableHeight + MARGIN_TOP + MARGIN_BOTTOM,
        });

        // Create the main panel container - below top bar with margins
        this._panel = new St.BoxLayout({
            style_class: 'praya-panel',
            vertical: true,
            reactive: true,
            track_hover: true,
            x: MARGIN_LEFT,
            y: panelHeight + MARGIN_TOP,
            width: PANEL_WIDTH,
            height: availableHeight,
        });

        // Create header (will be populated by _showMainMenu -> _updateHeader)
        this._header = new St.BoxLayout({
            style_class: 'praya-panel-header',
            height: HEADER_HEIGHT,
            x_expand: true,
        });

        this._panel.add_child(this._header);

        // Create persistent bottom section first to measure its height
        this._bottomSection = this._createBottomSection();

        // Base height for bottom section when collapsed (User ~72 + Lock 52 + LogOut 52 + Power 52 + separator ~17 + padding)
        this._bottomSectionBaseHeight = 260;
        // Additional height when power menu is expanded
        this._powerOptionsHeight = 150;

        // Create sliding container for navigation with clipping
        this._slidingContainer = new St.Widget({
            style_class: 'praya-sliding-container',
            x_expand: true,
            clip_to_allocation: true,
        });
        this._slidingContainer.set_size(PANEL_WIDTH, availableHeight - HEADER_HEIGHT - this._bottomSectionBaseHeight);

        this._panel.add_child(this._slidingContainer);
        this._panel.add_child(this._bottomSection);

        // Check if we should restore chatbot mode
        if (this._isChatbotMode) {
            // Restore chatbot mode
            this._restoreChatbotMode();
        } else {
            // Show main menu
            this._navigationStack = [];
            this._showMainMenu(false);
        }

        // Start with opacity 0 and off-screen to the left for slide-in animation
        this._panel.opacity = 0;
        this._panel.x = MARGIN_LEFT - PANEL_WIDTH;

        Main.layoutManager.addTopChrome(this._hoverZone);
        Main.layoutManager.addTopChrome(this._panel);
        this._panelVisible = true;

        // Fade in + slide to right animation
        let targetWidth = this._isChatbotMode ? CHATBOT_PANEL_WIDTH : PANEL_WIDTH;
        this._panel.ease({
            opacity: 255,
            x: MARGIN_LEFT,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                // Grab keyboard focus
                if (this._isChatbotMode && this._chatbotPanel) {
                    this._chatbotPanel.focusInput();
                } else if (this._searchEntry) {
                    this._searchEntry.grab_key_focus();
                }
            }
        });

        // Add key capture for navigation and search
        this._keyPressId = global.stage.connect('key-press-event', (actor, event) => {
            if (!this._panelVisible)
                return Clutter.EVENT_PROPAGATE;

            let keyval = event.get_key_symbol();
            let keychar = String.fromCharCode(Clutter.keysym_to_unicode(keyval));

            // Handle arrow key navigation
            if (keyval === Clutter.KEY_Down) {
                this._navigateMenu(1);
                return Clutter.EVENT_STOP;
            } else if (keyval === Clutter.KEY_Up) {
                this._navigateMenu(-1);
                return Clutter.EVENT_STOP;
            } else if (keyval === Clutter.KEY_Return || keyval === Clutter.KEY_KP_Enter) {
                // If search entry has focus and has text, launch first result
                if (this._searchEntry && this._searchEntry.has_key_focus() && this._searchEntry.get_text().trim() !== '') {
                    this._launchFirstSearchResult();
                    return Clutter.EVENT_STOP;
                }
                // Otherwise activate focused menu item
                if (this._focusedIndex >= 0 && this._focusedIndex < this._menuItems.length) {
                    this._activateMenuItem(this._focusedIndex);
                    return Clutter.EVENT_STOP;
                }
            } else if (keyval === Clutter.KEY_Right) {
                // Enter submenu if focused item has children
                if (this._focusedIndex >= 0 && this._focusedIndex < this._menuItems.length) {
                    let item = this._menuItems[this._focusedIndex];
                    if (item._hasChildren) {
                        this._activateMenuItem(this._focusedIndex);
                        return Clutter.EVENT_STOP;
                    }
                }
            } else if (keyval === Clutter.KEY_Left || keyval === Clutter.KEY_BackSpace) {
                // Go back if in nested menu (but not if typing in search)
                if (this._navigationStack.length > 0) {
                    if (keyval === Clutter.KEY_BackSpace && this._searchEntry && this._searchEntry.has_key_focus()) {
                        return Clutter.EVENT_PROPAGATE;
                    }
                    if (!this._isAnimating) this._goBack();
                    return Clutter.EVENT_STOP;
                }
            }

            // Check if it's an alphanumeric character
            if (/^[a-zA-Z0-9]$/.test(keychar)) {
                // If we're in a nested menu (no search entry), go back to main first
                if (!this._searchEntry || this._navigationStack.length > 0) {
                    this._navigationStack = [];
                    this._isSearchActive = false;
                    this._showMainMenu(false);
                }

                // Now we should have a search entry
                if (this._searchEntry) {
                    // Check if search entry already has focus
                    if (!this._searchEntry.has_key_focus()) {
                        this._searchEntry.grab_key_focus();
                        // Insert the character into the search entry
                        this._searchEntry.set_text(keychar);
                        // Move cursor to end
                        this._searchEntry.clutter_text.set_cursor_position(-1);
                    }
                }
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        });

        // Add hover handler on the panel to keep it open
        this._panelEnterId = this._panel.connect('enter-event', () => {
            if (this._hoverTimeoutId) {
                GLib.source_remove(this._hoverTimeoutId);
                this._hoverTimeoutId = null;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._panelLeaveId = this._panel.connect('leave-event', () => {
            this._scheduleHidePanel();
            return Clutter.EVENT_PROPAGATE;
        });

        // Add hover handler on the hover zone (includes margins)
        this._hoverZoneEnterId = this._hoverZone.connect('enter-event', () => {
            if (this._hoverTimeoutId) {
                GLib.source_remove(this._hoverTimeoutId);
                this._hoverTimeoutId = null;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._hoverZoneLeaveId = this._hoverZone.connect('leave-event', () => {
            this._scheduleHidePanel();
            return Clutter.EVENT_PROPAGATE;
        });

        // Also handle leaving the indicator button
        this._indicatorLeaveId = this.connect('leave-event', () => {
            this._scheduleHidePanel();
            return Clutter.EVENT_PROPAGATE;
        });

        // Add click-outside handler for stage (desktop background)
        this._captureEventId = global.stage.connect('captured-event', (actor, event) => {
            if (event.type() === Clutter.EventType.BUTTON_PRESS) {
                let [x, y] = event.get_coords();

                // Check if click is on the indicator button (don't hide)
                let dominated = this.contains(global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y));
                if (dominated) {
                    return Clutter.EVENT_PROPAGATE;
                }

                // Check if click is outside the panel (with margins)
                // Use actual panel width to handle chatbot mode (400px) vs normal mode (325px)
                let currentPanelWidth = this._panel ? this._panel.width : PANEL_WIDTH;
                let panelRight = MARGIN_LEFT + currentPanelWidth;
                let panelTop = Main.panel.height + MARGIN_TOP;
                let panelBottom = panelTop + this._panel.height;

                if (x < MARGIN_LEFT || x > panelRight || y < panelTop || y > panelBottom) {
                    this._hidePanel();
                    return Clutter.EVENT_STOP;
                }
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Add focus change handler to close when clicking on windows
        this._focusWindowId = global.display.connect('notify::focus-window', () => {
            // Only hide if a window gets focus (user clicked on a window)
            // Don't hide just because our panel got focus
            if (this._panelVisible && global.display.focus_window) {
                // Small delay to allow our panel to process focus first
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                    if (this._panelVisible && global.display.focus_window) {
                        this._hidePanel();
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
    }

    _scheduleHidePanel() {
        // Don't schedule hide if context menu is open or transitioning chatbot
        if (this._contextMenu || this._isTransitioningChatbot) {
            return;
        }

        if (this._hoverTimeoutId) {
            GLib.source_remove(this._hoverTimeoutId);
        }
        this._hoverTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._hoverTimeoutId = null;
            // Double-check context menu isn't open and not transitioning when timeout fires
            if (!this._contextMenu && !this._isTransitioningChatbot) {
                this._hidePanel();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _hidePanel() {
        // Close context menu first
        this._closeContextMenu();

        // Preserve chatbot messages before destroying panel (keep _isChatbotMode flag)
        if (this._chatbotPanel) {
            this._chatbotMessages = this._chatbotPanel.getMessages();
            this._chatbotPanel.destroy();
            this._chatbotPanel = null;
        }

        if (this._hoverTimeoutId) {
            GLib.source_remove(this._hoverTimeoutId);
            this._hoverTimeoutId = null;
        }

        if (this._captureEventId) {
            global.stage.disconnect(this._captureEventId);
            this._captureEventId = null;
        }

        if (this._keyPressId) {
            global.stage.disconnect(this._keyPressId);
            this._keyPressId = null;
        }

        if (this._focusWindowId) {
            global.display.disconnect(this._focusWindowId);
            this._focusWindowId = null;
        }

        if (this._indicatorLeaveId) {
            this.disconnect(this._indicatorLeaveId);
            this._indicatorLeaveId = null;
        }

        if (this._panel && this._panelEnterId) {
            this._panel.disconnect(this._panelEnterId);
            this._panelEnterId = null;
        }

        if (this._panel && this._panelLeaveId) {
            this._panel.disconnect(this._panelLeaveId);
            this._panelLeaveId = null;
        }

        if (this._hoverZone && this._hoverZoneEnterId) {
            this._hoverZone.disconnect(this._hoverZoneEnterId);
            this._hoverZoneEnterId = null;
        }

        if (this._hoverZone && this._hoverZoneLeaveId) {
            this._hoverZone.disconnect(this._hoverZoneLeaveId);
            this._hoverZoneLeaveId = null;
        }

        this._panelVisible = false;
        this._navigationStack = [];
        this._isSearchActive = false;
        this._isAnimating = false;
        this._searchEntry = null;
        this._focusedIndex = -1;
        this._menuItems = [];
        this._menuBox = null;
        this._bottomSection = null;

        // Immediately disable reactivity to prevent blocking clicks during animation
        if (this._hoverZone) {
            this._hoverZone.reactive = false;
        }
        if (this._panel) {
            this._panel.reactive = false;
        }

        // Clean up hover zone immediately if panel doesn't exist
        if (this._hoverZone && !this._panel) {
            Main.layoutManager.removeChrome(this._hoverZone);
            this._hoverZone.destroy();
            this._hoverZone = null;
        }

        if (this._panel) {
            // Fade out + slide to left animation
            this._panel.ease({
                opacity: 0,
                x: MARGIN_LEFT - PANEL_WIDTH,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (this._hoverZone) {
                        try {
                            Main.layoutManager.removeChrome(this._hoverZone);
                        } catch (e) {
                            // Ignore if already removed
                        }
                        this._hoverZone.destroy();
                        this._hoverZone = null;
                    }
                    if (this._panel) {
                        try {
                            Main.layoutManager.removeChrome(this._panel);
                        } catch (e) {
                            // Ignore if already removed
                        }
                        this._panel.destroy();
                        this._panel = null;
                    }
                }
            });
        }
    }

    _createScrollView(height = null) {
        let scrollView = new St.ScrollView({
            style_class: 'praya-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });
        // Use sliding container height which already accounts for bottom section
        let containerHeight = this._slidingContainer ? this._slidingContainer.height : 400;
        scrollView.set_size(PANEL_WIDTH, height || containerHeight);
        return scrollView;
    }

    _navigateMenu(direction) {
        if (this._menuItems.length === 0)
            return;

        // Remove focus from search entry if navigating
        if (this._searchEntry && this._searchEntry.has_key_focus()) {
            global.stage.set_key_focus(null);
        }

        let newIndex = this._focusedIndex + direction;

        // Wrap around
        if (newIndex < 0)
            newIndex = this._menuItems.length - 1;
        else if (newIndex >= this._menuItems.length)
            newIndex = 0;

        this._setFocusedIndex(newIndex);
    }

    _setFocusedIndex(index) {
        // Remove highlight from previous item
        if (this._focusedIndex >= 0 && this._focusedIndex < this._menuItems.length) {
            this._menuItems[this._focusedIndex].remove_style_class_name('praya-menu-item-focused');
        }

        this._focusedIndex = index;

        // Add highlight to new item
        if (this._focusedIndex >= 0 && this._focusedIndex < this._menuItems.length) {
            let item = this._menuItems[this._focusedIndex];
            item.add_style_class_name('praya-menu-item-focused');

            // Scroll item into view if needed
            if (this._currentScrollView) {
                let adjustment = this._currentScrollView.vscroll.adjustment;
                let [itemX, itemY] = item.get_transformed_position();
                let [scrollX, scrollY] = this._currentScrollView.get_transformed_position();
                let relativeY = itemY - scrollY;
                let scrollHeight = this._currentScrollView.height;
                let itemHeight = item.height;

                if (relativeY < 0) {
                    adjustment.value += relativeY;
                } else if (relativeY + itemHeight > scrollHeight) {
                    adjustment.value += (relativeY + itemHeight - scrollHeight);
                }
            }
        }
    }

    _activateMenuItem(index) {
        if (index < 0 || index >= this._menuItems.length)
            return;

        let item = this._menuItems[index];
        if (item._activateCallback) {
            item._activateCallback();
        }
    }

    _registerMenuItems(items, scrollView) {
        this._menuItems = items;
        this._currentScrollView = scrollView;
        this._focusedIndex = -1;
    }

    _animateSlide(newContent, direction) {
        if (this._isAnimating) return;
        this._isAnimating = true;

        // Use sliding container's actual height (already accounts for bottom section)
        let containerHeight = this._slidingContainer.height;

        // Get current content
        let currentContent = this._slidingContainer.get_first_child();

        // Set initial position for new content
        newContent.set_position(direction === 'forward' ? PANEL_WIDTH : -PANEL_WIDTH, 0);
        newContent.set_size(PANEL_WIDTH, containerHeight);
        this._slidingContainer.add_child(newContent);

        // Animate current content out
        if (currentContent) {
            currentContent.ease({
                x: direction === 'forward' ? -PANEL_WIDTH : PANEL_WIDTH,
                duration: ANIMATION_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    currentContent.destroy();
                }
            });
        }

        // Animate new content in
        newContent.ease({
            x: 0,
            duration: ANIMATION_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._isAnimating = false;
            }
        });
    }

    _showMainMenu(animate = true) {
        this._updateHeader('Menu', false);

        let monitor = Main.layoutManager.primaryMonitor;

        // Create a container for the whole view
        let contentContainer = new St.BoxLayout({
            style_class: 'praya-content-container',
            vertical: true,
            x_expand: true,
            y_expand: true,
        });

        // Scroll view takes remaining space (y_expand)
        let scrollView = new St.ScrollView({
            style_class: 'praya-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });

        let menuBox = new St.BoxLayout({
            style_class: 'praya-menu-box',
            vertical: true,
            x_expand: true,
        });

        let navItems = [];

        // Show favourite apps above Applications
        let favouriteApps = this._getFavouriteApps();
        if (favouriteApps.length > 0) {
            for (let appData of favouriteApps) {
                let appItem = this._createAppMenuItemFromData(appData, true);
                appItem._hasChildren = false;
                appItem._appData = appData;
                appItem._activateCallback = ((data) => () => {
                    this._launchAppFromData(data);
                    this._hidePanel();
                })(appData);
                appItem.connect('button-press-event', (actor, event) => {
                    if (event.get_button() === 3) {
                        // Right-click - show context menu
                        this._showContextMenu(appData, actor);
                        return Clutter.EVENT_STOP;
                    }
                    // Left-click - launch app
                    appItem._activateCallback();
                    return Clutter.EVENT_STOP;
                });
                menuBox.add_child(appItem);
                navItems.push(appItem);
            }
            // Separator after favourites
            menuBox.add_child(new St.Widget({style_class: 'praya-separator', height: 1, x_expand: true}));
        }

        // Applications item (has children)
        let appsItem = this._createMenuItem('Applications', 'view-app-grid-symbolic', true);
        appsItem._hasChildren = true;
        appsItem._activateCallback = () => {
            if (!this._isAnimating) this._showApplicationsList();
        };
        appsItem.connect('button-press-event', () => {
            appsItem._activateCallback();
            return Clutter.EVENT_STOP;
        });
        menuBox.add_child(appsItem);
        navItems.push(appsItem);

        // Places item (has children)
        let placesItem = this._createMenuItem('Places', 'folder-symbolic', true);
        placesItem._hasChildren = true;
        placesItem._activateCallback = () => {
            if (!this._isAnimating) this._showPlaces();
        };
        placesItem.connect('button-press-event', () => {
            placesItem._activateCallback();
            return Clutter.EVENT_STOP;
        });
        menuBox.add_child(placesItem);
        navItems.push(placesItem);

        // Separator
        menuBox.add_child(new St.Widget({style_class: 'praya-separator', height: 1, x_expand: true}));

        // System Settings item (opens GNOME Settings directly)
        let settingsItem = this._createMenuItem('System Settings', 'preferences-system-symbolic', false);
        settingsItem._hasChildren = false;
        settingsItem._activateCallback = () => {
            let appInfo = GioUnix.DesktopAppInfo.new('gnome-control-center.desktop');
            if (appInfo) {
                appInfo.launch([], null);
            } else {
                appInfo = GioUnix.DesktopAppInfo.new('org.gnome.Settings.desktop');
                if (appInfo)
                    appInfo.launch([], null);
            }
            this._hidePanel();
        };
        settingsItem.connect('button-press-event', () => {
            settingsItem._activateCallback();
            return Clutter.EVENT_STOP;
        });
        menuBox.add_child(settingsItem);
        navItems.push(settingsItem);

        // Praya Preferences item (opens preferences dialog)
        let prefsItem = this._createMenuItem('Praya Preferences', 'preferences-other-symbolic', false);
        prefsItem._hasChildren = false;
        prefsItem._activateCallback = () => {
            this._hidePanel();
            let dialog = new PrayaPreferencesDialog();
            dialog.open(global.get_current_time());
        };
        prefsItem.connect('button-press-event', () => {
            prefsItem._activateCallback();
            return Clutter.EVENT_STOP;
        });
        menuBox.add_child(prefsItem);
        navItems.push(prefsItem);

        // About BlankOn (has children)
        let aboutItem = this._createMenuItem('About BlankOn', 'help-about-symbolic', true);
        aboutItem._hasChildren = true;
        aboutItem._activateCallback = () => {
            if (!this._isAnimating) this._showAboutBlankOn();
        };
        aboutItem.connect('button-press-event', () => {
            aboutItem._activateCallback();
            return Clutter.EVENT_STOP;
        });
        menuBox.add_child(aboutItem);
        navItems.push(aboutItem);

        scrollView.add_child(menuBox);
        contentContainer.add_child(scrollView);

        // Register menu items for keyboard navigation
        this._registerMenuItems(navItems, scrollView);

        if (animate) {
            this._animateSlide(contentContainer, 'back');
        } else {
            // Use sliding container's actual height (already accounts for bottom section)
            let containerHeight = this._slidingContainer.height;
            this._slidingContainer.destroy_all_children();
            contentContainer.set_position(0, 0);
            contentContainer.set_size(PANEL_WIDTH, containerHeight);
            this._slidingContainer.add_child(contentContainer);
        }
    }

    _getCategoryInfo(categoryId) {
        // Map category IDs to display names and icons
        const categoryMap = {
            'AudioVideo': {name: 'Sound & Video', icon: 'applications-multimedia-symbolic'},
            'Audio': {name: 'Audio', icon: 'audio-x-generic-symbolic'},
            'Video': {name: 'Video', icon: 'video-x-generic-symbolic'},
            'Development': {name: 'Development', icon: 'applications-engineering-symbolic'},
            'Education': {name: 'Education', icon: 'applications-science-symbolic'},
            'Game': {name: 'Games', icon: 'applications-games-symbolic'},
            'Graphics': {name: 'Graphics', icon: 'applications-graphics-symbolic'},
            'Network': {name: 'Internet', icon: 'applications-internet-symbolic'},
            'Office': {name: 'Office', icon: 'x-office-document-symbolic'},
            'Science': {name: 'Science', icon: 'applications-science-symbolic'},
            'Settings': {name: 'Settings', icon: 'preferences-system-symbolic'},
            'System': {name: 'System Tools', icon: 'applications-system-symbolic'},
            'Utility': {name: 'Accessories', icon: 'applications-utilities-symbolic'},
            'Other': {name: 'Other', icon: 'applications-other-symbolic'},
        };
        return categoryMap[categoryId] || {name: categoryId, icon: 'application-x-executable-symbolic'};
    }

    _showApplicationsList() {
        this._navigationStack.push({type: 'main'});
        this._updateHeader('Applications', true);

        // Reload apps if categories are empty
        if (Object.keys(this._categories).length === 0) {
            this._loadApplicationsData();
        }

        let scrollView = this._createScrollView();

        let menuBox = new St.BoxLayout({
            style_class: 'praya-menu-box',
            vertical: true,
            x_expand: true,
        });

        let navItems = [];

        // Define the order of categories
        const categoryOrder = [
            'Network', 'Office', 'Graphics', 'AudioVideo', 'Video', 'Audio',
            'Development', 'Game', 'Education', 'Science', 'System',
            'Utility', 'Settings', 'Other'
        ];

        // Show categories that have apps
        for (let categoryId of categoryOrder) {
            if (this._categories[categoryId] && this._categories[categoryId].length > 0) {
                let info = this._getCategoryInfo(categoryId);
                let categoryItem = this._createMenuItem(
                    info.name,
                    info.icon,
                    true
                );
                categoryItem._hasChildren = true;
                categoryItem._activateCallback = ((catId) => () => {
                    if (!this._isAnimating) this._showCategoryApps(catId);
                })(categoryId);
                categoryItem.connect('button-press-event', () => {
                    categoryItem._activateCallback();
                    return Clutter.EVENT_STOP;
                });
                menuBox.add_child(categoryItem);
                navItems.push(categoryItem);
            }
        }

        // Check for any categories not in the predefined order
        for (let categoryId in this._categories) {
            if (!categoryOrder.includes(categoryId) && this._categories[categoryId].length > 0) {
                let info = this._getCategoryInfo(categoryId);
                let categoryItem = this._createMenuItem(
                    info.name,
                    info.icon,
                    true
                );
                categoryItem._hasChildren = true;
                categoryItem._activateCallback = ((catId) => () => {
                    if (!this._isAnimating) this._showCategoryApps(catId);
                })(categoryId);
                categoryItem.connect('button-press-event', () => {
                    categoryItem._activateCallback();
                    return Clutter.EVENT_STOP;
                });
                menuBox.add_child(categoryItem);
                navItems.push(categoryItem);
            }
        }

        // Show message if no categories found
        if (menuBox.get_n_children() === 0) {
            let noAppsLabel = new St.Label({
                text: 'No applications found.\nCategories: ' + Object.keys(this._categories).length,
                style_class: 'praya-no-results',
                x_align: Clutter.ActorAlign.CENTER,
            });
            menuBox.add_child(noAppsLabel);
        }

        scrollView.add_child(menuBox);
        this._registerMenuItems(navItems, scrollView);
        this._animateSlide(scrollView, 'forward');
    }

    _showCategoryApps(categoryId) {
        let info = this._getCategoryInfo(categoryId);
        this._navigationStack.push({type: 'applications'});
        this._updateHeader(info.name, true);

        let scrollView = this._createScrollView();

        let menuBox = new St.BoxLayout({
            style_class: 'praya-menu-box',
            vertical: true,
            x_expand: true,
        });

        let navItems = [];
        let apps = this._categories[categoryId] || [];

        for (let appData of apps) {
            let appItem = this._createAppMenuItemFromData(appData);
            appItem._hasChildren = false;
            appItem._activateCallback = ((data) => () => {
                this._launchAppFromData(data);
                this._hidePanel();
            })(appData);
            appItem.connect('button-press-event', (actor, event) => {
                if (event.get_button() === 3) {
                    // Right-click - show context menu
                    this._showContextMenu(appData, actor);
                    return Clutter.EVENT_STOP;
                }
                // Left-click - launch app
                appItem._activateCallback();
                return Clutter.EVENT_STOP;
            });
            menuBox.add_child(appItem);
            navItems.push(appItem);
        }

        scrollView.add_child(menuBox);
        this._registerMenuItems(navItems, scrollView);
        this._animateSlide(scrollView, 'forward');
    }

    _showPlaces() {
        this._navigationStack.push({type: 'main'});
        this._updateHeader('Places', true);

        let scrollView = this._createScrollView();

        let menuBox = new St.BoxLayout({
            style_class: 'praya-menu-box',
            vertical: true,
            x_expand: true,
        });

        let navItems = [];

        // Home
        let homeItem = this._createMenuItem('Home', 'user-home-symbolic', false);
        homeItem._hasChildren = false;
        homeItem._activateCallback = () => this._openPlace(GLib.get_home_dir());
        homeItem.connect('button-press-event', () => {
            homeItem._activateCallback();
            return Clutter.EVENT_STOP;
        });
        menuBox.add_child(homeItem);
        navItems.push(homeItem);

        // Documents
        let docsPath = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS);
        if (docsPath) {
            let docsItem = this._createMenuItem('Documents', 'folder-documents-symbolic', false);
            docsItem._hasChildren = false;
            docsItem._activateCallback = () => this._openPlace(docsPath);
            docsItem.connect('button-press-event', () => {
                docsItem._activateCallback();
                return Clutter.EVENT_STOP;
            });
            menuBox.add_child(docsItem);
            navItems.push(docsItem);
        }

        // Downloads
        let downloadsPath = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD);
        if (downloadsPath) {
            let downloadsItem = this._createMenuItem('Downloads', 'folder-download-symbolic', false);
            downloadsItem._hasChildren = false;
            downloadsItem._activateCallback = () => this._openPlace(downloadsPath);
            downloadsItem.connect('button-press-event', () => {
                downloadsItem._activateCallback();
                return Clutter.EVENT_STOP;
            });
            menuBox.add_child(downloadsItem);
            navItems.push(downloadsItem);
        }

        // Pictures
        let picturesPath = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES);
        if (picturesPath) {
            let picturesItem = this._createMenuItem('Pictures', 'folder-pictures-symbolic', false);
            picturesItem._hasChildren = false;
            picturesItem._activateCallback = () => this._openPlace(picturesPath);
            picturesItem.connect('button-press-event', () => {
                picturesItem._activateCallback();
                return Clutter.EVENT_STOP;
            });
            menuBox.add_child(picturesItem);
            navItems.push(picturesItem);
        }

        // Music
        let musicPath = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_MUSIC);
        if (musicPath) {
            let musicItem = this._createMenuItem('Music', 'folder-music-symbolic', false);
            musicItem._hasChildren = false;
            musicItem._activateCallback = () => this._openPlace(musicPath);
            musicItem.connect('button-press-event', () => {
                musicItem._activateCallback();
                return Clutter.EVENT_STOP;
            });
            menuBox.add_child(musicItem);
            navItems.push(musicItem);
        }

        // Videos
        let videosPath = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS);
        if (videosPath) {
            let videosItem = this._createMenuItem('Videos', 'folder-videos-symbolic', false);
            videosItem._hasChildren = false;
            videosItem._activateCallback = () => this._openPlace(videosPath);
            videosItem.connect('button-press-event', () => {
                videosItem._activateCallback();
                return Clutter.EVENT_STOP;
            });
            menuBox.add_child(videosItem);
            navItems.push(videosItem);
        }

        scrollView.add_child(menuBox);
        this._registerMenuItems(navItems, scrollView);
        this._animateSlide(scrollView, 'forward');
    }

    _onSearchTextChanged() {
        let searchText = this._searchEntry.get_text().trim();

        if (searchText === '') {
            // Show main menu when search is cleared
            if (this._navigationStack.length > 0 || this._isSearchActive) {
                this._isSearchActive = false;
                this._navigationStack = [];
                this._showMainMenu(true);
                // Maintain focus on search entry after reset
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    if (this._searchEntry) {
                        this._searchEntry.grab_key_focus();
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
            return;
        }

        this._isSearchActive = true;
        this._showSearchResults(searchText);
    }

    _launchFirstSearchResult() {
        let searchText = this._searchEntry.get_text().trim();
        if (searchText === '')
            return;

        let searchResults = GioUnix.DesktopAppInfo.search(searchText);
        if (searchResults.length === 0 || searchResults[0].length === 0) {
            // No results found - enter chatbot mode if configured
            // Reload settings to pick up any recent changes
            this._chatbotSettings.reload();
            if (this._chatbotSettings.isConfigured()) {
                this._enterChatbotMode(searchText);
            }
            return;
        }

        let appId = searchResults[0][0];
        let appInfo = GioUnix.DesktopAppInfo.new(appId);
        if (!appInfo)
            return;

        let app = this._appSystem.lookup_app(appId);
        if (app) {
            app.activate();
        } else {
            appInfo.launch([], null);
        }
        this._hidePanel();
    }

    _showSearchResults(query) {
        // Use GioUnix.DesktopAppInfo.search for search results
        let searchResults = GioUnix.DesktopAppInfo.search(query);

        // Flatten the array of arrays and create app data objects
        let matchedApps = [];
        for (let group of searchResults) {
            for (let appId of group) {
                // Get the desktop app info
                let appInfo = GioUnix.DesktopAppInfo.new(appId);
                if (!appInfo)
                    continue;

                // Try to get Shell.App
                let app = this._appSystem.lookup_app(appId);

                matchedApps.push({
                    app: app,
                    appInfo: appInfo,
                    name: appInfo.get_name() || appId,
                    id: appId,
                });
            }
        }

        // Create results view
        // Use sliding container's actual height (already accounts for bottom section)
        let containerHeight = this._slidingContainer.height;

        let scrollView = new St.ScrollView({
            style_class: 'praya-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });
        scrollView.set_size(PANEL_WIDTH, containerHeight);

        let menuBox = new St.BoxLayout({
            style_class: 'praya-menu-box',
            vertical: true,
            x_expand: true,
        });

        let navItems = [];

        if (matchedApps.length === 0) {
            // Reload settings to pick up any recent changes
            this._chatbotSettings.reload();
            let isChatbotConfigured = this._chatbotSettings.isConfigured();
            let noResultsText = isChatbotConfigured
                ? 'No applications found.\nPress Enter to chat with AI...'
                : 'No applications found';
            let noResultsLabel = new St.Label({
                text: noResultsText,
                style_class: 'praya-no-results',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            noResultsLabel.clutter_text.set_line_alignment(1); // Center alignment
            noResultsLabel.opacity = 0;
            menuBox.add_child(noResultsLabel);
            noResultsLabel.ease({
                opacity: 255,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            for (let i = 0; i < matchedApps.length; i++) {
                let appData = matchedApps[i];
                let appItem = this._createAppMenuItemFromData(appData);
                appItem._hasChildren = false;
                appItem._activateCallback = ((data) => () => {
                    this._launchAppFromData(data);
                    this._hidePanel();
                })(appData);
                appItem.connect('button-press-event', (actor, event) => {
                    if (event.get_button() === 3) {
                        // Right-click - show context menu
                        this._showContextMenu(appData, actor);
                        return Clutter.EVENT_STOP;
                    }
                    // Left-click - launch app
                    appItem._activateCallback();
                    return Clutter.EVENT_STOP;
                });

                // Start with opacity 0 and slide in from left
                appItem.opacity = 0;
                appItem.translation_x = -20;
                menuBox.add_child(appItem);
                navItems.push(appItem);

                // Staggered fade-in and slide animation
                let delay = i * 30; // 30ms delay between each item
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                    appItem.ease({
                        opacity: 255,
                        translation_x: 0,
                        duration: 150,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                    return GLib.SOURCE_REMOVE;
                });
            }
        }

        scrollView.add_child(menuBox);

        // Replace content without animation for smooth search experience
        this._slidingContainer.destroy_all_children();
        scrollView.set_position(0, 0);
        this._slidingContainer.add_child(scrollView);

        // Register menu items for keyboard navigation
        this._registerMenuItems(navItems, scrollView);
    }

    _createMenuItem(text, iconName, hasChildren) {
        let item = new St.BoxLayout({
            style_class: 'praya-menu-item',
            reactive: true,
            track_hover: true,
            height: 48,
            x_expand: true,
        });

        let icon = new St.Icon({
            icon_name: iconName,
            style_class: 'praya-menu-item-icon',
            icon_size: 24,
        });
        item.add_child(icon);

        let label = new St.Label({
            text: text,
            style_class: 'praya-menu-item-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        item.add_child(label);

        if (hasChildren) {
            let arrow = new St.Icon({
                icon_name: 'go-next-symbolic',
                style_class: 'praya-menu-item-arrow',
                icon_size: 16,
            });
            item.add_child(arrow);
        }

        return item;
    }

    _createAppMenuItem(app) {
        let item = new St.BoxLayout({
            style_class: 'praya-menu-item',
            reactive: true,
            track_hover: true,
            height: 48,
            x_expand: true,
        });

        let icon = app.create_icon_texture(24);
        icon.style_class = 'praya-menu-item-icon';
        item.add_child(icon);

        let label = new St.Label({
            text: app.get_name(),
            style_class: 'praya-menu-item-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        item.add_child(label);

        return item;
    }

    _createAppMenuItemFromData(appData, showFavStar = false) {
        let item = new St.BoxLayout({
            style_class: 'praya-menu-item',
            reactive: true,
            track_hover: true,
            height: 48,
            x_expand: true,
        });

        // Try to get icon from Shell.App first, fallback to AppInfo icon
        let icon;
        if (appData.app) {
            icon = appData.app.create_icon_texture(24);
        } else if (appData.appInfo) {
            let gicon = appData.appInfo.get_icon();
            icon = new St.Icon({
                gicon: gicon,
                icon_size: 24,
            });
        } else {
            icon = new St.Icon({
                icon_name: 'application-x-executable-symbolic',
                icon_size: 24,
            });
        }
        icon.style_class = 'praya-menu-item-icon';
        item.add_child(icon);

        let label = new St.Label({
            text: appData.name,
            style_class: 'praya-menu-item-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        item.add_child(label);

        // Show pin icon for favourites
        if (showFavStar && this._isFavourite(appData.id)) {
            let pinIcon = new St.Icon({
                icon_name: 'view-pin-symbolic',
                icon_size: 16,
                style_class: 'praya-favourite-pin',
            });
            pinIcon.set_pivot_point(0.5, 0.5);
            pinIcon.rotation_angle_z = 45;
            item.add_child(pinIcon);
        }

        // Store appData for context menu
        item._appData = appData;

        return item;
    }

    _launchAppFromData(appData) {
        if (appData.app) {
            appData.app.activate();
        } else if (appData.appInfo) {
            appData.appInfo.launch([], null);
        }
    }

    _createExpandableMenuItem(text, iconName) {
        let item = new St.BoxLayout({
            style_class: 'praya-menu-item',
            reactive: true,
            track_hover: true,
            height: 48,
            x_expand: true,
        });

        let icon = new St.Icon({
            icon_name: iconName,
            style_class: 'praya-menu-item-icon',
            icon_size: 24,
        });
        item.add_child(icon);

        let label = new St.Label({
            text: text,
            style_class: 'praya-menu-item-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        item.add_child(label);

        // Up arrow (collapsed state)
        let arrow = new St.Icon({
            icon_name: 'go-up-symbolic',
            style_class: 'praya-menu-item-arrow',
            icon_size: 16,
        });
        item.add_child(arrow);

        return item;
    }

    _createSubMenuItem(text) {
        let item = new St.BoxLayout({
            style_class: 'praya-submenu-item',
            reactive: true,
            track_hover: true,
            height: 42,
            x_expand: true,
        });

        let label = new St.Label({
            text: text,
            style_class: 'praya-menu-item-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        item.add_child(label);

        return item;
    }

    _createUserItem() {
        // Get current user info
        let userManager = AccountsService.UserManager.get_default();
        let user = userManager.get_user(GLib.get_user_name());

        let item = new St.BoxLayout({
            style_class: 'praya-user-item',
            reactive: true,
            track_hover: true,
            x_expand: true,
        });

        // Avatar
        let avatarFile = user.get_icon_file();
        let avatar;
        if (avatarFile && GLib.file_test(avatarFile, GLib.FileTest.EXISTS)) {
            avatar = new St.Bin({
                style_class: 'praya-user-avatar',
                style: `background-image: url("${avatarFile}");`,
            });
        } else {
            avatar = new St.Bin({
                style_class: 'praya-user-avatar',
                child: new St.Icon({
                    icon_name: 'avatar-default-symbolic',
                    icon_size: 32,
                }),
            });
        }
        item.add_child(avatar);

        // Name container (full name + username)
        let nameBox = new St.BoxLayout({
            vertical: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });

        let fullName = user.get_real_name() || GLib.get_user_name();
        let fullNameLabel = new St.Label({
            text: fullName,
            style_class: 'praya-user-fullname',
        });
        nameBox.add_child(fullNameLabel);

        let username = GLib.get_user_name();
        let usernameLabel = new St.Label({
            text: username,
            style_class: 'praya-user-username',
        });
        nameBox.add_child(usernameLabel);

        item.add_child(nameBox);

        // Click to open Settings -> System -> Users
        item.connect('button-press-event', () => {
            this._hidePanel();
            try {
                let subprocess = Gio.Subprocess.new(
                    ['gnome-control-center', 'users'],
                    Gio.SubprocessFlags.NONE
                );
            } catch (e) {
                // Fallback: try to open settings app
                let appInfo = GioUnix.DesktopAppInfo.new('gnome-control-center.desktop');
                if (appInfo)
                    appInfo.launch([], null);
            }
            return Clutter.EVENT_STOP;
        });

        return item;
    }

    _createBottomSection() {
        // Bottom section - sticks to bottom (User + Lock + Log Out + Power)
        let bottomSection = new St.BoxLayout({
            style_class: 'praya-bottom-section',
            vertical: true,
            x_expand: true,
        });

        // User component
        let userItem = this._createUserItem();
        bottomSection.add_child(userItem);

        // Separator between user and session actions
        bottomSection.add_child(new St.Widget({style_class: 'praya-separator', height: 1, x_expand: true}));

        // Lock item (same level as Power)
        let lockItem = this._createMenuItem('Lock', 'system-lock-screen-symbolic', false);
        lockItem.connect('button-press-event', () => {
            Main.screenShield.lock(true);
            this._hidePanel();
            return Clutter.EVENT_STOP;
        });
        bottomSection.add_child(lockItem);

        // Log Out item (same level as Power)
        let logoutItem = this._createMenuItem('Log Out', 'system-log-out-symbolic', false);
        logoutItem.connect('button-press-event', () => {
            this._hidePanel();
            this._systemActions.activateLogout();
            return Clutter.EVENT_STOP;
        });
        bottomSection.add_child(logoutItem);

        // Power item (expandable)
        let powerItem = this._createExpandableMenuItem('Power', 'system-shutdown-symbolic');
        bottomSection.add_child(powerItem);

        // Power options container (initially hidden with 0 height for animation)
        let powerOptionsBox = new St.BoxLayout({
            style_class: 'praya-power-options',
            vertical: true,
            x_expand: true,
            clip_to_allocation: true,
        });
        powerOptionsBox.set_height(0);
        powerOptionsBox._expanded = false;
        powerOptionsBox._targetHeight = 150; // 3 items * 42px height + margins + padding

        // Suspend
        let suspendItem = this._createSubMenuItem('Suspend');
        suspendItem.connect('button-press-event', () => {
            this._hidePanel();
            this._systemActions.activateSuspend();
            return Clutter.EVENT_STOP;
        });
        powerOptionsBox.add_child(suspendItem);

        // Restart
        let restartItem = this._createSubMenuItem('Restart');
        restartItem.connect('button-press-event', () => {
            this._hidePanel();
            this._systemActions.activateRestart();
            return Clutter.EVENT_STOP;
        });
        powerOptionsBox.add_child(restartItem);

        // Power Off
        let powerOffItem = this._createSubMenuItem('Power Off');
        powerOffItem.connect('button-press-event', () => {
            this._hidePanel();
            this._systemActions.activatePowerOff();
            return Clutter.EVENT_STOP;
        });
        powerOptionsBox.add_child(powerOffItem);

        bottomSection.add_child(powerOptionsBox);

        // Toggle power options on click with slide animation
        powerItem.connect('button-press-event', () => {
            let arrow = powerItem.get_last_child();
            if (powerOptionsBox._expanded) {
                // Collapse with animation
                powerOptionsBox.ease({
                    height: 0,
                    duration: ANIMATION_DURATION,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
                // Expand sliding container
                if (this._slidingContainer) {
                    this._slidingContainer.ease({
                        height: this._slidingContainer.height + this._powerOptionsHeight,
                        duration: ANIMATION_DURATION,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                }
                arrow.icon_name = 'go-up-symbolic';
                powerOptionsBox._expanded = false;
            } else {
                // Expand with animation
                powerOptionsBox.ease({
                    height: powerOptionsBox._targetHeight,
                    duration: ANIMATION_DURATION,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
                // Shrink sliding container to make room
                if (this._slidingContainer) {
                    this._slidingContainer.ease({
                        height: this._slidingContainer.height - this._powerOptionsHeight,
                        duration: ANIMATION_DURATION,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                }
                arrow.icon_name = 'go-down-symbolic';
                powerOptionsBox._expanded = true;
            }
            return Clutter.EVENT_STOP;
        });

        return bottomSection;
    }

    _updateHeader(title, showBack) {
        this._header.destroy_all_children();

        if (showBack) {
            // Show back button with title label (no search entry)
            let backButton = new St.Button({
                style_class: 'praya-back-button',
                child: new St.Icon({
                    icon_name: 'go-previous-symbolic',
                    icon_size: 20,
                }),
                width: 50,
                height: 50,
            });
            backButton.connect('clicked', () => {
                if (!this._isAnimating) this._goBack();
            });
            this._header.add_child(backButton);

            let headerLabel = new St.Label({
                text: title,
                style_class: 'praya-header-label',
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            this._header.add_child(headerLabel);
        } else {
            // Show search entry (main menu view) - entry first, icon on right
            this._searchEntry = new St.Entry({
                style_class: 'praya-search-entry',
                hint_text: 'Search or ask...',
                can_focus: true,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._searchEntry.clutter_text.connect('text-changed', () => {
                this._onSearchTextChanged();
            });
            this._searchEntry.clutter_text.connect('key-press-event', (actor, event) => {
                let symbol = event.get_key_symbol();
                if (symbol === Clutter.KEY_Escape) {
                    if (this._searchEntry.get_text() !== '') {
                        this._searchEntry.set_text('');
                        return Clutter.EVENT_STOP;
                    }
                } else if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
                    // Launch first app in search results
                    this._launchFirstSearchResult();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            this._header.add_child(this._searchEntry);

            let searchIcon = new St.Icon({
                icon_name: 'edit-find-symbolic',
                style_class: 'praya-search-icon',
                icon_size: 16,
            });
            this._header.add_child(searchIcon);
            // Note: Focus is handled by _showPanel's onComplete callback
        }
    }

    _goBack() {
        if (this._navigationStack.length === 0) {
            this._showMainMenu(true);
            return;
        }

        let previous = this._navigationStack.pop();

        if (previous.type === 'main') {
            this._showMainMenu(true);
        } else if (previous.type === 'applications') {
            // Go back to applications categories list
            this._navigationStack.push({type: 'main'});
            this._updateHeader('Applications', true);

            let scrollView = this._createScrollView();
            let menuBox = new St.BoxLayout({
                style_class: 'praya-menu-box',
                vertical: true,
                x_expand: true,
            });

            const categoryOrder = [
                'Network', 'Office', 'Graphics', 'AudioVideo', 'Video', 'Audio',
                'Development', 'Game', 'Education', 'Science', 'System',
                'Utility', 'Settings', 'Other'
            ];

            for (let categoryId of categoryOrder) {
                if (this._categories[categoryId] && this._categories[categoryId].length > 0) {
                    let info = this._getCategoryInfo(categoryId);
                    let categoryItem = this._createMenuItem(
                        info.name,
                        info.icon,
                        true
                    );
                    categoryItem.connect('button-press-event', () => {
                        if (!this._isAnimating) this._showCategoryApps(categoryId);
                        return Clutter.EVENT_STOP;
                    });
                    menuBox.add_child(categoryItem);
                }
            }

            for (let categoryId in this._categories) {
                if (!categoryOrder.includes(categoryId) && this._categories[categoryId].length > 0) {
                    let info = this._getCategoryInfo(categoryId);
                    let categoryItem = this._createMenuItem(
                        info.name,
                        info.icon,
                        true
                    );
                    categoryItem.connect('button-press-event', () => {
                        if (!this._isAnimating) this._showCategoryApps(categoryId);
                        return Clutter.EVENT_STOP;
                    });
                    menuBox.add_child(categoryItem);
                }
            }

            scrollView.add_child(menuBox);
            this._animateSlide(scrollView, 'back');
        }
    }

    _openPlace(path) {
        let file = Gio.File.new_for_path(path);
        let uri = file.get_uri();
        Gio.app_info_launch_default_for_uri(uri, null);
        this._hidePanel();
    }

    _openUrl(url) {
        Gio.app_info_launch_default_for_uri(url, null);
        this._hidePanel();
    }

    _showSettingsMenu() {
        this._navigationStack.push({type: 'main'});
        this._updateHeader('Settings', true);

        let scrollView = this._createScrollView();

        let menuBox = new St.BoxLayout({
            style_class: 'praya-menu-box',
            vertical: true,
            x_expand: true,
        });

        let navItems = [];

        // System Settings
        let systemSettingsItem = this._createMenuItem('System Settings', 'preferences-system-symbolic', false);
        systemSettingsItem._hasChildren = false;
        systemSettingsItem._activateCallback = () => {
            let appInfo = GioUnix.DesktopAppInfo.new('gnome-control-center.desktop');
            if (appInfo) {
                appInfo.launch([], null);
            } else {
                appInfo = GioUnix.DesktopAppInfo.new('org.gnome.Settings.desktop');
                if (appInfo)
                    appInfo.launch([], null);
            }
            this._hidePanel();
        };
        systemSettingsItem.connect('button-press-event', () => {
            systemSettingsItem._activateCallback();
            return Clutter.EVENT_STOP;
        });
        menuBox.add_child(systemSettingsItem);
        navItems.push(systemSettingsItem);

        scrollView.add_child(menuBox);
        this._registerMenuItems(navItems, scrollView);
        this._animateSlide(scrollView, 'forward');
    }

    _showAboutBlankOn() {
        this._navigationStack.push({type: 'main'});
        this._updateHeader('About BlankOn', true);

        let scrollView = this._createScrollView();

        let menuBox = new St.BoxLayout({
            style_class: 'praya-menu-box',
            vertical: true,
            x_expand: true,
        });

        let navItems = [];

        // BlankOn Linux
        let blankonItem = this._createMenuItem('BlankOn Linux', 'help-about-symbolic', false);
        blankonItem._hasChildren = false;
        blankonItem._activateCallback = () => {
            this._openUrl('https://blankon.github.io');
        };
        blankonItem.connect('button-press-event', () => {
            blankonItem._activateCallback();
            return Clutter.EVENT_STOP;
        });
        menuBox.add_child(blankonItem);
        navItems.push(blankonItem);

        // Praya Shell Extension
        let prayaItem = this._createMenuItem('Praya Shell Extension', 'help-about-symbolic', false);
        prayaItem._hasChildren = false;
        prayaItem._activateCallback = () => {
            this._openUrl('https://github.com/blankon/praya');
        };
        prayaItem.connect('button-press-event', () => {
            prayaItem._activateCallback();
            return Clutter.EVENT_STOP;
        });
        menuBox.add_child(prayaItem);
        navItems.push(prayaItem);

        // Donate
        let donateItem = this._createMenuItem('Donate', 'help-about-symbolic', false);
        donateItem._hasChildren = false;
        donateItem._activateCallback = () => {
            this._openUrl('https://blankon.id/donate');
        };
        donateItem.connect('button-press-event', () => {
            donateItem._activateCallback();
            return Clutter.EVENT_STOP;
        });
        menuBox.add_child(donateItem);
        navItems.push(donateItem);

        scrollView.add_child(menuBox);
        this._registerMenuItems(navItems, scrollView);
        this._animateSlide(scrollView, 'forward');
    }

    _launchApp(desktopId) {
        let appSystem = Shell.AppSystem.get_default();
        let app = appSystem.lookup_app(desktopId);
        if (app) {
            app.activate();
        }
    }

    _enterChatbotMode(initialMessage) {
        if (this._isChatbotMode) return;

        this._isChatbotMode = true;

        // Hide header search and bottom section
        if (this._header) {
            this._header.hide();
        }
        if (this._bottomSection) {
            this._bottomSection.hide();
        }

        // Clear the sliding container
        if (this._slidingContainer) {
            this._slidingContainer.destroy_all_children();
        }

        // Get available height for chatbot panel
        let monitor = Main.layoutManager.primaryMonitor;
        let panelHeight = Main.panel.height;
        let availableHeight = monitor.height - panelHeight - MARGIN_TOP - MARGIN_BOTTOM;

        // Create chatbot panel with calculated height
        this._chatbotPanel = new PrayaChatbotPanel(this._chatbotSettings, () => {
            this._exitChatbotMode();
        }, availableHeight);

        // Hide sliding container
        this._slidingContainer.hide();

        // Animate panel width from 325px to 400px with slow slide animation
        let chatbotAnimationDuration = 400;
        this._panel.ease({
            width: CHATBOT_PANEL_WIDTH,
            duration: chatbotAnimationDuration,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });

        // Update hover zone width
        if (this._hoverZone) {
            this._hoverZone.ease({
                width: CHATBOT_PANEL_WIDTH + MARGIN_LEFT * 2,
                duration: chatbotAnimationDuration,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }

        // Add chatbot panel directly to main panel (after header, which is hidden)
        this._chatbotPanel.set_width(CHATBOT_PANEL_WIDTH);
        this._panel.add_child(this._chatbotPanel);

        // Send initial message if provided
        if (initialMessage) {
            this._chatbotPanel.sendInitialMessage(initialMessage);
        } else {
            // Focus input
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (this._chatbotPanel) {
                    this._chatbotPanel.focusInput();
                }
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _restoreChatbotMode() {
        // Hide header and bottom section
        if (this._header) {
            this._header.hide();
        }
        if (this._bottomSection) {
            this._bottomSection.hide();
        }

        // Hide sliding container
        if (this._slidingContainer) {
            this._slidingContainer.hide();
        }

        // Get available height for chatbot panel
        let monitor = Main.layoutManager.primaryMonitor;
        let panelHeight = Main.panel.height;
        let availableHeight = monitor.height - panelHeight - MARGIN_TOP - MARGIN_BOTTOM;

        // Create chatbot panel with calculated height
        this._chatbotPanel = new PrayaChatbotPanel(this._chatbotSettings, () => {
            this._exitChatbotMode();
        }, availableHeight);

        // Set panel width immediately (no animation on restore)
        this._panel.width = CHATBOT_PANEL_WIDTH;
        if (this._hoverZone) {
            this._hoverZone.width = CHATBOT_PANEL_WIDTH + MARGIN_LEFT * 2;
        }

        // Add chatbot panel directly to main panel
        this._chatbotPanel.set_width(CHATBOT_PANEL_WIDTH);
        this._panel.add_child(this._chatbotPanel);

        // Restore previous messages
        if (this._chatbotMessages && this._chatbotMessages.length > 0) {
            this._chatbotPanel.restoreMessages(this._chatbotMessages);
        }
    }

    _exitChatbotMode() {
        if (!this._isChatbotMode) return;

        // Set flag to prevent panel from hiding during transition
        this._isTransitioningChatbot = true;

        this._isChatbotMode = false;
        this._chatbotMessages = []; // Clear saved messages

        // Destroy chatbot panel
        if (this._chatbotPanel) {
            this._chatbotPanel.destroy();
            this._chatbotPanel = null;
        }

        // Show header and bottom section
        if (this._header) {
            this._header.show();
        }
        if (this._bottomSection) {
            this._bottomSection.show();
        }

        // Get available height
        let monitor = Main.layoutManager.primaryMonitor;
        let panelHeight = Main.panel.height;
        let availableHeight = monitor.height - panelHeight - MARGIN_TOP - MARGIN_BOTTOM;

        // Animate panel width back to 325px
        this._panel.ease({
            width: PANEL_WIDTH,
            duration: ANIMATION_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        // Update hover zone width
        if (this._hoverZone) {
            this._hoverZone.ease({
                width: PANEL_WIDTH + MARGIN_LEFT * 2,
                duration: ANIMATION_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        // Show and reset sliding container
        this._slidingContainer.show();
        this._slidingContainer.set_size(PANEL_WIDTH, availableHeight - HEADER_HEIGHT - this._bottomSectionBaseHeight);

        // Show main menu (this will recreate the search entry)
        this._navigationStack = [];
        this._isSearchActive = false;
        this._showMainMenu(false);

        // Focus search entry and clear transition flag after transition
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._isTransitioningChatbot = false;
            if (this._searchEntry) {
                this._searchEntry.grab_key_focus();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._loadAppsTimeoutId) {
            GLib.source_remove(this._loadAppsTimeoutId);
            this._loadAppsTimeoutId = null;
        }
        if (this._installedChangedId && this._appSystem) {
            this._appSystem.disconnect(this._installedChangedId);
            this._installedChangedId = null;
        }
        this._hidePanel();
        super.destroy();
    }
});

export default class PrayaExtension extends Extension {
    enable() {
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

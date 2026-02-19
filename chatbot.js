/* chatbot.js
 *
 * Chatbot components for Praya extension
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';

import { _ } from './translations.js';
import {
    CHATBOT_SETTINGS_FILE,
    CHATBOT_PANEL_WIDTH,
    CHATBOT_HEADER_HEIGHT,
    CHATBOT_INPUT_HEIGHT,
    PROVIDERS
} from './constants.js';

// ChatbotSettings class for managing chatbot configuration
export class ChatbotSettings {
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
export class ChatbotAPI {
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

// PrayaChatbotPanel - Full chat interface
export const PrayaChatbotPanel = GObject.registerClass(
class PrayaChatbotPanel extends St.BoxLayout {
    _init(settings, onClose, panelHeight) {
        super._init({
            style_class: 'praya-chatbot-panel',
            vertical: true,
            x_expand: true,
            y_expand: false,
        });

        this._settings = settings;
        this._onClose = onClose;
        this._api = new ChatbotAPI(settings);
        this._messages = [];
        this._isWaiting = false;
        this._scrollTimeoutId = null;
        this._redrawTimerId = null;
        this._panelHeight = panelHeight || 600;

        // Set explicit height on the panel
        this.set_height(this._panelHeight);

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
            text: _('Artificial Intelligence'),
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

        // Message history scroll view
        this._scrollView = new St.ScrollView({
            style_class: 'praya-chatbot-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.ALWAYS,
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
        });

        // Create messages container - y_expand: false ensures it doesn't fill the viewport
        this._messagesBox = new St.BoxLayout({
            style_class: 'praya-chatbot-messages',
            vertical: true,
            x_expand: false,
            y_expand: false,
        });
        // Set fixed width so text labels can calculate wrapped height correctly
        this._messagesBox.set_width(CHATBOT_PANEL_WIDTH);

        // Use set_child() for proper StScrollable interface implementation
        this._scrollView.set_child(this._messagesBox);
        this.add_child(this._scrollView);

        // Periodic redraw to reduce scrolling artifacts
        this._redrawTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            if (this._scrollView) {
                this._scrollView.queue_redraw();
            }
            return GLib.SOURCE_CONTINUE;
        });


        // Input area with fixed height for 2-line textarea
        let inputArea = new St.BoxLayout({
            style_class: 'praya-chatbot-input-area',
            x_expand: true,
            height: CHATBOT_INPUT_HEIGHT,
        });

        this._inputEntry = new St.Entry({
            style_class: 'praya-chatbot-input',
            hint_text: _('Type a message... (Shift+Enter for new line)'),
            can_focus: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.START,
        });
        // Enable multi-line input
        this._inputEntry.clutter_text.set_single_line_mode(false);
        this._inputEntry.clutter_text.set_line_wrap(true);
        this._inputEntry.clutter_text.set_line_wrap_mode(2); // WORD_CHAR - wraps long words
        this._inputEntry.clutter_text.set_y_align(Clutter.ActorAlign.START);
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
            y_expand: false,
        });
        messageBox.set_width(maxWidth);

        // Parse markdown to Pango markup for styling
        let formattedContent = this._parseMarkdown(content);

        let messageLabel = new St.Label({
            style_class: 'praya-chatbot-message-text',
            y_expand: false,
        });
        // Use markup for styled text
        messageLabel.clutter_text.set_markup(formattedContent);
        messageLabel.clutter_text.set_line_wrap(true);
        messageLabel.clutter_text.set_line_wrap_mode(0); // WORD
        // Set width for proper line wrap height calculation (maxWidth minus padding)
        messageLabel.set_width(maxWidth - 28);
        // Allow text selection and copying
        messageLabel.clutter_text.set_selectable(true);
        messageLabel.clutter_text.set_reactive(true);
        messageBox.add_child(messageLabel);

        messageContainer.add_child(messageBox);
        this._messagesBox.add_child(messageContainer);

        // Force height calculation after layout
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (messageLabel && messageLabel.get_parent()) {
                // Get the natural height of the label and lock it
                let [, natHeight] = messageLabel.get_preferred_height(maxWidth - 28);
                if (natHeight > 0) {
                    messageLabel.set_height(natHeight);
                    // Also set container heights
                    let boxHeight = natHeight + 20; // padding
                    messageBox.set_height(boxHeight);
                    messageContainer.set_height(boxHeight);
                }
            }
            return GLib.SOURCE_REMOVE;
        });

        // Scroll to bottom after layout update
        this._scrollToBottom();
    }

    _scrollToBottom() {
        // Cancel any pending scroll operation
        if (this._scrollTimeoutId) {
            GLib.source_remove(this._scrollTimeoutId);
            this._scrollTimeoutId = null;
        }

        // Use idle_add to wait for layout completion, then scroll
        this._scrollTimeoutId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._scrollTimeoutId = null;

            if (!this._scrollView || !this._scrollView.vscroll) {
                return GLib.SOURCE_REMOVE;
            }

            let vscroll = this._scrollView.vscroll;
            let adjustment = vscroll.adjustment;

            // Validate adjustment values are ready
            if (adjustment.upper <= 0) {
                // Layout not ready, retry after a short delay
                this._scrollTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                    this._scrollTimeoutId = null;
                    this._scrollToBottom();
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            }

            let maxScroll = adjustment.upper - adjustment.page_size;
            if (maxScroll > 0) {
                // Animated scroll to bottom
                adjustment.ease(maxScroll, {
                    duration: 300,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        // Force redraw to reduce artifacts
                        if (this._scrollView) {
                            this._scrollView.queue_redraw();
                        }
                    },
                });
            }

            return GLib.SOURCE_REMOVE;
        });
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
            y_expand: false,
        });

        this._typingLabel = new St.Label({
            text: _('Thinking') + '.',
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
            this._typingLabel.set_text(`${_('Thinking')}${dots}`);
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

    destroy() {
        // Clean up timers
        if (this._redrawTimerId) {
            GLib.source_remove(this._redrawTimerId);
            this._redrawTimerId = null;
        }
        if (this._scrollTimeoutId) {
            GLib.source_remove(this._scrollTimeoutId);
            this._scrollTimeoutId = null;
        }
        if (this._typingAnimationId) {
            GLib.source_remove(this._typingAnimationId);
            this._typingAnimationId = null;
        }
        super.destroy();
    }
});

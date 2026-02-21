/* constants.js
 *
 * Shared constants for Praya extension
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import GLib from 'gi://GLib';

// Version
export const VERSION = '0.1.26';

// Panel dimensions
export const PANEL_WIDTH = 325;
export const HEADER_HEIGHT = 50;
export const ANIMATION_DURATION = 200;
export const MARGIN_LEFT = 8;
export const MARGIN_TOP = 8;
export const MARGIN_BOTTOM = 8;
export const MARGIN_BOTTOM_BAR = 16;

// Chatbot dimensions
export const CHATBOT_PANEL_WIDTH = 400;
export const CHATBOT_HEADER_HEIGHT = 60;
export const CHATBOT_INPUT_HEIGHT = 80;

// File paths
export const FAVOURITES_FILE = GLib.build_filenamev([GLib.get_user_config_dir(), 'praya', 'favourites.json']);
export const CHATBOT_SETTINGS_FILE = GLib.build_filenamev([GLib.get_user_config_dir(), 'praya', 'chatbot.json']);

// AI Providers configuration
export const PROVIDERS = {
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

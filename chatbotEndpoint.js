/* chatbotEndpoint.js
 *
 * Pure helpers for the AI chatbot: the provider table, endpoint and model
 * resolution, and the request/response formats of the two supported
 * protocols (OpenAI Chat Completions and Anthropic Messages).
 *
 * This module deliberately has no `gi://…` imports so its logic can be
 * unit tested with plain Node. chatbot.js does the actual HTTP calls with
 * libsoup. The provider keys and protocols must stay in sync with PROVIDERS
 * in praya-preferences.py (see test_praya_preferences.py).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

export const PROTOCOL_OPENAI = 'openai';
export const PROTOCOL_ANTHROPIC = 'anthropic';

export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_MAX_TOKENS = 1024;

// Built-in providers have a fixed endpoint and model list. Custom providers
// talk to a user-supplied base URL and model, stored per provider under
// `customEndpoints` in chatbot.json.
export const PROVIDERS = {
    anthropic: {
        name: 'Anthropic',
        protocol: 'anthropic',
        models: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-3-5-haiku-20241022'],
        endpoint: 'https://api.anthropic.com/v1/messages'
    },
    openai: {
        name: 'ChatGPT',
        protocol: 'openai',
        models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
        endpoint: 'https://api.openai.com/v1/chat/completions'
    },
    deepseek: {
        name: 'DeepSeek',
        protocol: 'openai',
        models: ['deepseek-flash', 'deepseek-v4-pro'],
        endpoint: 'https://api.deepseek.com/chat/completions'
    },
    'openai-compatible': {
        name: 'OpenAI-compatible (custom)',
        protocol: 'openai',
        custom: true
    },
    'anthropic-compatible': {
        name: 'Anthropic-compatible (custom)',
        protocol: 'anthropic',
        custom: true
    }
};

/**
 * @param {string} provider - provider key
 * @returns {boolean} whether the provider uses a user-supplied endpoint
 */
export function isCustomProvider(provider) {
    return !!PROVIDERS[provider]?.custom;
}

/**
 * Turn a user-supplied base URL into the full request URL for a protocol.
 *
 * Follows the convention of the official SDKs: an OpenAI base URL includes
 * the version (`…/v1`) and gets `/chat/completions` appended; an Anthropic
 * base URL may or may not include `/v1` and gets `/messages` or
 * `/v1/messages` appended. A URL that already ends with the full path is
 * kept as-is.
 *
 * @param {string} protocol - PROTOCOL_OPENAI or PROTOCOL_ANTHROPIC
 * @param {string} baseUrl - the URL entered by the user
 * @returns {string|null} the request URL, or null if the URL is not usable
 */
export function normalizeBaseUrl(protocol, baseUrl) {
    let url = String(baseUrl || '').trim();
    if (!/^https?:\/\/[^/\s?#]+/i.test(url) || /\s/.test(url))
        return null;

    url = url.replace(/\/+$/, '');

    if (protocol === PROTOCOL_OPENAI) {
        if (/\/chat\/completions$/.test(url))
            return url;
        return `${url}/chat/completions`;
    }

    if (protocol === PROTOCOL_ANTHROPIC) {
        if (/\/messages$/.test(url))
            return url;
        if (/\/v1$/.test(url))
            return `${url}/messages`;
        return `${url}/v1/messages`;
    }

    return null;
}

/**
 * @param {object} settings - parsed chatbot.json
 * @param {string} provider - provider key
 * @returns {{baseUrl: string, model: string}} the custom endpoint config
 */
export function customEndpointConfig(settings, provider) {
    let all = settings?.customEndpoints;
    let entry = all && typeof all === 'object' ? all[provider] : null;
    if (!entry || typeof entry !== 'object')
        entry = {};
    return {
        baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl.trim() : '',
        model: typeof entry.model === 'string' ? entry.model.trim() : '',
    };
}

/**
 * API keys are stored per provider. Built-in providers fall back to the
 * legacy single top-level `apiKey` so configs written by older versions keep
 * working; custom providers never do, since that key belonged to a built-in
 * provider.
 *
 * @param {object} settings - parsed chatbot.json
 * @param {string} provider - provider key
 * @returns {string} the API key, or '' if none
 */
export function resolveApiKey(settings, provider) {
    let apiKeys = settings?.apiKeys;
    if (apiKeys && typeof apiKeys === 'object' &&
        Object.prototype.hasOwnProperty.call(apiKeys, provider))
        return String(apiKeys[provider] || '');
    if (isCustomProvider(provider))
        return '';
    return String(settings?.apiKey || '');
}

/**
 * @param {object} settings - parsed chatbot.json
 * @param {string} provider - provider key
 * @returns {string} the model to request
 */
export function resolveModel(settings, provider) {
    if (isCustomProvider(provider))
        return customEndpointConfig(settings, provider).model;
    return String(settings?.model || '');
}

/**
 * @param {object} settings - parsed chatbot.json
 * @param {string} provider - provider key
 * @returns {string|null} the request URL, or null if it cannot be resolved
 */
export function resolveEndpoint(settings, provider) {
    let config = PROVIDERS[provider];
    if (!config)
        return null;
    if (config.custom) {
        return normalizeBaseUrl(config.protocol,
            customEndpointConfig(settings, provider).baseUrl);
    }
    return config.endpoint;
}

/**
 * A built-in provider needs an API key. A custom provider needs a usable
 * base URL and a model; its API key is optional because local servers
 * usually do not ask for one.
 *
 * @param {object} settings - parsed chatbot.json
 * @param {string} provider - provider key
 * @returns {boolean} whether the chatbot can send requests
 */
export function isConfigured(settings, provider) {
    if (!PROVIDERS[provider])
        return false;
    if (isCustomProvider(provider)) {
        return resolveEndpoint(settings, provider) !== null &&
            resolveModel(settings, provider).length > 0;
    }
    return resolveApiKey(settings, provider).length > 0;
}

/**
 * Build the headers and JSON body of a chat request. The auth header is
 * omitted when the API key is empty. Content-Type is left to the caller,
 * which sets it together with the body.
 *
 * @param {string} protocol - PROTOCOL_OPENAI or PROTOCOL_ANTHROPIC
 * @param {string} model - model name
 * @param {string} apiKey - API key, may be empty
 * @param {{role: string, content: string, error?: boolean}[]} messages -
 *     chat history; entries marked `error` are local error bubbles and are
 *     left out
 * @returns {{headers: string[][], body: string}} the request parts
 */
export function buildRequest(protocol, model, apiKey, messages) {
    let history = (messages || []).filter(m => !m.error).map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
    }));
    let headers = [];

    if (protocol === PROTOCOL_ANTHROPIC) {
        headers.push(['anthropic-version', ANTHROPIC_VERSION]);
        if (apiKey)
            headers.push(['x-api-key', apiKey]);
        return {
            headers,
            body: JSON.stringify({
                model,
                max_tokens: ANTHROPIC_MAX_TOKENS,
                messages: history,
            }),
        };
    }

    if (apiKey)
        headers.push(['Authorization', `Bearer ${apiKey}`]);
    return {
        headers,
        body: JSON.stringify({
            model,
            stream: false,
            messages: history,
        }),
    };
}

function errorMessage(data) {
    if (!data || typeof data !== 'object')
        return '';
    if (typeof data.error === 'string')
        return data.error;
    if (typeof data.error?.message === 'string')
        return data.error.message;
    if (typeof data.message === 'string')
        return data.message;
    if (typeof data.detail === 'string')
        return data.detail;
    return '';
}

/**
 * Extract the reply from a chat response. Compatible servers vary, so this
 * tolerates non-JSON bodies (for example an HTML error page from a proxy)
 * and both string and object error shapes.
 *
 * @param {string} protocol - PROTOCOL_OPENAI or PROTOCOL_ANTHROPIC
 * @param {number} status - HTTP status code
 * @param {string} text - response body
 * @returns {{content: string|null, error: string|null}} the reply or error
 */
export function parseResponse(protocol, status, text) {
    let data = null;
    try {
        data = JSON.parse(text);
    } catch (e) {
        data = null;
    }

    if (status < 200 || status >= 300)
        return {content: null, error: errorMessage(data) || `HTTP ${status}`};

    if (data === null || typeof data !== 'object')
        return {content: null, error: 'Invalid response from server'};

    let message = errorMessage(data);
    if (message && data.error)
        return {content: null, error: message};

    let content = '';
    if (protocol === PROTOCOL_ANTHROPIC) {
        // Join the text blocks; compatible servers may put other block
        // types (such as thinking) before the text.
        if (Array.isArray(data.content)) {
            content = data.content
                .filter(block => block?.type === 'text' && typeof block.text === 'string')
                .map(block => block.text)
                .join('');
        }
    } else {
        let value = data.choices?.[0]?.message?.content;
        if (typeof value === 'string')
            content = value;
    }

    if (!content)
        return {content: null, error: 'Empty response from server'};
    return {content, error: null};
}

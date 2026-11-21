/* chatbotEndpoint.test.js
 *
 * Unit tests for the pure chatbot endpoint helpers. Run with:
 *
 *     node --test
 *     make test
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    PROVIDERS,
    PROTOCOL_OPENAI,
    PROTOCOL_ANTHROPIC,
    ANTHROPIC_VERSION,
    isCustomProvider,
    normalizeBaseUrl,
    customEndpointConfig,
    resolveApiKey,
    resolveModel,
    resolveEndpoint,
    isConfigured,
    buildRequest,
    parseResponse,
} from './chatbotEndpoint.js';

const header = (headers, name) => {
    let found = headers.find(([n]) => n.toLowerCase() === name.toLowerCase());
    return found ? found[1] : undefined;
};

test('every provider has a known protocol', () => {
    for (let [key, config] of Object.entries(PROVIDERS)) {
        assert.ok([PROTOCOL_OPENAI, PROTOCOL_ANTHROPIC].includes(config.protocol), key);
        if (config.custom)
            assert.equal(config.endpoint, undefined, key);
        else
            assert.match(config.endpoint, /^https:\/\//, key);
    }
});

test('custom providers exist for both protocols', () => {
    assert.ok(isCustomProvider('openai-compatible'));
    assert.ok(isCustomProvider('anthropic-compatible'));
    assert.equal(PROVIDERS['openai-compatible'].protocol, PROTOCOL_OPENAI);
    assert.equal(PROVIDERS['anthropic-compatible'].protocol, PROTOCOL_ANTHROPIC);
    assert.ok(!isCustomProvider('anthropic'));
    assert.ok(!isCustomProvider('nope'));
});

test('normalizeBaseUrl appends the OpenAI path', () => {
    assert.equal(normalizeBaseUrl(PROTOCOL_OPENAI, 'http://localhost:8080/v1'),
        'http://localhost:8080/v1/chat/completions');
    assert.equal(normalizeBaseUrl(PROTOCOL_OPENAI, 'http://localhost:8080/v1/'),
        'http://localhost:8080/v1/chat/completions');
    assert.equal(normalizeBaseUrl(PROTOCOL_OPENAI, '  https://api.example.com/v1//  '),
        'https://api.example.com/v1/chat/completions');
    assert.equal(normalizeBaseUrl(PROTOCOL_OPENAI, 'https://api.example.com/v1/chat/completions'),
        'https://api.example.com/v1/chat/completions');
});

test('normalizeBaseUrl appends the Anthropic path', () => {
    assert.equal(normalizeBaseUrl(PROTOCOL_ANTHROPIC, 'https://api.example.com/anthropic'),
        'https://api.example.com/anthropic/v1/messages');
    assert.equal(normalizeBaseUrl(PROTOCOL_ANTHROPIC, 'https://api.example.com/v1/'),
        'https://api.example.com/v1/messages');
    assert.equal(normalizeBaseUrl(PROTOCOL_ANTHROPIC, 'https://api.example.com/v1/messages'),
        'https://api.example.com/v1/messages');
});

test('normalizeBaseUrl rejects unusable URLs', () => {
    for (let url of ['', '   ', null, undefined, 'localhost:8080/v1', 'ftp://example.com',
        'file:///etc/passwd', 'http://', 'http:// example.com', 'https://exa mple.com/v1'])
        assert.equal(normalizeBaseUrl(PROTOCOL_OPENAI, url), null, String(url));
    assert.equal(normalizeBaseUrl('unknown', 'https://api.example.com/v1'), null);
});

test('customEndpointConfig tolerates missing or corrupt data', () => {
    assert.deepEqual(customEndpointConfig({}, 'openai-compatible'), {baseUrl: '', model: ''});
    assert.deepEqual(customEndpointConfig({customEndpoints: 'nope'}, 'openai-compatible'),
        {baseUrl: '', model: ''});
    assert.deepEqual(customEndpointConfig({customEndpoints: {'openai-compatible': 5}}, 'openai-compatible'),
        {baseUrl: '', model: ''});
    assert.deepEqual(customEndpointConfig({customEndpoints: {'openai-compatible':
        {baseUrl: ' http://localhost:8080/v1 ', model: ' m '}}}, 'openai-compatible'),
    {baseUrl: 'http://localhost:8080/v1', model: 'm'});
});

test('resolveApiKey keeps the legacy fallback for built-in providers only', () => {
    let legacy = {provider: 'openai', apiKey: 'sk-legacy'};
    assert.equal(resolveApiKey(legacy, 'openai'), 'sk-legacy');
    assert.equal(resolveApiKey(legacy, 'openai-compatible'), '');

    let perProvider = {apiKeys: {openai: 'sk-oai', 'openai-compatible': 'sk-custom'}, apiKey: 'sk-legacy'};
    assert.equal(resolveApiKey(perProvider, 'openai'), 'sk-oai');
    assert.equal(resolveApiKey(perProvider, 'openai-compatible'), 'sk-custom');
    assert.equal(resolveApiKey(perProvider, 'anthropic'), 'sk-legacy');
});

test('resolveModel and resolveEndpoint for built-in and custom providers', () => {
    let settings = {
        model: 'gpt-4o',
        customEndpoints: {
            'openai-compatible': {baseUrl: 'http://localhost:8080/v1', model: 'local-model'},
        },
    };
    assert.equal(resolveModel(settings, 'openai'), 'gpt-4o');
    assert.equal(resolveModel(settings, 'openai-compatible'), 'local-model');
    assert.equal(resolveModel(settings, 'anthropic-compatible'), '');

    assert.equal(resolveEndpoint(settings, 'openai'), PROVIDERS.openai.endpoint);
    assert.equal(resolveEndpoint(settings, 'openai-compatible'),
        'http://localhost:8080/v1/chat/completions');
    assert.equal(resolveEndpoint(settings, 'anthropic-compatible'), null);
    assert.equal(resolveEndpoint(settings, 'nope'), null);
});

test('isConfigured needs a key for built-in providers', () => {
    assert.ok(!isConfigured({apiKeys: {}}, 'anthropic'));
    assert.ok(isConfigured({apiKeys: {anthropic: 'sk-ant'}}, 'anthropic'));
    assert.ok(isConfigured({apiKey: 'sk-legacy'}, 'anthropic'));
    assert.ok(!isConfigured({apiKeys: {nope: 'x'}}, 'nope'));
});

test('isConfigured needs a URL and model, not a key, for custom providers', () => {
    let endpoint = {baseUrl: 'http://localhost:8080/v1', model: 'local-model'};
    assert.ok(isConfigured({customEndpoints: {'openai-compatible': endpoint}}, 'openai-compatible'));
    assert.ok(!isConfigured({customEndpoints: {'openai-compatible': {...endpoint, model: ' '}}},
        'openai-compatible'));
    assert.ok(!isConfigured({customEndpoints: {'openai-compatible': {...endpoint, baseUrl: 'nope'}}},
        'openai-compatible'));
    assert.ok(!isConfigured({apiKey: 'sk-legacy'}, 'anthropic-compatible'));
});

test('buildRequest uses the Anthropic format', () => {
    let messages = [{role: 'user', content: 'hi'}, {role: 'assistant', content: 'hello'}];
    let {headers, body} = buildRequest(PROTOCOL_ANTHROPIC, 'm', 'sk-ant', messages);
    assert.equal(header(headers, 'x-api-key'), 'sk-ant');
    assert.equal(header(headers, 'anthropic-version'), ANTHROPIC_VERSION);
    assert.equal(header(headers, 'authorization'), undefined);
    let parsed = JSON.parse(body);
    assert.equal(parsed.model, 'm');
    assert.equal(typeof parsed.max_tokens, 'number');
    assert.deepEqual(parsed.messages, messages);
});

test('buildRequest uses the OpenAI format', () => {
    let messages = [{role: 'user', content: 'hi'}];
    let {headers, body} = buildRequest(PROTOCOL_OPENAI, 'm', 'sk-oai', messages);
    assert.equal(header(headers, 'authorization'), 'Bearer sk-oai');
    assert.equal(header(headers, 'x-api-key'), undefined);
    let parsed = JSON.parse(body);
    assert.equal(parsed.model, 'm');
    assert.equal(parsed.stream, false);
    assert.deepEqual(parsed.messages, messages);
});

test('buildRequest omits the auth header without a key', () => {
    for (let protocol of [PROTOCOL_OPENAI, PROTOCOL_ANTHROPIC]) {
        let {headers} = buildRequest(protocol, 'm', '', []);
        assert.equal(header(headers, 'authorization'), undefined, protocol);
        assert.equal(header(headers, 'x-api-key'), undefined, protocol);
    }
});

test('parseResponse reads successful replies', () => {
    assert.deepEqual(parseResponse(PROTOCOL_OPENAI, 200,
        JSON.stringify({choices: [{message: {role: 'assistant', content: 'hi'}}]})),
    {content: 'hi', error: null});
    assert.deepEqual(parseResponse(PROTOCOL_ANTHROPIC, 200,
        JSON.stringify({content: [{type: 'thinking', thinking: '…'}, {type: 'text', text: 'hi'},
            {type: 'text', text: ' there'}]})),
    {content: 'hi there', error: null});
});

test('parseResponse reports error bodies', () => {
    assert.deepEqual(parseResponse(PROTOCOL_ANTHROPIC, 401,
        JSON.stringify({type: 'error', error: {type: 'authentication_error', message: 'invalid x-api-key'}})),
    {content: null, error: 'invalid x-api-key'});
    assert.deepEqual(parseResponse(PROTOCOL_OPENAI, 404, JSON.stringify({error: 'model not found'})),
        {content: null, error: 'model not found'});
    assert.deepEqual(parseResponse(PROTOCOL_OPENAI, 422, JSON.stringify({detail: 'bad request'})),
        {content: null, error: 'bad request'});
    assert.deepEqual(parseResponse(PROTOCOL_OPENAI, 200, JSON.stringify({error: {message: 'overloaded'}})),
        {content: null, error: 'overloaded'});
});

test('parseResponse survives non-JSON and empty bodies', () => {
    assert.deepEqual(parseResponse(PROTOCOL_OPENAI, 502, '<html><body>Bad Gateway</body></html>'),
        {content: null, error: 'HTTP 502'});
    assert.deepEqual(parseResponse(PROTOCOL_OPENAI, 200, '<html></html>'),
        {content: null, error: 'Invalid response from server'});
    assert.deepEqual(parseResponse(PROTOCOL_OPENAI, 200, JSON.stringify({choices: []})),
        {content: null, error: 'Empty response from server'});
    assert.deepEqual(parseResponse(PROTOCOL_ANTHROPIC, 200, JSON.stringify({content: []})),
        {content: null, error: 'Empty response from server'});
});

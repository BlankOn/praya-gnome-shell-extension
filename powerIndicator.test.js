/* powerIndicator.test.js
 *
 * Unit tests for the pure power indicator helpers. Run with:
 *
 *     node --test
 *     make test
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    POWER_INDICATOR_RETRY_MS,
    POWER_INDICATOR_MAX_RETRIES,
    findPowerIndicator,
    applyPowerIndicatorVisibility,
} from './powerIndicator.js';

function makeSystemIndicator({hasBattery = true, withToggle = true, withIcon = true} = {}) {
    return {
        _systemItem: withToggle
            ? {powerToggle: {visible: hasBattery}}
            : undefined,
        _indicator: withIcon ? {visible: true} : undefined,
    };
}

test('findPowerIndicator reads the GNOME 50/51 system indicator', () => {
    const quickSettings = {_system: makeSystemIndicator()};
    const result = findPowerIndicator(quickSettings);

    assert.equal(result.powerToggle, quickSettings._system._systemItem.powerToggle);
    assert.equal(result.icon, quickSettings._system._indicator);
});

test('findPowerIndicator falls back to the older _power indicator', () => {
    const quickSettings = {_power: makeSystemIndicator()};
    const result = findPowerIndicator(quickSettings);

    assert.equal(result.powerToggle, quickSettings._power._systemItem.powerToggle);
    assert.equal(result.icon, quickSettings._power._indicator);
});

test('findPowerIndicator prefers _system when both layouts exist', () => {
    const quickSettings = {
        _system: makeSystemIndicator(),
        _power: makeSystemIndicator(),
    };
    const result = findPowerIndicator(quickSettings);

    assert.equal(result.icon, quickSettings._system._indicator);
});

test('findPowerIndicator tolerates missing quick settings', () => {
    assert.equal(findPowerIndicator(undefined), null);
    assert.equal(findPowerIndicator(null), null);
    assert.equal(findPowerIndicator({}), null);
});

test('findPowerIndicator rejects incomplete indicators', () => {
    assert.equal(findPowerIndicator({_system: makeSystemIndicator({withToggle: false})}), null);
    assert.equal(findPowerIndicator({_system: makeSystemIndicator({withIcon: false})}), null);
});

test('applyPowerIndicatorVisibility hides the icon when there is no battery', () => {
    const powerToggle = {visible: false};
    const icon = {visible: true};

    assert.equal(applyPowerIndicatorVisibility(powerToggle, icon), true);
    assert.equal(icon.visible, false);
});

test('applyPowerIndicatorVisibility keeps the icon when a battery is present', () => {
    const powerToggle = {visible: true};
    const icon = {visible: false};

    assert.equal(applyPowerIndicatorVisibility(powerToggle, icon), true);
    assert.equal(icon.visible, true);
});

test('applyPowerIndicatorVisibility coerces the toggle state to a boolean', () => {
    const icon = {visible: true};

    applyPowerIndicatorVisibility({visible: 1}, icon);
    assert.equal(icon.visible, true);

    applyPowerIndicatorVisibility({visible: 0}, icon);
    assert.equal(icon.visible, false);
});

test('applyPowerIndicatorVisibility tolerates missing widgets', () => {
    assert.equal(applyPowerIndicatorVisibility(undefined, {visible: true}), false);
    assert.equal(applyPowerIndicatorVisibility({visible: true}, undefined), false);
});

test('the power indicator retry policy is bounded', () => {
    assert.ok(POWER_INDICATOR_RETRY_MS > 0);
    assert.ok(POWER_INDICATOR_MAX_RETRIES > 0);
});

/* powerIndicator.js
 *
 * Pure helpers for hiding GNOME Shell's power/battery indicator on machines
 * without a battery.
 *
 * This module deliberately has no `gi://…` imports so its logic can be unit
 * tested with plain Node. The GNOME Shell-side code in extension.js imports
 * these helpers and connects them to the live widgets.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

// GNOME Shell sets up the quick settings indicators asynchronously, so the
// system indicator may not exist yet when the extension starts.
export const POWER_INDICATOR_RETRY_MS = 500;
export const POWER_INDICATOR_MAX_RETRIES = 10;

// Locate the panel icon and the quick settings toggle that tells us whether
// the machine actually has a battery or UPS.
//
// GNOME 50/51 expose the system indicator as `_system`; older releases used
// `_power`. The private fields are guarded so a future Shell layout change
// simply disables the workaround instead of throwing.
export function findPowerIndicator(quickSettings) {
    let systemIndicator = quickSettings?._system ?? quickSettings?._power;
    let powerToggle = systemIndicator?._systemItem?.powerToggle;
    let icon = systemIndicator?._indicator;

    if (!powerToggle || !icon)
        return null;

    return {powerToggle, icon};
}

// Copy the battery presence state onto the panel icon. GNOME creates the icon
// visible even when there is no battery (it falls back to a power symbol), so
// this is what actually hides it on desktops while leaving it on laptops.
export function applyPowerIndicatorVisibility(powerToggle, icon) {
    if (!powerToggle || !icon)
        return false;

    icon.visible = Boolean(powerToggle.visible);
    return true;
}

export default {
    POWER_INDICATOR_RETRY_MS,
    POWER_INDICATOR_MAX_RETRIES,
    findPowerIndicator,
    applyPowerIndicatorVisibility,
};

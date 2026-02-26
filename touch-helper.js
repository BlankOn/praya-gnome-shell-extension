/* touch-helper.js
 *
 * Shared utility for connecting click and touch handlers.
 * Provides touchscreen support by routing both button-press-event
 * and touch-event (TOUCH_BEGIN) through a unified handler with
 * a debounce guard to prevent double-fire when compositors
 * synthesize pointer events from touch input.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

/**
 * Connect click and touch handlers to an actor.
 *
 * @param {Clutter.Actor} actor - The actor to connect handlers to
 * @param {Function} callback - Left-click / touch-tap handler: (actor, event) => result
 * @param {Object} [options] - Optional additional handlers
 * @param {Function} [options.onRightClick] - Button 3 handler: (actor, event) => result
 * @param {Function} [options.onMiddleClick] - Button 2 handler: (actor, event) => result
 * @returns {number[]} Array of signal handler IDs
 */
export function connectClickHandler(actor, callback, options = {}) {
    let lastTouchTime = 0;
    const DEBOUNCE_MS = 100;

    let ids = [];

    ids.push(actor.connect('button-press-event', (act, event) => {
        let now = GLib.get_monotonic_time() / 1000;
        if (now - lastTouchTime < DEBOUNCE_MS) {
            return Clutter.EVENT_STOP;
        }

        let button = event.get_button();
        if (button === 1) {
            let result = callback(act, event);
            return result !== undefined ? result : Clutter.EVENT_STOP;
        } else if (button === 3 && options.onRightClick) {
            let result = options.onRightClick(act, event);
            return result !== undefined ? result : Clutter.EVENT_STOP;
        } else if (button === 2 && options.onMiddleClick) {
            let result = options.onMiddleClick(act, event);
            return result !== undefined ? result : Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }));

    ids.push(actor.connect('touch-event', (act, event) => {
        if (event.type() !== Clutter.EventType.TOUCH_BEGIN) {
            return Clutter.EVENT_PROPAGATE;
        }

        lastTouchTime = GLib.get_monotonic_time() / 1000;
        let result = callback(act, event);
        return result !== undefined ? result : Clutter.EVENT_STOP;
    }));

    return ids;
}

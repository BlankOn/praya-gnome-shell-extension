/* touch-helper.js
 *
 * Shared utility for connecting click and touch handlers.
 * Provides touchscreen support by routing both button-press-event
 * and touch-event (a tap, fired on TOUCH_END) through a unified handler with
 * a debounce guard to prevent double-fire when compositors
 * synthesize pointer events from touch input, and adds touchscreen
 * drag-to-scroll for St.ScrollView.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

const DRAG_THRESHOLD = 10;
const MOMENTUM_MIN_VELOCITY = 0.3; // px per ms
const MOMENTUM_DURATION = 600;

function _dragThreshold() {
    return DRAG_THRESHOLD * St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

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

    // A touch only counts as a tap if it lifts without travelling: firing on
    // TOUCH_BEGIN would turn every attempt to drag a scroll view into a click.
    let touchStart = null;

    ids.push(actor.connect('touch-event', (act, event) => {
        let type = event.type();
        lastTouchTime = GLib.get_monotonic_time() / 1000;

        if (type === Clutter.EventType.TOUCH_BEGIN) {
            touchStart = event.get_coords();
            return Clutter.EVENT_STOP;
        }

        if (!touchStart)
            return Clutter.EVENT_PROPAGATE;

        if (type === Clutter.EventType.TOUCH_UPDATE) {
            let [x, y] = event.get_coords();
            if (Math.abs(x - touchStart[0]) > _dragThreshold() ||
                Math.abs(y - touchStart[1]) > _dragThreshold())
                touchStart = null;
            return Clutter.EVENT_STOP;
        }

        if (type === Clutter.EventType.TOUCH_END) {
            touchStart = null;
            let result = callback(act, event);
            return result !== undefined ? result : Clutter.EVENT_STOP;
        }

        // TOUCH_CANCEL
        touchStart = null;
        return Clutter.EVENT_PROPAGATE;
    }));

    return ids;
}

/**
 * Let a scroll view be scrolled by dragging it on a touchscreen.
 *
 * Runs in the capture phase so it sees the touch before the item under the
 * finger. Once the finger travels past the drag threshold the rest of the
 * sequence is swallowed, so the item never receives TOUCH_END and no click
 * fires. Lifting a fast drag carries on with a short momentum scroll.
 *
 * @param {St.ScrollView} scrollView - The scroll view to make draggable
 * @param {Object} [options]
 * @param {boolean} [options.horizontal=false] - Drag along the x axis
 * @returns {number} Signal handler ID
 */
export function enableTouchScroll(scrollView, options = {}) {
    const horizontal = options.horizontal ?? false;
    let drag = null;

    const adjustment = () => horizontal
        ? scrollView.hadjustment
        : scrollView.vadjustment;
    const position = event => {
        let [x, y] = event.get_coords();
        return horizontal ? x : y;
    };

    return scrollView.connect('captured-event', (actor, event) => {
        let type = event.type();

        if (type === Clutter.EventType.TOUCH_BEGIN) {
            // Only the first finger drives the scroll
            if (drag)
                return Clutter.EVENT_PROPAGATE;

            let adj = adjustment();
            // Touching the list stops a momentum scroll in progress
            adj.remove_transition('value');
            let pos = position(event);
            drag = {
                startPos: pos,
                startValue: adj.value,
                dragging: false,
                lastPos: pos,
                lastTime: event.get_time(),
                velocity: 0,
            };
            return Clutter.EVENT_PROPAGATE;
        }

        if (!drag)
            return Clutter.EVENT_PROPAGATE;

        if (type === Clutter.EventType.TOUCH_UPDATE) {
            let pos = position(event);
            if (!drag.dragging) {
                if (Math.abs(pos - drag.startPos) <= _dragThreshold())
                    return Clutter.EVENT_PROPAGATE;
                drag.dragging = true;
                // Start from here so the content does not jump by the threshold
                drag.startPos = pos;
            }

            let time = event.get_time();
            let dt = time - drag.lastTime;
            if (dt > 0)
                drag.velocity = (pos - drag.lastPos) / dt;
            drag.lastPos = pos;
            drag.lastTime = time;

            adjustment().value = drag.startValue - (pos - drag.startPos);
            return Clutter.EVENT_STOP;
        }

        if (type === Clutter.EventType.TOUCH_END ||
            type === Clutter.EventType.TOUCH_CANCEL) {
            let wasDragging = drag.dragging;
            let velocity = drag.velocity;
            // A finger that rested before lifting should not fling
            let idle = event.get_time() - drag.lastTime;
            drag = null;

            if (!wasDragging)
                return Clutter.EVENT_PROPAGATE;

            if (type === Clutter.EventType.TOUCH_END && idle < 100 &&
                Math.abs(velocity) > MOMENTUM_MIN_VELOCITY) {
                let adj = adjustment();
                let target = adj.value - velocity * MOMENTUM_DURATION / 2;
                target = Math.max(adj.lower,
                    Math.min(target, adj.upper - adj.page_size));
                adj.ease(target, {
                    duration: MOMENTUM_DURATION,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    });
}

/* taskbar.js
 *
 * Taskbar component for Praya extension
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { connectClickHandler } from './touch-helper.js';
import { _ } from './translations.js';

// Applications with more windows than this are collapsed into a single
// grouped taskbar button
const GROUP_THRESHOLD = 2;

// Pixels scrolled per mouse wheel click
const SCROLL_STEP = 60;

// Breathing room left between the taskbar and the other panel items
const WIDTH_SLACK = 24;

// The taskbar never shrinks below this, even on a crowded panel
const MIN_WIDTH = 120;

// How far an arrow button scrolls, as a fraction of the visible width
const ARROW_SCROLL_FRACTION = 0.8;

// Duration of the arrow button's scroll animation
const ARROW_SCROLL_DURATION = 200;

export const PrayaTaskbar = GObject.registerClass(
class PrayaTaskbar extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'praya-taskbar',
            reactive: true,
            track_hover: true,
            x_expand: false,
        });

        // Scroll arrows, shown only when there is something to scroll to
        this._leftArrow = this._createArrow('pan-start-symbolic', -1);
        this.add_child(this._leftArrow);

        // Scrollable so a long list of windows never grows over the calendar
        // and quick settings on the right side of the panel. The buttons that
        // run past either edge fade out (-st-hfade-offset in the stylesheet).
        this._scrollView = new St.ScrollView({
            style_class: 'praya-taskbar-scroll',
            hscrollbar_policy: St.PolicyType.EXTERNAL,
            vscrollbar_policy: St.PolicyType.NEVER,
            reactive: true,
            track_hover: true,
            x_expand: true,
            clip_to_allocation: true,
        });
        this.add_child(this._scrollView);

        this._rightArrow = this._createArrow('pan-end-symbolic', 1);
        this.add_child(this._rightArrow);

        this._box = new St.BoxLayout({
            style_class: 'praya-taskbar-box',
            reactive: true,
            track_hover: true,
            x_expand: true,
        });
        this._scrollView.set_child(this._box);

        this._maxWidth = -1;
        this._scrollLaterId = 0;

        // Keep the arrows in sync with the scroll position
        let adjustment = this._getHAdjustment();
        this._adjustmentSignals = [];
        if (adjustment) {
            for (let signal of ['changed', 'notify::value']) {
                this._adjustmentSignals.push({
                    object: adjustment,
                    id: adjustment.connect(signal, () => this._updateArrows()),
                });
            }
        }

        this._windowTracker = Shell.WindowTracker.get_default();
        this._appSystem = Shell.AppSystem.get_default();
        this._hoverActivate = this._loadHoverActivate();

        // Track window signals
        this._windowSignals = [];
        this._workspaceSignals = [];
        this._titleSignals = [];
        this._clickCooldowns = new Map();

        // Right-click context menu
        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this._contextMenu = null;
        this._updatePending = false;

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

        // Recompute the available width when the panel or its contents change
        this._panelSignals = [];
        this._panelSignals.push({
            object: Main.panel,
            id: Main.panel.connect('notify::width', () => this._updateMaxWidth()),
        });
        for (let box of [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox]) {
            if (!box) {
                continue;
            }
            this._panelSignals.push({
                object: box,
                id: box.connect('child-added', () => this._updateMaxWidth()),
            });
            this._panelSignals.push({
                object: box,
                id: box.connect('child-removed', () => this._updateMaxWidth()),
            });
        }
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._updateMaxWidth();
        });

        // Mouse wheel scrolls the taskbar horizontally
        this._scrollView.connect('scroll-event', (actor, event) => this._onScroll(event));

        // Initial update with delay to ensure windows are loaded
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._updateTaskbar();
            return GLib.SOURCE_REMOVE;
        });
    }

    _getHAdjustment() {
        let view = this._scrollView;
        if (view.get_hadjustment) {
            return view.get_hadjustment();
        }
        return view.hscroll ? view.hscroll.adjustment : null;
    }

    _createArrow(iconName, direction) {
        let arrow = new St.Button({
            style_class: 'praya-taskbar-arrow',
            child: new St.Icon({
                icon_name: iconName,
                icon_size: 12,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });

        arrow.connect('clicked', () => this._scrollBy(direction));
        return arrow;
    }

    // Scroll one screenful in the given direction (-1 left, 1 right)
    _scrollBy(direction) {
        let adjustment = this._getHAdjustment();
        if (!adjustment || adjustment.page_size <= 0) {
            return;
        }

        let max = Math.max(0, adjustment.upper - adjustment.page_size);
        let step = adjustment.page_size * ARROW_SCROLL_FRACTION;
        let target = Math.min(max, Math.max(0, adjustment.value + direction * step));
        adjustment.ease(target, {
            duration: ARROW_SCROLL_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    // An arrow is shown only while there is hidden content on that side
    _updateArrows() {
        let adjustment = this._getHAdjustment();
        if (!adjustment) {
            return;
        }

        let max = Math.max(0, adjustment.upper - adjustment.page_size);
        this._leftArrow.visible = adjustment.value > 1;
        this._rightArrow.visible = adjustment.value < max - 1;
    }

    _onScroll(event) {
        let adjustment = this._getHAdjustment();
        if (!adjustment) {
            return Clutter.EVENT_PROPAGATE;
        }

        let delta = 0;
        switch (event.get_scroll_direction()) {
            case Clutter.ScrollDirection.UP:
            case Clutter.ScrollDirection.LEFT:
                delta = -SCROLL_STEP;
                break;
            case Clutter.ScrollDirection.DOWN:
            case Clutter.ScrollDirection.RIGHT:
                delta = SCROLL_STEP;
                break;
            case Clutter.ScrollDirection.SMOOTH: {
                let [dx, dy] = event.get_scroll_delta();
                delta = (dx + dy) * SCROLL_STEP;
                break;
            }
        }

        if (delta === 0) {
            return Clutter.EVENT_PROPAGATE;
        }

        let max = Math.max(0, adjustment.upper - adjustment.page_size);
        adjustment.value = Math.min(max, Math.max(0, adjustment.value + delta));
        return Clutter.EVENT_STOP;
    }

    // Cap the taskbar width at the space the other panel items leave free, so
    // that the buttons scroll instead of overlapping them
    _updateMaxWidth() {
        let panel = Main.panel;
        if (!panel) {
            return;
        }

        let panelWidth = panel.get_width();
        if (panelWidth <= 0) {
            let monitor = Main.layoutManager.primaryMonitor;
            panelWidth = monitor ? monitor.width : 0;
        }
        if (panelWidth <= 0) {
            return;
        }

        let used = 0;
        for (let box of [panel._leftBox, panel._centerBox, panel._rightBox]) {
            // The center box may have been removed from the panel
            if (!box || !box.get_parent()) {
                continue;
            }
            for (let child of box.get_children()) {
                if (child === this || !child.visible) {
                    continue;
                }
                used += child.get_preferred_width(-1)[1];
            }
        }

        let available = Math.max(MIN_WIDTH, panelWidth - used - WIDTH_SLACK);
        if (Math.abs(available - this._maxWidth) < 1) {
            return;
        }
        this._maxWidth = available;
        this.style = `max-width: ${Math.round(available)}px;`;
    }

    // Keep the focused window's button within the visible part of the taskbar.
    // Runs after the buttons have been laid out, so their allocation is known.
    _scrollToButton(button) {
        this._removeScrollLater();

        let laters = global.compositor.get_laters();
        this._scrollLaterId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._scrollLaterId = 0;

            let adjustment = this._getHAdjustment();
            if (!adjustment || !button.get_parent() || adjustment.page_size <= 0) {
                return GLib.SOURCE_REMOVE;
            }

            let box = button.get_allocation_box();
            let max = Math.max(0, adjustment.upper - adjustment.page_size);
            if (box.x1 < adjustment.value) {
                adjustment.value = Math.max(0, box.x1);
            } else if (box.x2 > adjustment.value + adjustment.page_size) {
                adjustment.value = Math.min(max, box.x2 - adjustment.page_size);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _removeScrollLater() {
        if (!this._scrollLaterId) {
            return;
        }
        global.compositor.get_laters().remove(this._scrollLaterId);
        this._scrollLaterId = 0;
    }

    _updateTaskbar() {
        // Rebuilding would destroy the context menu's source button,
        // so defer until the menu closes
        if (this._contextMenu) {
            this._updatePending = true;
            return;
        }

        // Disconnect existing title signals
        for (let sig of this._titleSignals) {
            sig.window.disconnect(sig.id);
        }
        this._titleSignals = [];

        // Remove all existing children
        this._box.destroy_all_children();

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

        let focusedButton = null;

        for (let group of this._groupWindows(windows)) {
            if (group.windows.length > GROUP_THRESHOLD) {
                let button = this._createGroupButton(
                    group.app, group.windows, focusedWindow);
                this._box.add_child(button);
                if (group.windows.includes(focusedWindow)) {
                    focusedButton = button;
                }
            } else {
                for (let window of group.windows) {
                    let button = this._createWindowButton(
                        window, group.app, window === focusedWindow);
                    this._box.add_child(button);
                    if (window === focusedWindow) {
                        focusedButton = button;
                    }
                }
            }

            // Connect to title changes
            for (let window of group.windows) {
                let titleId = window.connect('notify::title', () => {
                    this._updateTaskbar();
                });
                this._titleSignals.push({ window: window, id: titleId });
            }
        }

        this._updateMaxWidth();
        this._updateArrows();

        if (focusedButton) {
            this._scrollToButton(focusedButton);
        }
    }

    // Group windows by their application, preserving the order in which each
    // application's first window appears. Windows without an application are
    // kept as single-window groups.
    _groupWindows(windows) {
        let groups = new Map();

        for (let window of windows) {
            let app = this._windowTracker.get_window_app(window);
            let id = app ? app.get_id() : null;
            if (!id) {
                // Keyed by the window itself so it never merges with others
                groups.set(window, { app: app, windows: [window] });
                continue;
            }
            let group = groups.get(id);
            if (!group) {
                group = { app: app, windows: [] };
                groups.set(id, group);
            }
            group.windows.push(window);
        }

        return [...groups.values()];
    }

    // Windows in taskbar order: grouped by application, so that the order
    // matches the buttons shown in the panel
    getWindows() {
        let workspace = global.workspace_manager.get_active_workspace();
        let windows = global.get_window_actors()
            .map(a => a.meta_window)
            .filter(w => {
                return w.get_workspace() === workspace &&
                       !w.is_skip_taskbar() &&
                       w.get_window_type() === Meta.WindowType.NORMAL;
            });
        windows.sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());

        let ordered = [];
        for (let group of this._groupWindows(windows)) {
            ordered.push(...group.windows);
        }
        return ordered;
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

        // Hover handler - activate window on hover (if enabled)
        button.connect('notify::hover', (actor) => {
            if (this._hoverActivate && actor.hover &&
                !this._hoverSuppressed &&
                window !== global.display.focus_window) {
                if (window.minimized) {
                    // Block clicks for 1 second after hover-unminimizing
                    let existing = this._clickCooldowns.get(window);
                    if (existing) {
                        GLib.source_remove(existing);
                    }
                    let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                        this._clickCooldowns.delete(window);
                        return GLib.SOURCE_REMOVE;
                    });
                    this._clickCooldowns.set(window, timeoutId);
                    window.unminimize();
                }
                this._activateWithFade(window);
            }
            if (!actor.hover) {
                this._hoverSuppressed = false;
            }
        });

        // Click/touch handler
        connectClickHandler(button, () => {
            // Ignore clicks during cooldown after hover-unminimize
            if (this._clickCooldowns.has(window)) {
                return;
            }
            if (this._hoverActivate) {
                // Hover activate is on - click toggles minimize/restore
                if (window.minimized) {
                    window.unminimize();
                    this._activateWithFade(window);
                } else if (window === global.display.focus_window) {
                    window.minimize();
                }
                this._hoverSuppressed = true;
            } else {
                // Left click - focus or unminimize
                if (window.minimized) {
                    window.unminimize();
                    this._activateWithFade(window);
                } else if (window === global.display.focus_window) {
                    window.minimize();
                } else {
                    this._activateWithFade(window);
                }
            }
        }, {
            onMiddleClick: () => {
                window.delete(global.get_current_time());
            },
            onRightClick: () => {
                this._showContextMenu(button, window);
            },
        });

        return button;
    }

    _createGroupButton(app, windows, focusedWindow) {
        let button = new St.BoxLayout({
            style_class: 'praya-taskbar-button',
            reactive: true,
            track_hover: true,
        });

        let innerBox = new St.BoxLayout({
            style_class: 'praya-taskbar-button-inner',
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
        });

        if (windows.includes(focusedWindow)) {
            innerBox.add_style_class_name('praya-taskbar-button-inner-focused');
        }

        if (windows.every(w => w.minimized)) {
            button.add_style_class_name('praya-taskbar-button-minimized');
        }

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

        let name = app ? app.get_name() : 'Window';
        if (name.length > 20) {
            name = name.substring(0, 18) + '...';
        }
        innerBox.add_child(new St.Label({
            text: name,
            style_class: 'praya-taskbar-label',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        innerBox.add_child(new St.Label({
            text: `${windows.length}`,
            style_class: 'praya-taskbar-count',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        button.add_child(innerBox);

        // Both left and right click open the window list
        connectClickHandler(button, () => {
            this._showGroupMenu(button, app, windows);
        }, {
            onRightClick: () => {
                this._showGroupMenu(button, app, windows);
            },
        });

        return button;
    }

    _showGroupMenu(button, app, windows) {
        // Clicking the button while its menu is open closes it
        if (this._contextMenu && this._contextMenu.sourceActor === button) {
            this._destroyContextMenu();
            return;
        }

        let menu = this._createMenu(button);
        let focusedWindow = global.display.focus_window;

        for (let window of windows) {
            let title = window.get_title() || (app ? app.get_name() : 'Window');
            if (title.length > 40) {
                title = title.substring(0, 38) + '...';
            }
            let item = menu.addAction(title, (event) => {
                if (window.minimized) {
                    window.unminimize();
                }
                window.activate(event ? event.get_time() : global.get_current_time());
            });
            if (window === focusedWindow) {
                item.setOrnament(PopupMenu.Ornament.DOT);
            }
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        menu.addAction(_('Minimize All'), () => {
            for (let window of windows) {
                if (!window.minimized && window.can_minimize()) {
                    window.minimize();
                }
            }
        });

        menu.addAction(_('Close All'), (event) => {
            let time = event ? event.get_time() : global.get_current_time();
            for (let window of windows) {
                window.delete(time);
            }
        });

        menu.open();
    }

    // Create a popup menu anchored on a taskbar button, replacing any menu
    // that is currently open
    _createMenu(button) {
        this._destroyContextMenu();

        let menu = new PopupMenu.PopupMenu(button, 0.5, St.Side.TOP);
        Main.uiGroup.add_child(menu.actor);
        menu.actor.hide();
        this._menuManager.addMenu(menu);
        this._contextMenu = menu;

        menu.connect('open-state-changed', (m, isOpen) => {
            if (!isOpen) {
                // Destroy after the activated item's callback has run
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    if (this._contextMenu === menu) {
                        this._destroyContextMenu();
                    }
                    return GLib.SOURCE_REMOVE;
                });
            }
        });

        return menu;
    }

    _showContextMenu(button, window) {
        let menu = this._createMenu(button);

        let item;

        if (!window.minimized) {
            item = menu.addAction(_('Minimize'), () => {
                window.minimize();
            });
            if (!window.can_minimize()) {
                item.setSensitive(false);
            }
        }

        if (!window.is_maximized()) {
            item = menu.addAction(_('Maximize'), (event) => {
                if (window.minimized) {
                    window.unminimize();
                }
                window.maximize();
                window.activate(event.get_time());
            });
            if (!window.can_maximize()) {
                item.setSensitive(false);
            }
        }

        item = menu.addAction(_('Close'), (event) => {
            window.delete(event.get_time());
        });
        if (!window.can_close()) {
            item.setSensitive(false);
        }

        menu.addAction(_('Force Close'), () => {
            window.kill();
        });

        item = menu.addAction(_('Move'), (event) => {
            if (window.minimized) {
                window.unminimize();
            }
            window.activate(event.get_time());

            let backend = global.stage.get_context().get_backend();
            let sprite = backend.get_sprite(global.stage, event) ||
                backend.get_pointer_sprite(global.stage);
            window.begin_grab_op(
                Meta.GrabOp.KEYBOARD_MOVING,
                sprite,
                event.get_time(),
                null);
        });
        if (!window.allows_move()) {
            item.setSensitive(false);
        }

        menu.open();
    }

    _destroyContextMenu() {
        if (!this._contextMenu) {
            return;
        }
        let menu = this._contextMenu;
        this._contextMenu = null;
        this._menuManager.removeMenu(menu);
        menu.destroy();

        if (this._updatePending) {
            this._updatePending = false;
            this._updateTaskbar();
        }
    }

    _activateWithFade(window) {
        window.activate(global.get_current_time());
        let actor = window.get_compositor_private();
        if (actor) {
            actor.set_opacity(128);
            actor.ease({
                opacity: 255,
                duration: 500,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    _loadHoverActivate() {
        try {
            let configPath = GLib.build_filenamev([GLib.get_home_dir(), '.config', 'praya', 'services.json']);
            let configFile = Gio.File.new_for_path(configPath);
            if (configFile.query_exists(null)) {
                let [success, contents] = configFile.load_contents(null);
                if (success) {
                    let config = JSON.parse(new TextDecoder('utf-8').decode(contents));
                    return config.taskbarHoverActivate || false;
                }
            }
        } catch (e) {
            log(`Praya: Error loading taskbar config: ${e.message}`);
        }
        return false;
    }

    setHoverActivate(enabled) {
        this._hoverActivate = enabled;
    }

    destroy() {
        this._updatePending = false;
        this._destroyContextMenu();

        this._removeScrollLater();

        for (let sig of this._panelSignals || []) {
            sig.object.disconnect(sig.id);
        }
        this._panelSignals = [];

        for (let sig of this._adjustmentSignals || []) {
            sig.object.disconnect(sig.id);
        }
        this._adjustmentSignals = [];

        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }

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
        for (let timeoutId of this._clickCooldowns.values()) {
            GLib.source_remove(timeoutId);
        }
        this._clickCooldowns.clear();
        super.destroy();
    }
});

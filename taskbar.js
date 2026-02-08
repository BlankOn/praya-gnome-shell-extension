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

export const PrayaTaskbar = GObject.registerClass(
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
        this._hoverActivate = this._loadHoverActivate();

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

        // Hover handler - activate window on hover (if enabled)
        button.connect('notify::hover', (actor) => {
            if (this._hoverActivate && actor.hover &&
                !this._hoverSuppressed &&
                window !== global.display.focus_window) {
                if (window.minimized) {
                    window.unminimize();
                }
                this._activateWithFade(window);
            }
            if (!actor.hover) {
                this._hoverSuppressed = false;
            }
        });

        // Click handler
        button.connect('button-press-event', (actor, event) => {
            if (event.get_button() === 1) {
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

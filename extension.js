/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const PANEL_WIDTH = 300;
const HEADER_HEIGHT = 50;
const ANIMATION_DURATION = 200;
const MARGIN_LEFT = 8;
const MARGIN_TOP = 8;
const MARGIN_BOTTOM = 8;

const ManokwariIndicator = GObject.registerClass(
class ManokwariIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Manokwari Menu');

        // Create a box to hold the icon and label
        let box = new St.BoxLayout({style_class: 'panel-status-menu-box'});

        // Add an icon
        let icon = new St.Icon({
            icon_name: 'view-app-grid-symbolic',
            style_class: 'system-status-icon',
        });
        box.add_child(icon);

        // Add a label
        let label = new St.Label({
            text: 'Manokwari',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(label);

        this.add_child(box);

        // Track panel visibility
        this._panelVisible = false;
        this._panel = null;
        this._navigationStack = [];
        this._isAnimating = false;
        this._hoverTimeoutId = null;

        // Load applications data
        this._categories = {};
        this._loadApplicationsData();

        // Connect hover handler to show panel
        this.connect('enter-event', () => {
            if (this._hoverTimeoutId) {
                GLib.source_remove(this._hoverTimeoutId);
                this._hoverTimeoutId = null;
            }
            if (!this._panelVisible) {
                this._showPanel();
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Prevent click from hiding the panel - just keep it open
        this.connect('button-press-event', () => {
            // Cancel any pending hide timeout
            if (this._hoverTimeoutId) {
                GLib.source_remove(this._hoverTimeoutId);
                this._hoverTimeoutId = null;
            }
            // Show panel if not visible, but don't hide if already visible
            if (!this._panelVisible) {
                this._showPanel();
            }
            return Clutter.EVENT_STOP;
        });

        // Disable the default menu
        this.menu.actor.hide();
    }

    _loadApplicationsData() {
        let appSystem = Shell.AppSystem.get_default();
        let apps = appSystem.get_installed();

        this._categories = {};

        for (let app of apps) {
            let appInfo = app.app_info;
            if (!appInfo || appInfo.get_nodisplay())
                continue;

            let categoriesStr = appInfo.get_categories() || '';
            let category = this._getMainCategory(categoriesStr);

            if (!this._categories[category])
                this._categories[category] = [];

            this._categories[category].push(app);
        }

        // Sort apps in each category
        for (let category in this._categories) {
            this._categories[category].sort((a, b) =>
                a.get_name().localeCompare(b.get_name()));
        }
    }

    _getMainCategory(categoriesStr) {
        let categories = categoriesStr.split(';');

        const mainCategories = [
            'AudioVideo', 'Audio', 'Video', 'Development', 'Education',
            'Game', 'Graphics', 'Network', 'Office', 'Science', 'Settings',
            'System', 'Utility'
        ];

        for (let cat of categories) {
            if (mainCategories.includes(cat))
                return cat;
        }

        return 'Other';
    }

    _togglePanel() {
        if (this._panelVisible) {
            this._hidePanel();
        } else {
            this._showPanel();
        }
    }

    _showPanel() {
        if (this._panel) {
            this._panel.destroy();
        }

        let monitor = Main.layoutManager.primaryMonitor;
        let panelHeight = Main.panel.height;
        let availableHeight = monitor.height - panelHeight - MARGIN_TOP - MARGIN_BOTTOM;

        // Create the main panel container - below top bar with margins
        this._panel = new St.BoxLayout({
            style_class: 'manokwari-panel',
            vertical: true,
            reactive: true,
            track_hover: true,
            x: MARGIN_LEFT,
            y: panelHeight + MARGIN_TOP,
            width: PANEL_WIDTH,
            height: availableHeight,
        });

        // Create header
        this._header = new St.BoxLayout({
            style_class: 'manokwari-panel-header',
            height: HEADER_HEIGHT,
            x_expand: true,
        });

        let headerLabel = new St.Label({
            text: 'Menu',
            style_class: 'manokwari-header-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._headerLabel = headerLabel;
        this._header.add_child(headerLabel);

        this._panel.add_child(this._header);

        // Create sliding container for navigation with clipping
        this._slidingContainer = new St.Widget({
            style_class: 'manokwari-sliding-container',
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
        });
        this._slidingContainer.set_size(PANEL_WIDTH, availableHeight - HEADER_HEIGHT);

        this._panel.add_child(this._slidingContainer);

        // Show main menu
        this._navigationStack = [];
        this._showMainMenu(false);

        // Start with opacity 0 for fade-in animation
        this._panel.opacity = 0;

        Main.layoutManager.addTopChrome(this._panel);
        this._panelVisible = true;

        // Fade in animation
        this._panel.ease({
            opacity: 255,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        // Add hover handler on the panel to keep it open
        this._panelEnterId = this._panel.connect('enter-event', () => {
            if (this._hoverTimeoutId) {
                GLib.source_remove(this._hoverTimeoutId);
                this._hoverTimeoutId = null;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._panelLeaveId = this._panel.connect('leave-event', () => {
            this._scheduleHidePanel();
            return Clutter.EVENT_PROPAGATE;
        });

        // Also handle leaving the indicator button
        this._indicatorLeaveId = this.connect('leave-event', () => {
            this._scheduleHidePanel();
            return Clutter.EVENT_PROPAGATE;
        });

        // Add click-outside handler for stage (desktop background)
        this._captureEventId = global.stage.connect('captured-event', (actor, event) => {
            if (event.type() === Clutter.EventType.BUTTON_PRESS) {
                let [x, y] = event.get_coords();

                // Check if click is on the indicator button (don't hide)
                let dominated = this.contains(global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y));
                if (dominated) {
                    return Clutter.EVENT_PROPAGATE;
                }

                // Check if click is outside the panel (with margins)
                let panelRight = MARGIN_LEFT + PANEL_WIDTH;
                let panelTop = Main.panel.height + MARGIN_TOP;
                let panelBottom = panelTop + this._panel.height;

                if (x < MARGIN_LEFT || x > panelRight || y < panelTop || y > panelBottom) {
                    this._hidePanel();
                    return Clutter.EVENT_STOP;
                }
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Add focus change handler to close when clicking on windows
        this._focusWindowId = global.display.connect('notify::focus-window', () => {
            if (this._panelVisible && global.display.focus_window) {
                this._hidePanel();
            }
        });
    }

    _scheduleHidePanel() {
        if (this._hoverTimeoutId) {
            GLib.source_remove(this._hoverTimeoutId);
        }
        this._hoverTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._hoverTimeoutId = null;
            this._hidePanel();
            return GLib.SOURCE_REMOVE;
        });
    }

    _hidePanel() {
        if (this._hoverTimeoutId) {
            GLib.source_remove(this._hoverTimeoutId);
            this._hoverTimeoutId = null;
        }

        if (this._captureEventId) {
            global.stage.disconnect(this._captureEventId);
            this._captureEventId = null;
        }

        if (this._focusWindowId) {
            global.display.disconnect(this._focusWindowId);
            this._focusWindowId = null;
        }

        if (this._indicatorLeaveId) {
            this.disconnect(this._indicatorLeaveId);
            this._indicatorLeaveId = null;
        }

        if (this._panel && this._panelEnterId) {
            this._panel.disconnect(this._panelEnterId);
            this._panelEnterId = null;
        }

        if (this._panel && this._panelLeaveId) {
            this._panel.disconnect(this._panelLeaveId);
            this._panelLeaveId = null;
        }

        this._panelVisible = false;
        this._navigationStack = [];

        if (this._panel) {
            // Fade out animation
            this._panel.ease({
                opacity: 0,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (this._panel) {
                        Main.layoutManager.removeChrome(this._panel);
                        this._panel.destroy();
                        this._panel = null;
                    }
                }
            });
        }
    }

    _createScrollView(height = null) {
        let monitor = Main.layoutManager.primaryMonitor;
        let scrollView = new St.ScrollView({
            style_class: 'manokwari-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });
        let panelHeight = Main.panel.height;
        let availableHeight = monitor.height - panelHeight - MARGIN_TOP - MARGIN_BOTTOM - HEADER_HEIGHT;
        scrollView.set_size(PANEL_WIDTH, height || availableHeight);
        return scrollView;
    }

    _animateSlide(newContent, direction) {
        if (this._isAnimating) return;
        this._isAnimating = true;

        let monitor = Main.layoutManager.primaryMonitor;
        let panelHeight = Main.panel.height;
        let containerHeight = monitor.height - panelHeight - MARGIN_TOP - MARGIN_BOTTOM - HEADER_HEIGHT;

        // Get current content
        let currentContent = this._slidingContainer.get_first_child();

        // Set initial position for new content
        newContent.set_position(direction === 'forward' ? PANEL_WIDTH : -PANEL_WIDTH, 0);
        newContent.set_size(PANEL_WIDTH, containerHeight);
        this._slidingContainer.add_child(newContent);

        // Animate current content out
        if (currentContent) {
            currentContent.ease({
                x: direction === 'forward' ? -PANEL_WIDTH : PANEL_WIDTH,
                duration: ANIMATION_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    currentContent.destroy();
                }
            });
        }

        // Animate new content in
        newContent.ease({
            x: 0,
            duration: ANIMATION_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._isAnimating = false;
            }
        });
    }

    _showMainMenu(animate = true) {
        this._updateHeader('Menu', false);

        let monitor = Main.layoutManager.primaryMonitor;

        // Create a container for the whole view
        let contentContainer = new St.BoxLayout({
            style_class: 'manokwari-content-container',
            vertical: true,
            x_expand: true,
            y_expand: true,
        });

        // Scroll view takes remaining space (y_expand)
        let scrollView = new St.ScrollView({
            style_class: 'manokwari-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });

        let menuBox = new St.BoxLayout({
            style_class: 'manokwari-menu-box',
            vertical: true,
            x_expand: true,
        });

        // Applications item (has children)
        let appsItem = this._createMenuItem('Applications', 'view-app-grid-symbolic', true);
        appsItem.connect('button-press-event', () => {
            if (!this._isAnimating) this._showApplicationsList();
            return Clutter.EVENT_STOP;
        });
        menuBox.add_child(appsItem);

        // Places item (has children)
        let placesItem = this._createMenuItem('Places', 'folder-symbolic', true);
        placesItem.connect('button-press-event', () => {
            if (!this._isAnimating) this._showPlaces();
            return Clutter.EVENT_STOP;
        });
        menuBox.add_child(placesItem);

        // Separator
        menuBox.add_child(new St.Widget({style_class: 'manokwari-separator', height: 1, x_expand: true}));

        // Settings item
        let settingsItem = this._createMenuItem('Settings', 'preferences-system-symbolic', false);
        settingsItem.connect('button-press-event', () => {
            this._launchApp('gnome-control-center.desktop');
            this._hidePanel();
            return Clutter.EVENT_STOP;
        });
        menuBox.add_child(settingsItem);

        scrollView.add_child(menuBox);
        contentContainer.add_child(scrollView);

        // Bottom power section - sticks to bottom
        let powerSection = new St.BoxLayout({
            style_class: 'manokwari-power-section',
            vertical: true,
            x_expand: true,
        });

        // Separator above power
        powerSection.add_child(new St.Widget({style_class: 'manokwari-separator', height: 1, x_expand: true}));

        // Power item (expandable)
        let powerItem = this._createExpandableMenuItem('Power', 'system-shutdown-symbolic');
        powerSection.add_child(powerItem);

        // Power options container (initially hidden)
        let powerOptionsBox = new St.BoxLayout({
            style_class: 'manokwari-power-options',
            vertical: true,
            x_expand: true,
        });
        powerOptionsBox.hide();

        // Lock
        let lockItem = this._createSubMenuItem('Lock', 'system-lock-screen-symbolic');
        lockItem.connect('button-press-event', () => {
            Main.screenShield.lock(true);
            this._hidePanel();
            return Clutter.EVENT_STOP;
        });
        powerOptionsBox.add_child(lockItem);

        // Log Out
        let logoutItem = this._createSubMenuItem('Log Out', 'system-log-out-symbolic');
        logoutItem.connect('button-press-event', () => {
            Main.overview.hide();
            this._hidePanel();
            return Clutter.EVENT_STOP;
        });
        powerOptionsBox.add_child(logoutItem);

        // Suspend
        let suspendItem = this._createSubMenuItem('Suspend', 'media-playback-pause-symbolic');
        suspendItem.connect('button-press-event', () => {
            this._hidePanel();
            return Clutter.EVENT_STOP;
        });
        powerOptionsBox.add_child(suspendItem);

        // Power Off
        let powerOffItem = this._createSubMenuItem('Power Off', 'system-shutdown-symbolic');
        powerOffItem.connect('button-press-event', () => {
            this._hidePanel();
            return Clutter.EVENT_STOP;
        });
        powerOptionsBox.add_child(powerOffItem);

        powerSection.add_child(powerOptionsBox);

        // Toggle power options on click
        powerItem.connect('button-press-event', () => {
            let arrow = powerItem.get_last_child();
            if (powerOptionsBox.visible) {
                powerOptionsBox.hide();
                arrow.icon_name = 'go-up-symbolic';
            } else {
                powerOptionsBox.show();
                arrow.icon_name = 'go-down-symbolic';
            }
            return Clutter.EVENT_STOP;
        });

        contentContainer.add_child(powerSection);

        if (animate) {
            this._animateSlide(contentContainer, 'back');
        } else {
            let monitor = Main.layoutManager.primaryMonitor;
            let panelHeight = Main.panel.height;
            let containerHeight = monitor.height - panelHeight - MARGIN_TOP - MARGIN_BOTTOM - HEADER_HEIGHT;
            this._slidingContainer.destroy_all_children();
            contentContainer.set_position(0, 0);
            contentContainer.set_size(PANEL_WIDTH, containerHeight);
            this._slidingContainer.add_child(contentContainer);
        }
    }

    _showApplicationsList() {
        this._navigationStack.push({type: 'main'});
        this._updateHeader('Applications', true);

        let scrollView = this._createScrollView();

        let menuBox = new St.BoxLayout({
            style_class: 'manokwari-menu-box',
            vertical: true,
            x_expand: true,
        });

        // Get all apps and sort them alphabetically
        let allApps = [];
        for (let category in this._categories) {
            allApps = allApps.concat(this._categories[category]);
        }

        // Remove duplicates (apps can be in multiple categories) and sort
        let seenApps = new Set();
        let uniqueApps = [];
        for (let app of allApps) {
            let appId = app.get_id();
            if (!seenApps.has(appId)) {
                seenApps.add(appId);
                uniqueApps.push(app);
            }
        }
        uniqueApps.sort((a, b) => a.get_name().localeCompare(b.get_name()));

        for (let app of uniqueApps) {
            let appItem = this._createAppMenuItem(app);
            appItem.connect('button-press-event', () => {
                app.activate();
                this._hidePanel();
                return Clutter.EVENT_STOP;
            });
            menuBox.add_child(appItem);
        }

        scrollView.add_child(menuBox);
        this._animateSlide(scrollView, 'forward');
    }

    _showPlaces() {
        this._navigationStack.push({type: 'main'});
        this._updateHeader('Places', true);

        let scrollView = this._createScrollView();

        let menuBox = new St.BoxLayout({
            style_class: 'manokwari-menu-box',
            vertical: true,
            x_expand: true,
        });

        // Home
        let homeItem = this._createMenuItem('Home', 'user-home-symbolic', false);
        homeItem.connect('button-press-event', () => {
            this._openPlace(GLib.get_home_dir());
            return Clutter.EVENT_STOP;
        });
        menuBox.add_child(homeItem);

        // Documents
        let docsPath = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS);
        if (docsPath) {
            let docsItem = this._createMenuItem('Documents', 'folder-documents-symbolic', false);
            docsItem.connect('button-press-event', () => {
                this._openPlace(docsPath);
                return Clutter.EVENT_STOP;
            });
            menuBox.add_child(docsItem);
        }

        // Downloads
        let downloadsPath = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD);
        if (downloadsPath) {
            let downloadsItem = this._createMenuItem('Downloads', 'folder-download-symbolic', false);
            downloadsItem.connect('button-press-event', () => {
                this._openPlace(downloadsPath);
                return Clutter.EVENT_STOP;
            });
            menuBox.add_child(downloadsItem);
        }

        // Pictures
        let picturesPath = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES);
        if (picturesPath) {
            let picturesItem = this._createMenuItem('Pictures', 'folder-pictures-symbolic', false);
            picturesItem.connect('button-press-event', () => {
                this._openPlace(picturesPath);
                return Clutter.EVENT_STOP;
            });
            menuBox.add_child(picturesItem);
        }

        // Music
        let musicPath = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_MUSIC);
        if (musicPath) {
            let musicItem = this._createMenuItem('Music', 'folder-music-symbolic', false);
            musicItem.connect('button-press-event', () => {
                this._openPlace(musicPath);
                return Clutter.EVENT_STOP;
            });
            menuBox.add_child(musicItem);
        }

        // Videos
        let videosPath = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS);
        if (videosPath) {
            let videosItem = this._createMenuItem('Videos', 'folder-videos-symbolic', false);
            videosItem.connect('button-press-event', () => {
                this._openPlace(videosPath);
                return Clutter.EVENT_STOP;
            });
            menuBox.add_child(videosItem);
        }

        scrollView.add_child(menuBox);
        this._animateSlide(scrollView, 'forward');
    }

    _createMenuItem(text, iconName, hasChildren) {
        let item = new St.BoxLayout({
            style_class: 'manokwari-menu-item',
            reactive: true,
            track_hover: true,
            height: 48,
            x_expand: true,
        });

        let icon = new St.Icon({
            icon_name: iconName,
            style_class: 'manokwari-menu-item-icon',
            icon_size: 24,
        });
        item.add_child(icon);

        let label = new St.Label({
            text: text,
            style_class: 'manokwari-menu-item-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        item.add_child(label);

        if (hasChildren) {
            let arrow = new St.Icon({
                icon_name: 'go-next-symbolic',
                style_class: 'manokwari-menu-item-arrow',
                icon_size: 16,
            });
            item.add_child(arrow);
        }

        return item;
    }

    _createAppMenuItem(app) {
        let item = new St.BoxLayout({
            style_class: 'manokwari-menu-item',
            reactive: true,
            track_hover: true,
            height: 48,
            x_expand: true,
        });

        let icon = app.create_icon_texture(24);
        icon.style_class = 'manokwari-menu-item-icon';
        item.add_child(icon);

        let label = new St.Label({
            text: app.get_name(),
            style_class: 'manokwari-menu-item-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        item.add_child(label);

        return item;
    }

    _createExpandableMenuItem(text, iconName) {
        let item = new St.BoxLayout({
            style_class: 'manokwari-menu-item',
            reactive: true,
            track_hover: true,
            height: 48,
            x_expand: true,
        });

        let icon = new St.Icon({
            icon_name: iconName,
            style_class: 'manokwari-menu-item-icon',
            icon_size: 24,
        });
        item.add_child(icon);

        let label = new St.Label({
            text: text,
            style_class: 'manokwari-menu-item-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        item.add_child(label);

        // Up arrow (collapsed state)
        let arrow = new St.Icon({
            icon_name: 'go-up-symbolic',
            style_class: 'manokwari-menu-item-arrow',
            icon_size: 16,
        });
        item.add_child(arrow);

        return item;
    }

    _createSubMenuItem(text, iconName) {
        let item = new St.BoxLayout({
            style_class: 'manokwari-submenu-item',
            reactive: true,
            track_hover: true,
            height: 42,
            x_expand: true,
        });

        let icon = new St.Icon({
            icon_name: iconName,
            style_class: 'manokwari-menu-item-icon',
            icon_size: 20,
        });
        item.add_child(icon);

        let label = new St.Label({
            text: text,
            style_class: 'manokwari-menu-item-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        item.add_child(label);

        return item;
    }

    _updateHeader(title, showBack) {
        this._header.destroy_all_children();

        if (showBack) {
            let backButton = new St.Button({
                style_class: 'manokwari-back-button',
                child: new St.Icon({
                    icon_name: 'go-previous-symbolic',
                    icon_size: 20,
                }),
            });
            backButton.connect('clicked', () => {
                if (!this._isAnimating) this._goBack();
            });
            this._header.add_child(backButton);
        }

        let headerLabel = new St.Label({
            text: title,
            style_class: 'manokwari-header-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._header.add_child(headerLabel);
    }

    _goBack() {
        if (this._navigationStack.length === 0) {
            this._showMainMenu(true);
            return;
        }

        let previous = this._navigationStack.pop();

        if (previous.type === 'main') {
            this._showMainMenu(true);
        }
    }

    _openPlace(path) {
        let file = Gio.File.new_for_path(path);
        let uri = file.get_uri();
        Gio.app_info_launch_default_for_uri(uri, null);
        this._hidePanel();
    }

    _launchApp(desktopId) {
        let appSystem = Shell.AppSystem.get_default();
        let app = appSystem.lookup_app(desktopId);
        if (app) {
            app.activate();
        }
    }

    destroy() {
        this._hidePanel();
        super.destroy();
    }
});

export default class ManokwariExtension extends Extension {
    enable() {
        this._indicator = new ManokwariIndicator();
        // Add to the left side of the panel
        Main.panel.addToStatusArea('manokwari-indicator', this._indicator, 0, 'left');

        // Move date/time to the right
        this._moveDateTimeToRight();

        // Move activities/workspace to center
        this._moveActivitiesToCenter();

        // Hide the bottom dock when extension is enabled
        this._dock = null;
        this._hideDock();
    }

    _findDock() {
        // Try to find Dash to Dock or Ubuntu Dock
        let start = Main.extensionManager?.lookup('dash-to-dock@micxgx.gmail.com');
        if (start && start.stateObj && start.stateObj.dockManager) {
            return start.stateObj.dockManager._allDocks[0]?.dash;
        }

        // Try Ubuntu Dock
        start = Main.extensionManager?.lookup('ubuntu-dock@ubuntu.com');
        if (start && start.stateObj && start.stateObj.dockManager) {
            return start.stateObj.dockManager._allDocks[0]?.dash;
        }

        // Fallback to overview dash
        return Main.overview.dash;
    }

    _hideDock() {
        if (!this._dock) {
            this._dock = this._findDock();
        }
        if (this._dock) {
            this._dock.hide();
        }
    }

    _showDock() {
        if (this._dock) {
            this._dock.show();
        }
    }

    _moveActivitiesToCenter() {
        let activities = Main.panel.statusArea.activities;
        if (!activities)
            return;

        let leftBox = Main.panel._leftBox;
        let centerBox = Main.panel._centerBox;

        if (leftBox.contains(activities.container)) {
            leftBox.remove_child(activities.container);
            // Add to center box
            centerBox.insert_child_at_index(activities.container, 0);
        }
    }

    _restoreActivitiesPosition() {
        let activities = Main.panel.statusArea.activities;
        if (!activities)
            return;

        let leftBox = Main.panel._leftBox;
        let centerBox = Main.panel._centerBox;

        if (centerBox.contains(activities.container)) {
            centerBox.remove_child(activities.container);
            leftBox.insert_child_at_index(activities.container, 0);
        }
    }

    _moveDateTimeToRight() {
        let dateMenu = Main.panel.statusArea.dateMenu;
        if (!dateMenu)
            return;

        // Remove from center box
        let centerBox = Main.panel._centerBox;
        let rightBox = Main.panel._rightBox;

        if (centerBox.contains(dateMenu.container)) {
            centerBox.remove_child(dateMenu.container);
            // Add to the rightmost position (index 0 means first, so it appears at the far right)
            rightBox.insert_child_at_index(dateMenu.container, rightBox.get_n_children());
        }
    }

    _restoreDateTimePosition() {
        let dateMenu = Main.panel.statusArea.dateMenu;
        if (!dateMenu)
            return;

        let centerBox = Main.panel._centerBox;
        let rightBox = Main.panel._rightBox;

        if (rightBox.contains(dateMenu.container)) {
            rightBox.remove_child(dateMenu.container);
            centerBox.add_child(dateMenu.container);
        }
    }

    disable() {
        // Show the dock again when extension is disabled
        this._showDock();
        this._dock = null;

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        // Restore date/time to center
        this._restoreDateTimePosition();

        // Restore activities to left
        this._restoreActivitiesPosition();
    }
}

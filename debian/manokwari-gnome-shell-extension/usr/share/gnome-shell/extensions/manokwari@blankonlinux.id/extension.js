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
import Meta from 'gi://Meta';
import AccountsService from 'gi://AccountsService';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

const PANEL_WIDTH = 325;
const HEADER_HEIGHT = 50;
const ANIMATION_DURATION = 200;
const MARGIN_LEFT = 8;
const MARGIN_TOP = 8;
const MARGIN_BOTTOM = 8;

const ManokwariIndicator = GObject.registerClass(
class ManokwariIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Manokwari Menu');

        // Create a box to hold the logo
        let box = new St.BoxLayout({style_class: 'panel-status-menu-box'});

        // Add logo using St.Widget with CSS background
        let logo = new St.Widget({
            style_class: 'manokwari-panel-logo',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(logo);

        this.add_child(box);

        // Track panel visibility
        this._panelVisible = false;
        this._panel = null;
        this._hoverZone = null;
        this._navigationStack = [];
        this._isAnimating = false;
        this._hoverTimeoutId = null;
        this._isSearchActive = false;
        this._searchEntry = null;
        this._keyPressId = null;

        // Keyboard navigation
        this._focusedIndex = -1;
        this._menuItems = [];
        this._menuBox = null;

        // Load applications data
        this._categories = {};
        this._appSystem = Shell.AppSystem.get_default();

        // System actions for power menu
        this._systemActions = SystemActions.getDefault();

        // Delay initial load to ensure shell is ready (1 second)
        this._loadAppsTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._loadApplicationsData();
            this._loadAppsTimeoutId = null;
            return GLib.SOURCE_REMOVE;
        });

        // Reload apps when installed apps change
        this._installedChangedId = this._appSystem.connect('installed-changed', () => {
            this._loadApplicationsData();
        });

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
        this._categories = {};
        this._appSystem = Shell.AppSystem.get_default();

        // Use Gio.AppInfo.get_all() which reliably returns all desktop apps
        let allAppInfos = Gio.AppInfo.get_all();

        for (let appInfo of allAppInfos) {
            if (!appInfo)
                continue;

            // Skip apps that shouldn't be displayed
            if (typeof appInfo.should_show === 'function' && !appInfo.should_show())
                continue;

            // Get the app ID
            let appId = appInfo.get_id();
            if (!appId)
                continue;

            // Try to get Shell.App for icon support
            let app = this._appSystem.lookup_app(appId);

            // Get categories (only works on DesktopAppInfo)
            let categoriesStr = '';
            if (typeof appInfo.get_categories === 'function') {
                categoriesStr = appInfo.get_categories() || '';
            }

            let category = this._getMainCategory(categoriesStr);

            if (!this._categories[category])
                this._categories[category] = [];

            // Store both app and appInfo for flexibility
            this._categories[category].push({
                app: app,
                appInfo: appInfo,
                name: appInfo.get_name() || appId,
                id: appId,
            });
        }

        // Sort apps in each category
        for (let category in this._categories) {
            this._categories[category].sort((a, b) =>
                a.name.localeCompare(b.name));
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

        // Create invisible hover zone that includes margins
        this._hoverZone = new St.Widget({
            reactive: true,
            track_hover: true,
            x: 0,
            y: panelHeight,
            width: PANEL_WIDTH + MARGIN_LEFT * 2,
            height: availableHeight + MARGIN_TOP + MARGIN_BOTTOM,
        });

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

        // Create header (will be populated by _showMainMenu -> _updateHeader)
        this._header = new St.BoxLayout({
            style_class: 'manokwari-panel-header',
            height: HEADER_HEIGHT,
            x_expand: true,
        });

        this._panel.add_child(this._header);

        // Create persistent bottom section first to measure its height
        this._bottomSection = this._createBottomSection();

        // Fixed height for bottom section (User ~72 + Lock 52 + LogOut 52 + Power 52 + Power children 150 + separators + padding)
        let bottomSectionHeight = 420;

        // Create sliding container for navigation with clipping
        this._slidingContainer = new St.Widget({
            style_class: 'manokwari-sliding-container',
            x_expand: true,
            clip_to_allocation: true,
        });
        this._slidingContainer.set_size(PANEL_WIDTH, availableHeight - HEADER_HEIGHT - bottomSectionHeight);

        this._panel.add_child(this._slidingContainer);
        this._panel.add_child(this._bottomSection);

        // Show main menu
        this._navigationStack = [];
        this._showMainMenu(false);

        // Start with opacity 0 and off-screen to the left for slide-in animation
        this._panel.opacity = 0;
        this._panel.x = MARGIN_LEFT - PANEL_WIDTH;

        Main.layoutManager.addTopChrome(this._hoverZone);
        Main.layoutManager.addTopChrome(this._panel);
        this._panelVisible = true;

        // Fade in + slide to right animation
        this._panel.ease({
            opacity: 255,
            x: MARGIN_LEFT,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                // Grab keyboard focus to prevent app windows from stealing input
                if (this._searchEntry) {
                    this._searchEntry.grab_key_focus();
                }
            }
        });

        // Add key capture for navigation and search
        this._keyPressId = global.stage.connect('key-press-event', (actor, event) => {
            if (!this._panelVisible)
                return Clutter.EVENT_PROPAGATE;

            let keyval = event.get_key_symbol();
            let keychar = String.fromCharCode(Clutter.keysym_to_unicode(keyval));

            // Handle arrow key navigation
            if (keyval === Clutter.KEY_Down) {
                this._navigateMenu(1);
                return Clutter.EVENT_STOP;
            } else if (keyval === Clutter.KEY_Up) {
                this._navigateMenu(-1);
                return Clutter.EVENT_STOP;
            } else if (keyval === Clutter.KEY_Return || keyval === Clutter.KEY_KP_Enter) {
                // If search entry has focus and has text, launch first result
                if (this._searchEntry && this._searchEntry.has_key_focus() && this._searchEntry.get_text().trim() !== '') {
                    this._launchFirstSearchResult();
                    return Clutter.EVENT_STOP;
                }
                // Otherwise activate focused menu item
                if (this._focusedIndex >= 0 && this._focusedIndex < this._menuItems.length) {
                    this._activateMenuItem(this._focusedIndex);
                    return Clutter.EVENT_STOP;
                }
            } else if (keyval === Clutter.KEY_Right) {
                // Enter submenu if focused item has children
                if (this._focusedIndex >= 0 && this._focusedIndex < this._menuItems.length) {
                    let item = this._menuItems[this._focusedIndex];
                    if (item._hasChildren) {
                        this._activateMenuItem(this._focusedIndex);
                        return Clutter.EVENT_STOP;
                    }
                }
            } else if (keyval === Clutter.KEY_Left || keyval === Clutter.KEY_BackSpace) {
                // Go back if in nested menu (but not if typing in search)
                if (this._navigationStack.length > 0) {
                    if (keyval === Clutter.KEY_BackSpace && this._searchEntry && this._searchEntry.has_key_focus()) {
                        return Clutter.EVENT_PROPAGATE;
                    }
                    if (!this._isAnimating) this._goBack();
                    return Clutter.EVENT_STOP;
                }
            }

            // Check if it's an alphanumeric character
            if (/^[a-zA-Z0-9]$/.test(keychar)) {
                // If we're in a nested menu (no search entry), go back to main first
                if (!this._searchEntry || this._navigationStack.length > 0) {
                    this._navigationStack = [];
                    this._isSearchActive = false;
                    this._showMainMenu(false);
                }

                // Now we should have a search entry
                if (this._searchEntry) {
                    // Check if search entry already has focus
                    if (!this._searchEntry.has_key_focus()) {
                        this._searchEntry.grab_key_focus();
                        // Insert the character into the search entry
                        this._searchEntry.set_text(keychar);
                        // Move cursor to end
                        this._searchEntry.clutter_text.set_cursor_position(-1);
                    }
                }
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
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

        // Add hover handler on the hover zone (includes margins)
        this._hoverZoneEnterId = this._hoverZone.connect('enter-event', () => {
            if (this._hoverTimeoutId) {
                GLib.source_remove(this._hoverTimeoutId);
                this._hoverTimeoutId = null;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._hoverZoneLeaveId = this._hoverZone.connect('leave-event', () => {
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
            // Only hide if a window gets focus (user clicked on a window)
            // Don't hide just because our panel got focus
            if (this._panelVisible && global.display.focus_window) {
                // Small delay to allow our panel to process focus first
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                    if (this._panelVisible && global.display.focus_window) {
                        this._hidePanel();
                    }
                    return GLib.SOURCE_REMOVE;
                });
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

        if (this._keyPressId) {
            global.stage.disconnect(this._keyPressId);
            this._keyPressId = null;
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

        if (this._hoverZone && this._hoverZoneEnterId) {
            this._hoverZone.disconnect(this._hoverZoneEnterId);
            this._hoverZoneEnterId = null;
        }

        if (this._hoverZone && this._hoverZoneLeaveId) {
            this._hoverZone.disconnect(this._hoverZoneLeaveId);
            this._hoverZoneLeaveId = null;
        }

        this._panelVisible = false;
        this._navigationStack = [];
        this._isSearchActive = false;
        this._isAnimating = false;
        this._searchEntry = null;
        this._focusedIndex = -1;
        this._menuItems = [];
        this._menuBox = null;
        this._bottomSection = null;

        // Clean up hover zone immediately if panel doesn't exist
        if (this._hoverZone && !this._panel) {
            Main.layoutManager.removeChrome(this._hoverZone);
            this._hoverZone.destroy();
            this._hoverZone = null;
        }

        if (this._panel) {
            // Fade out + slide to left animation
            this._panel.ease({
                opacity: 0,
                x: MARGIN_LEFT - PANEL_WIDTH,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (this._hoverZone) {
                        Main.layoutManager.removeChrome(this._hoverZone);
                        this._hoverZone.destroy();
                        this._hoverZone = null;
                    }
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
        let scrollView = new St.ScrollView({
            style_class: 'manokwari-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });
        // Use sliding container height which already accounts for bottom section
        let containerHeight = this._slidingContainer ? this._slidingContainer.height : 400;
        scrollView.set_size(PANEL_WIDTH, height || containerHeight);
        return scrollView;
    }

    _navigateMenu(direction) {
        if (this._menuItems.length === 0)
            return;

        // Remove focus from search entry if navigating
        if (this._searchEntry && this._searchEntry.has_key_focus()) {
            global.stage.set_key_focus(null);
        }

        let newIndex = this._focusedIndex + direction;

        // Wrap around
        if (newIndex < 0)
            newIndex = this._menuItems.length - 1;
        else if (newIndex >= this._menuItems.length)
            newIndex = 0;

        this._setFocusedIndex(newIndex);
    }

    _setFocusedIndex(index) {
        // Remove highlight from previous item
        if (this._focusedIndex >= 0 && this._focusedIndex < this._menuItems.length) {
            this._menuItems[this._focusedIndex].remove_style_class_name('manokwari-menu-item-focused');
        }

        this._focusedIndex = index;

        // Add highlight to new item
        if (this._focusedIndex >= 0 && this._focusedIndex < this._menuItems.length) {
            let item = this._menuItems[this._focusedIndex];
            item.add_style_class_name('manokwari-menu-item-focused');

            // Scroll item into view if needed
            if (this._currentScrollView) {
                let adjustment = this._currentScrollView.vscroll.adjustment;
                let [itemX, itemY] = item.get_transformed_position();
                let [scrollX, scrollY] = this._currentScrollView.get_transformed_position();
                let relativeY = itemY - scrollY;
                let scrollHeight = this._currentScrollView.height;
                let itemHeight = item.height;

                if (relativeY < 0) {
                    adjustment.value += relativeY;
                } else if (relativeY + itemHeight > scrollHeight) {
                    adjustment.value += (relativeY + itemHeight - scrollHeight);
                }
            }
        }
    }

    _activateMenuItem(index) {
        if (index < 0 || index >= this._menuItems.length)
            return;

        let item = this._menuItems[index];
        if (item._activateCallback) {
            item._activateCallback();
        }
    }

    _registerMenuItems(items, scrollView) {
        this._menuItems = items;
        this._currentScrollView = scrollView;
        this._focusedIndex = -1;
    }

    _animateSlide(newContent, direction) {
        if (this._isAnimating) return;
        this._isAnimating = true;

        // Use sliding container's actual height (already accounts for bottom section)
        let containerHeight = this._slidingContainer.height;

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

        let navItems = [];

        // Applications item (has children)
        let appsItem = this._createMenuItem('Applications', 'view-app-grid-symbolic', true);
        appsItem._hasChildren = true;
        appsItem._activateCallback = () => {
            if (!this._isAnimating) this._showApplicationsList();
        };
        appsItem.connect('button-press-event', () => {
            appsItem._activateCallback();
            return Clutter.EVENT_STOP;
        });
        menuBox.add_child(appsItem);
        navItems.push(appsItem);

        // Places item (has children)
        let placesItem = this._createMenuItem('Places', 'folder-symbolic', true);
        placesItem._hasChildren = true;
        placesItem._activateCallback = () => {
            if (!this._isAnimating) this._showPlaces();
        };
        placesItem.connect('button-press-event', () => {
            placesItem._activateCallback();
            return Clutter.EVENT_STOP;
        });
        menuBox.add_child(placesItem);
        navItems.push(placesItem);

        // Separator
        menuBox.add_child(new St.Widget({style_class: 'manokwari-separator', height: 1, x_expand: true}));

        // Settings item
        let settingsItem = this._createMenuItem('Settings', 'preferences-system-symbolic', false);
        settingsItem._hasChildren = false;
        settingsItem._activateCallback = () => {
            let appInfo = Gio.DesktopAppInfo.new('gnome-control-center.desktop');
            if (appInfo) {
                appInfo.launch([], null);
            } else {
                appInfo = Gio.DesktopAppInfo.new('org.gnome.Settings.desktop');
                if (appInfo)
                    appInfo.launch([], null);
            }
            this._hidePanel();
        };
        settingsItem.connect('button-press-event', () => {
            settingsItem._activateCallback();
            return Clutter.EVENT_STOP;
        });
        menuBox.add_child(settingsItem);
        navItems.push(settingsItem);

        scrollView.add_child(menuBox);
        contentContainer.add_child(scrollView);

        // Register menu items for keyboard navigation
        this._registerMenuItems(navItems, scrollView);

        if (animate) {
            this._animateSlide(contentContainer, 'back');
        } else {
            // Use sliding container's actual height (already accounts for bottom section)
            let containerHeight = this._slidingContainer.height;
            this._slidingContainer.destroy_all_children();
            contentContainer.set_position(0, 0);
            contentContainer.set_size(PANEL_WIDTH, containerHeight);
            this._slidingContainer.add_child(contentContainer);
        }
    }

    _getCategoryInfo(categoryId) {
        // Map category IDs to display names and icons
        const categoryMap = {
            'AudioVideo': {name: 'Sound & Video', icon: 'applications-multimedia-symbolic'},
            'Audio': {name: 'Audio', icon: 'audio-x-generic-symbolic'},
            'Video': {name: 'Video', icon: 'video-x-generic-symbolic'},
            'Development': {name: 'Development', icon: 'applications-engineering-symbolic'},
            'Education': {name: 'Education', icon: 'applications-science-symbolic'},
            'Game': {name: 'Games', icon: 'applications-games-symbolic'},
            'Graphics': {name: 'Graphics', icon: 'applications-graphics-symbolic'},
            'Network': {name: 'Internet', icon: 'applications-internet-symbolic'},
            'Office': {name: 'Office', icon: 'x-office-document-symbolic'},
            'Science': {name: 'Science', icon: 'applications-science-symbolic'},
            'Settings': {name: 'Settings', icon: 'preferences-system-symbolic'},
            'System': {name: 'System Tools', icon: 'applications-system-symbolic'},
            'Utility': {name: 'Accessories', icon: 'applications-utilities-symbolic'},
            'Other': {name: 'Other', icon: 'applications-other-symbolic'},
        };
        return categoryMap[categoryId] || {name: categoryId, icon: 'application-x-executable-symbolic'};
    }

    _showApplicationsList() {
        this._navigationStack.push({type: 'main'});
        this._updateHeader('Applications', true);

        // Reload apps if categories are empty
        if (Object.keys(this._categories).length === 0) {
            this._loadApplicationsData();
        }

        let scrollView = this._createScrollView();

        let menuBox = new St.BoxLayout({
            style_class: 'manokwari-menu-box',
            vertical: true,
            x_expand: true,
        });

        let navItems = [];

        // Define the order of categories
        const categoryOrder = [
            'Network', 'Office', 'Graphics', 'AudioVideo', 'Video', 'Audio',
            'Development', 'Game', 'Education', 'Science', 'System',
            'Utility', 'Settings', 'Other'
        ];

        // Show categories that have apps
        for (let categoryId of categoryOrder) {
            if (this._categories[categoryId] && this._categories[categoryId].length > 0) {
                let info = this._getCategoryInfo(categoryId);
                let categoryItem = this._createMenuItem(
                    `${info.name} (${this._categories[categoryId].length})`,
                    info.icon,
                    true
                );
                categoryItem._hasChildren = true;
                categoryItem._activateCallback = ((catId) => () => {
                    if (!this._isAnimating) this._showCategoryApps(catId);
                })(categoryId);
                categoryItem.connect('button-press-event', () => {
                    categoryItem._activateCallback();
                    return Clutter.EVENT_STOP;
                });
                menuBox.add_child(categoryItem);
                navItems.push(categoryItem);
            }
        }

        // Check for any categories not in the predefined order
        for (let categoryId in this._categories) {
            if (!categoryOrder.includes(categoryId) && this._categories[categoryId].length > 0) {
                let info = this._getCategoryInfo(categoryId);
                let categoryItem = this._createMenuItem(
                    `${info.name} (${this._categories[categoryId].length})`,
                    info.icon,
                    true
                );
                categoryItem._hasChildren = true;
                categoryItem._activateCallback = ((catId) => () => {
                    if (!this._isAnimating) this._showCategoryApps(catId);
                })(categoryId);
                categoryItem.connect('button-press-event', () => {
                    categoryItem._activateCallback();
                    return Clutter.EVENT_STOP;
                });
                menuBox.add_child(categoryItem);
                navItems.push(categoryItem);
            }
        }

        // Show message if no categories found
        if (menuBox.get_n_children() === 0) {
            let noAppsLabel = new St.Label({
                text: 'No applications found.\nCategories: ' + Object.keys(this._categories).length,
                style_class: 'manokwari-no-results',
                x_align: Clutter.ActorAlign.CENTER,
            });
            menuBox.add_child(noAppsLabel);
        }

        scrollView.add_child(menuBox);
        this._registerMenuItems(navItems, scrollView);
        this._animateSlide(scrollView, 'forward');
    }

    _showCategoryApps(categoryId) {
        let info = this._getCategoryInfo(categoryId);
        this._navigationStack.push({type: 'applications'});
        this._updateHeader(info.name, true);

        let scrollView = this._createScrollView();

        let menuBox = new St.BoxLayout({
            style_class: 'manokwari-menu-box',
            vertical: true,
            x_expand: true,
        });

        let navItems = [];
        let apps = this._categories[categoryId] || [];

        for (let appData of apps) {
            let appItem = this._createAppMenuItemFromData(appData);
            appItem._hasChildren = false;
            appItem._activateCallback = ((data) => () => {
                this._launchAppFromData(data);
                this._hidePanel();
            })(appData);
            appItem.connect('button-press-event', () => {
                appItem._activateCallback();
                return Clutter.EVENT_STOP;
            });
            menuBox.add_child(appItem);
            navItems.push(appItem);
        }

        scrollView.add_child(menuBox);
        this._registerMenuItems(navItems, scrollView);
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

        let navItems = [];

        // Home
        let homeItem = this._createMenuItem('Home', 'user-home-symbolic', false);
        homeItem._hasChildren = false;
        homeItem._activateCallback = () => this._openPlace(GLib.get_home_dir());
        homeItem.connect('button-press-event', () => {
            homeItem._activateCallback();
            return Clutter.EVENT_STOP;
        });
        menuBox.add_child(homeItem);
        navItems.push(homeItem);

        // Documents
        let docsPath = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS);
        if (docsPath) {
            let docsItem = this._createMenuItem('Documents', 'folder-documents-symbolic', false);
            docsItem._hasChildren = false;
            docsItem._activateCallback = () => this._openPlace(docsPath);
            docsItem.connect('button-press-event', () => {
                docsItem._activateCallback();
                return Clutter.EVENT_STOP;
            });
            menuBox.add_child(docsItem);
            navItems.push(docsItem);
        }

        // Downloads
        let downloadsPath = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD);
        if (downloadsPath) {
            let downloadsItem = this._createMenuItem('Downloads', 'folder-download-symbolic', false);
            downloadsItem._hasChildren = false;
            downloadsItem._activateCallback = () => this._openPlace(downloadsPath);
            downloadsItem.connect('button-press-event', () => {
                downloadsItem._activateCallback();
                return Clutter.EVENT_STOP;
            });
            menuBox.add_child(downloadsItem);
            navItems.push(downloadsItem);
        }

        // Pictures
        let picturesPath = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES);
        if (picturesPath) {
            let picturesItem = this._createMenuItem('Pictures', 'folder-pictures-symbolic', false);
            picturesItem._hasChildren = false;
            picturesItem._activateCallback = () => this._openPlace(picturesPath);
            picturesItem.connect('button-press-event', () => {
                picturesItem._activateCallback();
                return Clutter.EVENT_STOP;
            });
            menuBox.add_child(picturesItem);
            navItems.push(picturesItem);
        }

        // Music
        let musicPath = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_MUSIC);
        if (musicPath) {
            let musicItem = this._createMenuItem('Music', 'folder-music-symbolic', false);
            musicItem._hasChildren = false;
            musicItem._activateCallback = () => this._openPlace(musicPath);
            musicItem.connect('button-press-event', () => {
                musicItem._activateCallback();
                return Clutter.EVENT_STOP;
            });
            menuBox.add_child(musicItem);
            navItems.push(musicItem);
        }

        // Videos
        let videosPath = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS);
        if (videosPath) {
            let videosItem = this._createMenuItem('Videos', 'folder-videos-symbolic', false);
            videosItem._hasChildren = false;
            videosItem._activateCallback = () => this._openPlace(videosPath);
            videosItem.connect('button-press-event', () => {
                videosItem._activateCallback();
                return Clutter.EVENT_STOP;
            });
            menuBox.add_child(videosItem);
            navItems.push(videosItem);
        }

        scrollView.add_child(menuBox);
        this._registerMenuItems(navItems, scrollView);
        this._animateSlide(scrollView, 'forward');
    }

    _onSearchTextChanged() {
        let searchText = this._searchEntry.get_text().trim();

        if (searchText === '') {
            // Show main menu when search is cleared
            if (this._navigationStack.length > 0 || this._isSearchActive) {
                this._isSearchActive = false;
                this._navigationStack = [];
                this._showMainMenu(true);
            }
            return;
        }

        this._isSearchActive = true;
        this._showSearchResults(searchText);
    }

    _launchFirstSearchResult() {
        let searchText = this._searchEntry.get_text().trim();
        if (searchText === '')
            return;

        let searchResults = Gio.DesktopAppInfo.search(searchText);
        if (searchResults.length === 0 || searchResults[0].length === 0)
            return;

        let appId = searchResults[0][0];
        let appInfo = Gio.DesktopAppInfo.new(appId);
        if (!appInfo)
            return;

        let app = this._appSystem.lookup_app(appId);
        if (app) {
            app.activate();
        } else {
            appInfo.launch([], null);
        }
        this._hidePanel();
    }

    _showSearchResults(query) {
        // Use Gio.DesktopAppInfo.search for search results
        let searchResults = Gio.DesktopAppInfo.search(query);

        // Flatten the array of arrays and create app data objects
        let matchedApps = [];
        for (let group of searchResults) {
            for (let appId of group) {
                // Get the desktop app info
                let appInfo = Gio.DesktopAppInfo.new(appId);
                if (!appInfo)
                    continue;

                // Try to get Shell.App
                let app = this._appSystem.lookup_app(appId);

                matchedApps.push({
                    app: app,
                    appInfo: appInfo,
                    name: appInfo.get_name() || appId,
                    id: appId,
                });
            }
        }

        // Create results view
        // Use sliding container's actual height (already accounts for bottom section)
        let containerHeight = this._slidingContainer.height;

        let scrollView = new St.ScrollView({
            style_class: 'manokwari-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });
        scrollView.set_size(PANEL_WIDTH, containerHeight);

        let menuBox = new St.BoxLayout({
            style_class: 'manokwari-menu-box',
            vertical: true,
            x_expand: true,
        });

        let navItems = [];

        if (matchedApps.length === 0) {
            let noResultsLabel = new St.Label({
                text: 'No applications found',
                style_class: 'manokwari-no-results',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            noResultsLabel.opacity = 0;
            menuBox.add_child(noResultsLabel);
            noResultsLabel.ease({
                opacity: 255,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            for (let i = 0; i < matchedApps.length; i++) {
                let appData = matchedApps[i];
                let appItem = this._createAppMenuItemFromData(appData);
                appItem._hasChildren = false;
                appItem._activateCallback = ((data) => () => {
                    this._launchAppFromData(data);
                    this._hidePanel();
                })(appData);
                appItem.connect('button-press-event', () => {
                    appItem._activateCallback();
                    return Clutter.EVENT_STOP;
                });

                // Start with opacity 0 and slide in from left
                appItem.opacity = 0;
                appItem.translation_x = -20;
                menuBox.add_child(appItem);
                navItems.push(appItem);

                // Staggered fade-in and slide animation
                let delay = i * 30; // 30ms delay between each item
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                    appItem.ease({
                        opacity: 255,
                        translation_x: 0,
                        duration: 150,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                    return GLib.SOURCE_REMOVE;
                });
            }
        }

        scrollView.add_child(menuBox);

        // Replace content without animation for smooth search experience
        this._slidingContainer.destroy_all_children();
        scrollView.set_position(0, 0);
        this._slidingContainer.add_child(scrollView);

        // Register menu items for keyboard navigation
        this._registerMenuItems(navItems, scrollView);
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

    _createAppMenuItemFromData(appData) {
        let item = new St.BoxLayout({
            style_class: 'manokwari-menu-item',
            reactive: true,
            track_hover: true,
            height: 48,
            x_expand: true,
        });

        // Try to get icon from Shell.App first, fallback to AppInfo icon
        let icon;
        if (appData.app) {
            icon = appData.app.create_icon_texture(24);
        } else if (appData.appInfo) {
            let gicon = appData.appInfo.get_icon();
            icon = new St.Icon({
                gicon: gicon,
                icon_size: 24,
            });
        } else {
            icon = new St.Icon({
                icon_name: 'application-x-executable-symbolic',
                icon_size: 24,
            });
        }
        icon.style_class = 'manokwari-menu-item-icon';
        item.add_child(icon);

        let label = new St.Label({
            text: appData.name,
            style_class: 'manokwari-menu-item-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        item.add_child(label);

        return item;
    }

    _launchAppFromData(appData) {
        if (appData.app) {
            appData.app.activate();
        } else if (appData.appInfo) {
            appData.appInfo.launch([], null);
        }
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

    _createUserItem() {
        // Get current user info
        let userManager = AccountsService.UserManager.get_default();
        let user = userManager.get_user(GLib.get_user_name());

        let item = new St.BoxLayout({
            style_class: 'manokwari-user-item',
            reactive: true,
            track_hover: true,
            x_expand: true,
        });

        // Avatar
        let avatarFile = user.get_icon_file();
        let avatar;
        if (avatarFile && GLib.file_test(avatarFile, GLib.FileTest.EXISTS)) {
            avatar = new St.Bin({
                style_class: 'manokwari-user-avatar',
                style: `background-image: url("${avatarFile}");`,
            });
        } else {
            avatar = new St.Bin({
                style_class: 'manokwari-user-avatar',
                child: new St.Icon({
                    icon_name: 'avatar-default-symbolic',
                    icon_size: 32,
                }),
            });
        }
        item.add_child(avatar);

        // Name container (full name + username)
        let nameBox = new St.BoxLayout({
            vertical: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });

        let fullName = user.get_real_name() || GLib.get_user_name();
        let fullNameLabel = new St.Label({
            text: fullName,
            style_class: 'manokwari-user-fullname',
        });
        nameBox.add_child(fullNameLabel);

        let username = GLib.get_user_name();
        let usernameLabel = new St.Label({
            text: username,
            style_class: 'manokwari-user-username',
        });
        nameBox.add_child(usernameLabel);

        item.add_child(nameBox);

        // Click to open Settings -> System -> Users
        item.connect('button-press-event', () => {
            this._hidePanel();
            try {
                let subprocess = Gio.Subprocess.new(
                    ['gnome-control-center', 'users'],
                    Gio.SubprocessFlags.NONE
                );
            } catch (e) {
                // Fallback: try to open settings app
                let appInfo = Gio.DesktopAppInfo.new('gnome-control-center.desktop');
                if (appInfo)
                    appInfo.launch([], null);
            }
            return Clutter.EVENT_STOP;
        });

        return item;
    }

    _createBottomSection() {
        // Bottom section - sticks to bottom (User + Lock + Log Out + Power)
        let bottomSection = new St.BoxLayout({
            style_class: 'manokwari-bottom-section',
            vertical: true,
            x_expand: true,
        });

        // User component
        let userItem = this._createUserItem();
        bottomSection.add_child(userItem);

        // Separator between user and session actions
        bottomSection.add_child(new St.Widget({style_class: 'manokwari-separator', height: 1, x_expand: true}));

        // Lock item (same level as Power)
        let lockItem = this._createMenuItem('Lock', 'system-lock-screen-symbolic', false);
        lockItem.connect('button-press-event', () => {
            Main.screenShield.lock(true);
            this._hidePanel();
            return Clutter.EVENT_STOP;
        });
        bottomSection.add_child(lockItem);

        // Log Out item (same level as Power)
        let logoutItem = this._createMenuItem('Log Out', 'system-log-out-symbolic', false);
        logoutItem.connect('button-press-event', () => {
            this._hidePanel();
            this._systemActions.activateLogout();
            return Clutter.EVENT_STOP;
        });
        bottomSection.add_child(logoutItem);

        // Power item (expandable)
        let powerItem = this._createExpandableMenuItem('Power', 'system-shutdown-symbolic');
        bottomSection.add_child(powerItem);

        // Power options container (initially hidden with 0 height for animation)
        let powerOptionsBox = new St.BoxLayout({
            style_class: 'manokwari-power-options',
            vertical: true,
            x_expand: true,
            clip_to_allocation: true,
        });
        powerOptionsBox.set_height(0);
        powerOptionsBox._expanded = false;
        powerOptionsBox._targetHeight = 150; // 3 items * 42px height + margins + padding

        // Suspend
        let suspendItem = this._createSubMenuItem('Suspend', 'media-playback-pause-symbolic');
        suspendItem.connect('button-press-event', () => {
            this._hidePanel();
            this._systemActions.activateSuspend();
            return Clutter.EVENT_STOP;
        });
        powerOptionsBox.add_child(suspendItem);

        // Restart
        let restartItem = this._createSubMenuItem('Restart', 'system-reboot-symbolic');
        restartItem.connect('button-press-event', () => {
            this._hidePanel();
            this._systemActions.activateRestart();
            return Clutter.EVENT_STOP;
        });
        powerOptionsBox.add_child(restartItem);

        // Power Off
        let powerOffItem = this._createSubMenuItem('Power Off', 'system-shutdown-symbolic');
        powerOffItem.connect('button-press-event', () => {
            this._hidePanel();
            this._systemActions.activatePowerOff();
            return Clutter.EVENT_STOP;
        });
        powerOptionsBox.add_child(powerOffItem);

        bottomSection.add_child(powerOptionsBox);

        // Toggle power options on click with slide animation
        powerItem.connect('button-press-event', () => {
            let arrow = powerItem.get_last_child();
            if (powerOptionsBox._expanded) {
                // Collapse with animation
                powerOptionsBox.ease({
                    height: 0,
                    duration: ANIMATION_DURATION,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
                arrow.icon_name = 'go-up-symbolic';
                powerOptionsBox._expanded = false;
            } else {
                // Expand with animation
                powerOptionsBox.ease({
                    height: powerOptionsBox._targetHeight,
                    duration: ANIMATION_DURATION,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
                arrow.icon_name = 'go-down-symbolic';
                powerOptionsBox._expanded = true;
            }
            return Clutter.EVENT_STOP;
        });

        return bottomSection;
    }

    _updateHeader(title, showBack) {
        this._header.destroy_all_children();

        if (showBack) {
            // Show back button with title label (no search entry)
            let backButton = new St.Button({
                style_class: 'manokwari-back-button',
                child: new St.Icon({
                    icon_name: 'go-previous-symbolic',
                    icon_size: 20,
                }),
                width: 50,
                height: 50,
            });
            backButton.connect('clicked', () => {
                if (!this._isAnimating) this._goBack();
            });
            this._header.add_child(backButton);

            let headerLabel = new St.Label({
                text: title,
                style_class: 'manokwari-header-label',
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            this._header.add_child(headerLabel);
        } else {
            // Show search entry (main menu view) - entry first, icon on right
            this._searchEntry = new St.Entry({
                style_class: 'manokwari-search-entry',
                hint_text: 'Search applications...',
                can_focus: true,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._searchEntry.clutter_text.connect('text-changed', () => {
                this._onSearchTextChanged();
            });
            this._searchEntry.clutter_text.connect('key-press-event', (actor, event) => {
                let symbol = event.get_key_symbol();
                if (symbol === Clutter.KEY_Escape) {
                    if (this._searchEntry.get_text() !== '') {
                        this._searchEntry.set_text('');
                        return Clutter.EVENT_STOP;
                    }
                } else if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
                    // Launch first app in search results
                    this._launchFirstSearchResult();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            this._header.add_child(this._searchEntry);

            let searchIcon = new St.Icon({
                icon_name: 'edit-find-symbolic',
                style_class: 'manokwari-search-icon',
                icon_size: 16,
            });
            this._header.add_child(searchIcon);
            // Note: Focus is handled by _showPanel's onComplete callback
        }
    }

    _goBack() {
        if (this._navigationStack.length === 0) {
            this._showMainMenu(true);
            return;
        }

        let previous = this._navigationStack.pop();

        if (previous.type === 'main') {
            this._showMainMenu(true);
        } else if (previous.type === 'applications') {
            // Go back to applications categories list
            this._navigationStack.push({type: 'main'});
            this._updateHeader('Applications', true);

            let scrollView = this._createScrollView();
            let menuBox = new St.BoxLayout({
                style_class: 'manokwari-menu-box',
                vertical: true,
                x_expand: true,
            });

            const categoryOrder = [
                'Network', 'Office', 'Graphics', 'AudioVideo', 'Video', 'Audio',
                'Development', 'Game', 'Education', 'Science', 'System',
                'Utility', 'Settings', 'Other'
            ];

            for (let categoryId of categoryOrder) {
                if (this._categories[categoryId] && this._categories[categoryId].length > 0) {
                    let info = this._getCategoryInfo(categoryId);
                    let categoryItem = this._createMenuItem(
                        `${info.name} (${this._categories[categoryId].length})`,
                        info.icon,
                        true
                    );
                    categoryItem.connect('button-press-event', () => {
                        if (!this._isAnimating) this._showCategoryApps(categoryId);
                        return Clutter.EVENT_STOP;
                    });
                    menuBox.add_child(categoryItem);
                }
            }

            for (let categoryId in this._categories) {
                if (!categoryOrder.includes(categoryId) && this._categories[categoryId].length > 0) {
                    let info = this._getCategoryInfo(categoryId);
                    let categoryItem = this._createMenuItem(
                        `${info.name} (${this._categories[categoryId].length})`,
                        info.icon,
                        true
                    );
                    categoryItem.connect('button-press-event', () => {
                        if (!this._isAnimating) this._showCategoryApps(categoryId);
                        return Clutter.EVENT_STOP;
                    });
                    menuBox.add_child(categoryItem);
                }
            }

            scrollView.add_child(menuBox);
            this._animateSlide(scrollView, 'back');
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
        if (this._loadAppsTimeoutId) {
            GLib.source_remove(this._loadAppsTimeoutId);
            this._loadAppsTimeoutId = null;
        }
        if (this._installedChangedId && this._appSystem) {
            this._appSystem.disconnect(this._installedChangedId);
            this._installedChangedId = null;
        }
        this._hidePanel();
        super.destroy();
    }
});

export default class ManokwariExtension extends Extension {
    enable() {
        this._indicator = new ManokwariIndicator();
        // Add to the left side of the panel
        Main.panel.addToStatusArea('manokwari-indicator', this._indicator, 0, 'left');

        // Move date/time to the right (left of quick settings)
        this._moveDateTimeToRight();

        // Setup hover trigger for quick settings
        this._setupQuickSettingsHover();

        // Move activities/workspace to center
        this._moveActivitiesToCenter();

        // Hide the bottom dock when extension is enabled
        this._dock = null;
        this._hideDock();

        // Override hot corner to open our panel instead of overview
        this._setupHotCorner();

        // Setup Meta+Space keybinding to toggle panel
        this._setupKeybinding();
    }

    _setupKeybinding() {
        // Grab the Super+Space accelerator
        this._acceleratorAction = global.display.grab_accelerator('<Super>space', Meta.KeyBindingFlags.NONE);

        if (this._acceleratorAction !== Meta.KeyBindingAction.NONE) {
            let name = Meta.external_binding_name_for_action(this._acceleratorAction);
            Main.wm.allowKeybinding(name, Shell.ActionMode.ALL);

            this._acceleratorActivatedId = global.display.connect('accelerator-activated', (display, action) => {
                if (action === this._acceleratorAction) {
                    if (this._indicator) {
                        this._indicator._togglePanel();
                    }
                }
            });
        }
    }

    _removeKeybinding() {
        if (this._acceleratorActivatedId) {
            global.display.disconnect(this._acceleratorActivatedId);
            this._acceleratorActivatedId = null;
        }

        if (this._acceleratorAction && this._acceleratorAction !== Meta.KeyBindingAction.NONE) {
            global.display.ungrab_accelerator(this._acceleratorAction);
            this._acceleratorAction = null;
        }
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
            // Add to position 0 (left of quick settings)
            rightBox.insert_child_at_index(dateMenu.container, 0);
        }

        // Add hover trigger for dateMenu
        this._dateMenuHoverId = dateMenu.container.connect('enter-event', () => {
            if (!dateMenu.menu.isOpen) {
                dateMenu.menu.open();
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _setupQuickSettingsHover() {
        let quickSettings = Main.panel.statusArea.quickSettings;
        if (!quickSettings)
            return;

        // Add hover trigger for quick settings
        this._quickSettingsHoverId = quickSettings.container.connect('enter-event', () => {
            if (!quickSettings.menu.isOpen) {
                quickSettings.menu.open();
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _setupHotCorner() {
        // Store original hot corner functions to restore later
        this._originalHotCorners = [];

        // Disable all existing hot corners and override with our behavior
        for (let hotCorner of Main.layoutManager.hotCorners) {
            if (hotCorner) {
                // Store original _toggleOverview function
                this._originalHotCorners.push({
                    corner: hotCorner,
                    originalToggle: hotCorner._toggleOverview.bind(hotCorner)
                });

                // Override to open our panel instead
                hotCorner._toggleOverview = () => {
                    if (this._indicator && !this._indicator._panelVisible) {
                        this._indicator._showPanel();
                    }
                };
            }
        }
    }

    _restoreHotCorner() {
        // Restore original hot corner behavior
        if (this._originalHotCorners) {
            for (let item of this._originalHotCorners) {
                if (item.corner && item.originalToggle) {
                    item.corner._toggleOverview = item.originalToggle;
                }
            }
            this._originalHotCorners = null;
        }
    }

    _restoreDateTimePosition() {
        let dateMenu = Main.panel.statusArea.dateMenu;
        if (!dateMenu)
            return;

        // Disconnect hover handler
        if (this._dateMenuHoverId) {
            dateMenu.container.disconnect(this._dateMenuHoverId);
            this._dateMenuHoverId = null;
        }

        let centerBox = Main.panel._centerBox;
        let rightBox = Main.panel._rightBox;

        if (rightBox.contains(dateMenu.container)) {
            rightBox.remove_child(dateMenu.container);
            centerBox.add_child(dateMenu.container);
        }
    }

    _removeQuickSettingsHover() {
        let quickSettings = Main.panel.statusArea.quickSettings;
        if (!quickSettings)
            return;

        if (this._quickSettingsHoverId) {
            quickSettings.container.disconnect(this._quickSettingsHoverId);
            this._quickSettingsHoverId = null;
        }
    }

    disable() {
        // Remove keybinding
        this._removeKeybinding();

        // Restore hot corner behavior
        this._restoreHotCorner();

        // Show the dock again when extension is disabled
        this._showDock();
        this._dock = null;

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        // Remove quick settings hover
        this._removeQuickSettingsHover();

        // Restore date/time to center
        this._restoreDateTimePosition();

        // Restore activities to left
        this._restoreActivitiesPosition();
    }
}

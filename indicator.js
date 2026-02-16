/* indicator.js
 *
 * Main panel indicator for Praya extension
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import AccountsService from 'gi://AccountsService';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

import { ChatbotSettings, PrayaChatbotPanel } from './chatbot.js';
import { PrayaPreferencesDialog } from './preferences.js';
import {
    PANEL_WIDTH,
    HEADER_HEIGHT,
    ANIMATION_DURATION,
    MARGIN_LEFT,
    MARGIN_TOP,
    MARGIN_BOTTOM,
    MARGIN_BOTTOM_BAR,
    CHATBOT_PANEL_WIDTH,
    FAVOURITES_FILE
} from './constants.js';

export const PrayaIndicator = GObject.registerClass(
class PrayaIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Praya Menu');

        // Create a box to hold the logo
        let box = new St.BoxLayout({style_class: 'panel-status-menu-box'});

        // Add logo using St.Widget with CSS background
        let logo = new St.Widget({
            style_class: 'praya-panel-logo',
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

        // Favourites
        this._favourites = [];
        this._loadFavourites();

        // Context menu for right-click
        this._contextMenu = null;

        // System actions for power menu
        this._systemActions = SystemActions.getDefault();

        // Chatbot state
        this._chatbotSettings = new ChatbotSettings();
        this._isChatbotMode = false;
        this._chatbotPanel = null;
        this._chatbotMessages = []; // Preserve messages across panel hide/show
        this._isTransitioningChatbot = false; // Prevent panel hide during transition
        this._servicesConfig = this._loadServicesConfig(); // Load AI enabled state
        this._mainMenuHoverActivate = this._servicesConfig.mainMenuHoverActivate || false;

        // Multi-monitor support - track which monitor the panel is on
        this._currentMonitor = null;

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

        // Connect hover handler to show panel (only if enabled in config)
        this.connect('enter-event', () => {
            if (!this._mainMenuHoverActivate) return Clutter.EVENT_PROPAGATE;
            if (this._hoverTimeoutId) {
                GLib.source_remove(this._hoverTimeoutId);
                this._hoverTimeoutId = null;
            }
            if (!this._panelVisible) {
                this._showPanel();
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Click handler for indicator button
        this.connect('button-press-event', () => {
            // Cancel any pending hide timeout
            if (this._hoverTimeoutId) {
                GLib.source_remove(this._hoverTimeoutId);
                this._hoverTimeoutId = null;
            }
            if (!this._mainMenuHoverActivate) {
                // When hover is disabled, click toggles the panel
                if (this._panelVisible) {
                    this._hidePanel();
                } else {
                    this._showPanel();
                }
            } else {
                // When hover is active, click only opens (hover handles close)
                if (!this._panelVisible) {
                    this._showPanel();
                }
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

    _isLiveSession() {
        try {
            // Check for live-boot marker directory
            let liveDir = Gio.File.new_for_path('/run/live');
            if (liveDir.query_exists(null))
                return true;

            // Check kernel command line for boot=live
            let cmdlineFile = Gio.File.new_for_path('/proc/cmdline');
            if (cmdlineFile.query_exists(null)) {
                let [success, contents] = cmdlineFile.load_contents(null);
                if (success) {
                    let decoder = new TextDecoder('utf-8');
                    let cmdline = decoder.decode(contents);
                    if (cmdline.includes('boot=live'))
                        return true;
                }
            }
        } catch (e) {
            log(`Praya: Error detecting live session: ${e.message}`);
        }
        return false;
    }

    _loadFavourites() {
        try {
            let file = Gio.File.new_for_path(FAVOURITES_FILE);
            if (file.query_exists(null)) {
                let [success, contents] = file.load_contents(null);
                if (success) {
                    let decoder = new TextDecoder('utf-8');
                    let json = decoder.decode(contents);
                    this._favourites = JSON.parse(json);
                }
            } else {
                // Create file with default favourites
                let terminalOrInstaller = this._isLiveSession()
                    ? 'calamares-install-blankon.desktop'
                    : 'org.gnome.Ptyxis.desktop';
                this._favourites = [
                    'firefox.desktop',
                    'org.gnome.Nautilus.desktop',
                    terminalOrInstaller,
                ];
                this._saveFavourites();
            }
        } catch (e) {
            log(`Praya: Error loading favourites: ${e.message}`);
            this._favourites = [];
        }
    }

    _saveFavourites() {
        try {
            let file = Gio.File.new_for_path(FAVOURITES_FILE);
            let parent = file.get_parent();
            if (!parent.query_exists(null)) {
                parent.make_directory_with_parents(null);
            }
            let json = JSON.stringify(this._favourites);
            let encoder = new TextEncoder();
            let contents = encoder.encode(json);
            file.replace_contents(contents, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            log(`Praya: Error saving favourites: ${e.message}`);
        }
    }

    _isFavourite(appId) {
        return this._favourites.includes(appId);
    }

    _addFavourite(appId) {
        if (!this._favourites.includes(appId)) {
            this._favourites.push(appId);
            this._saveFavourites();
        }
    }

    _removeFavourite(appId) {
        let index = this._favourites.indexOf(appId);
        if (index !== -1) {
            this._favourites.splice(index, 1);
            this._saveFavourites();
        }
    }

    _showContextMenu(appData, sourceActor) {
        // Destroy existing context menu
        if (this._contextMenu) {
            this._contextMenu.destroy();
            this._contextMenu = null;
        }

        // Cancel any pending hide timeout
        if (this._hoverTimeoutId) {
            GLib.source_remove(this._hoverTimeoutId);
            this._hoverTimeoutId = null;
        }

        let isFav = this._isFavourite(appData.id);

        // Create context menu container
        this._contextMenu = new St.BoxLayout({
            style_class: 'praya-context-menu',
            vertical: true,
            reactive: true,
            track_hover: true,
        });

        // Add hover handlers to keep panel open while interacting with context menu
        this._contextMenu.connect('enter-event', () => {
            if (this._hoverTimeoutId) {
                GLib.source_remove(this._hoverTimeoutId);
                this._hoverTimeoutId = null;
            }
            // Cancel context menu close timeout
            if (this._contextMenuTimeoutId) {
                GLib.source_remove(this._contextMenuTimeoutId);
                this._contextMenuTimeoutId = null;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._contextMenu.connect('leave-event', () => {
            // Close context menu when mouse leaves it
            // Use a small delay to allow clicking on items
            if (this._contextMenuTimeoutId) {
                GLib.source_remove(this._contextMenuTimeoutId);
            }
            this._contextMenuTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                this._contextMenuTimeoutId = null;
                this._closeContextMenu();
                return GLib.SOURCE_REMOVE;
            });
            return Clutter.EVENT_PROPAGATE;
        });

        // Create menu item
        let menuItemText = isFav ? 'Unpin' : 'Pin to Menu';
        let menuItemIcon = isFav ? 'view-pin-symbolic' : 'view-pin-symbolic';

        let menuItem = new St.BoxLayout({
            style_class: 'praya-context-menu-item',
            reactive: true,
            track_hover: true,
        });

        let icon = new St.Icon({
            icon_name: menuItemIcon,
            icon_size: 16,
            style_class: 'praya-context-menu-icon',
        });
        menuItem.add_child(icon);

        let label = new St.Label({
            text: menuItemText,
            y_align: Clutter.ActorAlign.CENTER,
        });
        menuItem.add_child(label);

        menuItem.connect('button-press-event', () => {
            if (isFav) {
                this._removeFavourite(appData.id);
            } else {
                this._addFavourite(appData.id);
            }
            this._closeContextMenu();
            // Always reset to main menu after pin/unpin
            this._navigationStack = [];
            this._isSearchActive = false;
            if (this._searchEntry) {
                this._searchEntry.set_text('');
            }
            this._showMainMenu(false);
            return Clutter.EVENT_STOP;
        });

        this._contextMenu.add_child(menuItem);

        // Position the context menu near the source actor
        let [x, y] = sourceActor.get_transformed_position();
        let [width, height] = sourceActor.get_size();

        this._contextMenu.set_position(x + width - 150, y + height / 2);

        Main.layoutManager.addTopChrome(this._contextMenu);

        // Close context menu when clicking elsewhere
        this._contextMenuCaptureId = global.stage.connect('captured-event', (actor, event) => {
            if (event.type() === Clutter.EventType.BUTTON_PRESS) {
                let [eventX, eventY] = event.get_coords();
                let dominated = this._contextMenu.contains(global.stage.get_actor_at_pos(Clutter.PickMode.ALL, eventX, eventY));
                if (!dominated) {
                    this._closeContextMenu();
                }
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _closeContextMenu() {
        if (this._contextMenuTimeoutId) {
            GLib.source_remove(this._contextMenuTimeoutId);
            this._contextMenuTimeoutId = null;
        }
        if (this._contextMenuCaptureId) {
            global.stage.disconnect(this._contextMenuCaptureId);
            this._contextMenuCaptureId = null;
        }
        if (this._contextMenu) {
            Main.layoutManager.removeChrome(this._contextMenu);
            this._contextMenu.destroy();
            this._contextMenu = null;
        }
    }

    _getFavouriteApps() {
        let favouriteApps = [];
        for (let appId of this._favourites) {
            let appInfo = GioUnix.DesktopAppInfo.new(appId);
            if (appInfo) {
                let app = this._appSystem.lookup_app(appId);
                favouriteApps.push({
                    app: app,
                    appInfo: appInfo,
                    name: appInfo.get_name() || appId,
                    id: appId,
                });
            }
        }
        return favouriteApps;
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
        // Clean up any existing hover zone first to prevent orphaned zones
        if (this._hoverZone) {
            try {
                Main.layoutManager.removeChrome(this._hoverZone);
            } catch (e) {
                // Ignore if already removed
            }
            this._hoverZone.destroy();
            this._hoverZone = null;
        }

        if (this._panel) {
            try {
                Main.layoutManager.removeChrome(this._panel);
            } catch (e) {
                // Ignore if already removed
            }
            this._panel.destroy();
            this._panel = null;
        }

        // Clean up existing menu button hover area
        this._removeMenuButtonHoverArea();

        // Use the monitor where the pointer currently is (where user clicked the indicator)
        this._currentMonitor = Main.layoutManager.currentMonitor;
        let monitor = this._currentMonitor;
        let panelHeight = Main.panel.height;
        let isBottomBar = this._servicesConfig.panelPosition === 'bottom';
        let bottomMargin = isBottomBar ? MARGIN_BOTTOM_BAR : MARGIN_BOTTOM;
        let availableHeight = monitor.height - panelHeight - MARGIN_TOP - bottomMargin;

        let effectiveWidth = this._getEffectivePanelWidth();

        // Create invisible hover zone that includes margins
        // Position relative to the current monitor's coordinates
        let hoverZoneY = isBottomBar ? monitor.y : monitor.y + panelHeight;
        this._hoverZone = new St.Widget({
            reactive: true,
            track_hover: true,
            x: monitor.x,
            y: hoverZoneY,
            width: effectiveWidth + MARGIN_LEFT * 2,
            height: availableHeight + MARGIN_TOP + bottomMargin,
        });

        // Create the main panel container - position depends on bar location
        // Position relative to the current monitor's coordinates
        let panelY = isBottomBar ? monitor.y + MARGIN_TOP : monitor.y + panelHeight + MARGIN_TOP;
        this._panel = new St.BoxLayout({
            style_class: 'praya-panel',
            vertical: true,
            reactive: true,
            track_hover: true,
            x: monitor.x + MARGIN_LEFT,
            y: panelY,
            width: effectiveWidth,
            height: availableHeight,
        });

        // Create header (will be populated by _showMainMenu -> _updateHeader)
        this._header = new St.BoxLayout({
            style_class: 'praya-panel-header',
            height: HEADER_HEIGHT,
            x_expand: true,
        });

        this._panel.add_child(this._header);

        // Create persistent bottom section first to measure its height
        this._bottomSection = this._createBottomSection();

        // Base height for bottom section when collapsed (User ~72 + Lock 52 + LogOut 52 + Power 52 + separator ~17 + padding)
        this._bottomSectionBaseHeight = 260;
        // Additional height when power menu is expanded
        this._powerOptionsHeight = 150;

        // Create sliding container for navigation with clipping
        this._slidingContainer = new St.Widget({
            style_class: 'praya-sliding-container',
            x_expand: true,
            clip_to_allocation: true,
        });
        this._slidingContainer.set_size(effectiveWidth, availableHeight - HEADER_HEIGHT - this._bottomSectionBaseHeight);

        this._panel.add_child(this._slidingContainer);
        this._panel.add_child(this._bottomSection);

        // Check if we should restore chatbot mode
        if (this._isChatbotMode) {
            // Restore chatbot mode
            this._restoreChatbotMode();
        } else {
            // Show main menu
            this._navigationStack = [];
            this._showMainMenu(false);
        }

        // Start with opacity 0 and off-screen to the left for slide-in animation
        this._panel.opacity = 0;
        this._panel.x = monitor.x + MARGIN_LEFT - effectiveWidth;

        Main.layoutManager.addTopChrome(this._hoverZone);
        Main.layoutManager.addTopChrome(this._panel);
        this._panelVisible = true;

        // Fade in + slide to right animation
        let targetWidth = this._isChatbotMode ? CHATBOT_PANEL_WIDTH : effectiveWidth;
        this._panel.ease({
            opacity: 255,
            x: monitor.x + MARGIN_LEFT,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                // Grab keyboard focus
                if (this._isChatbotMode && this._chatbotPanel) {
                    this._chatbotPanel.focusInput();
                } else if (this._searchEntry) {
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
            if (this._mainMenuHoverActivate) {
                this._scheduleHidePanel();
            }
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
            if (this._mainMenuHoverActivate) {
                this._scheduleHidePanel();
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Also handle leaving the indicator button
        this._indicatorLeaveId = this.connect('leave-event', () => {
            if (this._mainMenuHoverActivate) {
                this._scheduleHidePanel();
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Add click-outside handler for stage (desktop background)
        this._captureEventId = global.stage.connect('captured-event', (actor, event) => {
            if (event.type() === Clutter.EventType.BUTTON_PRESS) {
                let [x, y] = event.get_coords();

                // Check if click is on the indicator button or menu button hover area (don't hide)
                let clickedActor = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y);
                let dominated = this.contains(clickedActor);
                if (dominated) {
                    return Clutter.EVENT_PROPAGATE;
                }
                if (this._menuButtonHoverArea && (this._menuButtonHoverArea === clickedActor || this._menuButtonHoverArea.contains(clickedActor))) {
                    return Clutter.EVENT_PROPAGATE;
                }

                // Check if click is outside the panel (with margins)
                // Use actual panel width to handle chatbot mode (400px) vs normal mode (325px)
                // Account for monitor offset for multi-monitor setups
                let monitor = this._currentMonitor;
                let currentPanelWidth = this._panel ? this._panel.width : PANEL_WIDTH;
                let panelLeft = monitor.x + MARGIN_LEFT;
                let panelRight = panelLeft + currentPanelWidth;
                let isBottomBar = this._servicesConfig.panelPosition === 'bottom';
                let panelTop = isBottomBar ? monitor.y + MARGIN_TOP : monitor.y + Main.panel.height + MARGIN_TOP;
                let panelBottom = panelTop + this._panel.height;

                if (x < panelLeft || x > panelRight || y < panelTop || y > panelBottom) {
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

        // Create the menu button hover area
        this._setupMenuButtonHoverArea();
    }

    _setupMenuButtonHoverArea() {
        let monitor = this._currentMonitor || Main.layoutManager.primaryMonitor;
        if (!monitor) return;

        let isBottomBar = this._servicesConfig.panelPosition === 'bottom';
        let triggerX = monitor.x;
        let triggerY = isBottomBar
            ? monitor.y + monitor.height - 25
            : monitor.y;

        this._menuButtonHoverArea = new St.Widget({
            reactive: true,
            track_hover: true,
            x: triggerX,
            y: triggerY,
            width: 75,
            height: 25,
            style: 'background-color: transparent;',
        });

        this._menuButtonHoverArea.connect('button-press-event', () => {
            if (this._panelVisible) {
                this._hidePanel();
            } else {
                this._showPanel();
            }
            return Clutter.EVENT_STOP;
        });

        // Hover behavior same as indicator button
        this._menuButtonHoverArea.connect('enter-event', () => {
            if (!this._mainMenuHoverActivate) return Clutter.EVENT_PROPAGATE;
            if (this._hoverTimeoutId) {
                GLib.source_remove(this._hoverTimeoutId);
                this._hoverTimeoutId = null;
            }
            if (!this._panelVisible) {
                this._showPanel();
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._menuButtonHoverArea.connect('leave-event', () => {
            if (this._mainMenuHoverActivate) {
                this._scheduleHidePanel();
            }
            return Clutter.EVENT_PROPAGATE;
        });

        global.stage.add_child(this._menuButtonHoverArea);
    }

    _removeMenuButtonHoverArea() {
        if (this._menuButtonHoverArea) {
            if (this._menuButtonHoverArea.get_parent()) {
                this._menuButtonHoverArea.get_parent().remove_child(this._menuButtonHoverArea);
            }
            this._menuButtonHoverArea.destroy();
            this._menuButtonHoverArea = null;
        }
    }

    _scheduleHidePanel() {
        // Don't schedule hide if context menu is open or transitioning chatbot
        if (this._contextMenu || this._isTransitioningChatbot) {
            return;
        }

        if (this._hoverTimeoutId) {
            GLib.source_remove(this._hoverTimeoutId);
        }
        this._hoverTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._hoverTimeoutId = null;
            // Double-check context menu isn't open and not transitioning when timeout fires
            if (!this._contextMenu && !this._isTransitioningChatbot) {
                this._hidePanel();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _hidePanel() {
        // Close context menu first
        this._closeContextMenu();

        // Preserve chatbot messages before destroying panel (keep _isChatbotMode flag)
        if (this._chatbotPanel) {
            this._chatbotMessages = this._chatbotPanel.getMessages();
            this._chatbotPanel.destroy();
            this._chatbotPanel = null;
        }

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

        // Remove menu button hover area
        this._removeMenuButtonHoverArea();

        // Get the monitor offset for animation (use stored monitor or fall back to current)
        let monitorX = this._currentMonitor ? this._currentMonitor.x : 0;

        // Immediately disable reactivity to prevent blocking clicks during animation
        if (this._hoverZone) {
            this._hoverZone.reactive = false;
        }
        if (this._panel) {
            this._panel.reactive = false;
        }

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
                x: monitorX + MARGIN_LEFT - this._getEffectivePanelWidth(),
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (this._hoverZone) {
                        try {
                            Main.layoutManager.removeChrome(this._hoverZone);
                        } catch (e) {
                            // Ignore if already removed
                        }
                        this._hoverZone.destroy();
                        this._hoverZone = null;
                    }
                    if (this._panel) {
                        try {
                            Main.layoutManager.removeChrome(this._panel);
                        } catch (e) {
                            // Ignore if already removed
                        }
                        this._panel.destroy();
                        this._panel = null;
                    }
                    // Clear the stored monitor reference
                    this._currentMonitor = null;
                }
            });
        }
    }

    _createScrollView(height = null) {
        let scrollView = new St.ScrollView({
            style_class: 'praya-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });
        // Use sliding container height which already accounts for bottom section
        let containerHeight = this._slidingContainer ? this._slidingContainer.height : 400;
        scrollView.set_size(this._getEffectivePanelWidth(), height || containerHeight);
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
            this._menuItems[this._focusedIndex].remove_style_class_name('praya-menu-item-focused');
        }

        this._focusedIndex = index;

        // Add highlight to new item
        if (this._focusedIndex >= 0 && this._focusedIndex < this._menuItems.length) {
            let item = this._menuItems[this._focusedIndex];
            item.add_style_class_name('praya-menu-item-focused');

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

        let panelWidth = this._getEffectivePanelWidth();

        // Use sliding container's actual height (already accounts for bottom section)
        let containerHeight = this._slidingContainer.height;

        // Get current content
        let currentContent = this._slidingContainer.get_first_child();

        // Set initial position for new content
        newContent.set_position(direction === 'forward' ? panelWidth : -panelWidth, 0);
        newContent.set_size(panelWidth, containerHeight);
        this._slidingContainer.add_child(newContent);

        // Animate current content out
        if (currentContent) {
            currentContent.ease({
                x: direction === 'forward' ? -panelWidth : panelWidth,
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

        // Use stored monitor from when panel was opened
        let monitor = this._currentMonitor || Main.layoutManager.currentMonitor;

        // Create a container for the whole view
        let contentContainer = new St.BoxLayout({
            style_class: 'praya-content-container',
            vertical: true,
            x_expand: true,
            y_expand: true,
        });

        // Scroll view takes remaining space (y_expand)
        let scrollView = new St.ScrollView({
            style_class: 'praya-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });

        let menuBox = new St.BoxLayout({
            style_class: 'praya-menu-box',
            vertical: true,
            x_expand: true,
        });

        let navItems = [];

        // Read layout preference
        this._servicesConfig = this._loadServicesConfig();
        let useGrid = this._servicesConfig.appMenuLayout === 'grid';

        // Show favourite apps above Applications
        let favouriteApps = this._getFavouriteApps();
        if (favouriteApps.length > 0) {
            if (useGrid) {
                let gridContainer = this._createAppGridContainer();
                for (let appData of favouriteApps) {
                    let gridItem = this._createAppGridItem(appData, true);
                    gridItem._hasChildren = false;
                    gridItem._appData = appData;
                    gridItem._activateCallback = ((data) => () => {
                        this._launchAppFromData(data);
                        this._hidePanel();
                    })(appData);
                    gridItem.connect('button-press-event', (actor, event) => {
                        if (event.get_button() === 3) {
                            this._showContextMenu(appData, actor);
                            return Clutter.EVENT_STOP;
                        }
                        gridItem._activateCallback();
                        return Clutter.EVENT_STOP;
                    });
                    gridContainer._addGridItem(gridItem);
                    navItems.push(gridItem);
                }
                menuBox.add_child(gridContainer);
            } else {
                for (let appData of favouriteApps) {
                    let appItem = this._createAppMenuItemFromData(appData, true);
                    appItem._hasChildren = false;
                    appItem._appData = appData;
                    appItem._activateCallback = ((data) => () => {
                        this._launchAppFromData(data);
                        this._hidePanel();
                    })(appData);
                    appItem.connect('button-press-event', (actor, event) => {
                        if (event.get_button() === 3) {
                            this._showContextMenu(appData, actor);
                            return Clutter.EVENT_STOP;
                        }
                        appItem._activateCallback();
                        return Clutter.EVENT_STOP;
                    });
                    menuBox.add_child(appItem);
                    navItems.push(appItem);
                }
            }
            // Separator after favourites
            menuBox.add_child(new St.Widget({style_class: 'praya-separator', height: 1, x_expand: true}));
        }

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
        menuBox.add_child(new St.Widget({style_class: 'praya-separator', height: 1, x_expand: true}));

        // System Settings item (opens GNOME Settings directly)
        let settingsItem = this._createMenuItem('System Settings', 'preferences-system-symbolic', false);
        settingsItem._hasChildren = false;
        settingsItem._activateCallback = () => {
            let appInfo = GioUnix.DesktopAppInfo.new('gnome-control-center.desktop');
            if (appInfo) {
                appInfo.launch([], null);
            } else {
                appInfo = GioUnix.DesktopAppInfo.new('org.gnome.Settings.desktop');
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

        // Praya Preferences item (opens preferences dialog)
        let prefsItem = this._createMenuItem('Praya Preferences', 'preferences-other-symbolic', false);
        prefsItem._hasChildren = false;
        prefsItem._activateCallback = () => {
            this._hidePanel();

            // Pause posture polling while preferences is open
            let ext = Main.extensionManager.lookup('praya@blankonlinux.id');
            if (ext?.stateObj?.pausePosturePolling) {
                ext.stateObj.pausePosturePolling();
            }

            let dialog = new PrayaPreferencesDialog();
            dialog.open(global.get_current_time());

            // Resume polling when dialog closes
            dialog.connect('destroy', () => {
                if (ext?.stateObj?.resumePosturePolling) {
                    ext.stateObj.resumePosturePolling();
                }
            });
        };
        prefsItem.connect('button-press-event', () => {
            prefsItem._activateCallback();
            return Clutter.EVENT_STOP;
        });
        menuBox.add_child(prefsItem);
        navItems.push(prefsItem);

        // About BlankOn (has children)
        let aboutItem = this._createMenuItem('About BlankOn', 'help-about-symbolic', true);
        aboutItem._hasChildren = true;
        aboutItem._activateCallback = () => {
            if (!this._isAnimating) this._showAboutBlankOn();
        };
        aboutItem.connect('button-press-event', () => {
            aboutItem._activateCallback();
            return Clutter.EVENT_STOP;
        });
        menuBox.add_child(aboutItem);
        navItems.push(aboutItem);

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
            contentContainer.set_size(this._getEffectivePanelWidth(), containerHeight);
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

        let useGrid = this._servicesConfig.appMenuLayout === 'grid';

        let scrollView = this._createScrollView();

        let menuBox = new St.BoxLayout({
            style_class: 'praya-menu-box',
            vertical: true,
            x_expand: true,
        });

        let navItems = [];

        if (useGrid) {
            // Grid mode: flatten all apps, sort alphabetically, render as grid
            let allApps = [];
            for (let categoryId in this._categories) {
                for (let appData of this._categories[categoryId]) {
                    allApps.push(appData);
                }
            }
            // Deduplicate by app id
            let seen = new Set();
            allApps = allApps.filter(app => {
                if (seen.has(app.id)) return false;
                seen.add(app.id);
                return true;
            });
            allApps.sort((a, b) => a.name.localeCompare(b.name));

            if (allApps.length > 0) {
                let gridContainer = this._createAppGridContainer();
                for (let appData of allApps) {
                    let gridItem = this._createAppGridItem(appData);
                    gridItem._hasChildren = false;
                    gridItem._appData = appData;
                    gridItem._activateCallback = ((data) => () => {
                        this._launchAppFromData(data);
                        this._hidePanel();
                    })(appData);
                    gridItem.connect('button-press-event', (actor, event) => {
                        if (event.get_button() === 3) {
                            this._showContextMenu(appData, actor);
                            return Clutter.EVENT_STOP;
                        }
                        gridItem._activateCallback();
                        return Clutter.EVENT_STOP;
                    });
                    gridContainer._addGridItem(gridItem);
                    navItems.push(gridItem);
                }
                menuBox.add_child(gridContainer);
            } else {
                let noAppsLabel = new St.Label({
                    text: 'No applications found.',
                    style_class: 'praya-no-results',
                    x_align: Clutter.ActorAlign.CENTER,
                });
                menuBox.add_child(noAppsLabel);
            }
        } else {
            // List mode: show category tree (original behavior)
            const categoryOrder = [
                'Network', 'Office', 'Graphics', 'AudioVideo', 'Video', 'Audio',
                'Development', 'Game', 'Education', 'Science', 'System',
                'Utility', 'Settings', 'Other'
            ];

            for (let categoryId of categoryOrder) {
                if (this._categories[categoryId] && this._categories[categoryId].length > 0) {
                    let info = this._getCategoryInfo(categoryId);
                    let categoryItem = this._createMenuItem(
                        info.name,
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
                        info.name,
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
                    style_class: 'praya-no-results',
                    x_align: Clutter.ActorAlign.CENTER,
                });
                menuBox.add_child(noAppsLabel);
            }
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
            style_class: 'praya-menu-box',
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
            appItem.connect('button-press-event', (actor, event) => {
                if (event.get_button() === 3) {
                    // Right-click - show context menu
                    this._showContextMenu(appData, actor);
                    return Clutter.EVENT_STOP;
                }
                // Left-click - launch app
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
            style_class: 'praya-menu-box',
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
                // Maintain focus on search entry after reset
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    if (this._searchEntry) {
                        this._searchEntry.grab_key_focus();
                    }
                    return GLib.SOURCE_REMOVE;
                });
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

        let searchResults = GioUnix.DesktopAppInfo.search(searchText);
        if (searchResults.length === 0 || searchResults[0].length === 0) {
            // No results found - enter chatbot mode if AI is enabled and configured
            // Reload settings to pick up any recent changes
            this._chatbotSettings.reload();
            if (this._isAIEnabled() && this._chatbotSettings.isConfigured()) {
                this._enterChatbotMode(searchText);
            }
            return;
        }

        let appId = searchResults[0][0];
        let appInfo = GioUnix.DesktopAppInfo.new(appId);
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
        // Use GioUnix.DesktopAppInfo.search for search results
        let searchResults = GioUnix.DesktopAppInfo.search(query);

        // Flatten the array of arrays and create app data objects
        let matchedApps = [];
        for (let group of searchResults) {
            for (let appId of group) {
                // Get the desktop app info
                let appInfo = GioUnix.DesktopAppInfo.new(appId);
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
            style_class: 'praya-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });
        scrollView.set_size(this._getEffectivePanelWidth(), containerHeight);

        let menuBox = new St.BoxLayout({
            style_class: 'praya-menu-box',
            vertical: true,
            x_expand: true,
        });

        let navItems = [];

        if (matchedApps.length === 0) {
            // Reload settings to pick up any recent changes
            this._chatbotSettings.reload();
            let isChatbotAvailable = this._isAIEnabled() && this._chatbotSettings.isConfigured();
            let noResultsText = isChatbotAvailable
                ? 'No applications found.\nPress Enter to chat with AI...'
                : 'No applications found';
            let noResultsLabel = new St.Label({
                text: noResultsText,
                style_class: 'praya-no-results',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            noResultsLabel.clutter_text.set_line_alignment(1); // Center alignment
            noResultsLabel.opacity = 0;
            menuBox.add_child(noResultsLabel);
            noResultsLabel.ease({
                opacity: 255,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            let useGrid = this._servicesConfig.appMenuLayout === 'grid';
            let gridContainer = useGrid ? this._createAppGridContainer() : null;

            for (let i = 0; i < matchedApps.length; i++) {
                let appData = matchedApps[i];
                let appItem;

                if (useGrid) {
                    appItem = this._createAppGridItem(appData);
                } else {
                    appItem = this._createAppMenuItemFromData(appData);
                }
                appItem._hasChildren = false;
                appItem._activateCallback = ((data) => () => {
                    this._launchAppFromData(data);
                    this._hidePanel();
                })(appData);
                appItem.connect('button-press-event', (actor, event) => {
                    if (event.get_button() === 3) {
                        // Right-click - show context menu
                        this._showContextMenu(appData, actor);
                        return Clutter.EVENT_STOP;
                    }
                    // Left-click - launch app
                    appItem._activateCallback();
                    return Clutter.EVENT_STOP;
                });

                // Start with opacity 0 and slide in from left
                appItem.opacity = 0;
                appItem.translation_x = -20;

                if (useGrid) {
                    gridContainer._addGridItem(appItem);
                } else {
                    menuBox.add_child(appItem);
                }
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

            if (useGrid && gridContainer) {
                menuBox.add_child(gridContainer);
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
            style_class: 'praya-menu-item',
            reactive: true,
            track_hover: true,
            height: 48,
            x_expand: true,
        });

        let icon = new St.Icon({
            icon_name: iconName,
            style_class: 'praya-menu-item-icon',
            icon_size: 24,
        });
        item.add_child(icon);

        let label = new St.Label({
            text: text,
            style_class: 'praya-menu-item-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        item.add_child(label);

        if (hasChildren) {
            let arrow = new St.Icon({
                icon_name: 'go-next-symbolic',
                style_class: 'praya-menu-item-arrow',
                icon_size: 16,
            });
            item.add_child(arrow);
        }

        return item;
    }

    _createAppMenuItem(app) {
        let item = new St.BoxLayout({
            style_class: 'praya-menu-item',
            reactive: true,
            track_hover: true,
            height: 48,
            x_expand: true,
        });

        let icon = app.create_icon_texture(24);
        icon.style_class = 'praya-menu-item-icon';
        item.add_child(icon);

        let label = new St.Label({
            text: app.get_name(),
            style_class: 'praya-menu-item-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        item.add_child(label);

        return item;
    }

    _createAppMenuItemFromData(appData, showFavStar = false) {
        let item = new St.BoxLayout({
            style_class: 'praya-menu-item',
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
        icon.style_class = 'praya-menu-item-icon';
        item.add_child(icon);

        let label = new St.Label({
            text: appData.name,
            style_class: 'praya-menu-item-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        item.add_child(label);

        // Show pin icon for favourites
        if (showFavStar && this._isFavourite(appData.id)) {
            let pinIcon = new St.Icon({
                icon_name: 'view-pin-symbolic',
                icon_size: 16,
                style_class: 'praya-favourite-pin',
            });
            pinIcon.set_pivot_point(0.5, 0.5);
            pinIcon.rotation_angle_z = 45;
            item.add_child(pinIcon);
        }

        // Store appData for context menu
        item._appData = appData;

        return item;
    }

    _createAppGridItem(appData, showFavStar = false) {
        let item = new St.BoxLayout({
            style_class: 'praya-grid-item',
            vertical: true,
            reactive: true,
            track_hover: true,
            x_align: Clutter.ActorAlign.CENTER,
        });

        // Create 64px icon
        let icon;
        if (appData.app) {
            icon = appData.app.create_icon_texture(64);
        } else if (appData.appInfo) {
            let gicon = appData.appInfo.get_icon();
            icon = new St.Icon({
                gicon: gicon,
                icon_size: 64,
            });
        } else {
            icon = new St.Icon({
                icon_name: 'application-x-executable-symbolic',
                icon_size: 64,
            });
        }
        icon.style_class = 'praya-grid-item-icon';
        item.add_child(icon);

        let label = new St.Label({
            text: appData.name,
            style_class: 'praya-grid-item-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.set_line_wrap(false);
        label.clutter_text.set_ellipsize(3); // Pango.EllipsizeMode.END
        label.set_width(88);
        item.add_child(label);

        if (showFavStar && this._isFavourite(appData.id)) {
            let pinIcon = new St.Icon({
                icon_name: 'view-pin-symbolic',
                icon_size: 12,
                style_class: 'praya-favourite-pin',
            });
            pinIcon.set_pivot_point(0.5, 0.5);
            pinIcon.rotation_angle_z = 45;
            item.add_child(pinIcon);
        }

        item._appData = appData;
        return item;
    }

    _createAppGridContainer() {
        // Calculate how many columns fit in effective width
        let itemWidth = 96;
        let spacing = 4;
        let padding = 16; // menu-box + grid-container padding
        let availableWidth = this._getEffectivePanelWidth() - padding;
        let columns = Math.max(1, Math.floor((availableWidth + spacing) / (itemWidth + spacing)));

        // Vertical box that holds horizontal rows
        let container = new St.BoxLayout({
            style_class: 'praya-grid-container',
            vertical: true,
            x_expand: true,
        });
        container._gridRow = null;
        container._gridCount = 0;
        container._columns = columns;

        // Auto-arrange items into rows
        container._addGridItem = function(child) {
            if (this._gridCount % this._columns === 0) {
                this._gridRow = new St.BoxLayout({
                    x_expand: true,
                    x_align: Clutter.ActorAlign.START,
                });
                St.BoxLayout.prototype.add_child.call(this, this._gridRow);
            }
            this._gridRow.add_child(child);
            this._gridCount++;
        };

        return container;
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
            style_class: 'praya-menu-item',
            reactive: true,
            track_hover: true,
            height: 48,
            x_expand: true,
        });

        let icon = new St.Icon({
            icon_name: iconName,
            style_class: 'praya-menu-item-icon',
            icon_size: 24,
        });
        item.add_child(icon);

        let label = new St.Label({
            text: text,
            style_class: 'praya-menu-item-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        item.add_child(label);

        // Up arrow (collapsed state)
        let arrow = new St.Icon({
            icon_name: 'go-up-symbolic',
            style_class: 'praya-menu-item-arrow',
            icon_size: 16,
        });
        item.add_child(arrow);

        return item;
    }

    _createSubMenuItem(text) {
        let item = new St.BoxLayout({
            style_class: 'praya-submenu-item',
            reactive: true,
            track_hover: true,
            height: 42,
            x_expand: true,
        });

        let label = new St.Label({
            text: text,
            style_class: 'praya-menu-item-label',
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
            style_class: 'praya-user-item',
            reactive: true,
            track_hover: true,
            x_expand: true,
        });

        // Avatar
        let avatarFile = user.get_icon_file();
        let avatar;
        if (avatarFile && GLib.file_test(avatarFile, GLib.FileTest.EXISTS)) {
            avatar = new St.Bin({
                style_class: 'praya-user-avatar',
                style: `background-image: url("${avatarFile}");`,
            });
        } else {
            avatar = new St.Bin({
                style_class: 'praya-user-avatar',
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
            style_class: 'praya-user-fullname',
        });
        nameBox.add_child(fullNameLabel);

        let username = GLib.get_user_name();
        let usernameLabel = new St.Label({
            text: username,
            style_class: 'praya-user-username',
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
                let appInfo = GioUnix.DesktopAppInfo.new('gnome-control-center.desktop');
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
            style_class: 'praya-bottom-section',
            vertical: true,
            x_expand: true,
        });

        // User component
        let userItem = this._createUserItem();
        bottomSection.add_child(userItem);

        // Separator between user and session actions
        bottomSection.add_child(new St.Widget({style_class: 'praya-separator', height: 1, x_expand: true}));

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
            style_class: 'praya-power-options',
            vertical: true,
            x_expand: true,
            clip_to_allocation: true,
        });
        powerOptionsBox.set_height(0);
        powerOptionsBox._expanded = false;
        powerOptionsBox._targetHeight = 150; // 3 items * 42px height + margins + padding

        // Suspend
        let suspendItem = this._createSubMenuItem('Suspend');
        suspendItem.connect('button-press-event', () => {
            this._hidePanel();
            this._systemActions.activateSuspend();
            return Clutter.EVENT_STOP;
        });
        powerOptionsBox.add_child(suspendItem);

        // Restart
        let restartItem = this._createSubMenuItem('Restart');
        restartItem.connect('button-press-event', () => {
            this._hidePanel();
            this._systemActions.activateRestart();
            return Clutter.EVENT_STOP;
        });
        powerOptionsBox.add_child(restartItem);

        // Power Off
        let powerOffItem = this._createSubMenuItem('Power Off');
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
                // Expand sliding container
                if (this._slidingContainer) {
                    this._slidingContainer.ease({
                        height: this._slidingContainer.height + this._powerOptionsHeight,
                        duration: ANIMATION_DURATION,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                }
                arrow.icon_name = 'go-up-symbolic';
                powerOptionsBox._expanded = false;
            } else {
                // Expand with animation
                powerOptionsBox.ease({
                    height: powerOptionsBox._targetHeight,
                    duration: ANIMATION_DURATION,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
                // Shrink sliding container to make room
                if (this._slidingContainer) {
                    this._slidingContainer.ease({
                        height: this._slidingContainer.height - this._powerOptionsHeight,
                        duration: ANIMATION_DURATION,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                }
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
                style_class: 'praya-back-button',
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
                style_class: 'praya-header-label',
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            this._header.add_child(headerLabel);
        } else {
            // Show search entry (main menu view) - entry first, icon on right
            this._searchEntry = new St.Entry({
                style_class: 'praya-search-entry',
                hint_text: 'Search or ask...',
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
                style_class: 'praya-search-icon',
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
                style_class: 'praya-menu-box',
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
                        info.name,
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
                        info.name,
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

    _openUrl(url) {
        Gio.app_info_launch_default_for_uri(url, null);
        this._hidePanel();
    }

    _showSettingsMenu() {
        this._navigationStack.push({type: 'main'});
        this._updateHeader('Settings', true);

        let scrollView = this._createScrollView();

        let menuBox = new St.BoxLayout({
            style_class: 'praya-menu-box',
            vertical: true,
            x_expand: true,
        });

        let navItems = [];

        // System Settings
        let systemSettingsItem = this._createMenuItem('System Settings', 'preferences-system-symbolic', false);
        systemSettingsItem._hasChildren = false;
        systemSettingsItem._activateCallback = () => {
            let appInfo = GioUnix.DesktopAppInfo.new('gnome-control-center.desktop');
            if (appInfo) {
                appInfo.launch([], null);
            } else {
                appInfo = GioUnix.DesktopAppInfo.new('org.gnome.Settings.desktop');
                if (appInfo)
                    appInfo.launch([], null);
            }
            this._hidePanel();
        };
        systemSettingsItem.connect('button-press-event', () => {
            systemSettingsItem._activateCallback();
            return Clutter.EVENT_STOP;
        });
        menuBox.add_child(systemSettingsItem);
        navItems.push(systemSettingsItem);

        scrollView.add_child(menuBox);
        this._registerMenuItems(navItems, scrollView);
        this._animateSlide(scrollView, 'forward');
    }

    _showAboutBlankOn() {
        this._navigationStack.push({type: 'main'});
        this._updateHeader('About BlankOn', true);

        let scrollView = this._createScrollView();

        let menuBox = new St.BoxLayout({
            style_class: 'praya-menu-box',
            vertical: true,
            x_expand: true,
        });

        let navItems = [];

        // BlankOn Linux
        let blankonItem = this._createMenuItem('BlankOn Linux', 'help-about-symbolic', false);
        blankonItem._hasChildren = false;
        blankonItem._activateCallback = () => {
            this._openUrl('http://blankonlinux.id/');
        };
        blankonItem.connect('button-press-event', () => {
            blankonItem._activateCallback();
            return Clutter.EVENT_STOP;
        });
        menuBox.add_child(blankonItem);
        navItems.push(blankonItem);

        // BlankOn Foundation
        let foundationItem = this._createMenuItem('BlankOn Foundation', 'help-about-symbolic', false);
        foundationItem._hasChildren = false;
        foundationItem._activateCallback = () => {
            this._openUrl('https://blankon.id/en');
        };
        foundationItem.connect('button-press-event', () => {
            foundationItem._activateCallback();
            return Clutter.EVENT_STOP;
        });
        menuBox.add_child(foundationItem);
        navItems.push(foundationItem);

        // Praya Shell Extension
        let prayaItem = this._createMenuItem('Praya Shell Extension', 'help-about-symbolic', false);
        prayaItem._hasChildren = false;
        prayaItem._activateCallback = () => {
            this._openUrl('https://github.com/BlankOn/praya-gnome-shell-extension');
        };
        prayaItem.connect('button-press-event', () => {
            prayaItem._activateCallback();
            return Clutter.EVENT_STOP;
        });
        menuBox.add_child(prayaItem);
        navItems.push(prayaItem);

        // Donate
        let donateItem = this._createMenuItem('Donate', 'help-about-symbolic', false);
        donateItem._hasChildren = false;
        donateItem._activateCallback = () => {
            this._openUrl('https://blankon.id/en/donate');
        };
        donateItem.connect('button-press-event', () => {
            donateItem._activateCallback();
            return Clutter.EVENT_STOP;
        });
        menuBox.add_child(donateItem);
        navItems.push(donateItem);

        scrollView.add_child(menuBox);
        this._registerMenuItems(navItems, scrollView);
        this._animateSlide(scrollView, 'forward');
    }

    _launchApp(desktopId) {
        let appSystem = Shell.AppSystem.get_default();
        let app = appSystem.lookup_app(desktopId);
        if (app) {
            app.activate();
        }
    }

    _enterChatbotMode(initialMessage) {
        if (this._isChatbotMode) return;

        this._isChatbotMode = true;

        // Hide header search and bottom section
        if (this._header) {
            this._header.hide();
        }
        if (this._bottomSection) {
            this._bottomSection.hide();
        }

        // Clear the sliding container
        if (this._slidingContainer) {
            this._slidingContainer.destroy_all_children();
        }

        // Get available height for chatbot panel
        // Use stored monitor from when panel was opened
        let monitor = this._currentMonitor || Main.layoutManager.currentMonitor;
        let panelHeight = Main.panel.height;
        let isBottomBar = this._servicesConfig.panelPosition === 'bottom';
        let bottomMargin = isBottomBar ? MARGIN_BOTTOM_BAR : MARGIN_BOTTOM;
        let availableHeight = monitor.height - panelHeight - MARGIN_TOP - bottomMargin;

        // Create chatbot panel with calculated height
        this._chatbotPanel = new PrayaChatbotPanel(this._chatbotSettings, () => {
            this._exitChatbotMode();
        }, availableHeight);

        // Hide sliding container
        this._slidingContainer.hide();

        // Animate panel width from 325px to 400px with slow slide animation
        let chatbotAnimationDuration = 400;
        this._panel.ease({
            width: CHATBOT_PANEL_WIDTH,
            duration: chatbotAnimationDuration,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });

        // Update hover zone width
        if (this._hoverZone) {
            this._hoverZone.ease({
                width: CHATBOT_PANEL_WIDTH + MARGIN_LEFT * 2,
                duration: chatbotAnimationDuration,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        }

        // Add chatbot panel directly to main panel (after header, which is hidden)
        this._chatbotPanel.set_width(CHATBOT_PANEL_WIDTH);
        this._panel.add_child(this._chatbotPanel);

        // Send initial message if provided
        if (initialMessage) {
            this._chatbotPanel.sendInitialMessage(initialMessage);
        } else {
            // Focus input
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (this._chatbotPanel) {
                    this._chatbotPanel.focusInput();
                }
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _restoreChatbotMode() {
        // Hide header and bottom section
        if (this._header) {
            this._header.hide();
        }
        if (this._bottomSection) {
            this._bottomSection.hide();
        }

        // Hide sliding container
        if (this._slidingContainer) {
            this._slidingContainer.hide();
        }

        // Get available height for chatbot panel
        // Use stored monitor from when panel was opened
        let monitor = this._currentMonitor || Main.layoutManager.currentMonitor;
        let panelHeight = Main.panel.height;
        let isBottomBar = this._servicesConfig.panelPosition === 'bottom';
        let bottomMargin = isBottomBar ? MARGIN_BOTTOM_BAR : MARGIN_BOTTOM;
        let availableHeight = monitor.height - panelHeight - MARGIN_TOP - bottomMargin;

        // Create chatbot panel with calculated height
        this._chatbotPanel = new PrayaChatbotPanel(this._chatbotSettings, () => {
            this._exitChatbotMode();
        }, availableHeight);

        // Set panel width immediately (no animation on restore)
        this._panel.width = CHATBOT_PANEL_WIDTH;
        if (this._hoverZone) {
            this._hoverZone.width = CHATBOT_PANEL_WIDTH + MARGIN_LEFT * 2;
        }

        // Add chatbot panel directly to main panel
        this._chatbotPanel.set_width(CHATBOT_PANEL_WIDTH);
        this._panel.add_child(this._chatbotPanel);

        // Restore previous messages
        if (this._chatbotMessages && this._chatbotMessages.length > 0) {
            this._chatbotPanel.restoreMessages(this._chatbotMessages);
        }
    }

    _exitChatbotMode() {
        if (!this._isChatbotMode) return;

        // Set flag to prevent panel from hiding during transition
        this._isTransitioningChatbot = true;

        this._isChatbotMode = false;
        this._chatbotMessages = []; // Clear saved messages

        // Destroy chatbot panel
        if (this._chatbotPanel) {
            this._chatbotPanel.destroy();
            this._chatbotPanel = null;
        }

        // Show header and bottom section
        if (this._header) {
            this._header.show();
        }
        if (this._bottomSection) {
            this._bottomSection.show();
        }

        // Get available height
        // Use stored monitor from when panel was opened
        let monitor = this._currentMonitor || Main.layoutManager.currentMonitor;
        let panelHeight = Main.panel.height;
        let isBottomBar = this._servicesConfig.panelPosition === 'bottom';
        let bottomMargin = isBottomBar ? MARGIN_BOTTOM_BAR : MARGIN_BOTTOM;
        let availableHeight = monitor.height - panelHeight - MARGIN_TOP - bottomMargin;

        let effectiveWidth = this._getEffectivePanelWidth();

        // Animate panel width back to menu width
        this._panel.ease({
            width: effectiveWidth,
            duration: ANIMATION_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        // Update hover zone width
        if (this._hoverZone) {
            this._hoverZone.ease({
                width: effectiveWidth + MARGIN_LEFT * 2,
                duration: ANIMATION_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        // Show and reset sliding container
        this._slidingContainer.show();
        this._slidingContainer.set_size(effectiveWidth, availableHeight - HEADER_HEIGHT - this._bottomSectionBaseHeight);

        // Show main menu (this will recreate the search entry)
        this._navigationStack = [];
        this._isSearchActive = false;
        this._showMainMenu(false);

        // Focus search entry and clear transition flag after transition
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._isTransitioningChatbot = false;
            if (this._searchEntry) {
                this._searchEntry.grab_key_focus();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _loadServicesConfig() {
        let homeDir = GLib.get_home_dir();
        let configPath = GLib.build_filenamev([homeDir, '.config', 'praya', 'services.json']);

        let defaultConfig = { ai: false, posture: false, appMenuLayout: 'grid', mainMenuHoverActivate: false, taskbarHoverActivate: false, showDesktopHoverActivate: false, panelPosition: 'top' };

        try {
            let configFile = Gio.File.new_for_path(configPath);
            if (configFile.query_exists(null)) {
                let [success, contents] = configFile.load_contents(null);
                if (success) {
                    let decoder = new TextDecoder('utf-8');
                    let jsonStr = decoder.decode(contents);
                    let config = JSON.parse(jsonStr);
                    // Ensure appMenuLayout has a default
                    if (!config.appMenuLayout) config.appMenuLayout = 'grid';
                    return config;
                }
            }
        } catch (e) {
            log(`Praya: Error loading services config: ${e.message}`);
        }
        return defaultConfig;
    }

    setMainMenuHoverActivate(enabled) {
        this._mainMenuHoverActivate = enabled;
    }

    _isAIEnabled() {
        // Reload config to get latest state
        this._servicesConfig = this._loadServicesConfig();
        return this._servicesConfig.ai || false;
    }

    _getEffectivePanelWidth() {
        return this._servicesConfig.appMenuLayout === 'grid'
            ? PANEL_WIDTH + 20
            : PANEL_WIDTH;
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

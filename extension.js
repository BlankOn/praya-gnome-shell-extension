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
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { PrayaIndicator } from './indicator.js';
import { PrayaTaskbar } from './taskbar.js';

export default class PrayaExtension extends Extension {
    enable() {
        // Save and apply gsettings
        this._applySettings();

        this._indicator = new PrayaIndicator();
        // Add to the left side of the panel
        Main.panel.addToStatusArea('praya-indicator', this._indicator, 0, 'left');

        // Hide activities button
        this._hideActivities();

        // Add taskbar to the left box, after indicator (index 1)
        this._taskbar = new PrayaTaskbar();
        Main.panel._leftBox.insert_child_at_index(this._taskbar, 1);

        // Move date/time to the right (left of quick settings)
        this._moveDateTimeToRight();

        // Setup hover trigger for quick settings
        this._setupQuickSettingsHover();

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

    _applySettings() {
        // Extension's modified values - used to detect if we're reading our own changes
        const EXTENSION_OVERLAY_KEY = 'Alt_L';
        const EXTENSION_BUTTON_LAYOUT = ':minimize,maximize,close';

        // GNOME default values - used as fallback
        const DEFAULT_OVERLAY_KEY = 'Super_L';
        const DEFAULT_BUTTON_LAYOUT = 'appmenu:close';

        // Get settings objects
        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        this._wmSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});

        // Save original values, but check if they're our own modified values
        // (can happen after shell restart while extension was enabled)
        this._originalHotCorner = this._interfaceSettings.get_boolean('enable-hot-corners');

        let currentOverlayKey = this._mutterSettings.get_string('overlay-key');
        if (currentOverlayKey === EXTENSION_OVERLAY_KEY) {
            // We're reading our own modified value, use default
            this._originalOverlayKey = DEFAULT_OVERLAY_KEY;
        } else {
            this._originalOverlayKey = currentOverlayKey;
        }

        let currentButtonLayout = this._wmSettings.get_string('button-layout');
        if (currentButtonLayout === EXTENSION_BUTTON_LAYOUT) {
            // We're reading our own modified value, use default
            this._originalButtonLayout = DEFAULT_BUTTON_LAYOUT;
        } else {
            this._originalButtonLayout = currentButtonLayout;
        }

        // Apply new settings
        this._interfaceSettings.set_boolean('enable-hot-corners', false);
        this._mutterSettings.set_string('overlay-key', EXTENSION_OVERLAY_KEY);
        this._wmSettings.set_string('button-layout', EXTENSION_BUTTON_LAYOUT);
    }

    _restoreSettings() {
        // GNOME default values - used as fallback
        const DEFAULT_OVERLAY_KEY = 'Super_L';
        const DEFAULT_BUTTON_LAYOUT = 'appmenu:close';

        // Restore original values (create settings objects if needed)
        if (!this._interfaceSettings) {
            this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        }
        if (!this._mutterSettings) {
            this._mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        }
        if (!this._wmSettings) {
            this._wmSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
        }

        // Restore hot corners
        if (this._originalHotCorner !== undefined) {
            this._interfaceSettings.set_boolean('enable-hot-corners', this._originalHotCorner);
        }

        // Restore overlay key (Meta key behavior)
        let overlayKeyToRestore = this._originalOverlayKey !== undefined
            ? this._originalOverlayKey
            : DEFAULT_OVERLAY_KEY;
        this._mutterSettings.set_string('overlay-key', overlayKeyToRestore);

        // Restore button layout (hide minimize button)
        let buttonLayoutToRestore = this._originalButtonLayout !== undefined
            ? this._originalButtonLayout
            : DEFAULT_BUTTON_LAYOUT;
        this._wmSettings.set_string('button-layout', buttonLayoutToRestore);

        this._interfaceSettings = null;
        this._mutterSettings = null;
        this._wmSettings = null;
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

    _hideActivities() {
        let activities = Main.panel.statusArea.activities;
        if (!activities)
            return;

        this._originalActivitiesVisible = activities.container.visible;
        activities.container.visible = false;
    }

    _restoreActivities() {
        let activities = Main.panel.statusArea.activities;
        if (!activities)
            return;

        if (this._originalActivitiesVisible !== undefined) {
            activities.container.visible = this._originalActivitiesVisible;
            this._originalActivitiesVisible = undefined;
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

        // Remove center box from panel so left box can expand freely
        let panelBox = centerBox.get_parent();
        if (panelBox && panelBox.contains(centerBox)) {
            this._centerBoxParent = panelBox;
            this._centerBoxIndex = panelBox.get_children().indexOf(centerBox);
            panelBox.remove_child(centerBox);
            this._removedCenterBox = centerBox;
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

        // Restore center box to panel
        if (this._removedCenterBox && this._centerBoxParent) {
            this._centerBoxParent.insert_child_at_index(this._removedCenterBox, this._centerBoxIndex);
            this._removedCenterBox = null;
            this._centerBoxParent = null;
            this._centerBoxIndex = undefined;
        }

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
        // Restore gsettings
        this._restoreSettings();

        // Remove keybinding
        this._removeKeybinding();

        // Restore hot corner behavior
        this._restoreHotCorner();

        // Show the dock again when extension is disabled
        this._showDock();
        this._dock = null;

        if (this._taskbar) {
            this._taskbar.destroy();
            this._taskbar = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        // Remove quick settings hover
        this._removeQuickSettingsHover();

        // Restore date/time to center
        this._restoreDateTimePosition();

        // Restore activities button
        this._restoreActivities();
    }
}

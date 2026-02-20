#!/usr/bin/env python3
"""Praya Preferences — standalone GTK4/Adw preferences window.

Reads and writes:
  ~/.config/praya/services.json   (panel / hover / posture / AI toggles)
  ~/.config/praya/chatbot.json    (provider, model, API key)

The GNOME Shell extension watches these files via Gio.FileMonitor and
applies changes live.
"""
import json
import os
import sys
import locale
import gettext
import subprocess

import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Adw', '1')
from gi.repository import GLib, Gtk, Adw, Gio

# -- Keep in sync with constants.js -------------------------------------------
VERSION = '0.1.22'

PROVIDERS = {
    'anthropic': {
        'name': 'Anthropic',
        'models': ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-3-5-haiku-20241022'],
    },
    'openai': {
        'name': 'ChatGPT',
        'models': ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
    },
}
# ------------------------------------------------------------------------------

# D-Bus constants for posture service
POSTURE_BUS_NAME = 'com.github.blankon.praya'
POSTURE_MAIN_INTERFACE = 'com.github.blankon.Praya'
POSTURE_MAIN_PATH = '/com/github/blankon/Praya'
POSTURE_SERVICE_INTERFACE = 'com.github.blankon.Praya.Posture'
POSTURE_SERVICE_PATH = '/com/github/blankon/Praya/Posture'

# Setup translations (same pattern as lowspec-dialog.py)
locale.setlocale(locale.LC_ALL, '')
script_dir = os.path.dirname(os.path.abspath(__file__))
localedir = os.path.join(script_dir, 'locale')
try:
    t = gettext.translation('praya', localedir=localedir)
except FileNotFoundError:
    t = gettext.NullTranslations()
_ = t.gettext

# Config paths
CONFIG_DIR = os.path.join(GLib.get_user_config_dir(), 'praya')
SERVICES_CONFIG_PATH = os.path.join(CONFIG_DIR, 'services.json')
CHATBOT_CONFIG_PATH = os.path.join(CONFIG_DIR, 'chatbot.json')

DEFAULT_SERVICES_CONFIG = {
    'ai': False,
    'posture': False,
    'appMenuLayout': 'grid',
    'mainMenuHoverActivate': False,
    'taskbarHoverActivate': False,
    'showDesktopHoverActivate': False,
    'calendarHoverActivate': False,
    'quickAccessHoverActivate': False,
    'floatingPanel': True,
    'panelPosition': 'top',
}

DEFAULT_CHATBOT_CONFIG = {
    'provider': 'anthropic',
    'model': 'claude-sonnet-4-20250514',
    'apiKey': '',
}


def _ensure_config_dir():
    os.makedirs(CONFIG_DIR, exist_ok=True)


def _load_json(path, defaults):
    try:
        with open(path, 'r') as f:
            data = json.load(f)
        # Merge with defaults so new keys are always present
        merged = dict(defaults)
        merged.update(data)
        return merged
    except (FileNotFoundError, json.JSONDecodeError):
        return dict(defaults)


def _save_json(path, data):
    _ensure_config_dir()
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)
        f.write('\n')


# ---------------------------------------------------------------------------
# Window
# ---------------------------------------------------------------------------
class PrayaPreferencesWindow(Adw.PreferencesWindow):
    def __init__(self, app, **kwargs):
        super().__init__(
            application=app,
            title=_('Praya Preferences'),
            **kwargs,
        )
        self.set_default_size(520, 680)
        self.set_search_enabled(False)

        self._services = _load_json(SERVICES_CONFIG_PATH, DEFAULT_SERVICES_CONFIG)
        self._chatbot = _load_json(CHATBOT_CONFIG_PATH, DEFAULT_CHATBOT_CONFIG)
        self._dbus = None
        self._posture_poll_id = None
        self._service_running = False

        try:
            self._dbus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        except Exception:
            self._dbus = None

        self._build_panel_page()
        self._build_services_page()
        self._build_about_page()

        # Start service status check
        self._check_service_status()

        # Start posture polling
        self._start_posture_polling()

        self.connect('close-request', self._on_close)

    # ==================================================================
    # Page 1: Panel
    # ==================================================================
    def _build_panel_page(self):
        page = Adw.PreferencesPage(
            title=_('Panel'),
            icon_name='view-grid-symbolic',
        )

        # -- Panel Options group --
        panel_group = Adw.PreferencesGroup(title=_('Panel Options'))

        # App menu layout
        self._layout_row = Adw.ComboRow(title=_('App menu layout'))
        layout_model = Gtk.StringList.new([_('Grid'), _('List')])
        self._layout_row.set_model(layout_model)
        self._layout_row.set_selected(0 if self._services.get('appMenuLayout', 'grid') == 'grid' else 1)
        self._layout_row.connect('notify::selected', self._on_layout_changed)
        panel_group.add(self._layout_row)

        # Position
        self._position_row = Adw.ComboRow(title=_('Position'))
        pos_model = Gtk.StringList.new([_('Top'), _('Bottom')])
        self._position_row.set_model(pos_model)
        self._position_row.set_selected(0 if self._services.get('panelPosition', 'top') == 'top' else 1)
        self._position_row.connect('notify::selected', self._on_position_changed)
        panel_group.add(self._position_row)

        # Floating panel
        self._floating_row = Adw.SwitchRow(title=_('Floating panel'))
        self._floating_row.set_active(self._services.get('floatingPanel', True))
        self._floating_row.connect('notify::active', self._on_floating_changed)
        panel_group.add(self._floating_row)

        page.add(panel_group)

        # -- Activate on Hover group --
        hover_group = Adw.PreferencesGroup(title=_('Activate on Hover'))

        hover_keys = [
            ('mainMenuHoverActivate',      _('Main menu')),
            ('taskbarHoverActivate',        _('Taskbar')),
            ('showDesktopHoverActivate',    _('Show Desktop')),
            ('calendarHoverActivate',       _('Calendar')),
            ('quickAccessHoverActivate',    _('Quick Access')),
        ]
        self._hover_rows = {}
        for key, label in hover_keys:
            row = Adw.SwitchRow(title=label)
            row.set_active(self._services.get(key, False))
            row.connect('notify::active', lambda r, _p, k=key: self._on_hover_changed(r, k))
            hover_group.add(row)
            self._hover_rows[key] = row

        page.add(hover_group)

        # -- Performance group --
        perf_group = Adw.PreferencesGroup(title=_('Performance'))

        self._lowspec_row = Adw.SwitchRow(title=_('Low-spec Mode'))
        self._lowspec_row.set_active(self._services.get('lowspecEnabled', False))
        self._lowspec_row.connect('notify::active', self._on_lowspec_changed)
        perf_group.add(self._lowspec_row)

        page.add(perf_group)

        self.add(page)

    # ==================================================================
    # Page 2: Services
    # ==================================================================
    def _build_services_page(self):
        page = Adw.PreferencesPage(
            title=_('Services'),
            icon_name='preferences-system-symbolic',
        )

        # -- Praya Service group --
        svc_group = Adw.PreferencesGroup(title=_('Praya Service'))

        self._service_row = Adw.ActionRow(title=_('Status'))
        self._service_label = Gtk.Label(label=_('Checking...'))
        self._service_label.set_valign(Gtk.Align.CENTER)
        self._service_row.add_suffix(self._service_label)

        refresh_btn = Gtk.Button(icon_name='view-refresh-symbolic')
        refresh_btn.set_valign(Gtk.Align.CENTER)
        refresh_btn.connect('clicked', lambda _b: self._check_service_status())
        self._service_row.add_suffix(refresh_btn)
        svc_group.add(self._service_row)

        page.add(svc_group)

        # -- Posture Monitoring group --
        posture_group = Adw.PreferencesGroup(
            title=_('Posture Monitoring'),
            description=_('(Experimental)'),
        )

        self._posture_enable_row = Adw.SwitchRow(title=_('Enable'))
        self._posture_enable_row.set_active(self._services.get('posture', False))
        self._posture_enable_row.connect('notify::active', self._on_posture_enable_changed)
        posture_group.add(self._posture_enable_row)

        # Recalibrate button
        recalib_row = Adw.ActionRow(title=_('Calibration'))
        recalib_btn = Gtk.Button(label=_('Recalibrate'))
        recalib_btn.set_valign(Gtk.Align.CENTER)
        recalib_btn.connect('clicked', lambda _b: self._recalibrate())
        recalib_row.add_suffix(recalib_btn)
        posture_group.add(recalib_row)

        # Live posture display
        self._posture_status_row = Adw.ActionRow(title=_('Current'))
        self._posture_status_label = Gtk.Label(label=_('Waiting for data...'))
        self._posture_status_label.set_valign(Gtk.Align.CENTER)
        self._posture_status_row.add_suffix(self._posture_status_label)
        posture_group.add(self._posture_status_row)

        # Level bar
        self._posture_level_row = Adw.ActionRow(title=_('Level'))
        self._posture_level_bar = Gtk.LevelBar()
        self._posture_level_bar.set_min_value(0.0)
        self._posture_level_bar.set_max_value(1.0)
        self._posture_level_bar.set_value(0.0)
        self._posture_level_bar.set_valign(Gtk.Align.CENTER)
        self._posture_level_bar.set_hexpand(True)
        self._posture_level_bar.set_size_request(150, -1)
        self._posture_level_row.add_suffix(self._posture_level_bar)
        posture_group.add(self._posture_level_row)

        page.add(posture_group)

        # -- Artificial Intelligence group --
        ai_group = Adw.PreferencesGroup(
            title=_('Artificial Intelligence'),
            description=_('(Experimental)'),
        )

        self._ai_enable_row = Adw.SwitchRow(title=_('Enable'))
        self._ai_enable_row.set_active(self._services.get('ai', False))
        self._ai_enable_row.connect('notify::active', self._on_ai_enable_changed)
        ai_group.add(self._ai_enable_row)

        # Provider combo
        self._provider_row = Adw.ComboRow(title=_('Provider'))
        provider_names = [PROVIDERS[k]['name'] for k in PROVIDERS]
        provider_model = Gtk.StringList.new(provider_names)
        self._provider_row.set_model(provider_model)
        # Set initial selection
        provider_keys = list(PROVIDERS.keys())
        current_provider = self._chatbot.get('provider', 'anthropic')
        if current_provider in provider_keys:
            self._provider_row.set_selected(provider_keys.index(current_provider))
        self._provider_row.connect('notify::selected', self._on_provider_changed)
        ai_group.add(self._provider_row)

        # Model combo
        self._model_row = Adw.ComboRow(title=_('Model'))
        self._update_model_list()
        self._model_row.connect('notify::selected', self._on_model_changed)
        ai_group.add(self._model_row)

        # API key
        self._apikey_row = Adw.PasswordEntryRow(title=_('API Key'))
        self._apikey_row.set_text(self._chatbot.get('apiKey', ''))
        self._apikey_row.connect('changed', self._on_apikey_changed)
        ai_group.add(self._apikey_row)

        page.add(ai_group)

        self.add(page)

    # ==================================================================
    # Page 3: About Praya
    # ==================================================================
    def _build_about_page(self):
        page = Adw.PreferencesPage(
            title=_('About Praya'),
            icon_name='help-about-symbolic',
        )

        about_group = Adw.PreferencesGroup()

        # Version
        version_row = Adw.ActionRow(title=_('Version'))
        version_label = Gtk.Label(label=VERSION)
        version_label.set_valign(Gtk.Align.CENTER)
        version_row.add_suffix(version_label)
        about_group.add(version_row)

        # Author
        author_row = Adw.ActionRow(
            title=_('Author'),
            subtitle='Herpiko Dwi Aguno &lt;herpiko@gmail.com&gt;',
        )
        about_group.add(author_row)

        # License
        license_row = Adw.ActionRow(
            title=_('License'),
            subtitle='MIT',
        )
        about_group.add(license_row)

        page.add(about_group)
        self.add(page)

    # ==================================================================
    # Helpers — model list
    # ==================================================================
    def _current_provider_key(self):
        keys = list(PROVIDERS.keys())
        idx = self._provider_row.get_selected()
        if 0 <= idx < len(keys):
            return keys[idx]
        return 'anthropic'

    def _update_model_list(self):
        pkey = self._current_provider_key()
        models = PROVIDERS[pkey]['models']
        model_store = Gtk.StringList.new(models)
        self._model_row.set_model(model_store)

        # Try to select current model
        current_model = self._chatbot.get('model', '')
        if current_model in models:
            self._model_row.set_selected(models.index(current_model))
        else:
            self._model_row.set_selected(0)

    # ==================================================================
    # Callbacks — Panel page
    # ==================================================================
    def _on_layout_changed(self, row, _pspec):
        val = 'grid' if row.get_selected() == 0 else 'list'
        self._services['appMenuLayout'] = val
        self._save_services()

    def _on_position_changed(self, row, _pspec):
        val = 'top' if row.get_selected() == 0 else 'bottom'
        self._services['panelPosition'] = val
        self._save_services()

    def _on_floating_changed(self, row, _pspec):
        self._services['floatingPanel'] = row.get_active()
        self._save_services()

    def _on_hover_changed(self, row, key):
        self._services[key] = row.get_active()
        self._save_services()

    def _on_lowspec_changed(self, row, _pspec):
        enabled = row.get_active()
        self._services['lowspecEnabled'] = enabled

        # Toggle GNOME animations
        try:
            settings = Gio.Settings(schema_id='org.gnome.desktop.interface')
            settings.set_boolean('enable-animations', not enabled)
        except Exception:
            pass

        # Toggle tilingshell extension
        try:
            shell_settings = Gio.Settings(schema_id='org.gnome.shell')
            tiling_id = 'tilingshell@ferrarodomenico.com'
            enabled_exts = list(shell_settings.get_strv('enabled-extensions'))
            disabled_exts = list(shell_settings.get_strv('disabled-extensions'))

            if enabled:
                enabled_exts = [x for x in enabled_exts if x != tiling_id]
                if tiling_id not in disabled_exts:
                    disabled_exts.append(tiling_id)
            else:
                disabled_exts = [x for x in disabled_exts if x != tiling_id]
                if tiling_id not in enabled_exts:
                    enabled_exts.append(tiling_id)

            shell_settings.set_strv('enabled-extensions', enabled_exts)
            shell_settings.set_strv('disabled-extensions', disabled_exts)
        except Exception:
            pass

        # Toggle menu layout
        new_layout = 'list' if enabled else 'grid'
        self._services['appMenuLayout'] = new_layout
        self._layout_row.set_selected(0 if new_layout == 'grid' else 1)

        self._save_services()

    # ==================================================================
    # Callbacks — Services page
    # ==================================================================
    def _on_posture_enable_changed(self, row, _pspec):
        enabled = row.get_active()
        self._services['posture'] = enabled
        self._save_services()

        if self._dbus and self._service_running:
            method = 'EnableService' if enabled else 'DisableService'
            try:
                self._dbus.call_sync(
                    POSTURE_BUS_NAME,
                    POSTURE_MAIN_PATH,
                    POSTURE_MAIN_INTERFACE,
                    method,
                    GLib.Variant('(s)', ('posture',)),
                    None,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    None,
                )
            except Exception:
                pass

    def _on_ai_enable_changed(self, row, _pspec):
        enabled = row.get_active()
        self._services['ai'] = enabled
        self._save_services()

    def _on_provider_changed(self, row, _pspec):
        self._update_model_list()
        self._chatbot['provider'] = self._current_provider_key()
        self._save_chatbot()

    def _on_model_changed(self, row, _pspec):
        pkey = self._current_provider_key()
        models = PROVIDERS[pkey]['models']
        idx = row.get_selected()
        if 0 <= idx < len(models):
            self._chatbot['model'] = models[idx]
            self._save_chatbot()

    def _on_apikey_changed(self, row):
        self._chatbot['apiKey'] = row.get_text()
        self._save_chatbot()

    # ==================================================================
    # Service status
    # ==================================================================
    def _check_service_status(self):
        self._service_label.set_label(_('Checking...'))
        try:
            result = subprocess.run(
                ['systemctl', '--user', 'is-active', 'praya'],
                capture_output=True, text=True, timeout=5,
            )
            status = result.stdout.strip()
            if status == 'active':
                self._service_label.set_label(_('Running'))
                self._service_running = True
            elif status == 'inactive':
                self._service_label.set_label(_('Stopped'))
                self._service_running = False
            else:
                self._service_label.set_label(status or _('Unknown'))
                self._service_running = False
        except Exception:
            self._service_label.set_label(_('Error checking status'))
            self._service_running = False

    # ==================================================================
    # Posture polling
    # ==================================================================
    def _start_posture_polling(self):
        self._posture_poll_id = GLib.timeout_add(200, self._poll_posture)

    def _poll_posture(self):
        if not self._dbus:
            self._posture_status_label.set_label(_('D-Bus not available'))
            return GLib.SOURCE_CONTINUE

        try:
            reply = self._dbus.call_sync(
                POSTURE_BUS_NAME,
                POSTURE_SERVICE_PATH,
                POSTURE_SERVICE_INTERFACE,
                'GetUserPosture',
                None,
                None,
                Gio.DBusCallFlags.NONE,
                200,  # short timeout so we don't block
                None,
            )
            status = reply.get_child_value(0).get_string()
            score = reply.get_child_value(1).get_double()
            self._posture_status_label.set_label(f'{status} ({score:.2f})')
            self._posture_level_bar.set_value(max(0.0, min(1.0, score)))
        except Exception:
            self._posture_status_label.set_label(_('Service unavailable'))
            self._posture_level_bar.set_value(0.0)

        return GLib.SOURCE_CONTINUE

    def _recalibrate(self):
        if not self._dbus:
            return
        try:
            self._dbus.call_sync(
                POSTURE_BUS_NAME,
                POSTURE_SERVICE_PATH,
                POSTURE_SERVICE_INTERFACE,
                'Recalibrate',
                None,
                None,
                Gio.DBusCallFlags.NONE,
                -1,
                None,
            )
        except Exception:
            pass

    # ==================================================================
    # Config persistence
    # ==================================================================
    def _save_services(self):
        _save_json(SERVICES_CONFIG_PATH, self._services)

    def _save_chatbot(self):
        _save_json(CHATBOT_CONFIG_PATH, self._chatbot)

    # ==================================================================
    # Cleanup
    # ==================================================================
    def _on_close(self, _window):
        if self._posture_poll_id:
            GLib.source_remove(self._posture_poll_id)
            self._posture_poll_id = None
        return False  # allow close


# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------
class PrayaPreferencesApp(Adw.Application):
    def __init__(self):
        super().__init__(application_id='id.blankonlinux.praya.preferences')

    def do_activate(self):
        win = self.get_active_window()
        if not win:
            win = PrayaPreferencesWindow(app=self)
        win.present()


def main():
    app = PrayaPreferencesApp()
    app.run(sys.argv)


if __name__ == '__main__':
    main()

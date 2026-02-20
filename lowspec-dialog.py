#!/usr/bin/env python3
"""Praya low-spec hardware dialog.

Exit codes:
  0 - user clicked Ignore
  1 - user clicked Disable a few features
  2 - window closed without choosing
"""
import sys
import os
import locale
import gettext

import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Adw', '1')
from gi.repository import GLib, Gtk, Adw

# Setup translations
locale.setlocale(locale.LC_ALL, '')
script_dir = os.path.dirname(os.path.abspath(__file__))
localedir = os.path.join(script_dir, 'locale')
try:
    t = gettext.translation('praya', localedir=localedir)
except FileNotFoundError:
    t = gettext.NullTranslations()
_ = t.gettext


class LowspecApp(Adw.Application):
    def __init__(self):
        super().__init__(application_id='id.blankonlinux.praya.lowspec')
        self.exit_code = 2

    def do_activate(self):
        GLib.set_prgname('Prihatin')
        GLib.set_application_name('Prihatin')

        # Create a hidden parent window so the dialog appears centered
        parent = Adw.ApplicationWindow(application=self)
        parent.set_title('Prihatin')
        parent.set_default_size(1, 1)
        parent.present()

        dialog = Adw.MessageDialog(
            transient_for=parent,
            modal=True,
            heading='\U0001F422',
            heading_use_markup=True,
            body=_("Not all hardware is the same, and that's okay. "
                   "If your device needs a little help, just switch off some "
                   "features to get better performance. You can tweak this "
                   "later in Praya Preferences."),
        )
        # Use Pango markup for large emoji (61440 = 60pt * 1024 Pango units)
        dialog.set_heading('<span size="61440">\U0001F422</span>')
        dialog.set_heading_use_markup(True)

        dialog.add_response('ignore', _('Ignore'))
        dialog.add_response('apply', _('Disable a few features'))
        dialog.set_response_appearance('apply', Adw.ResponseAppearance.SUGGESTED)
        dialog.set_close_response('ignore')

        dialog.connect('response', self._on_response)
        dialog.present()

    def _on_response(self, dialog, response):
        if response == 'ignore':
            self.exit_code = 0
        elif response == 'apply':
            self.exit_code = 1
        self.quit()


def main():
    app = LowspecApp()
    app.run([])
    sys.exit(app.exit_code)


if __name__ == '__main__':
    main()

DOMAIN = praya
POTFILES_JS = $(shell grep '\.js$$' po/POTFILES.in)
POTFILES_PY = $(shell grep '\.py$$' po/POTFILES.in)
LINGUAS = $(shell cat po/LINGUAS)
EXT_UUID = praya@blankonlinux.id
EXT_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(EXT_UUID)
EXT_FILES = extension.js indicator.js constants.js chatbot.js taskbar.js \
	translations.js touch-helper.js metadata.json stylesheet.css \
	lowspec-dialog.py praya-preferences.py assets locale

# Install the working tree over the user's installed extension, so a test
# session runs the code you just edited. Deliberately a copy and not a
# symlink: the packaged autostart updater (praya-update-user.sh) does
# `cp -r` into this directory, which through a symlink would overwrite the
# git working tree.
install-user: build-mo
	@mkdir -p $(EXT_DIR)
	@cp -r $(EXT_FILES) $(EXT_DIR)/
	@echo "Installed working tree to $(EXT_DIR)"

run: install-user
	dbus-run-session -- ./tools/run-rdp.sh

run-devkit-nested:
	dbus-run-session -- gnome-shell --devkit --wayland

pot:
	xgettext --from-code=UTF-8 --language=JavaScript \
		--keyword=_ --keyword=N_ \
		--output=po/$(DOMAIN).pot \
		--package-name=$(DOMAIN) \
		$(POTFILES_JS)
	xgettext --from-code=UTF-8 --language=Python \
		--keyword=_ --keyword=N_ \
		--output=po/$(DOMAIN).pot \
		--join-existing \
		--package-name=$(DOMAIN) \
		$(POTFILES_PY)

update-po:
	@for lang in $(LINGUAS); do \
		if [ -f po/$$lang.po ]; then \
			msgmerge --update --backup=none po/$$lang.po po/$(DOMAIN).pot; \
		else \
			msginit --no-translator --locale=$$lang --input=po/$(DOMAIN).pot --output=po/$$lang.po; \
		fi; \
	done

build-mo:
	@for lang in $(LINGUAS); do \
		mkdir -p locale/$$lang/LC_MESSAGES; \
		msgfmt po/$$lang.po -o locale/$$lang/LC_MESSAGES/$(DOMAIN).mo; \
	done

i18n: pot update-po build-mo

.PHONY: run install-user run-devkit-nested pot update-po build-mo i18n

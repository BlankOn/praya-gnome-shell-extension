DOMAIN = praya
POTFILES_JS = $(shell grep '\.js$$' po/POTFILES.in)
POTFILES_PY = $(shell grep '\.py$$' po/POTFILES.in)
LINGUAS = $(shell cat po/LINGUAS)

# Variant selection: PRAYA_GENERIC=1 builds the generic (other-distro)
# variant. Unset (0) builds the BlankOn variant (the default).
PRAYA_GENERIC ?= 0
export PRAYA_GENERIC

# Generate the variant module, then read the uuid from it.
distro:
	@tools/gen-distro.sh

# The uuid depends on the variant; read it from the generated distro.js.
UUID = $(shell node -e "import('./distro.js').then(m => console.log(m.UUID)).catch(() => {})" 2>/dev/null)
EXT_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
EXT_FILES = extension.js indicator.js constants.js chatbot.js taskbar.js \
	translations.js touch-helper.js startButton.js distro.js metadata.json \
	stylesheet.css lowspec-dialog.py praya-preferences.py distro.py assets locale

# Install the working tree over the user's real installed extension, for
# trying it in an actual desktop session. `make run` does not need this.
# Deliberately a copy and not a symlink: the packaged autostart updater
# (praya-update-user.sh) does `cp -r` into this directory, which through a
# symlink would overwrite the git working tree.
install-user: distro build-mo
	@mkdir -p $(EXT_DIR)
	@cp -r $(EXT_FILES) $(EXT_DIR)/
	@echo "Installed working tree to $(EXT_DIR)"

# Generic variant of install-user.
install-user-generic:
	@$(MAKE) install-user PRAYA_GENERIC=1

# Runs the extension straight from the working tree (see tools/run-rdp.sh);
# nothing is copied into ~/.local/share. Use install-user for that.
run: distro build-mo
	dbus-run-session -- ./tools/run-rdp.sh

# Generic variant of run.
run-generic:
	@$(MAKE) run PRAYA_GENERIC=1

# Runs a nested GNOME Shell via GNOME 50's `--devkit`, also straight from the
# working tree (see tools/run-devkit.sh). Unlike `run` it needs no RDP client,
# but it does need /usr/libexec/mutter-devkit, which Debian/BlankOn lacks.
run-mutter-devkit: distro build-mo
	dbus-run-session -- ./tools/run-devkit.sh

# Generic variant of run-mutter-devkit.
run-mutter-devkit-generic:
	@$(MAKE) run-mutter-devkit PRAYA_GENERIC=1

# Generate the variant files without building.
distro-generic:
	@$(MAKE) distro PRAYA_GENERIC=1

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

# Run the unit tests: Node tests for the JS helpers and Python's unittest
# for the preferences/generator helpers. Requires a generated distro.js/py.
test: distro
	node --test
	python3 -m unittest -v test_praya_preferences test_gen_distro

# Run the test suite against the generic variant.
test-generic:
	@$(MAKE) test PRAYA_GENERIC=1
	@$(MAKE) distro >/dev/null

.PHONY: distro distro-generic run run-generic run-mutter-devkit \
	run-mutter-devkit-generic install-user install-user-generic \
	pot update-po build-mo i18n test test-generic

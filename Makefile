DOMAIN = praya
POTFILES = $(shell cat po/POTFILES.in)
LINGUAS = $(shell cat po/LINGUAS)

run:
	dbus-run-session -- gnome-shell --devkit --wayland

pot:
	xgettext --from-code=UTF-8 --language=JavaScript \
		--keyword=_ --keyword=N_ \
		--output=po/$(DOMAIN).pot \
		--package-name=$(DOMAIN) \
		$(POTFILES)

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

.PHONY: run pot update-po build-mo i18n

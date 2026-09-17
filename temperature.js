import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { _ } from './translations.js';

const HWMON_DIR = '/sys/class/hwmon';
const UPDATE_INTERVAL_MS = 2000;

function readFile(path) {
	try {
		let [ok, contents] = Gio.File.new_for_path(path).load_contents(null)
		if (!ok) {
			return null;
		}
		return new TextDecoder('utf-8').decode(contents).trim();
	}
	catch (e) {
		return null;
	}
}

export function toCelsius(str) {
	if (str === null) {
		return null;
	}
	let n = parseFloat(str);
	return Number.isFinite(n) ? n / 1000 : null;
}

export function formatTemp(celsius) {
	return celsius === null ? '—' : `${Math.round(celsius)}°C`;
}

export function readSensors() {
	let sensors = [];
	let enumerator;
	try {
		enumerator = Gio.File.new_for_path(HWMON_DIR)
			.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
	} catch (e) {
		return sensors;
	}

	let info;
	while ((info = enumerator.next_file(null)) !== null) {
		let hwmon = info.get_name();
		if (!hwmon.startsWith('hwmon')) continue;
		let base = GLib.build_filenamev([HWMON_DIR, hwmon]);
		let chip = readFile(GLib.build_filenamev([base, 'name'])) || hwmon;
		let sub;
		try {
		sub = Gio.File.new_for_path(base)
			.enumerate_children('standard::name',
				Gio.FileQueryInfoFlags.NONE, null);
		} catch (e) {
			continue;
		}

		let entry;
		while ((entry = sub.next_file(null)) !== null) {
			let name = entry.get_name();
			let m = name.match(/^temp(\d+)_input$/);
			if (!m) continue;

			let celsius = toCelsius(readFile(GLib.build_filenamev([base, name])));
			if (celsius === null) continue;

			let label = readFile(GLib.build_filenamev([base, `temp${m[1]}_label`]))
				|| `${chip} temp${m[1]}`;
			let crit = toCelsius(readFile(GLib.build_filenamev([base, `temp${m[1]}_crit`])));

			sensors.push({id: `${hwmon}:${m[1]}`, chip, label, celsius, crit});
		}
	}
	return sensors;
}

export const PrayaTemperatureIndicator = GObject.registerClass(
class PrayaTemperatureIndicator extends PanelMenu.Button {
	_init() {
		super._init(0.0, _('Temperature'));

		let box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
		box.add_child(new St.Icon({
			icon_name: 'temperature-symbolic',
			style_class: 'system-status-icon',
			y_align: Clutter.ActorAlign.CENTER,
		}));
		this._label = new St.Label({
			text: '—',
			y_align: Clutter.ActorAlign.CENTER,
			style_class: 'praya-temp-indicator-label',
		});
		box.add_child(this._label);
		this.add_child(box);

		this.menu.addMenuItem(new PopupMenu.PopupMenuItem(_('Temperature'), {
			reactive: false,
			can_focus: false,
		}));
		this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
		this._rows = [];
		this.menu.connect('open-state-changed', (_menu, open) => {
			if (open) this._renderRows();
		});

		this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, UPDATE_INTERVAL_MS, () => {
			this._update();
			return GLib.SOURCE_CONTINUE;
		});
		this._update();
	}

	_update() {
		let sensors = readSensors();
		let hottest = sensors.reduce((a, b) => (!a || b.celsius > a.celsius) ? b : a, null);
		this._label.text = hottest ? formatTemp(hottest.celsius) : '—';
	}

	_renderRows(sensors = readSensors()) {
		for (let row of this._rows) row.destroy();
		this._rows = [];

		if (sensors.length === 0) {
			let empty = new PopupMenu.PopupMenuItem(_('No sensors found'), {
				reactive: false,
				can_focus: false,
			});
			this.menu.addMenuItem(empty);
			this._rows.push(empty);
			return;
		}

		for (let sensor of sensors) {
			let item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
			item.add_child(new St.Label({text: sensor.label, x_expand: true}));
			item.add_child(new St.Label({text: formatTemp(sensor.celsius)}));
			this.menu.addMenuItem(item);
			this._rows.push(item);
		}
	}

	destroy() {
		if (this._timeoutId) {
			GLib.source_remove(this._timeoutId);
			this._timeoutId = null;
		}
		super.destroy();
	}
});

export function demo() {
	console.assert(toCelsius('78000\n') === 78, 'toCelsius basic');
	console.assert(toCelsius('abc') === null, 'toCelsius invalid');
	console.assert(toCelsius(null) === null, 'toCelsius null');
	console.assert(formatTemp(78.4) === '78°C', 'formatTemp basic');
	console.assert(formatTemp(null) === '—', 'formatTemp null');
	print('temperature.js demo OK');
}

/* Praya session-menu self-test harness.
 *
 * This file is appended to a throwaway copy of extension.js by
 * tests/test-session-menu.sh, so it runs inside a real GNOME Shell (devkit) with
 * the extension loaded. It exercises the bottom session menu and prints
 * machine-checkable lines:
 *
 *     PRAYA-TEST PASS <message>
 *     PRAYA-TEST FAIL <message>
 *     PRAYA-TEST DONE
 *
 * It relies on `GLib` and `Main` already being imported at the top of
 * extension.js; no imports of its own are needed.
 */

const PRAYA_TEST_INDICATOR = 'praya-indicator';

const _prayaTestResults = [];

function _prayaTestLog(kind, message) {
    log(`PRAYA-TEST ${kind} ${message}`);
}

function _prayaTestCheck(ok, message) {
    _prayaTestResults.push(ok);
    _prayaTestLog(ok ? 'PASS' : 'FAIL', message);
}

function _prayaTestApprox(actual, expected, tolerance = 0.5) {
    return Math.abs(actual - expected) <= tolerance;
}

function _prayaTestDone() {
    const passed = _prayaTestResults.filter(r => r).length;
    const total = _prayaTestResults.length;
    _prayaTestLog(passed === total ? 'PASS' : 'FAIL',
        `summary: ${passed}/${total} checks passed`);
    log('PRAYA-TEST DONE');
}

function _prayaTestRun(indicator) {
    try {
        indicator._showPanel();

        // Let the panel build and settle.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            const items = indicator._bottomSectionItems;
            _prayaTestCheck(!!items, 'bottom section was built');

            if (!items) {
                _prayaTestDone();
                return GLib.SOURCE_REMOVE;
            }

            // Profile row: a direct Lock button and a Power toggle.
            _prayaTestCheck(!!items.lockButton, 'Lock button exists in the profile row');
            _prayaTestCheck(!!items.power, 'Power toggle exists in the profile row');
            _prayaTestCheck(!items.lockOptionsBox,
                'Lock has no dropdown (it locks directly)');

            const box = items.powerOptionsBox;
            _prayaTestCheck(!!box, 'Power dropdown exists');

            if (!box) {
                _prayaTestDone();
                return GLib.SOURCE_REMOVE;
            }

            const rows = box.get_children();
            _prayaTestCheck(rows.length === 5,
                `Power dropdown lists 5 rows (got ${rows.length})`);

            const separator = rows[3];
            _prayaTestCheck(!!separator &&
                    (separator.get_style_class_name() || '').includes('praya-separator'),
                'row 4 is a horizontal separator');

            _prayaTestCheck(!box._expanded, 'dropdown starts closed');
            _prayaTestCheck(indicator._getSessionActionsHeight() === 0,
                'closed dropdown contributes no height');

            // Open the dropdown.
            indicator._togglePowerOptions();

            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                _prayaTestCheck(box._expanded, 'dropdown opens when toggled');
                _prayaTestCheck(
                    _prayaTestApprox(indicator._sessionActionsBox.height, box._targetHeight),
                    `open dropdown height matches target ` +
                    `(${indicator._sessionActionsBox.height} vs ${box._targetHeight})`);

                const last = rows[rows.length - 1];
                const bottom = last.y + last.height;
                _prayaTestCheck(bottom <= box.height + 0.5,
                    `last row is fully visible, not clipped ` +
                    `(bottom ${bottom.toFixed(1)} <= box ${box.height})`);

                _prayaTestCheck(
                    indicator._getBottomSectionHeight() ===
                        indicator._bottomSectionCollapsedHeight + box._targetHeight,
                    'bottom section height accounts for the open dropdown');

                // Close it again.
                indicator._togglePowerOptions();

                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                    _prayaTestCheck(!box._expanded, 'dropdown closes on second toggle');
                    _prayaTestCheck(
                        _prayaTestApprox(indicator._sessionActionsBox.height, 0),
                        'dropdown height returns to 0');
                    _prayaTestCheck(
                        indicator._getBottomSectionHeight() ===
                            indicator._bottomSectionCollapsedHeight,
                        'bottom section returns to its collapsed height');
                    _prayaTestDone();
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
    } catch (e) {
        _prayaTestCheck(false, `unexpected exception: ${e.message}`);
        _prayaTestDone();
    }
}

// Wait for the indicator to be added to the panel, then run the checks.
let _prayaTestAttempts = 0;
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, function _prayaTestWaitForIndicator() {
    const indicator = Main.panel.statusArea
        ? Main.panel.statusArea[PRAYA_TEST_INDICATOR]
        : null;

    if (!indicator) {
        if (++_prayaTestAttempts < 40)
            return GLib.SOURCE_CONTINUE;

        _prayaTestCheck(false, `indicator '${PRAYA_TEST_INDICATOR}' was never added`);
        _prayaTestDone();
        return GLib.SOURCE_REMOVE;
    }

    _prayaTestRun(indicator);
    return GLib.SOURCE_REMOVE;
});

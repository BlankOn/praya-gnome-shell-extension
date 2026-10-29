import Gettext from 'gettext';

import { EN } from './translations-en.js';

const Domain = Gettext.domain('praya');
const gettext = Domain.gettext.bind(Domain);

// Follow the system language, but fall back to English when the active
// catalog is missing or a particular message is untranslated.
export function _(msgid) {
    const translated = gettext(msgid);
    return translated === msgid ? (EN[msgid] ?? msgid) : translated;
}

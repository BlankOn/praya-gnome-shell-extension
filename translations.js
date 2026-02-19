import Gettext from 'gettext';
const Domain = Gettext.domain('praya');
export const _ = Domain.gettext.bind(Domain);

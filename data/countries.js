// Registry of country modules. Add a new country by creating data/<CODE>/
// with the same files as data/RO/ and listing it here. A planned entry may carry a note,
// shown in the country selector and the AIP data tab.
import RO from './RO/index.js';

export const COUNTRIES = [
  { code: 'RO', name: 'Romania · LRBB', data: RO },
  // withdrawn: AIP Hungary GEN 0.1 makes any use subject to HungaroControl's prior written consent
  { code: 'HU', name: 'Hungary · LHCC', planned: true, note: 'pending permission from HungaroControl' },
  { code: 'BG', name: 'Bulgaria · LBSR', planned: true },
  { code: 'MUAC', name: 'Maastricht UAC (EDYY)', planned: true },
  { code: 'MD', name: 'Moldova · LUUU', planned: true }
];

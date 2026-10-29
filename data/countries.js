// Registry of country modules. Add a new country by creating data/<CODE>/
// with the same files as data/RO/ and listing it here.
import RO from './RO/index.js';

export const COUNTRIES = [
  { code: 'RO', name: 'Romania · LRBB', data: RO },
  { code: 'HU', name: 'Hungary · LHCC', planned: true },
  { code: 'BG', name: 'Bulgaria · LBSR', planned: true },
  { code: 'MUAC', name: 'Maastricht UAC (EDYY)', planned: true },
  { code: 'MD', name: 'Moldova · LUUU', planned: true }
];

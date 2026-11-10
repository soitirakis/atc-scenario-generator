// Built-in scenario library: scenario files in the same format as Export writes
// (see validateScenarioFile in src/scenario.js). Listed in the order shown on the Scenario tab.
import roArges from './ro-arges-foundational.json';
import roDinsi from './ro-dinsi-weather.json';
import roNight from './ro-knl-night-shift.json';
import roNerdi from './ro-nerdi-coordination.json';

export const LIBRARY = [
  { id: 'ro-arges-foundational', label: 'Romania · ARGES · foundational', file: roArges },
  { id: 'ro-dinsi-weather', label: 'Romania · DINSI · intermediate, weather', file: roDinsi },
  { id: 'ro-knl-night-shift', label: 'Romania · KOMAN + LOMOS + NERDI collapsed · night shift, emergency and military area', file: roNight },
  { id: 'ro-nerdi-coordination', label: 'Romania · NERDI · coordination and late transfer', file: roNerdi }
];

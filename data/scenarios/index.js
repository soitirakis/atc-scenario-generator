// Built-in scenario library: scenario files in the same format as Export writes
// (see validateScenarioFile in src/scenario.js). Listed in the order shown on the Scenario tab.
import roArges from './ro-arges-foundational.json';
import roDinsi from './ro-dinsi-weather.json';
import roKoman from './ro-koman-emergency-tsa.json';
import roNerdi from './ro-nerdi-coordination.json';
import huEast from './hu-east-intermediate.json';
import huFir from './hu-fir-advanced.json';

export const LIBRARY = [
  { id: 'ro-arges-foundational', label: 'Romania · ARGES · foundational', file: roArges },
  { id: 'ro-dinsi-weather', label: 'Romania · DINSI · intermediate, weather', file: roDinsi },
  { id: 'ro-koman-emergency-tsa', label: 'Romania · KOMAN · advanced, emergency and TSA', file: roKoman },
  { id: 'ro-nerdi-coordination', label: 'Romania · NERDI · coordination and late transfer', file: roNerdi },
  { id: 'hu-east-intermediate', label: 'Hungary · EAST · intermediate', file: huEast },
  { id: 'hu-fir-advanced', label: 'Hungary · whole FIR combined · advanced', file: huFir }
];

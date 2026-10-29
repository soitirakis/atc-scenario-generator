import { describe, it, expect } from 'vitest';
import RO from '../../data/RO/index.js';
import { loadCountry } from '../../src/country.js';
import { TYPES } from '../../src/sim.js';
import { buildLocalScenario, buildClaudePrompt, parseClaudeScenario } from '../../src/scenario.js';

const C = loadCountry(RO);
const cfg = (o = {}) => ({ sector: 'DIN', difficulty: 'intermediate', duration: 30, seed: 7, objective: 'Busy sector.', ...o });

describe('local scenario builder', () => {
  it('keeps every inject inside the session', () => {
    for (const duration of [20, 30, 45]) for (const difficulty of ['foundational', 'intermediate', 'advanced']) {
      const s = buildLocalScenario(C, cfg({ duration, difficulty }));
      expect(s.injects.length).toBeGreaterThan(0);
      for (const i of s.injects) {
        expect(TYPES[i.type]).toBeTruthy();
        expect(i.min).toBeGreaterThanOrEqual(1);
        expect(i.min).toBeLessThan(duration);
      }
    }
  });

  it('puts the objective\'s main theme first', () => {
    expect(buildLocalScenario(C, cfg({ objective: 'Handling a pressurisation emergency' , difficulty: 'advanced' })).injects[0].type).toBe('EMERGENCY_DESCENT');
    expect(buildLocalScenario(C, cfg({ objective: 'Civil-military coordination with a TSA' , difficulty: 'advanced' })).injects[0].type).toBe('MILITARY_TSA');
  });

  it('adds a conflict when the objective is about separation', () => {
    const base = buildLocalScenario(C, cfg()).conflicts;
    expect(buildLocalScenario(C, cfg({ objective: 'Late conflict detection and separation' })).conflicts).toBe(base + 1);
  });
});

describe('Claude scenario', () => {
  it('prompt names the sector, its real points and the allowed inject types', () => {
    const p = buildClaudePrompt(C, cfg());
    expect(p).toContain('DINSI');
    expect(p).toContain('LRBBDIN19');
    expect(p).toMatch(/TALAM|ADINA|PILAT/);
    for (const t of Object.keys(TYPES)) expect(p).toContain(t);
  });

  it('validator drops unknown types, clamps times and sorts', () => {
    const s = parseClaudeScenario({
      title: 'T', conflicts: 9,
      injects: [{ min: 50, type: 'LEVEL_BUST', text: 'x' }, { min: 2, type: 'ALIEN_INVASION' }, { min: 5, type: 'WEATHER_CELL' }]
    }, cfg());
    expect(s.injects.map(i => i.type)).toEqual(['WEATHER_CELL', 'LEVEL_BUST']);
    expect(s.injects[1].min).toBe(28);
    expect(s.conflicts).toBe(5);
    expect(s.source).toBe('claude');
  });

  it('validator rejects a reply with no usable injects', () => {
    expect(() => parseClaudeScenario({ injects: [{ type: 'NOPE' }] }, cfg())).toThrow();
    expect(() => parseClaudeScenario(null, cfg())).toThrow();
  });
});

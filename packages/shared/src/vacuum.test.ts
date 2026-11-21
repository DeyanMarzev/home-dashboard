import { describe, expect, it } from 'vitest';
import { vacuumState } from './vacuum.js';

describe('vacuumState', () => {
  it('counts charging, full and dock work as docked', () => {
    for (const code of [8, 100, 22, 23]) expect(vacuumState(code).place).toBe('docked');
    expect(vacuumState(8).label).toBe('Charging');
    expect(vacuumState(100).label).toBe('Fully charged');
  });

  it('leaves the robot alone while it cleans or heads home', () => {
    for (const code of [5, 6, 15, 18]) expect(vacuumState(code).place).toBe('busy');
  });

  it('flags a robot left off its dock, paused, in error or not charging', () => {
    for (const code of [2, 3, 9, 10, 12]) expect(vacuumState(code).place).toBe('stranded');
    expect(vacuumState(3).label).toBe('Idle');
  });

  it('names an unknown code without guessing where the robot is', () => {
    expect(vacuumState(77)).toEqual({ label: 'State 77', place: 'unknown' });
  });
});

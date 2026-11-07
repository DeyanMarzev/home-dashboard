import { describe, expect, it } from 'vitest';
import { isSnakeCase } from './ids.js';

describe('isSnakeCase', () => {
  it.each(['room_sensors', 'co2', 'living_room', 'energy_import', 'pi'])('accepts %s', (id) => {
    expect(isSnakeCase(id)).toBe(true);
  });

  it.each(['', 'Room', 'living-room', '_kitchen', 'kitchen_', 'two__parts', '2nd_floor'])(
    'rejects %j',
    (id) => {
      expect(isSnakeCase(id)).toBe(false);
    },
  );
});

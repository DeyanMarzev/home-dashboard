import { describe, expect, it } from 'vitest';
import { BOTTOM_NAV, isMorePage, MORE_SECTIONS, SECTIONS } from './sections.js';

describe('phone navigation', () => {
  it('reaches every section from the bottom bar or More, plus Settings', () => {
    const reachable = [...BOTTOM_NAV, ...MORE_SECTIONS.map((s) => s.to)];
    for (const s of SECTIONS) expect(reachable).toContain(s.to);
    expect(MORE_SECTIONS.map((s) => s.label)).toEqual([
      'Weather',
      'Water',
      'Wi-Fi',
      'Misc',
      'System',
      'Settings',
    ]);
  });

  it('marks More active on its own pages only', () => {
    expect(isMorePage('/misc')).toBe(true);
    expect(isMorePage('/settings')).toBe(true);
    expect(isMorePage('/rooms')).toBe(false);
    expect(isMorePage('/')).toBe(false);
  });
});

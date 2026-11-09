import { describe, expect, it } from 'vitest';
import { redactor } from './redact.js';

const redact = (value: unknown, options?: Parameters<typeof redactor>[0]) =>
  JSON.parse(JSON.stringify(value, redactor(options), 2)) as unknown;

describe('redactor', () => {
  it('removes a nested address object and other personal fields whatever their type', () => {
    // The shape Glowmarkt returns for a virtual entity (values invented).
    const out = redact({
      name: 'DCC Sourced',
      attributes: { address: { addressLine1: '1', postcode: 'AB1 2CD' } },
      postalCode: 'AB1 2CD',
      mpan: 1234567890123,
    });
    expect(out).toEqual({
      name: 'DCC Sourced',
      attributes: 'REDACTED',
      postalCode: 'REDACTED',
      mpan: 'REDACTED',
    });
  });

  it('replaces ids with stable placeholders, so the same id maps to the same placeholder', () => {
    const out = redact({
      _id: 'a1',
      id: 'a1',
      veId: 'v9',
      resources: [{ resourceId: 'r1', ownerId: 'o1' }, { resourceId: 'r1' }],
      dataSourceUnitInfo: { shid: 's1' },
      valid: 'true', // not an id, despite ending in "id"
    }) as Record<string, unknown>;
    expect(out._id).toBe('REDACTED-_id-1');
    expect(out.id).toBe('REDACTED-_id-1');
    expect(out.veId).toBe('REDACTED-veId-2');
    expect(out.resources).toEqual([
      { resourceId: 'REDACTED-resourceId-3', ownerId: 'REDACTED-ownerId-4' },
      { resourceId: 'REDACTED-resourceId-3' },
    ]);
    expect(out.dataSourceUnitInfo).toEqual({ shid: 'REDACTED-shid-5' });
    expect(out.valid).toBe('true');
  });

  it('catches personal values under any key: MACs, IPv4, IPv6, emails, postcodes', () => {
    const out = redact({
      a: 'AA:BB:CC:DD:EE:01',
      b: '192.168.1.23',
      c: '2a00:23c5:1234:5678::1',
      d: 'fe80::1',
      e: 'Owner <someone@example.com>',
      f: '12 Some Road, Town AB1 2CD',
      g: 'electricity consumption',
      h: '0.123',
    });
    expect(out).toEqual({
      a: '02:00:00:00:00:01',
      b: '192.168.1.x',
      c: 'fd00::x',
      d: 'fd00::x',
      e: 'REDACTED',
      f: 'REDACTED',
      g: 'electricity consumption',
      h: '0.123',
    });
  });

  it('keeps MACs consistent across the output (any case or separator), even under address keys', () => {
    const out = redact({
      knownInterfaces: [{ macAddress: 'AA:BB:CC:DD:EE:01' }, { macAddress: 'AA:BB:CC:DD:EE:02' }],
      connections: [{ macAddress: 'aa-bb-cc-dd-ee-02', ipAddress: '192.168.1.40' }],
      wireless: { bssid: 'AA:BB:CC:DD:EE:01' },
    });
    expect(out).toEqual({
      knownInterfaces: [{ macAddress: '02:00:00:00:00:01' }, { macAddress: '02:00:00:00:00:02' }],
      connections: [{ macAddress: '02:00:00:00:00:02', ipAddress: '192.168.1.x' }],
      wireless: { bssid: '02:00:00:00:00:01' },
    });
  });

  it('numbers device names', () => {
    const out = redact([{ friendlyName: 'Kitchen TV' }, { friendlyName: 'Kitchen TV' }], {
      nameKeys: ['friendlyName'],
      nameLabel: 'device',
    });
    expect(out).toEqual([{ friendlyName: 'device 1' }, { friendlyName: 'device 1' }]);
  });

  it('keeps numbers and readings untouched', () => {
    expect(
      redact({
        data: [
          [1794024000, 0.604],
          [1794025800, 0],
        ],
      }),
    ).toEqual({
      data: [
        [1794024000, 0.604],
        [1794025800, 0],
      ],
    });
  });
});

import { loadAlertsFile, loadRegistryFile, migrate, syncSources } from '@home/db';
import { SOURCES_FILE, startPglite, type TestDatabase } from '@home/db/testing';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlertEngine } from '../../alerts/engine.js';
import { describeDevice, handleDeviceList } from './new-devices.js';

const ALERTS_FILE = fileURLToPath(new URL('../../../../../config/alerts.yaml', import.meta.url));
const log = pino({ level: 'silent' });
let db: TestDatabase;
let engine: AlertEngine;

const seen = (mac: string, over: Record<string, unknown> = {}) => ({
  mac,
  ip: '192.168.1.40',
  vendor: null,
  hostname: null,
  wired: null,
  ...over,
});
const openNewDevices = () =>
  db.sql<{ entity: string; message: string; data: { randomised: boolean } }[]>`
    select entity, message, data from events
    where kind = 'network_new_device' and resolved_at is null order by id`;

beforeAll(async () => {
  db = await startPglite();
  const registry = await loadRegistryFile(SOURCES_FILE);
  await migrate(db.sql, db.migrationsDir);
  await syncSources(db.sql, registry);
  engine = new AlertEngine({ db: db.sql, registry, file: await loadAlertsFile(ALERTS_FILE), log });
  await engine.load();
});

afterAll(async () => {
  await db?.close();
});

describe('new devices on the network (docs/10 §5)', () => {
  it('raises nothing for the first scan (the baseline)', async () => {
    const first = [
      seen('b8:27:eb:00:00:01', { vendor: 'Raspberry Pi Foundation' }),
      seen('a4:c3:f0:00:00:02'),
    ];
    expect(await handleDeviceList(first, db.sql, log)).toEqual({ seen: 2, fresh: 0 });
    expect(await openNewDevices()).toEqual([]);
  });

  it('raises one event for a new device, guests’ private addresses included, and not again', async () => {
    const laptop = seen('f4:5c:89:00:00:03', {
      vendor: 'Apple, Inc.',
      ip: '192.168.1.50',
      wired: true,
    });
    const guest = seen('3a:1f:9c:00:00:04', { ip: '192.168.1.51' });
    expect(await handleDeviceList([laptop, guest], db.sql, log)).toEqual({ seen: 2, fresh: 2 });
    expect(await handleDeviceList([laptop, guest], db.sql, log)).toEqual({ seen: 2, fresh: 0 });
    expect(await openNewDevices()).toEqual([
      {
        entity: 'f4:5c:89:00:00:03',
        message:
          'New device on the network · Apple, Inc. device · 192.168.1.50 · wired. Open Wi-Fi to name it or mark it as yours',
        data: expect.objectContaining({ randomised: false }) as unknown,
      },
      {
        entity: '3a:1f:9c:00:00:04',
        message:
          'New device on the network · Unknown device (private address) · 192.168.1.51. Open Wi-Fi to name it or mark it as yours',
        data: expect.objectContaining({ randomised: true }) as unknown,
      },
    ]);
  });

  it('skips private addresses once an admin switches on ignoreRandomised', async () => {
    await db.sql`insert into alert_rule_overrides (rule_id, params)
                 values ('network_new_device', '{"options": {"ignoreRandomised": true}}')`;
    await engine.load();
    await handleDeviceList([seen('7e:00:00:00:00:05'), seen('00:1a:2b:00:00:06')], db.sql, log);
    const entities = (await openNewDevices()).map((e) => e.entity);
    expect(entities).toContain('00:1a:2b:00:00:06');
    expect(entities).not.toContain('7e:00:00:00:00:05');
  });

  it('closes unacknowledged alerts after a day, and ignores a round without a list', async () => {
    await db.sql`update events set ts = now() - interval '25 hours' where kind = 'network_new_device'`;
    expect(await handleDeviceList(undefined, db.sql, log)).toBeNull();
    await handleDeviceList([seen('b8:27:eb:00:00:01')], db.sql, log);
    expect(await openNewDevices()).toEqual([]);
  });

  it('rejects a malformed list', async () => {
    await expect(handleDeviceList([{ mac: 'not-a-mac' }], db.sql, log)).rejects.toThrow();
  });
});

describe('describeDevice', () => {
  it('prefers the router name, then the maker', () => {
    const d = {
      mac: 'x',
      ip: '192.168.1.9',
      vendor: 'Samsung',
      hostname: null,
      wired: null,
      randomised: false,
    };
    expect(describeDevice(d)).toBe('Samsung device · 192.168.1.9');
    expect(describeDevice({ ...d, hostname: 'Galaxy-Tab' })).toBe(
      'Galaxy-Tab (Samsung) · 192.168.1.9',
    );
    expect(describeDevice({ ...d, vendor: null, ip: null })).toBe('Unknown device');
  });
});

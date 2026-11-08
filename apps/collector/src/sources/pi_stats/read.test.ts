import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readUnderVoltageAlarm, sameFilesystem } from './read.js';

describe('sameFilesystem', () => {
  const dirs: string[] = [];
  afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true }))));

  it('is true for a directory and its parent (data dir on the SD card)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-stats-'));
    dirs.push(dir);
    expect(await sameFilesystem(dir, tmpdir())).toBe(true);
  });

  it('is false across filesystems (data dir on the SSD)', async () => {
    if (process.platform !== 'linux') return;
    expect(await sameFilesystem('/proc', tmpdir())).toBe(false);
  });
});

describe('readUnderVoltageAlarm', () => {
  const dirs: string[] = [];
  afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true }))));

  async function fakeSys(devices: Record<string, Record<string, string>>): Promise<string> {
    const sys = await mkdtemp(join(tmpdir(), 'pi-sys-'));
    dirs.push(sys);
    for (const [device, files] of Object.entries(devices)) {
      await mkdir(join(sys, 'class/hwmon', device), { recursive: true });
      for (const [file, text] of Object.entries(files)) {
        await writeFile(join(sys, 'class/hwmon', device, file), text);
      }
    }
    return sys;
  }

  it('finds the rpi_volt device by name (the hwmon number varies)', async () => {
    const sys = await fakeSys({
      hwmon0: { name: 'cpu_thermal\n', temp1_input: '48000\n' },
      hwmon1: { name: 'rpi_volt\n', in0_lcrit_alarm: '0\n' },
    });
    expect(await readUnderVoltageAlarm(sys)).toBe('0\n');
  });

  it('is null without an rpi_volt device or a hwmon directory', async () => {
    expect(await readUnderVoltageAlarm(await fakeSys({ hwmon0: { name: 'cpu_thermal' } }))).toBe(
      null,
    );
    expect(await readUnderVoltageAlarm(join(tmpdir(), 'does-not-exist-sys'))).toBe(null);
  });
});

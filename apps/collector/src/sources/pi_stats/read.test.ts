import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sameFilesystem } from './read.js';

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

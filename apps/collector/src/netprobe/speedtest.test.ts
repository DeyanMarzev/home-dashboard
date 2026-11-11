import { existsSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseTimings, speedTest, type CurlRunner } from './speedtest.js';

/** curl's -w output for each kind of request, as curl prints it (seconds). */
function fakeCurl(overrides: { download?: string; upload?: string } = {}) {
  const calls: string[][] = [];
  const curl: CurlRunner = (args) => {
    calls.push(args);
    const url = args.at(-1)!;
    if (url.endsWith('bytes=0')) return Promise.resolve('0.050000 0.070000'); // 20 ms
    // 25 MB received in 2.877 s after the first byte.
    if (url.includes('__down'))
      return Promise.resolve(overrides.download ?? '25000000 0.070000 2.947000');
    // 10 MB sent: 4.484 s from first byte out to the reply, one 20 ms round trip of it.
    return Promise.resolve(overrides.upload ?? '10000000 0.050000 4.534000');
  };
  return { curl, calls };
}
const noFile = () => Promise.resolve('/tmp/speedtest-upload.bin');

describe('speedTest', () => {
  it('measures latency, then download and upload, from curl’s own timings', async () => {
    const { curl, calls } = fakeCurl();
    const s = await speedTest(curl, noFile);
    expect(s.latencyMs).toBeCloseTo(20, 5);
    expect(s.downloadMbps).toBeCloseTo(70, 0);
    expect(s.uploadMbps).toBeCloseTo(18, 0);
    expect(calls).toHaveLength(7); // 5 pings, download, upload
  });

  it('streams to /dev/null and uploads from a file, so memory stays flat', async () => {
    const { curl, calls } = fakeCurl();
    await speedTest(curl, noFile);
    for (const args of calls) {
      expect(args).toEqual(expect.arrayContaining(['--output', '/dev/null', '--fail']));
    }
    const upload = calls.at(-1)!;
    expect(upload).toEqual(
      expect.arrayContaining(['--request', 'POST', '--upload-file', '/tmp/speedtest-upload.bin']),
    );
    expect(upload.at(-1)).toBe('https://speed.cloudflare.com/__up');
    expect(calls[5]!.at(-1)).toBe('https://speed.cloudflare.com/__down?bytes=25000000');
  });

  it('uploads a 10 MB file of zeros, and removes it afterwards', async () => {
    let size = 0;
    let file = '';
    const { curl } = fakeCurl();
    const watching: CurlRunner = (args) => {
      const i = args.indexOf('--upload-file');
      if (i >= 0) {
        file = args[i + 1]!;
        size = statSync(file).size;
      }
      return curl(args);
    };
    await speedTest(watching); // the real temporary file
    expect(size).toBe(10_000_000);
    expect(existsSync(file)).toBe(false);
  });

  it('fails when a transfer is cut short', async () => {
    await expect(speedTest(fakeCurl({ download: '1000 0.07 0.1' }).curl, noFile)).rejects.toThrow(
      /download stopped short/,
    );
    await expect(speedTest(fakeCurl({ upload: '1000 0.05 0.1' }).curl, noFile)).rejects.toThrow(
      /upload stopped short/,
    );
  });
});

describe('parseTimings', () => {
  it('reads curl -w numbers and rejects anything else', () => {
    expect(parseTimings('25000000 0.051 2.928\n', 3)).toEqual([25000000, 0.051, 2.928]);
    expect(() => parseTimings('<html>', 3)).toThrow(/unexpected curl timings/);
    expect(() => parseTimings('1 2', 3)).toThrow(/unexpected curl timings/);
  });
});

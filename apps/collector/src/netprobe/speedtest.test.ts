import { describe, expect, it } from 'vitest';
import { speedTest } from './speedtest.js';

describe('speedTest', () => {
  it('measures latency, then download and upload net of one round trip', async () => {
    let clock = 0;
    const fake = ((url: string) => {
      // 20 ms per tiny request; 25 MB down takes 2.877 s; 10 MB up takes 4.464 s.
      clock += url.includes('bytes=0') ? 20 : url.includes('__down') ? 2877 : 4464;
      const size = url.includes('__down?bytes=25000000') ? 25_000_000 : 0;
      return Promise.resolve(new Response(new Uint8Array(size)));
    }) as unknown as typeof fetch;
    const s = await speedTest(new AbortController().signal, fake, () => clock);
    expect(s.latencyMs).toBe(20);
    expect(s.downloadMbps).toBeCloseTo(70, 0);
    expect(s.uploadMbps).toBeCloseTo(18, 0);
  });

  it('fails when the download is cut short', async () => {
    const fake = (() =>
      Promise.resolve(new Response(new Uint8Array(1000)))) as unknown as typeof fetch;
    await expect(speedTest(new AbortController().signal, fake, () => 0)).rejects.toThrow(
      /stopped short/,
    );
  });
});

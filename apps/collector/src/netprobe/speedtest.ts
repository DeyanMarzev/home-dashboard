import { megabitsPerSecond } from '@home/shared';

/**
 * Broadband speed via Cloudflare's speed test endpoints (what speed.cloudflare.com uses):
 * plain HTTPS, no binary, works on arm64. Latency first, then download, then upload.
 */
const BASE = 'https://speed.cloudflare.com';
const DOWNLOAD_BYTES = 25_000_000;
const UPLOAD_BYTES = 10_000_000;
const LATENCY_SAMPLES = 5;

export interface SpeedResult {
  downloadMbps: number;
  uploadMbps: number;
  latencyMs: number;
}

export async function speedTest(
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  now: () => number = () => performance.now(),
): Promise<SpeedResult> {
  const timed = async (url: string, init?: RequestInit) => {
    const start = now();
    const res = await fetchImpl(url, { ...init, signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`speed test server answered HTTP ${res.status}`);
    const body = await res.arrayBuffer();
    return { ms: now() - start, bytes: body.byteLength };
  };

  const pings: number[] = [];
  for (let i = 0; i < LATENCY_SAMPLES; i++) pings.push((await timed(`${BASE}/__down?bytes=0`)).ms);
  pings.sort((a, b) => a - b);
  const latencyMs = pings[Math.floor(pings.length / 2)]!;

  const down = await timed(`${BASE}/__down?bytes=${DOWNLOAD_BYTES}`);
  if (down.bytes < DOWNLOAD_BYTES * 0.9)
    throw new Error(`download stopped short (${down.bytes} bytes)`);
  const up = await timed(`${BASE}/__up`, {
    method: 'POST',
    body: new Uint8Array(UPLOAD_BYTES),
    headers: { 'content-type': 'application/octet-stream' },
  });

  // Take one round trip off each transfer: it's latency, not throughput.
  return {
    downloadMbps: megabitsPerSecond(down.bytes, Math.max(1, down.ms - latencyMs)),
    uploadMbps: megabitsPerSecond(UPLOAD_BYTES, Math.max(1, up.ms - latencyMs)),
    latencyMs,
  };
}

import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { megabitsPerSecond } from '@home/shared';

/**
 * Broadband speed via Cloudflare's speed test endpoints (what speed.cloudflare.com uses):
 * plain HTTPS, works on arm64. Latency first, then download, then upload.
 *
 * The transfers run in `curl`, which streams to /dev/null with small fixed buffers. Reading
 * them in Node held the 25 MB download in memory (measured: ~160 MB peak), past netprobe's
 * 96 MB limit, so Docker killed the container mid-test and no result was ever published.
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

/** Runs curl with these arguments and resolves to its stdout (the -w timings). */
export type CurlRunner = (args: string[]) => Promise<string>;

/** `-w` output as numbers: e.g. "25000000 0.051 2.928" → [25000000, 0.051, 2.928]. */
export function parseTimings(out: string, count: number): number[] {
  const values = out.trim().split(/\s+/).map(Number);
  if (values.length !== count || values.some((v) => !Number.isFinite(v)))
    throw new Error(`unexpected curl timings "${out.trim().slice(0, 80)}"`);
  return values;
}

const COMMON = ['--silent', '--show-error', '--fail', '--max-time', '60', '--output', '/dev/null'];

/** A file of zeros to upload from (netprobe's /tmp is a small tmpfs), written in 64 KB pieces. */
async function uploadFile(): Promise<string> {
  const path = join(tmpdir(), 'speedtest-upload.bin');
  const piece = Buffer.alloc(65_536);
  const out = createWriteStream(path);
  for (let left = UPLOAD_BYTES; left > 0; left -= piece.length) {
    const chunk = left >= piece.length ? piece : piece.subarray(0, left);
    if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
  }
  await new Promise<void>((resolve, reject) =>
    out.end((err?: Error | null) => (err ? reject(err) : resolve())),
  );
  return path;
}

export async function speedTest(
  curl: CurlRunner,
  makeUploadFile: () => Promise<string> = uploadFile,
): Promise<SpeedResult> {
  // Latency: request sent → first byte back, so connection and TLS setup aren't counted.
  const pings: number[] = [];
  for (let i = 0; i < LATENCY_SAMPLES; i++) {
    const [pre, first] = parseTimings(
      await curl([
        ...COMMON,
        '--write-out',
        '%{time_pretransfer} %{time_starttransfer}',
        `${BASE}/__down?bytes=0`,
      ]),
      2,
    );
    pings.push((first! - pre!) * 1000);
  }
  pings.sort((a, b) => a - b);
  const latencyMs = pings[Math.floor(pings.length / 2)]!;

  // Download: bytes over the time spent receiving them.
  const [bytes, start, total] = parseTimings(
    await curl([
      ...COMMON,
      '--write-out',
      '%{size_download} %{time_starttransfer} %{time_total}',
      `${BASE}/__down?bytes=${DOWNLOAD_BYTES}`,
    ]),
    3,
  );
  if (bytes! < DOWNLOAD_BYTES * 0.9) throw new Error(`download stopped short (${bytes} bytes)`);
  const downloadMbps = megabitsPerSecond(bytes!, Math.max(1, (total! - start!) * 1000));

  // Upload: from sending the body to the reply, less the one round trip for the reply.
  const file = await makeUploadFile();
  try {
    const [sent, pre, done] = parseTimings(
      await curl([
        ...COMMON,
        '--request',
        'POST',
        '--header',
        'content-type: application/octet-stream',
        '--upload-file',
        file,
        '--write-out',
        '%{size_upload} %{time_pretransfer} %{time_total}',
        `${BASE}/__up`,
      ]),
      3,
    );
    if (sent! < UPLOAD_BYTES * 0.9) throw new Error(`upload stopped short (${sent} bytes)`);
    const uploadMbps = megabitsPerSecond(sent!, Math.max(1, (done! - pre!) * 1000 - latencyMs));
    return { downloadMbps, uploadMbps, latencyMs };
  } finally {
    await rm(file, { force: true });
  }
}

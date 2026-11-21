import { createHash } from 'node:crypto';
import webpush, { WebPushError } from 'web-push';
import type { PushConfig } from '../config.js';

/** One push to one device (docs/09 §5 Sending). */
export interface PushPayload {
  v: 1;
  phase: 'opened' | 'escalated' | 'resolved' | 'test' | 'rate_limit';
  eventId: number | null;
  ruleId: string | null;
  level: 'warning' | 'alert' | null;
  title: string;
  body: string;
  tag: string;
  url: string;
  ts: string;
}

export interface PushTargetKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type SendResult =
  | { ok: true }
  /** `gone`: the subscription no longer exists (404/410), delete it. `retry`: 429/5xx. */
  | { ok: false; gone: boolean; retry: boolean; error: string };

/** How a push leaves the Pi. Tests use a fake; WebPushChannel is the only real one. */
export interface Channel {
  send(target: PushTargetKeys, payload: PushPayload): Promise<SendResult>;
}

/** TTL and urgency by what it is: urgent alerts live longest and wake the phone. */
function delivery(payload: PushPayload): { TTL: number; urgency: 'high' | 'normal' | 'low' } {
  if (payload.phase === 'resolved') return { TTL: 30 * 60, urgency: 'low' };
  if (payload.level === 'alert') return { TTL: 6 * 3600, urgency: 'high' };
  return { TTL: 3600, urgency: 'normal' };
}

/** A short URL-safe topic: a newer push with the same tag replaces an undelivered older one. */
export function topicFor(tag: string): string {
  return createHash('sha256').update(tag).digest('base64url').slice(0, 32);
}

/** "fcm.googleapis.com …a1b2c3d4": enough to tell devices apart in logs, nothing more. */
export function endpointHint(endpoint: string): string {
  try {
    return `${new URL(endpoint).host} …${endpoint.slice(-8)}`;
  } catch {
    return 'invalid endpoint';
  }
}

export class WebPushChannel implements Channel {
  constructor(private readonly config: PushConfig) {}

  async send(target: PushTargetKeys, payload: PushPayload): Promise<SendResult> {
    try {
      await webpush.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        JSON.stringify(payload),
        {
          vapidDetails: {
            subject: this.config.subject,
            publicKey: this.config.publicKey,
            privateKey: this.config.privateKey,
          },
          ...delivery(payload),
          topic: topicFor(payload.tag),
          timeout: 10_000,
        },
      );
      return { ok: true };
    } catch (err) {
      if (err instanceof WebPushError) {
        const status = err.statusCode;
        return {
          ok: false,
          gone: status === 404 || status === 410,
          retry: status === 429 || status >= 500,
          error: `HTTP ${status}`,
        };
      }
      // Network trouble (timeout, DNS): worth another try.
      return { ok: false, gone: false, retry: true, error: (err as Error).message.slice(0, 200) };
    }
  }
}

/** Fake channel for tests: records pushes; `respond` decides each result. */
export class FakeChannel implements Channel {
  readonly sent: { endpoint: string; payload: PushPayload }[] = [];
  respond: (endpoint: string) => SendResult = () => ({ ok: true });

  send(target: PushTargetKeys, payload: PushPayload): Promise<SendResult> {
    const result = this.respond(target.endpoint);
    if (result.ok) this.sent.push({ endpoint: target.endpoint, payload });
    return Promise.resolve(result);
  }
}

import { z } from 'zod';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Refresh this long before Google's expiry, so a poll never uses a token mid-expiry. */
const EARLY_REFRESH_MS = 120_000;

export interface NestCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** Google refused the refresh token or client: needs the owner (docs/06 § Nest), not a retry. */
export class NestAuthError extends Error {
  override name = 'NestAuthError';
}

const TokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});
const ErrorSchema = z.object({ error: z.string(), error_description: z.string().optional() });

let cached: { accessToken: string; expiresAt: number } | null = null;

export function clearAccessToken(): void {
  cached = null;
}

/** A valid access token, refreshed from the long-lived refresh token when needed. Never logged. */
export async function getAccessToken(
  creds: NestCredentials,
  signal: AbortSignal,
  now = Date.now(),
): Promise<string> {
  if (cached && cached.expiresAt - EARLY_REFRESH_MS > now) return cached.accessToken;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = ErrorSchema.safeParse(body);
    const code = err.success ? err.data.error : `HTTP ${res.status}`;
    if (res.status === 400 || res.status === 401) {
      throw new NestAuthError(
        `Google refused the Nest refresh token (${code}). Re-authorise and update NEST_REFRESH_TOKEN (docs/06 § Nest).`,
      );
    }
    throw new Error(`Google token endpoint answered ${code}`);
  }
  const token = TokenSchema.parse(body);
  cached = { accessToken: token.access_token, expiresAt: now + token.expires_in * 1000 };
  return token.access_token;
}

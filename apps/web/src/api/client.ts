import type { z } from 'zod';

/** Relative by default (the API serves the web app); the Android app sets its own base. */
export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Cloudflare Access redirects to its login page once the session expires. */
export class SessionExpiredError extends ApiError {
  override name = 'SessionExpiredError';
  constructor() {
    super(401, 'Your sign-in has expired. Reload the page to sign in again.');
  }
}

export async function getJson<T>(path: string, schema?: z.ZodType<T>): Promise<T> {
  return request(path, { method: 'GET' }, schema);
}

export async function putJson<T>(path: string, body: unknown, schema?: z.ZodType<T>): Promise<T> {
  return request(
    path,
    { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
    schema,
  );
}

async function request<T>(path: string, init: RequestInit, schema?: z.ZodType<T>): Promise<T> {
  const res = await fetch(API_BASE + path, {
    ...init,
    credentials: 'include',
    // A redirect here can only be Access's login page; don't follow it into a CORS error.
    redirect: 'manual',
    headers: { accept: 'application/json', ...init.headers },
  });
  if (res.type === 'opaqueredirect' || res.status === 401) throw new SessionExpiredError();
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new ApiError(res.status, body?.error?.message ?? `Request failed (HTTP ${res.status})`);
  }
  const body: unknown = await res.json();
  // In development, catch API/UI drift early; in production trust the API (it's tested).
  if (import.meta.env.DEV && schema) {
    const result = schema.safeParse(body);
    if (!result.success)
      console.warn(`${path}: response does not match its schema`, result.error.issues);
  }
  return body as T;
}

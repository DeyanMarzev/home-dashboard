const USER_AGENT = 'home-dashboard (self-hosted; https://github.com/DeyanMarzev/home-dashboard)';

export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * GET a JSON API. Errors name the host and status only: never the full URL or body, which
 * may carry tokens (CLAUDE.md rule 6).
 */
export async function fetchJson(
  url: URL,
  signal: AbortSignal,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const res = await fetch(url, {
    signal,
    headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...headers },
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new HttpError(res.status, `${url.host} answered HTTP ${res.status}`);
  }
  try {
    return await res.json();
  } catch {
    throw new Error(`${url.host} sent a response that is not JSON`);
  }
}

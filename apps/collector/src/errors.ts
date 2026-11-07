/** One line for logs and collector_runs.error: the message plus its cause (e.g. ENOTFOUND). */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? err.cause.message : undefined;
  const name = err.name === 'Error' ? '' : `${err.name}: `;
  return cause && cause !== err.message
    ? `${name}${err.message} (${cause})`
    : `${name}${err.message}`;
}

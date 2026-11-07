/** The subset of pino's logger this package uses, so callers can pass their own. */
export interface LogFn {
  (msg: string): void;
  (obj: object, msg?: string): void;
}

export interface Logger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

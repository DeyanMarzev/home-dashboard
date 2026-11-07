import type { z } from 'zod';
import { HttpError } from './errors.js';

/** Parses request input with a zod schema; a 400 with every problem listed if it doesn't fit. */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    const problems = result.error.issues.map((i) =>
      i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message,
    );
    throw new HttpError(400, 'BAD_REQUEST', problems.join('; '));
  }
  return result.data;
}

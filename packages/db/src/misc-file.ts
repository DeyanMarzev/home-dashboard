import { readFile } from 'node:fs/promises';
import { MiscFileSchema, type MiscFile } from '@home/shared';
import { parse } from 'yaml';

export class MiscFileError extends Error {
  override name = 'MiscFileError';
}

/** Reads and validates config/misc.yaml; a missing file is an empty Misc page. */
export async function loadMiscFile(path: string): Promise<MiscFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { bins: [] };
    throw new MiscFileError(`Cannot read ${path}: ${(err as Error).message}`);
  }
  // YAML reads 2026-11-19 as a string here (the default schema doesn't make dates).
  const parsed = MiscFileSchema.safeParse(parse(text) ?? {});
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new MiscFileError(`Invalid ${path}:\n  - ${problems.join('\n  - ')}`);
  }
  return parsed.data;
}

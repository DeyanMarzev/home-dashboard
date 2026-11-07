import { readFile } from 'node:fs/promises';
import { parseRegistry, RegistryError, type Registry } from '@home/shared';
import { parse } from 'yaml';

/** Reads and validates config/sources.yaml. Throws RegistryError with every problem listed. */
export async function loadRegistryFile(path: string): Promise<Registry> {
  let raw: unknown;
  try {
    raw = parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new RegistryError(`Cannot read source registry ${path}: ${(err as Error).message}`);
  }
  return parseRegistry(raw);
}

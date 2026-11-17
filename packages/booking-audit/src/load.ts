import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { extractRawCalls } from './normalize-retell.js';

export interface LoadResult {
  raws: unknown[];
  filesRead: number;
  /** Files that were not valid JSON. Named in the run notes, never skipped silently. */
  filesFailed: string[];
}

/**
 * Reads call objects a builder already has on disk: one JSON file, or a folder
 * of them. Each file may hold one call, an array of calls, or a list response.
 * For builders who would rather not hand a key to anything.
 */
export async function loadCallsFromPath(path: string): Promise<LoadResult> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`No such file or folder: ${path}`);
  }

  const files = info.isDirectory()
    ? (await readdir(path))
        .filter((name) => name.toLowerCase().endsWith('.json'))
        .sort()
        .map((name) => join(path, name))
    : [path];

  const result: LoadResult = { raws: [], filesRead: 0, filesFailed: [] };
  for (const file of files) {
    try {
      const json: unknown = JSON.parse(await readFile(file, 'utf8'));
      result.raws.push(...extractRawCalls(json));
      result.filesRead += 1;
    } catch {
      result.filesFailed.push(file);
    }
  }
  return result;
}

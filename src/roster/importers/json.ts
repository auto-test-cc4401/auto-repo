import { readFile } from 'node:fs/promises';
import type { RawRow } from '../normalize.js';
import { resolveHeaders, rowFromRecord, type RosterImporter } from './index.js';

/**
 * Reads a JSON array of student records.
 *
 * Handles both spreadsheet-export headers and the legacy `students_info.json`
 * shape (`{name, seccion, github_user, team}`).
 */
export const jsonImporter: RosterImporter = {
  name: 'json',
  canHandle: (source) => /\.json$/i.test(source),
  async load(source) {
    const parsed: unknown = JSON.parse(await readFile(source, 'utf8'));
    if (!Array.isArray(parsed)) {
      throw new Error(`Expected "${source}" to contain a JSON array of students.`);
    }
    const records = parsed as Record<string, unknown>[];
    if (records.length === 0) return [];

    const keys = new Set<string>();
    for (const record of records) for (const key of Object.keys(record)) keys.add(key);

    // `github_user` normalizes to "github user" and matches that alias, so the
    // legacy key needs no special-casing here.
    const mapping = resolveHeaders([...keys]);
    return records.map((record): RawRow => rowFromRecord(record, mapping));
  },
};

import { readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import type { RawRow } from '../normalize.js';
import { resolveHeaders, rowFromRecord, type RosterImporter } from './index.js';

export const csvImporter: RosterImporter = {
  name: 'csv',
  canHandle: (source) => /\.(csv|tsv)$/i.test(source),
  async load(source) {
    const text = await readFile(source, 'utf8');
    const delimiter = /\.tsv$/i.test(source) ? '\t' : ',';
    const records = parse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      bom: true,
      delimiter,
    }) as Record<string, string>[];

    if (records.length === 0) return [];
    const mapping = resolveHeaders(Object.keys(records[0]!));
    if (!mapping.fullName) {
      throw new Error(
        `Could not find a name column in "${source}". Headers seen: ${Object.keys(records[0]!).join(', ')}`,
      );
    }
    return records.map((record): RawRow => rowFromRecord(record, mapping));
  },
};

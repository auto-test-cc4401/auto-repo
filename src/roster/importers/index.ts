import type { RawRow } from '../normalize.js';

/**
 * Pluggable roster source. Other courses hand us different spreadsheets, so
 * the only contract is "produce rows"; normalization is shared downstream.
 */
export interface RosterImporter {
  name: string;
  /** True if this importer can handle the given source string. */
  canHandle(source: string): boolean;
  load(source: string): Promise<RawRow[]>;
}

/**
 * Header aliases seen in the CC4401 Google Form export. Matching is done on a
 * normalized, accent-stripped substring so that the survey's very long GitHub
 * question ("Ingrese su usuario de Github. Si no tienen cuenta...") still maps.
 */
const FIELD_ALIASES: Record<keyof RawRow, string[]> = {
  timestamp: ['timestamp', 'marca temporal', 'fecha'],
  fullName: ['nombre completo', 'nombre', 'full name', 'name'],
  email: ['email address', 'email', 'correo', 'e mail'],
  githubLogin: ['github', 'usuario de github', 'github user'],
  section: ['seccion', 'section'],
  team: ['equipo', 'team', 'grupo', 'group'],
};

function normalizeHeader(header: string): string {
  return header
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Map spreadsheet headers onto RawRow fields.
 *
 * Longer aliases win, so "usuario de github" beats a bare "github" if both
 * somehow appear, and a column is never claimed by two fields.
 */
export function resolveHeaders(headers: string[]): Partial<Record<keyof RawRow, string>> {
  const mapping: Partial<Record<keyof RawRow, string>> = {};
  const claimed = new Set<string>();

  for (const [field, aliases] of Object.entries(FIELD_ALIASES) as [
    keyof RawRow,
    string[],
  ][]) {
    const sorted = [...aliases].sort((a, b) => b.length - a.length);
    for (const alias of sorted) {
      const hit = headers.find(
        (h) => !claimed.has(h) && normalizeHeader(h).includes(alias),
      );
      if (hit) {
        mapping[field] = hit;
        claimed.add(hit);
        break;
      }
    }
  }
  return mapping;
}

export function rowFromRecord(
  record: Record<string, unknown>,
  mapping: Partial<Record<keyof RawRow, string>>,
): RawRow {
  // Values arrive as strings from CSV but can be numbers from JSON — v1's
  // students_info.json stored `seccion` and `team` as numbers.
  const pick = (field: keyof RawRow): string | null => {
    const column = mapping[field];
    if (!column) return null;
    const value = record[column];
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    return text === '' ? null : text;
  };

  return {
    timestamp: pick('timestamp'),
    fullName: pick('fullName') ?? '',
    email: pick('email'),
    githubLogin: pick('githubLogin'),
    section: pick('section'),
    team: pick('team'),
  };
}

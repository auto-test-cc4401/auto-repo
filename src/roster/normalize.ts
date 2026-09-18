/**
 * Roster normalization.
 *
 * Every rule here exists because of a real defect in the CC4401 2026-1 survey
 * export. They are pure functions so they can be tested against that data
 * without touching the network.
 */

/** GitHub login syntax: alphanumeric, single internal hyphens, max 39 chars. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

const GITHUB_URL =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#\s]+)\/?(?:[?#].*)?$/i;

export interface LoginResult {
  /** Bare, syntactically valid login, or null if none could be recovered. */
  login: string | null;
  /** Why it could not be used, for the run report. Null when clean. */
  issue: string | null;
}

/**
 * Recover a bare GitHub login from whatever the student typed into the form.
 *
 * Pasting a full profile URL (`https://github.com/someone`) is common; the API
 * returns 404 for anything but a bare login, so the value is normalized before
 * it is used.
 */
export function normalizeGithubLogin(raw: string | null | undefined): LoginResult {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return { login: null, issue: null };

  const fromUrl = GITHUB_URL.exec(trimmed);
  const candidate = (fromUrl?.[1] ?? trimmed).replace(/^@/, '').trim();

  if (candidate === '') return { login: null, issue: `empty after normalizing "${raw}"` };
  if (!GITHUB_LOGIN.test(candidate)) {
    return { login: null, issue: `"${raw}" is not a valid GitHub username` };
  }
  return { login: candidate, issue: null };
}

/**
 * `"1 - Gonzalo"` / `"2 - Jocelyn"` / `"Sección 2"` / `"2"` -> 2.
 * The form encodes the professor's name into the section field.
 */
export function parseSection(raw: string | number | null | undefined): number | null {
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : null;
  const match = /\d+/.exec((raw ?? '').trim());
  return match ? Number.parseInt(match[0], 10) : null;
}

export function parseTeam(raw: string | number | null | undefined): number | null {
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : null;
  const match = /\d+/.exec((raw ?? '').trim());
  return match ? Number.parseInt(match[0], 10) : null;
}

/** Accent- and case-insensitive key used to match a person across rows. */
export function normalizeName(raw: string | null | undefined): string {
  return (raw ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim().toLowerCase();
  return value === '' ? null : value;
}

/** A row as read from a source, before identity resolution. */
export interface RawRow {
  timestamp?: string | null;
  fullName: string;
  email?: string | null;
  githubLogin?: string | null;
  section?: string | number | null;
  team?: string | number | null;
}

export interface DedupeResult<T> {
  rows: T[];
  /** Human-readable notes about which duplicates were collapsed. */
  notes: string[];
}

/**
 * Collapse repeat submissions, keeping the LAST response per person.
 *
 * Matching is by any shared identity signal — login, email, or normalized name —
 * because the real data contains a student who submitted twice under two
 * different email addresses but the same name and GitHub login. Keying on email
 * alone would have created a phantom second student.
 *
 * `rows` is expected in submission order; callers that have a timestamp should
 * sort by it first.
 */
export function dedupeByPerson<T extends RawRow>(rows: T[]): DedupeResult<T> {
  const kept: (T | null)[] = [];
  const byKey = new Map<string, number>();
  const notes: string[] = [];

  for (const row of rows) {
    const login = normalizeGithubLogin(row.githubLogin).login?.toLowerCase() ?? null;
    const email = normalizeEmail(row.email);
    const name = normalizeName(row.fullName);

    const keys = [
      login ? `login:${login}` : null,
      email ? `email:${email}` : null,
      name ? `name:${name}` : null,
    ].filter((k): k is string => k !== null);

    const existing = keys.map((k) => byKey.get(k)).find((i) => i !== undefined);

    let index: number;
    if (existing === undefined) {
      index = kept.push(row) - 1;
    } else {
      index = existing;
      const previous = kept[index];
      if (previous) {
        notes.push(
          `Kept the later response for "${row.fullName}" (superseded "${previous.fullName}")`,
        );
      }
      kept[index] = row;
    }
    for (const key of keys) byKey.set(key, index);
  }

  return { rows: kept.filter((r): r is T => r !== null), notes };
}

/** Sort rows by their form timestamp so that "last response wins" is meaningful. */
export function sortByTimestamp<T extends RawRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const ta = Date.parse(a.timestamp ?? '');
    const tb = Date.parse(b.timestamp ?? '');
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return -1;
    if (Number.isNaN(tb)) return 1;
    return ta - tb;
  });
}

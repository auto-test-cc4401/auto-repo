import type { CourseConfig } from '../core/config.js';
import { repoNameFor } from '../core/config.js';
import type { DesiredState, DesiredTeam, Student } from '../core/types.js';
import { csvImporter } from './importers/csv.js';
import { jsonImporter } from './importers/json.js';
import type { RosterImporter } from './importers/index.js';
import {
  dedupeByPerson,
  normalizeEmail,
  normalizeGithubLogin,
  normalizeName,
  parseSection,
  parseTeam,
  sortByTimestamp,
  type RawRow,
} from './normalize.js';

export const importers: RosterImporter[] = [csvImporter, jsonImporter];

export type IssueLevel = 'error' | 'warning' | 'info';

export interface RosterIssue {
  level: IssueLevel;
  message: string;
  student?: string;
}

export interface Roster {
  students: Student[];
  issues: RosterIssue[];
  /** Students on a team who never supplied a GitHub username. */
  missingGithub: Student[];
}

function importerFor(source: string): RosterImporter {
  const importer = importers.find((i) => i.canHandle(source));
  if (!importer) {
    throw new Error(
      `No importer handles "${source}". Supported: ${importers.map((i) => i.name).join(', ')}.`,
    );
  }
  return importer;
}

export async function loadRoster(source: string, config: CourseConfig): Promise<Roster> {
  const importer = importerFor(source);
  const raw = await importer.load(source);
  return buildRoster(raw, config);
}

/**
 * Turn raw spreadsheet rows into validated students.
 *
 * Pure, so the whole normalization chain can be tested against the real
 * 2026-1 export without any I/O.
 */
export function buildRoster(rows: RawRow[], config: CourseConfig): Roster {
  const issues: RosterIssue[] = [];

  const ordered = sortByTimestamp(rows);
  const { rows: unique, notes } = dedupeByPerson(ordered);
  for (const note of notes) issues.push({ level: 'info', message: note });

  const docentes = new Set(config.docentes.map((d) => d.toLowerCase()));
  const students: Student[] = [];

  for (const row of unique) {
    const fullName = row.fullName.trim();
    if (fullName === '') {
      issues.push({ level: 'warning', message: 'Skipped a row with no name.' });
      continue;
    }

    const { login, issue } = normalizeGithubLogin(row.githubLogin);
    if (issue) issues.push({ level: 'warning', message: issue, student: fullName });

    const team = parseTeam(row.team);
    if (team === null) {
      issues.push({
        level: 'error',
        message: 'Has no team assignment; cannot be provisioned.',
        student: fullName,
      });
      continue;
    }

    if (login && docentes.has(login.toLowerCase())) {
      issues.push({
        level: 'error',
        message: `"${login}" is in the docentes allowlist but appears in the roster as a student. Skipped.`,
        student: fullName,
      });
      continue;
    }

    students.push({
      fullName,
      email: normalizeEmail(row.email),
      githubLogin: login,
      section: parseSection(row.section) ?? 0,
      team,
    });
  }

  issues.push(...validate(students, config));

  return {
    students,
    issues,
    missingGithub: students.filter((s) => s.githubLogin === null),
  };
}

/** Cross-row checks that only make sense once the whole roster is known. */
export function validate(students: Student[], config: CourseConfig): RosterIssue[] {
  const issues: RosterIssue[] = [];

  // The same GitHub account on two different teams is always a data error:
  // one of the two students would silently get the wrong repo.
  const byLogin = new Map<string, Student[]>();
  for (const student of students) {
    if (!student.githubLogin) continue;
    const key = student.githubLogin.toLowerCase();
    byLogin.set(key, [...(byLogin.get(key) ?? []), student]);
  }
  for (const [login, owners] of byLogin) {
    const teams = new Set(owners.map((o) => o.team));
    if (teams.size > 1) {
      issues.push({
        level: 'error',
        message: `GitHub user "${login}" is assigned to more than one team (${[...teams].sort((a, b) => a - b).join(', ')}).`,
      });
    } else if (owners.length > 1) {
      issues.push({
        level: 'warning',
        message: `GitHub user "${login}" appears ${owners.length} times: ${owners.map((o) => o.fullName).join(', ')}.`,
      });
    }
  }

  // Team numbers must be globally unique, not per-section. In 2026-1 section 2
  // was renumbered 1-12 -> 11-22 for exactly this reason; importing the
  // pre-renumbering tab would collide two sections onto the same repos.
  const sectionsPerTeam = new Map<number, Set<number>>();
  for (const student of students) {
    const set = sectionsPerTeam.get(student.team) ?? new Set<number>();
    set.add(student.section);
    sectionsPerTeam.set(student.team, set);
  }
  for (const [team, sections] of [...sectionsPerTeam].sort((a, b) => a[0] - b[0])) {
    if (sections.size > 1) {
      issues.push({
        level: 'error',
        message: `Team ${team} contains students from sections ${[...sections].sort((a, b) => a - b).join(' and ')}. Team numbers must be unique across sections.`,
      });
    }
  }

  // Team sizes, as a warning: a team of 1 usually means a bad import, but a
  // team of 6 in a course sized for 5 is a normal end-of-enrollment outcome.
  const sizes = new Map<number, number>();
  for (const student of students) sizes.set(student.team, (sizes.get(student.team) ?? 0) + 1);
  for (const [team, size] of [...sizes].sort((a, b) => a[0] - b[0])) {
    if (size < config.teamSize.min || size > config.teamSize.max) {
      issues.push({
        level: 'warning',
        message: `Team ${team} has ${size} members (expected ${config.teamSize.min}-${config.teamSize.max}).`,
      });
    }
  }

  // Same person listed twice under different spellings.
  const byName = new Map<string, Student[]>();
  for (const student of students) {
    const key = normalizeName(student.fullName);
    byName.set(key, [...(byName.get(key) ?? []), student]);
  }
  for (const [, matches] of byName) {
    if (matches.length > 1) {
      issues.push({
        level: 'warning',
        message: `"${matches[0]!.fullName}" appears ${matches.length} times after deduplication.`,
      });
    }
  }

  return issues;
}

/** Project a validated roster onto the GitHub footprint it implies. */
export function toDesiredState(students: Student[], config: CourseConfig): DesiredState {
  const byTeam = new Map<number, Student[]>();
  for (const student of students) {
    byTeam.set(student.team, [...(byTeam.get(student.team) ?? []), student]);
  }

  const teams: DesiredTeam[] = [...byTeam.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([number, members]) => ({
      number,
      teamName: repoNameFor(config, number),
      slug: repoNameFor(config, number).toLowerCase(),
      repoName: repoNameFor(config, number),
      // Students without a GitHub account simply have nothing to add yet.
      // They are reported separately, never dropped from the roster.
      memberLogins: members
        .map((m) => m.githubLogin)
        .filter((l): l is string => l !== null)
        .map((l) => l.toLowerCase())
        .sort(),
    }));

  return { org: config.org, prefix: `${config.year}-${config.semester}-${config.course}`, teams };
}

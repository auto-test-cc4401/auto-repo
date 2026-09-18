import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRoster, toDesiredState, validate } from '../src/roster/index.js';
import { csvImporter } from '../src/roster/importers/csv.js';
import { jsonImporter } from '../src/roster/importers/json.js';
import type { RawRow } from '../src/roster/normalize.js';
import type { Student } from '../src/core/types.js';
import { testConfig } from './helpers.js';

const config = testConfig();

describe('csv importer', () => {
  it('maps the real Google Form headers, including the long GitHub question', async () => {
    const rows = await csvImporter.load('test/fixtures/roster.csv');
    expect(rows).toHaveLength(10);
    expect(rows[0]).toMatchObject({
      fullName: 'Benjamín Francisco Brito Espinoza',
      email: 'benjamin.brito.e@ug.uchile.cl',
      githubLogin: 'BritoEspNya',
      section: '1 - Gonzalo',
      team: '4',
    });
  });

  it('normalizes a whole real-shaped roster end to end', async () => {
    const rows = await csvImporter.load('test/fixtures/roster.csv');
    const roster = buildRoster(rows, config);

    // 10 rows, minus one duplicate Vicente and one duplicate Magdalena.
    expect(roster.students).toHaveLength(8);

    const logins = roster.students.map((s) => s.githubLogin);
    expect(logins).toContain('bytw1');
    expect(logins).toContain('Tomas-Saavedra-Leon');
    expect(logins).toContain('jensen-facts');

    // The student who never filled the form is kept, with a null login.
    const josefina = roster.students.find((s) => s.fullName.startsWith('Josefina'));
    expect(josefina).toBeDefined();
    expect(josefina!.githubLogin).toBeNull();
    expect(josefina!.team).toBe(1);
    expect(roster.missingGithub).toHaveLength(1);

    expect(roster.students.every((s) => s.section === 1 || s.section === 2)).toBe(true);
  });
});

describe('buildRoster', () => {
  const row = (over: Partial<RawRow>): RawRow => ({
    fullName: 'Someone',
    email: null,
    githubLogin: null,
    section: '1 - Gonzalo',
    team: '1',
    ...over,
  });

  it('skips a student with no team but keeps the rest of the roster', () => {
    const roster = buildRoster(
      [row({ fullName: 'No Team', team: null }), row({ fullName: 'Has Team', team: '3' })],
      config,
    );
    expect(roster.students.map((s) => s.fullName)).toEqual(['Has Team']);
    expect(roster.issues.some((i) => i.level === 'error' && i.student === 'No Team')).toBe(true);
  });

  it('refuses to provision a docente listed as a student', () => {
    const roster = buildRoster([row({ fullName: 'Profe', githubLogin: 'gonzalo' })], {
      ...config,
      docentes: ['Gonzalo'],
    });
    expect(roster.students).toHaveLength(0);
    expect(roster.issues.some((i) => i.message.includes('docentes allowlist'))).toBe(true);
  });

  it('warns about a malformed username but keeps the student on the roster', () => {
    const roster = buildRoster([row({ fullName: 'Typo', githubLogin: 'not valid!' })], config);
    expect(roster.students).toHaveLength(1);
    expect(roster.students[0]!.githubLogin).toBeNull();
    expect(roster.issues.some((i) => i.level === 'warning')).toBe(true);
  });
});

describe('validate', () => {
  const student = (over: Partial<Student>): Student => ({
    fullName: 'Someone',
    email: null,
    githubLogin: null,
    section: 1,
    team: 1,
    ...over,
  });

  it('flags one GitHub account assigned to two teams', () => {
    const issues = validate(
      [
        student({ fullName: 'A', githubLogin: 'shared', team: 1 }),
        student({ fullName: 'B', githubLogin: 'shared', team: 2 }),
      ],
      config,
    );
    expect(issues.some((i) => i.level === 'error' && i.message.includes('more than one team'))).toBe(true);
  });

  it('catches the section-renumbering mistake', () => {
    // Importing the pre-renumbering tab collides section 1's team 5 with
    // section 2's team 5, pointing both at the same repository.
    const issues = validate(
      [
        student({ fullName: 'A', section: 1, team: 5, githubLogin: 'a' }),
        student({ fullName: 'B', section: 2, team: 5, githubLogin: 'b' }),
      ],
      config,
    );
    expect(
      issues.some((i) => i.level === 'error' && i.message.includes('unique across sections')),
    ).toBe(true);
  });

  it('accepts globally unique team numbers across sections', () => {
    const issues = validate(
      [
        student({ fullName: 'A', section: 1, team: 5, githubLogin: 'a' }),
        student({ fullName: 'B', section: 2, team: 15, githubLogin: 'b' }),
      ],
      config,
    );
    expect(issues.some((i) => i.message.includes('unique across sections'))).toBe(false);
  });

  it('warns about a team outside the expected size range', () => {
    const issues = validate([student({ fullName: 'Solo', team: 7, githubLogin: 'solo' })], config);
    expect(issues.some((i) => i.level === 'warning' && i.message.includes('Team 7 has 1'))).toBe(true);
  });
});

describe('toDesiredState', () => {
  it('names teams and repos from the semester prefix and excludes students with no account', () => {
    const desired = toDesiredState(
      [
        { fullName: 'A', email: null, githubLogin: 'Alpha', section: 1, team: 5 },
        { fullName: 'B', email: null, githubLogin: null, section: 1, team: 5 },
      ],
      config,
    );
    expect(desired.teams).toHaveLength(1);
    expect(desired.teams[0]).toMatchObject({
      number: 5,
      teamName: '2026-2-CC4401-grupo-5',
      slug: '2026-2-cc4401-grupo-5',
      repoName: '2026-2-CC4401-grupo-5',
      memberLogins: ['alpha'],
    });
  });
});

describe('json importer', () => {
  it('reads the legacy students_info.json shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'auto-repo-json-'));
    const path = join(dir, 'students_info.json');
    // Note that `seccion` and `team` are numbers here, where a CSV source would
    // always deliver strings.
    await writeFile(
      path,
      JSON.stringify([
        { name: 'Nombre Apellido', seccion: 1, github_user: 'BritoEspNya', team: 5 },
        { name: 'Otro Nombre', seccion: 2, github_user: 'amaro-carvajal', team: 4 },
      ]),
      'utf8',
    );

    const roster = buildRoster(await jsonImporter.load(path), config);

    expect(roster.students).toHaveLength(2);
    expect(roster.students[0]).toMatchObject({
      fullName: 'Nombre Apellido',
      githubLogin: 'BritoEspNya',
      section: 1,
      team: 5,
    });
  });

  it('reports placeholder usernames rather than sending them to the API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'auto-repo-json-'));
    const path = join(dir, 'sample_students.json');
    // GitHub logins cannot contain underscores, so a template value left
    // unedited is caught during import instead of failing as a 404 at apply.
    await writeFile(
      path,
      JSON.stringify([
        { name: 'Nombre/s Apellido/s', seccion: 1, github_user: 'github_user_1', team: 5 },
      ]),
      'utf8',
    );

    const roster = buildRoster(await jsonImporter.load(path), config);

    expect(roster.students[0]!.githubLogin).toBeNull();
    expect(roster.issues.some((i) => i.message.includes('not a valid GitHub username'))).toBe(true);
    expect(roster.missingGithub).toHaveLength(1);
  });
});

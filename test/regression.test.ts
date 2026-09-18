import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { jsonImporter } from '../src/roster/importers/json.js';
import { buildRoster } from '../src/roster/index.js';
import { testConfig } from './helpers.js';

const run = promisify(execFile);

/**
 * The original tool stopped working because Node removed the `assert
 * { type: 'json' }` import syntax. These tests pin the two halves of the fix:
 * the old syntax really is fatal on this runtime, and we never use it.
 */
describe('v1 decay regression', () => {
  it('confirms import assertions are a SyntaxError on this Node', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'auto-repo-regression-'));
    await writeFile(join(dir, 'data.json'), '[]', 'utf8');
    await writeFile(
      join(dir, 'v1.mjs'),
      `import data from './data.json' assert { type: 'json' };\nconsole.log(data);\n`,
      'utf8',
    );

    await expect(run(process.execPath, [join(dir, 'v1.mjs')])).rejects.toMatchObject({
      stderr: expect.stringContaining('SyntaxError'),
    });
  });

  it('never uses an import assertion or attribute anywhere in src', async () => {
    const { stdout } = await run('git', ['grep', '-nE', "(assert|with)\\s*\\{\\s*type:", '--', 'src']).catch(
      (error: { code: number; stdout: string }) => {
        // git grep exits 1 when there are no matches, which is what we want.
        if (error.code === 1) return { stdout: '' };
        throw error;
      },
    );
    expect(stdout.trim()).toBe('');
  });

  it('reads the roster at runtime, so a JSON file is data and not a module', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'auto-repo-runtime-'));
    const path = join(dir, 'students_info.json');
    // v1's students_info.json shape: note `seccion` and `team` are numbers,
    // not strings, which the CSV path never produces.
    await writeFile(
      path,
      JSON.stringify([
        { name: 'Nombre Apellido', seccion: 1, github_user: 'BritoEspNya', team: 5 },
        { name: 'Otro Nombre', seccion: 2, github_user: 'amaro-carvajal', team: 4 },
      ]),
      'utf8',
    );

    const rows = await jsonImporter.load(path);
    const roster = buildRoster(rows, testConfig());

    expect(roster.students).toHaveLength(2);
    expect(roster.students[0]).toMatchObject({
      fullName: 'Nombre Apellido',
      githubLogin: 'BritoEspNya',
      section: 1,
      team: 5,
    });
  });

  it('rejects the placeholder usernames in v1\'s sample_students.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'auto-repo-sample-'));
    const path = join(dir, 'sample_students.json');
    // These are the literal placeholders shipped in the original repo. GitHub
    // logins cannot contain underscores, so v1 would have sent them to the API
    // and taken a 404 — which is what killed the whole run.
    await writeFile(
      path,
      JSON.stringify([
        { name: 'Nombre/s Apellido/s', seccion: 1, github_user: 'github_user_1', team: 5 },
      ]),
      'utf8',
    );

    const roster = buildRoster(await jsonImporter.load(path), testConfig());
    expect(roster.students[0]!.githubLogin).toBeNull();
    expect(roster.issues.some((i) => i.message.includes('not a valid GitHub username'))).toBe(true);
    expect(roster.missingGithub).toHaveLength(1);
  });
});

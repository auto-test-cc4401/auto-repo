import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startGithubStub, type StubServer } from './support/github-stub.js';

const exec = promisify(execFile);

/**
 * Drives the built CLI end to end against a local stub API.
 *
 * Unlike the unit tests, this exercises the real entrypoint: argument parsing,
 * config loading, the roster pipeline, the reconcile, the SQLite writes and the
 * report files. What it cannot check is whether the endpoint paths and payloads
 * match the real GitHub API, since the stub is built to the same understanding
 * as the client. `.github/workflows/dry-run.yml` covers that.
 */

const CLI = resolve('dist/cli/index.js');
const ORG = 'stub-org';
const PREFIX = '2026-2-CC4401';
// GitHub slugifies team names to lowercase; repo names keep their case.
const SLUG = PREFIX.toLowerCase();

let stub: StubServer;
let workdir: string;

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function run(args: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], {
      cwd: workdir,
      env: {
        ...process.env,
        GITHUB_API_URL: stub.url,
        GITHUB_TOKEN: 'stub-token',
        // Ensure a real App config in the environment cannot take precedence.
        GITHUB_APP_ID: '',
        GITHUB_APP_INSTALLATION_ID: '',
        GITHUB_APP_PRIVATE_KEY: '',
        GITHUB_APP_PRIVATE_KEY_PATH: '',
      },
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

async function writeRoster(rows: string[]): Promise<void> {
  const header = 'Nombre completo,Email Address,Sección,Ingrese su usuario de Github,Equipo';
  await writeFile(join(workdir, 'roster.csv'), [header, ...rows].join('\n'), 'utf8');
}

function db() {
  return new Database(join(workdir, 'e2e.sqlite'), { readonly: true });
}

beforeAll(async () => {
  if (!existsSync(CLI)) {
    throw new Error('dist/cli/index.js is missing — run `pnpm build` before the e2e tests.');
  }

  stub = await startGithubStub({
    org: ORG,
    // `ana` is already in the org, so she joins teams directly; `bruno` is not,
    // so his membership stays pending. `ghost` is not a GitHub account at all.
    knownUsers: ['ana', 'bruno', 'carla'],
    orgMembers: ['ana'],
  });

  workdir = await mkdtemp(join(tmpdir(), 'auto-repo-e2e-'));

  await writeFile(
    join(workdir, 'course.config.yaml'),
    [
      `org: ${ORG}`,
      'course: CC4401',
      "year: '2026'",
      "semester: '2'",
      'permission: push',
      'teamSize:',
      '  min: 1',
      '  max: 6',
      'autoInit: true',
      'roster: ./roster.csv',
      'databasePath: ./e2e.sqlite',
      'reportDir: ./reports',
    ].join('\n'),
    'utf8',
  );

  await writeRoster([
    'Ana Perez,ana@example.cl,1 - Gonzalo,ana,1',
    'Bruno Soto,bruno@example.cl,1 - Gonzalo,https://github.com/bruno,1',
    'Carla Diaz,carla@example.cl,1 - Gonzalo,carla,2',
    'Fantasma Inexistente,ghost@example.cl,1 - Gonzalo,ghost,2',
    'Sin Cuenta,sincuenta@example.cl,1 - Gonzalo,,2',
  ]);
}, 30_000);

afterAll(async () => {
  await stub?.close();
});

describe('end to end', () => {
  it('doctor reports a healthy environment', async () => {
    const { stdout, code } = await run(['doctor']);
    expect(stdout).toContain('Credentials');
    expect(stdout).toContain(`Organization "${ORG}" is reachable`);
    expect(stdout).toContain('Rate limit');
    expect(code).toBe(0);
  }, 60_000);

  it('roster import flags the nonexistent account without discarding the roster', async () => {
    const { stdout, code } = await run(['roster', 'import']);

    // A profile URL was normalized, so only the genuinely fake login fails.
    expect(stdout).toContain('ghost');
    expect(stdout).toContain('do not exist');
    expect(stdout).toContain('Saved 5 students');
    // Non-zero because something needs the operator's attention.
    expect(code).toBe(1);

    const students = db().prepare('select full_name, github_login from students').all() as {
      full_name: string;
      github_login: string | null;
    }[];
    expect(students).toHaveLength(5);
    expect(students.find((s) => s.full_name === 'Bruno Soto')?.github_login).toBe('bruno');
    expect(students.find((s) => s.full_name === 'Sin Cuenta')?.github_login).toBeNull();
  }, 60_000);

  it('plan describes the work without changing anything', async () => {
    const { stdout, code } = await run(['plan']);

    expect(stdout).toContain(`Create team ${SLUG}-grupo-1`);
    expect(stdout).toContain(`Create private repo ${PREFIX}-grupo-1`);
    expect(stdout).toContain(`Grant ${SLUG}-grupo-1 "push"`);
    expect(stdout).toContain('Add ana');
    // The student with no account and the one that does not exist are excluded.
    expect(stdout).not.toContain('Add ghost');
    expect(code).toBe(0);

    expect(stub.state.teams.size).toBe(0);
    expect(stub.state.repos.size).toBe(0);
  }, 60_000);

  it('apply creates the teams, repos, grants and memberships', async () => {
    const { stdout, code } = await run(['apply']);
    expect(code).toBe(0);
    expect(stdout).toContain('succeeded');

    expect([...stub.state.repos.keys()].sort()).toEqual([
      `${PREFIX}-grupo-1`.toLowerCase(),
      `${PREFIX}-grupo-2`.toLowerCase(),
    ]);
    // Bare repos, but with a default branch to push to.
    for (const repo of stub.state.repos.values()) {
      expect(repo.private).toBe(true);
      expect(repo.autoInit).toBe(true);
    }

    const team1 = stub.state.teams.get(`${PREFIX}-grupo-1`.toLowerCase());
    expect(team1).toBeDefined();
    expect(team1!.repos.get(`${PREFIX}-grupo-1`.toLowerCase())).toBe('push');
    expect(team1!.members.get('ana')).toBe('active');
    expect(team1!.members.get('bruno')).toBe('pending');

    // No template repository is ever generated.
    expect(stub.state.calls.some((c) => c.path.includes('/generate'))).toBe(false);
  }, 60_000);

  it('a second apply is a no-op', async () => {
    const before = stub.state.calls.length;
    const { stdout, code } = await run(['apply']);

    expect(stdout).toContain('Nothing to do');
    expect(code).toBe(0);

    const written = stub.state.calls
      .slice(before)
      .filter((c) => c.method !== 'GET');
    expect(written).toEqual([]);
  }, 60_000);

  it('status separates accepted from pending invitations', async () => {
    const { stdout, code } = await run(['status']);
    expect(code).toBe(0);
    expect(stdout).toContain('1 accepted, 1 pending');
    expect(stdout).toContain('pending: bruno');
    expect(stdout).toContain('have no GitHub account on record');
    expect(stdout).toContain('Sin Cuenta');
  }, 60_000);

  it('removals are withheld until explicitly allowed', async () => {
    // Carla leaves the course.
    await writeRoster([
      'Ana Perez,ana@example.cl,1 - Gonzalo,ana,1',
      'Bruno Soto,bruno@example.cl,1 - Gonzalo,https://github.com/bruno,1',
      'Fantasma Inexistente,ghost@example.cl,1 - Gonzalo,ghost,2',
      'Sin Cuenta,sincuenta@example.cl,1 - Gonzalo,,2',
    ]);

    const team2 = stub.state.teams.get(`${PREFIX}-grupo-2`.toLowerCase())!;
    expect(team2.members.has('carla')).toBe(true);

    const skipped = await run(['apply']);
    expect(skipped.stdout).toContain('will be SKIPPED');
    expect(team2.members.has('carla')).toBe(true);

    const applied = await run(['apply', '--allow-removals']);
    expect(applied.code).toBe(0);
    expect(team2.members.has('carla')).toBe(false);
  }, 60_000);

  it('writes a report naming what failed', async () => {
    const files = await readdir(join(workdir, 'reports'));
    const markdown = files.filter((f) => f.endsWith('.md')).sort();
    expect(markdown.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith('.csv'))).toBe(true);

    const latest = await readFile(join(workdir, 'reports', markdown[markdown.length - 1]!), 'utf8');
    expect(latest).toContain('auto-repo — ' + PREFIX);
    expect(latest).toContain('Students without a GitHub account');
    expect(latest).toContain('Sin Cuenta');
    expect(latest).toContain('ghost');
  }, 60_000);

  it('records every run and action in the database', async () => {
    const handle = db();
    const runs = handle
      .prepare('select command, dry_run, allow_removals, finished_at, exit_status from runs')
      .all() as { command: string; allow_removals: number; finished_at: string | null }[];

    // Four `apply` invocations ran, but the one that found nothing to do
    // returns before opening a run record, so only three are logged.
    expect(runs.filter((r) => r.command === 'apply')).toHaveLength(3);
    // Every run is closed out, including the ones that reported failures.
    expect(runs.every((r) => r.finished_at !== null)).toBe(true);
    expect(runs.some((r) => r.allow_removals === 1)).toBe(true);

    const kinds = handle
      .prepare('select distinct kind from actions order by kind')
      .all() as { kind: string }[];
    expect(kinds.map((k) => k.kind)).toEqual(
      expect.arrayContaining([
        'add-member',
        'create-repo',
        'create-team',
        'grant-team-repo',
        'remove-member',
      ]),
    );

    const skippedRemoval = handle
      .prepare("select count(*) as n from actions where kind = 'remove-member' and outcome = 'skipped'")
      .get() as { n: number };
    expect(skippedRemoval.n).toBeGreaterThan(0);

    const teams = handle.prepare('select number, repo_name from teams order by number').all();
    expect(teams).toHaveLength(2);

    const memberships = handle.prepare('select state, count(*) as n from memberships group by state').all() as {
      state: string;
      n: number;
    }[];
    expect(memberships.some((m) => m.state === 'active')).toBe(true);
    expect(memberships.some((m) => m.state === 'pending')).toBe(true);
  }, 60_000);
});

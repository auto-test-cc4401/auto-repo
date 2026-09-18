import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { diff, summarize } from '../core/diff.js';
import type { Action, DesiredState, Student } from '../core/types.js';
import { memberships, students as studentsTable, teams as teamsTable } from '../db/schema.js';
import {
  finishRun,
  recordAction,
  saveMemberships,
  saveStudents,
  saveTeams,
  startRun,
  upsertSemester,
} from '../db/persist.js';
import { checkLogins, readActualState } from '../github/state.js';
import { loadRoster, toDesiredState, type Roster } from '../roster/index.js';
import { renderCsv, renderMarkdown, type ReportInput } from '../report/markdown.js';
import { buildContext, createClient, whoami, type GlobalOptions } from './context.js';
import { executePlan, type ExecutedAction } from './execute-plan.js';

const check = (ok: boolean) => (ok ? 'OK  ' : 'FAIL');

export async function doctor(options: GlobalOptions): Promise<number> {
  const context = buildContext(options);
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 22;
  console.log(`${check(nodeOk)} Node ${process.versions.node} (need >= 22)`);
  console.log(`OK   Config for ${context.prefix} in org "${context.config.org}"`);

  let client;
  try {
    client = createClient();
  } catch (error) {
    console.log(`FAIL ${(error as Error).message}`);
    return 1;
  }
  console.log(`OK   Credentials: ${client.auth.description}`);

  const actor = await whoami(client);
  if (actor) console.log(`OK   Authenticated as ${actor}`);

  let ok = nodeOk;
  try {
    await client.octokit.request('GET /orgs/{org}', { org: context.config.org });
    console.log(`OK   Organization "${context.config.org}" is reachable`);
  } catch (error) {
    console.log(`FAIL Cannot read org "${context.config.org}": ${(error as Error).message}`);
    ok = false;
  }

  try {
    const { data } = await client.octokit.request('GET /rate_limit');
    const core = data.resources.core;
    console.log(`OK   Rate limit: ${core.remaining}/${core.limit} remaining`);
  } catch {
    console.log('WARN Could not read rate limit');
  }

  return ok ? 0 : 1;
}

export async function rosterImport(options: GlobalOptions): Promise<number> {
  const context = buildContext(options);
  const roster = await loadRoster(context.rosterPath, context.config);
  printRoster(roster);

  const client = createClient();
  const logins = roster.students
    .map((s) => s.githubLogin)
    .filter((l): l is string => l !== null);
  const checked = await checkLogins(client, logins);

  const invalid = [...checked.values()].filter((c) => !c.exists);
  if (invalid.length > 0) {
    console.log('');
    console.log(`${invalid.length} GitHub username(s) do not exist:`);
    for (const { login } of invalid) {
      const owners = roster.students.filter(
        (s) => s.githubLogin?.toLowerCase() === login.toLowerCase(),
      );
      const who = owners.map((o) => `${o.fullName} (team ${o.team})`).join(', ');
      console.log(`  - ${login}: ${who || 'unknown student'}`);
    }
  }

  const semesterId = upsertSemester(context.db, context.config);
  saveStudents(
    context.db,
    semesterId,
    roster.students,
    new Map([...checked].map(([login, c]) => [login, c.id])),
  );
  console.log('');
  console.log(`Saved ${roster.students.length} students to the database.`);
  return invalid.length > 0 ? 1 : 0;
}

interface PlanResult {
  actions: Action[];
  desired: DesiredState;
  roster: Roster;
  context: ReturnType<typeof buildContext>;
  blocking: string[];
}

async function computePlan(options: GlobalOptions): Promise<PlanResult & { client: ReturnType<typeof createClient> }> {
  const context = buildContext(options);
  const roster = await loadRoster(context.rosterPath, context.config);
  const client = createClient();

  const actual = await readActualState(client, context.config.org, context.prefix);
  const checked = await checkLogins(
    client,
    roster.students.map((s) => s.githubLogin).filter((l): l is string => l !== null),
  );

  // Students whose account does not exist are excluded from the desired state
  // rather than attempted: the API call would 404 and, in v1, take the run with it.
  const usable: Student[] = roster.students.map((student) => {
    const login = student.githubLogin?.toLowerCase();
    if (login && checked.get(login)?.exists === false) {
      roster.issues.push({
        level: 'error',
        message: `GitHub user "${student.githubLogin}" does not exist; not provisioned.`,
        student: student.fullName,
      });
      return { ...student, githubLogin: null };
    }
    return student;
  });

  const desired = toDesiredState(usable, context.config);

  // Structural problems affect the whole plan; per-student ones already took
  // that student out of the desired state above.
  const blocking = roster.issues
    .filter((i) => i.level === 'error' && !i.student)
    .map((i) => i.message);

  return {
    actions: diff(desired, actual, context.config.permission),
    desired,
    roster: { ...roster, students: usable },
    context,
    blocking,
    client,
  };
}

export async function plan(options: GlobalOptions): Promise<number> {
  const { actions, roster, context, blocking } = await computePlan(options);
  printRoster(roster);
  printPlan(actions);

  const semesterId = upsertSemester(context.db, context.config);
  const runId = startRun(context.db, {
    command: 'plan',
    actorLogin: null,
    authMode: null,
    dryRun: true,
    allowRemovals: false,
  });
  for (const action of actions) recordAction(context.db, runId, action, { outcome: 'planned' });
  finishRun(context.db, runId, 0);
  saveStudents(context.db, semesterId, roster.students);

  if (blocking.length > 0) {
    console.log('');
    console.log('These must be fixed before `apply` will run:');
    for (const message of blocking) console.log(`  - ${message}`);
    return 1;
  }
  return 0;
}

export async function apply(
  options: GlobalOptions & { allowRemovals?: boolean },
): Promise<number> {
  const { actions, desired, roster, context, blocking, client } = await computePlan(options);
  printRoster(roster);

  if (blocking.length > 0) {
    console.log('Refusing to apply — the roster has structural errors:');
    for (const message of blocking) console.log(`  - ${message}`);
    return 1;
  }

  printPlan(actions);
  if (actions.length === 0) {
    console.log('');
    console.log('Nothing to do.');
    return 0;
  }

  const allowRemovals = options.allowRemovals ?? false;
  const destructive = actions.filter((a) => a.destructive).length;
  if (destructive > 0 && !allowRemovals) {
    console.log('');
    console.log(
      `${destructive} removal(s) will be SKIPPED. Re-run with --allow-removals to apply them.`,
    );
  }

  const semesterId = upsertSemester(context.db, context.config);
  const actor = await whoami(client);
  const runId = startRun(context.db, {
    command: 'apply',
    actorLogin: actor,
    authMode: client.auth.mode,
    dryRun: false,
    allowRemovals,
  });

  console.log('');
  const executed = await executePlan(client, context.config, actions, {
    allowRemovals,
    onResult: ({ action, result }) => {
      const mark = result.outcome === 'succeeded' ? '+' : result.outcome === 'failed' ? '!' : '.';
      console.log(`  ${mark} ${action.summary}${result.outcome === 'failed' ? ` — ${'error' in result ? result.error : ''}` : ''}`);
      recordAction(context.db, runId, action, result);
    },
  });

  // Re-read so the stored snapshot reflects reality, including which
  // invitations are still pending rather than accepted.
  const finalState = await readActualState(client, context.config.org, context.prefix);
  saveTeams(context.db, semesterId, desired, finalState);
  saveStudents(context.db, semesterId, roster.students);
  saveMemberships(context.db, semesterId, finalState);

  const failed = executed.filter((e) => e.result.outcome === 'failed').length;
  finishRun(context.db, runId, failed > 0 ? 1 : 0);

  const reportPath = writeReport(context, 'apply', roster, executed, allowRemovals);
  console.log('');
  console.log(summaryLine(executed));
  console.log(`Report: ${reportPath}`);
  return failed > 0 ? 1 : 0;
}

export async function status(options: GlobalOptions): Promise<number> {
  const context = buildContext(options);
  const semesterId = upsertSemester(context.db, context.config);

  const teamRows = context.db
    .select()
    .from(teamsTable)
    .where(eq(teamsTable.semesterId, semesterId))
    .all();
  const studentRows = context.db
    .select()
    .from(studentsTable)
    .where(eq(studentsTable.semesterId, semesterId))
    .all();
  const membershipRows = context.db.select().from(memberships).all();

  if (teamRows.length === 0) {
    console.log('No teams recorded yet. Run `auto-repo apply` first.');
    return 0;
  }

  const studentById = new Map(studentRows.map((s) => [s.id, s]));
  console.log(`${context.prefix} — ${teamRows.length} teams`);
  console.log('');

  let pendingTotal = 0;
  for (const team of teamRows.sort((a, b) => a.number - b.number)) {
    const rows = membershipRows.filter((m) => m.teamId === team.id && m.state !== 'removed');
    const active = rows.filter((m) => m.state === 'active').length;
    const pending = rows.filter((m) => m.state === 'pending').length;
    pendingTotal += pending;
    const roster = studentRows.filter((s) => s.teamNumber === team.number);
    const noAccount = roster.filter((s) => !s.githubLogin).length;

    console.log(
      `  grupo ${String(team.number).padStart(2)}  ${active} accepted, ${pending} pending` +
        (noAccount > 0 ? `, ${noAccount} without a GitHub account` : ''),
    );
    for (const row of rows.filter((m) => m.state === 'pending')) {
      const student = studentById.get(row.studentId);
      if (student) console.log(`              pending: ${student.githubLogin} (${student.fullName})`);
    }
  }

  const missing = studentRows.filter((s) => !s.githubLogin);
  if (missing.length > 0) {
    console.log('');
    console.log(`${missing.length} student(s) have no GitHub account on record:`);
    for (const student of missing.sort((a, b) => a.teamNumber - b.teamNumber)) {
      console.log(`  - team ${student.teamNumber}: ${student.fullName} <${student.email ?? 'no email'}>`);
    }
  }
  if (pendingTotal > 0) {
    console.log('');
    console.log(`${pendingTotal} invitation(s) still unaccepted.`);
  }
  return 0;
}

export async function report(options: GlobalOptions): Promise<number> {
  const { actions, roster, context } = await computePlan(options);
  const executed: ExecutedAction[] = actions.map((action) => ({
    action,
    result: { outcome: 'planned' as const },
  }));
  const path = writeReport(context, 'report', roster, executed, false);
  console.log(`Report: ${path}`);
  return 0;
}

function writeReport(
  context: ReturnType<typeof buildContext>,
  command: string,
  roster: Roster,
  executed: ExecutedAction[],
  allowRemovals: boolean,
): string {
  const input: ReportInput = {
    command,
    prefix: context.prefix,
    org: context.config.org,
    dryRun: command !== 'apply',
    allowRemovals,
    issues: roster.issues,
    missingGithub: roster.missingGithub,
    results: executed,
  };
  mkdirSync(context.config.reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = join(context.config.reportDir, `${stamp}_${command}`);
  writeFileSync(`${base}.md`, renderMarkdown(input), 'utf8');
  writeFileSync(`${base}.csv`, renderCsv(input), 'utf8');
  return `${base}.md`;
}

function printRoster(roster: Roster): void {
  const teams = new Set(roster.students.map((s) => s.team));
  console.log(
    `Roster: ${roster.students.length} students across ${teams.size} teams` +
      (roster.missingGithub.length > 0
        ? `, ${roster.missingGithub.length} without a GitHub account`
        : ''),
  );
  const notable = roster.issues.filter((i) => i.level !== 'info');
  for (const issue of notable) {
    console.log(`  ${issue.level}: ${issue.student ? `${issue.student} — ` : ''}${issue.message}`);
  }
}

function printPlan(actions: Action[]): void {
  console.log('');
  if (actions.length === 0) {
    console.log('Plan: no changes — GitHub already matches the roster.');
    return;
  }
  const counts = summarize(actions);
  console.log(
    `Plan: ${actions.length} action(s) — ${Object.entries(counts)
      .map(([kind, n]) => `${n} ${kind}`)
      .join(', ')}`,
  );
  for (const action of actions) {
    console.log(`  ${action.destructive ? '-' : '+'} ${action.summary}`);
  }
}

function summaryLine(executed: ExecutedAction[]): string {
  const counts: Record<string, number> = {};
  for (const { result } of executed) {
    counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([outcome, n]) => `${n} ${outcome}`)
    .join(', ');
}

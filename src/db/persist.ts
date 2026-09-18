import { and, eq } from 'drizzle-orm';
import type { CourseConfig } from '../core/config.js';
import { prefixOf } from '../core/config.js';
import type { Action, ActualState, DesiredState, Student } from '../core/types.js';
import type { ExecutionResult } from '../github/execute.js';
import type { Db } from './index.js';
import { actions, memberships, runs, semesters, students, teams } from './schema.js';

export function upsertSemester(db: Db, config: CourseConfig): number {
  const prefix = prefixOf(config);
  const existing = db.select().from(semesters).where(eq(semesters.prefix, prefix)).get();
  if (existing) return existing.id;

  const inserted = db
    .insert(semesters)
    .values({
      year: config.year,
      semester: config.semester,
      course: config.course,
      org: config.org,
      prefix,
    })
    .returning()
    .get();
  return inserted.id;
}

/** Replace the roster snapshot for a semester, preserving GitHub ids we know. */
export function saveStudents(
  db: Db,
  semesterId: number,
  roster: Student[],
  githubIds: Map<string, number | null> = new Map(),
): void {
  db.transaction((tx) => {
    for (const student of roster) {
      const login = student.githubLogin;
      const githubUserId = login ? (githubIds.get(login.toLowerCase()) ?? null) : null;
      tx.insert(students)
        .values({
          semesterId,
          fullName: student.fullName,
          email: student.email,
          githubLogin: login,
          githubUserId,
          section: student.section,
          teamNumber: student.team,
        })
        .onConflictDoUpdate({
          target: [students.semesterId, students.fullName],
          set: {
            email: student.email,
            githubLogin: login,
            githubUserId,
            section: student.section,
            teamNumber: student.team,
            updatedAt: new Date().toISOString(),
          },
        })
        .run();
    }
  });
}

export function saveTeams(
  db: Db,
  semesterId: number,
  desired: DesiredState,
  actual: ActualState,
): void {
  db.transaction((tx) => {
    for (const team of desired.teams) {
      const actualTeam = actual.teams.get(team.slug.toLowerCase());
      const actualRepo = actual.repos.get(team.repoName.toLowerCase());
      tx.insert(teams)
        .values({
          semesterId,
          number: team.number,
          githubTeamSlug: team.slug,
          githubTeamId: actualTeam?.id ?? null,
          repoName: team.repoName,
          repoId: actualRepo?.id ?? null,
        })
        .onConflictDoUpdate({
          target: [teams.semesterId, teams.number],
          set: {
            githubTeamSlug: team.slug,
            githubTeamId: actualTeam?.id ?? null,
            repoName: team.repoName,
            repoId: actualRepo?.id ?? null,
          },
        })
        .run();
    }
  });
}

/**
 * Snapshot who is actually on each team, and in what state.
 *
 * `pending` vs `active` is kept rather than flattened: it is precisely the
 * distinction the rubric's "Acceso al repo" row is graded on.
 */
export function saveMemberships(db: Db, semesterId: number, actual: ActualState): void {
  const now = new Date().toISOString();
  const teamRows = db.select().from(teams).where(eq(teams.semesterId, semesterId)).all();
  const studentRows = db.select().from(students).where(eq(students.semesterId, semesterId)).all();
  const byLogin = new Map(
    studentRows
      .filter((s) => s.githubLogin)
      .map((s) => [s.githubLogin!.toLowerCase(), s.id] as const),
  );

  db.transaction((tx) => {
    for (const teamRow of teamRows) {
      const actualTeam = actual.teams.get(teamRow.githubTeamSlug.toLowerCase());
      const seen = new Set<number>();

      for (const [login, state] of actualTeam?.members ?? []) {
        const studentId = byLogin.get(login);
        if (studentId === undefined) continue; // not a roster member; left alone
        seen.add(studentId);
        tx.insert(memberships)
          .values({ studentId, teamId: teamRow.id, state, lastSeen: now })
          .onConflictDoUpdate({
            target: [memberships.studentId, memberships.teamId],
            set: { state, lastSeen: now },
          })
          .run();
      }

      // Anyone previously recorded on this team but absent now is marked
      // removed rather than deleted, so the history stays readable.
      const previous = tx
        .select()
        .from(memberships)
        .where(eq(memberships.teamId, teamRow.id))
        .all();
      for (const row of previous) {
        if (seen.has(row.studentId) || row.state === 'removed') continue;
        tx.update(memberships)
          .set({ state: 'removed', lastSeen: now })
          .where(
            and(eq(memberships.studentId, row.studentId), eq(memberships.teamId, teamRow.id)),
          )
          .run();
      }
    }
  });
}

export interface RunContext {
  command: string;
  actorLogin: string | null;
  authMode: string | null;
  dryRun: boolean;
  allowRemovals: boolean;
}

export function startRun(db: Db, context: RunContext): number {
  return db
    .insert(runs)
    .values({
      command: context.command,
      actorLogin: context.actorLogin,
      authMode: context.authMode,
      dryRun: context.dryRun,
      allowRemovals: context.allowRemovals,
    })
    .returning()
    .get().id;
}

export function recordAction(
  db: Db,
  runId: number,
  action: Action,
  result: ExecutionResult | { outcome: 'planned' | 'skipped' },
): void {
  const executed = 'httpStatus' in result ? result : null;
  db.insert(actions)
    .values({
      runId,
      kind: action.kind,
      resourceId: action.resourceId,
      summary: action.summary,
      destructive: action.destructive,
      outcome: result.outcome,
      httpStatus: executed?.httpStatus ?? null,
      error: executed?.error ?? null,
      durationMs: executed?.durationMs ?? null,
    })
    .run();
}

export function finishRun(db: Db, runId: number, exitStatus: number): void {
  db.update(runs)
    .set({ finishedAt: new Date().toISOString(), exitStatus })
    .where(eq(runs.id, runId))
    .run();
}

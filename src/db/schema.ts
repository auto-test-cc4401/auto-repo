import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Phase 1 schema. `runs` + `actions` are the log of actions taken; `teams` +
 * `memberships` are the record of who was on which team. Phase 2 dashboards add
 * commits/pull_requests/reviews keyed off `teams` and `students`, so no
 * migration of this data is needed later.
 */

export const semesters = sqliteTable(
  'semesters',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    year: text('year').notNull(),
    semester: text('semester').notNull(),
    course: text('course').notNull(),
    org: text('org').notNull(),
    prefix: text('prefix').notNull(),
    createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [uniqueIndex('semesters_prefix_idx').on(t.prefix)],
);

export const students = sqliteTable(
  'students',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    semesterId: integer('semester_id')
      .notNull()
      .references(() => semesters.id),
    fullName: text('full_name').notNull(),
    email: text('email'),
    /** Nullable: a student can be on a team without ever supplying an account. */
    githubLogin: text('github_login'),
    /** Numeric GitHub id, stable across username changes. */
    githubUserId: integer('github_user_id'),
    section: integer('section').notNull(),
    teamNumber: integer('team_number').notNull(),
    status: text('status').notNull().default('active'),
    updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    index('students_semester_idx').on(t.semesterId),
    uniqueIndex('students_identity_idx').on(t.semesterId, t.fullName),
  ],
);

export const teams = sqliteTable(
  'teams',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    semesterId: integer('semester_id')
      .notNull()
      .references(() => semesters.id),
    number: integer('number').notNull(),
    githubTeamSlug: text('github_team_slug').notNull(),
    githubTeamId: integer('github_team_id'),
    repoName: text('repo_name').notNull(),
    repoId: integer('repo_id'),
  },
  (t) => [uniqueIndex('teams_semester_number_idx').on(t.semesterId, t.number)],
);

export const memberships = sqliteTable(
  'memberships',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    studentId: integer('student_id')
      .notNull()
      .references(() => students.id),
    teamId: integer('team_id')
      .notNull()
      .references(() => teams.id),
    /** pending | active | removed */
    state: text('state').notNull(),
    firstSeen: text('first_seen').notNull().default(sql`CURRENT_TIMESTAMP`),
    lastSeen: text('last_seen').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [uniqueIndex('memberships_student_team_idx').on(t.studentId, t.teamId)],
);

export const runs = sqliteTable('runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  command: text('command').notNull(),
  actorLogin: text('actor_login'),
  authMode: text('auth_mode'),
  dryRun: integer('dry_run', { mode: 'boolean' }).notNull(),
  allowRemovals: integer('allow_removals', { mode: 'boolean' }).notNull().default(false),
  startedAt: text('started_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  finishedAt: text('finished_at'),
  exitStatus: integer('exit_status'),
});

export const actions = sqliteTable(
  'actions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => runs.id),
    kind: text('kind').notNull(),
    resourceId: text('resource_id').notNull(),
    summary: text('summary').notNull(),
    destructive: integer('destructive', { mode: 'boolean' }).notNull().default(false),
    /** succeeded | skipped | failed | planned */
    outcome: text('outcome').notNull(),
    httpStatus: integer('http_status'),
    error: text('error'),
    durationMs: integer('duration_ms'),
    createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [index('actions_run_idx').on(t.runId)],
);

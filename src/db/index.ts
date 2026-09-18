import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;
export * as schema from './schema.js';

/**
 * Schema is applied with plain idempotent DDL rather than generated migration
 * files: one table set, one writer, and a CREATE TABLE IF NOT EXISTS keeps the
 * tool runnable from a clean checkout with no extra build step.
 */
const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS semesters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year TEXT NOT NULL,
  semester TEXT NOT NULL,
  course TEXT NOT NULL,
  org TEXT NOT NULL,
  prefix TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS semesters_prefix_idx ON semesters (prefix);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  semester_id INTEGER NOT NULL REFERENCES semesters(id),
  full_name TEXT NOT NULL,
  email TEXT,
  github_login TEXT,
  github_user_id INTEGER,
  section INTEGER NOT NULL,
  team_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS students_semester_idx ON students (semester_id);
CREATE UNIQUE INDEX IF NOT EXISTS students_identity_idx ON students (semester_id, full_name);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  semester_id INTEGER NOT NULL REFERENCES semesters(id),
  number INTEGER NOT NULL,
  github_team_slug TEXT NOT NULL,
  github_team_id INTEGER,
  repo_name TEXT NOT NULL,
  repo_id INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS teams_semester_number_idx ON teams (semester_id, number);

CREATE TABLE IF NOT EXISTS memberships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  state TEXT NOT NULL,
  first_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS memberships_student_team_idx ON memberships (student_id, team_id);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  command TEXT NOT NULL,
  actor_login TEXT,
  auth_mode TEXT,
  dry_run INTEGER NOT NULL,
  allow_removals INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  exit_status INTEGER
);

CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  destructive INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL,
  http_status INTEGER,
  error TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS actions_run_idx ON actions (run_id);
`;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.exec(DDL);
  return drizzle(sqlite, { schema });
}

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * Course configuration. Every value here changes between semesters, so it lives
 * in a file rather than in source and the code is identical from one term to
 * the next.
 */
export const courseConfigSchema = z.object({
  org: z.string().min(1),
  course: z.string().min(1),
  year: z.coerce.string().regex(/^\d{4}$/),
  /** 1 = autumn, 2 = spring, 3 = summer. */
  semester: z.coerce.string().regex(/^[123]$/),
  /** Permission granted to each group team on its own repo. */
  permission: z
    .enum(['pull', 'triage', 'push', 'maintain', 'admin'])
    .default('push'),
  /** Section count varies by semester (2 in 2026-1, 1 in 2026-2). */
  sections: z.number().int().positive().default(1),
  teamSize: z
    .object({ min: z.number().int().positive(), max: z.number().int().positive() })
    .default({ min: 4, max: 6 }),
  /**
   * Teaching staff GitHub logins. Used to refuse to provision a docente as if
   * they were a student; also the seed for Phase 2 web auth.
   */
  docentes: z.array(z.string()).default([]),
  /**
   * Create an initial README commit so the repo has a real default branch.
   * Without it a new repo has no commits and no `main`, which is a confusing
   * first push for students new to git.
   */
  autoInit: z.boolean().default(true),
  /** Default roster location; overridable with --roster. */
  roster: z.string().default('./roster/students.csv'),
  databasePath: z.string().default('./auto-repo.sqlite'),
  /** Where run reports are written. */
  reportDir: z.string().default('./reports'),
});

export type CourseConfig = z.infer<typeof courseConfigSchema>;

/** `{year}-{semester}-{course}`, the prefix for every team and repo name. */
export function prefixOf(config: CourseConfig): string {
  return `${config.year}-${config.semester}-${config.course}`;
}

export function repoNameFor(config: CourseConfig, team: number): string {
  return `${prefixOf(config)}-grupo-${team}`;
}

export function loadConfig(path: string): CourseConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `Could not read course config at "${path}". Copy course.config.example.yaml and fill it in.`,
    );
  }
  const parsed = courseConfigSchema.safeParse(parseYaml(raw));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid course config at "${path}":\n${issues}`);
  }
  return parsed.data;
}

import type { Action } from '../core/types.js';
import type { ExecutionResult } from '../github/execute.js';
import type { RosterIssue } from '../roster/index.js';
import type { Student } from '../core/types.js';

export interface ReportInput {
  command: string;
  prefix: string;
  org: string;
  dryRun: boolean;
  allowRemovals: boolean;
  issues: RosterIssue[];
  missingGithub: Student[];
  results: { action: Action; result: ExecutionResult | { outcome: 'planned' | 'skipped' } }[];
}

export function renderMarkdown(input: ReportInput): string {
  const lines: string[] = [];
  const counts = tally(input);

  lines.push(`# auto-repo — ${input.prefix}`);
  lines.push('');
  lines.push(`- Organization: \`${input.org}\``);
  lines.push(`- Command: \`${input.command}\`${input.dryRun ? ' (dry run — nothing was changed)' : ''}`);
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push('| Outcome | Count |');
  lines.push('| --- | ---: |');
  for (const [outcome, count] of Object.entries(counts)) {
    lines.push(`| ${outcome} | ${count} |`);
  }
  lines.push('');

  const failures = input.results.filter((r) => r.result.outcome === 'failed');
  if (failures.length > 0) {
    lines.push('## Failures');
    lines.push('');
    lines.push('| Action | HTTP | Error |');
    lines.push('| --- | ---: | --- |');
    for (const { action, result } of failures) {
      const detail = 'error' in result ? (result.error ?? '') : '';
      const status = 'httpStatus' in result ? (result.httpStatus ?? '') : '';
      lines.push(`| ${escape(action.summary)} | ${status} | ${escape(detail)} |`);
    }
    lines.push('');
  }

  const skipped = input.results.filter(
    (r) => r.result.outcome === 'skipped' && r.action.destructive,
  );
  if (skipped.length > 0) {
    lines.push('## Removals not applied');
    lines.push('');
    lines.push('These were planned but skipped. Re-run with `--allow-removals` to apply them.');
    lines.push('');
    for (const { action } of skipped) lines.push(`- ${escape(action.summary)}`);
    lines.push('');
  }

  if (input.missingGithub.length > 0) {
    lines.push('## Students without a GitHub account');
    lines.push('');
    lines.push(
      'These students are on a team but never supplied a username, so there is nobody to invite yet.',
    );
    lines.push('');
    lines.push('| Student | Team | Email |');
    lines.push('| --- | ---: | --- |');
    for (const student of [...input.missingGithub].sort((a, b) => a.team - b.team)) {
      lines.push(`| ${escape(student.fullName)} | ${student.team} | ${escape(student.email ?? '—')} |`);
    }
    lines.push('');
  }

  const notable = input.issues.filter((i) => i.level !== 'info');
  if (notable.length > 0) {
    lines.push('## Roster issues');
    lines.push('');
    lines.push('| Level | Student | Issue |');
    lines.push('| --- | --- | --- |');
    for (const issue of notable) {
      lines.push(`| ${issue.level} | ${escape(issue.student ?? '—')} | ${escape(issue.message)} |`);
    }
    lines.push('');
  }

  lines.push('## Actions');
  lines.push('');
  if (input.results.length === 0) {
    lines.push('Nothing to do — GitHub already matches the roster.');
  } else {
    lines.push('| Action | Outcome |');
    lines.push('| --- | --- |');
    for (const { action, result } of input.results) {
      lines.push(`| ${escape(action.summary)} | ${result.outcome} |`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

export function renderCsv(input: ReportInput): string {
  const rows = [['kind', 'resource', 'summary', 'destructive', 'outcome', 'http_status', 'error']];
  for (const { action, result } of input.results) {
    rows.push([
      action.kind,
      action.resourceId,
      action.summary,
      String(action.destructive),
      result.outcome,
      'httpStatus' in result ? String(result.httpStatus ?? '') : '',
      'error' in result ? (result.error ?? '') : '',
    ]);
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

function tally(input: ReportInput): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { result } of input.results) {
    counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
  }
  return counts;
}

function escape(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

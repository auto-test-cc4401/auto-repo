import { describe, expect, it, vi } from 'vitest';
import { executePlan } from '../src/cli/execute-plan.js';
import type { GitHubClient } from '../src/github/client.js';
import type { Action } from '../src/core/types.js';
import { openDb } from '../src/db/index.js';
import { actions as actionsTable, runs } from '../src/db/schema.js';
import { finishRun, recordAction, startRun } from '../src/db/persist.js';
import { testConfig } from './helpers.js';

const config = testConfig();

function action(over: Partial<Action> & Pick<Action, 'kind'>): Action {
  return {
    resourceId: `${over.kind}:x`,
    summary: over.summary ?? over.kind,
    destructive: false,
    teamNumber: 1,
    slug: '2026-2-cc4401-grupo-1',
    ...over,
  };
}

/** Octokit stub that fails only for the logins named in `failing`. */
function fakeClient(failing: string[] = []): GitHubClient {
  const request = vi.fn(async (_route: string, params: Record<string, unknown>) => {
    const username = String(params.username ?? '');
    if (failing.includes(username)) {
      throw Object.assign(new Error(`Not Found: ${username}`), { status: 404 });
    }
    return { status: 201 };
  });
  return { auth: { mode: 'pat', options: {}, description: 'test' }, octokit: { request } } as unknown as GitHubClient;
}

describe('executePlan', () => {
  it('keeps going after a failure instead of aborting the run', async () => {
    // One unreachable account must not discard the results of the rest of the
    // plan, nor the audit record of what already succeeded.
    const plan = [
      action({ kind: 'add-member', login: 'ana', summary: 'Add ana' }),
      action({ kind: 'add-member', login: 'ghost', summary: 'Add ghost' }),
      action({ kind: 'add-member', login: 'bob', summary: 'Add bob' }),
    ];

    const executed = await executePlan(fakeClient(['ghost']), config, plan, {
      allowRemovals: false,
    });

    expect(executed).toHaveLength(3);
    const byLogin = new Map(executed.map((e) => [e.action.login, e.result.outcome]));
    expect(byLogin.get('ana')).toBe('succeeded');
    expect(byLogin.get('bob')).toBe('succeeded');
    expect(byLogin.get('ghost')).toBe('failed');

    const ghost = executed.find((e) => e.action.login === 'ghost')!;
    expect('httpStatus' in ghost.result && ghost.result.httpStatus).toBe(404);
  });

  it('skips removals unless they are explicitly allowed', async () => {
    const plan = [
      action({ kind: 'add-member', login: 'ana', summary: 'Add ana' }),
      action({ kind: 'remove-member', login: 'gone', summary: 'Remove gone', destructive: true }),
    ];

    const skipped = await executePlan(fakeClient(), config, plan, { allowRemovals: false });
    expect(skipped.find((e) => e.action.destructive)!.result.outcome).toBe('skipped');

    const applied = await executePlan(fakeClient(), config, plan, { allowRemovals: true });
    expect(applied.find((e) => e.action.destructive)!.result.outcome).toBe('succeeded');
  });

  it('creates a bare private repo and never uses a template', async () => {
    const request = vi.fn(async () => ({ status: 201 }));
    const client = {
      auth: { mode: 'pat', options: {}, description: 'test' },
      octokit: { request },
    } as unknown as GitHubClient;

    await executePlan(
      client,
      config,
      [action({ kind: 'create-repo', repoName: '2026-2-CC4401-grupo-1' })],
      { allowRemovals: false },
    );

    expect(request).toHaveBeenCalledWith(
      'POST /orgs/{org}/repos',
      expect.objectContaining({
        org: 'DCC-CC4401',
        name: '2026-2-CC4401-grupo-1',
        private: true,
        auto_init: true,
      }),
    );
    // Templating was removed outright; nothing should reach the generate endpoint.
    for (const [route] of request.mock.calls as unknown as [string][]) {
      expect(route).not.toContain('/generate');
    }
  });

  it('runs creates before grants before memberships', async () => {
    const order: string[] = [];
    const request = vi.fn(async (route: string) => {
      order.push(route);
      return { status: 201 };
    });
    const client = {
      auth: { mode: 'pat', options: {}, description: 'test' },
      octokit: { request },
    } as unknown as GitHubClient;

    await executePlan(
      client,
      config,
      [
        action({ kind: 'add-member', login: 'ana' }),
        action({ kind: 'grant-team-repo', repoName: 'r', permission: 'push' }),
        action({ kind: 'create-team', teamName: 't' }),
        action({ kind: 'create-repo', repoName: 'r' }),
      ],
      { allowRemovals: false },
    );

    expect(order[order.length - 1]).toContain('memberships');
    expect(order.findIndex((r) => r.includes('teams/{team_slug}/repos'))).toBeGreaterThan(
      order.findIndex((r) => r.includes('POST /orgs/{org}/teams')),
    );
  });
});

describe('audit trail', () => {
  it('records every action, including the failed one', async () => {
    const db = openDb(':memory:');
    const runId = startRun(db, {
      command: 'apply',
      actorLogin: 'tester',
      authMode: 'pat',
      dryRun: false,
      allowRemovals: false,
    });

    const plan = [
      action({ kind: 'add-member', login: 'ana', summary: 'Add ana' }),
      action({ kind: 'add-member', login: 'ghost', summary: 'Add ghost' }),
    ];
    const executed = await executePlan(fakeClient(['ghost']), config, plan, {
      allowRemovals: false,
    });
    for (const { action: a, result } of executed) recordAction(db, runId, a, result);
    finishRun(db, runId, 1);

    const rows = db.select().from(actionsTable).all();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.outcome === 'succeeded')).toHaveLength(1);

    const failure = rows.find((r) => r.outcome === 'failed')!;
    expect(failure.httpStatus).toBe(404);
    expect(failure.error).toContain('ghost');

    // The run is closed out even though an action failed, so the record of
    // what did succeed survives.
    const run = db.select().from(runs).all()[0]!;
    expect(run.finishedAt).not.toBeNull();
    expect(run.exitStatus).toBe(1);
  });
});

import pLimit from 'p-limit';
import type { CourseConfig } from '../core/config.js';
import type { Action } from '../core/types.js';
import { executeAction, type ExecutionResult } from '../github/execute.js';
import type { GitHubClient } from '../github/client.js';

const CONCURRENCY = 6;

export type Outcome = ExecutionResult | { outcome: 'planned' | 'skipped' };

export interface ExecutedAction {
  action: Action;
  result: Outcome;
}

/**
 * Actions are not independent: a team must exist before it can be granted a
 * repo or gain members, and a repo must exist before it can be granted. So they
 * run in dependency phases, concurrently within each phase and never across.
 */
const PHASES: Action['kind'][][] = [
  ['create-team', 'create-repo'],
  ['grant-team-repo'],
  ['add-member', 'remove-member'],
];

export interface ApplyOptions {
  allowRemovals: boolean;
  onResult?: (executed: ExecutedAction) => void;
}

/**
 * Execute a plan.
 *
 * Every action is isolated: a failure is recorded and the run continues. This is
 * the direct fix for the v1 bug where a single 404 rejected Promise.all, skipped
 * the .then(), and threw away the log of everything that had already succeeded.
 */
export async function executePlan(
  client: GitHubClient,
  config: CourseConfig,
  actions: Action[],
  options: ApplyOptions,
): Promise<ExecutedAction[]> {
  const executed: ExecutedAction[] = [];

  for (const kinds of PHASES) {
    const phase = actions.filter((a) => kinds.includes(a.kind));
    if (phase.length === 0) continue;

    const limit = pLimit(CONCURRENCY);
    const results = await Promise.all(
      phase.map((action) =>
        limit(async (): Promise<ExecutedAction> => {
          if (action.destructive && !options.allowRemovals) {
            return { action, result: { outcome: 'skipped' } };
          }
          const result = await executeAction(client, config, action);
          return { action, result };
        }),
      ),
    );

    for (const result of results) {
      executed.push(result);
      options.onResult?.(result);
    }

    // If creating the teams and repos failed wholesale, the later phases would
    // only produce a cascade of confusing 404s.
    if (kinds.includes('create-team') && results.every((r) => r.result.outcome === 'failed')) {
      break;
    }
  }

  return executed;
}

import type { CourseConfig } from '../core/config.js';
import type { Action } from '../core/types.js';
import type { GitHubClient } from './client.js';

export interface ExecutionResult {
  outcome: 'succeeded' | 'skipped' | 'failed';
  httpStatus: number | null;
  error: string | null;
  durationMs: number;
}

/**
 * Perform one action.
 *
 * Errors are captured and returned rather than thrown: every action must be
 * independently survivable so that one bad username cannot take down the run
 * and lose the audit trail with it.
 */
export async function executeAction(
  client: GitHubClient,
  config: CourseConfig,
  action: Action,
): Promise<ExecutionResult> {
  const started = Date.now();
  try {
    const httpStatus = await perform(client, config, action);
    return { outcome: 'succeeded', httpStatus, error: null, durationMs: Date.now() - started };
  } catch (error) {
    return {
      outcome: 'failed',
      httpStatus: statusOf(error),
      error: messageOf(error),
      durationMs: Date.now() - started,
    };
  }
}

async function perform(
  client: GitHubClient,
  config: CourseConfig,
  action: Action,
): Promise<number> {
  const { octokit } = client;
  const org = config.org;

  switch (action.kind) {
    case 'create-team': {
      const { status } = await octokit.request('POST /orgs/{org}/teams', {
        org,
        name: action.teamName ?? action.slug,
        description: `Grupo ${action.teamNumber} — ${config.course} ${config.year}-${config.semester}`,
        privacy: 'secret',
      });
      return status;
    }

    case 'create-repo': {
      const name = action.repoName!;
      // Repos are created bare. Setting up the project is the students' work,
      // and `auto_init` only gives them a default branch to push to.
      const { status } = await octokit.request('POST /orgs/{org}/repos', {
        org,
        name,
        private: true,
        auto_init: config.autoInit,
        has_issues: true,
        has_wiki: false,
        has_projects: false,
      });
      return status;
    }

    case 'grant-team-repo': {
      const { status } = await octokit.request(
        'PUT /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}',
        {
          org,
          team_slug: action.slug,
          owner: org,
          repo: action.repoName!,
          permission: action.permission ?? config.permission,
        },
      );
      return status;
    }

    case 'add-member': {
      const { status } = await octokit.request(
        'PUT /orgs/{org}/teams/{team_slug}/memberships/{username}',
        { org, team_slug: action.slug, username: action.login!, role: 'member' },
      );
      return status;
    }

    case 'remove-member': {
      const { status } = await octokit.request(
        'DELETE /orgs/{org}/teams/{team_slug}/memberships/{username}',
        { org, team_slug: action.slug, username: action.login! },
      );
      return status;
    }
  }
}

function statusOf(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

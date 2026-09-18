import pLimit from 'p-limit';
import type { ActualState, ActualTeam, MembershipState, Permission } from '../core/types.js';
import type { GitHubClient } from './client.js';

const CONCURRENCY = 6;

/**
 * Read the current GitHub footprint for one semester.
 *
 * Only teams and repos carrying the semester prefix are inspected, so an org
 * holding several years of course repos costs the same as a fresh one.
 */
export async function readActualState(
  client: GitHubClient,
  org: string,
  prefix: string,
): Promise<ActualState> {
  const { octokit } = client;
  const needle = prefix.toLowerCase();

  const [allTeams, allRepos] = await Promise.all([
    octokit.paginate('GET /orgs/{org}/teams', { org, per_page: 100 }),
    octokit.paginate('GET /orgs/{org}/repos', { org, per_page: 100, type: 'all' }),
  ]);

  const repos: ActualState['repos'] = new Map();
  for (const repo of allRepos) {
    if (!repo.name.toLowerCase().startsWith(needle)) continue;
    repos.set(repo.name.toLowerCase(), {
      name: repo.name,
      id: repo.id,
      private: repo.private,
    });
  }

  const relevant = allTeams.filter((t) => t.slug.toLowerCase().startsWith(needle));
  const limit = pLimit(CONCURRENCY);
  const detailed = await Promise.all(
    relevant.map((team) =>
      limit(() => readTeam(client, org, team.slug, team.id, expectedRepoFor(team.slug, repos))),
    ),
  );

  const teams: ActualState['teams'] = new Map();
  for (const team of detailed) teams.set(team.slug.toLowerCase(), team);

  return { teams, repos };
}

/** A group team owns the repo of the same name; nothing else is inspected. */
function expectedRepoFor(slug: string, repos: ActualState['repos']): string | null {
  return repos.get(slug.toLowerCase())?.name ?? null;
}

async function readTeam(
  client: GitHubClient,
  org: string,
  slug: string,
  id: number,
  repoName: string | null,
): Promise<ActualTeam> {
  const { octokit } = client;

  const [members, invitations, teamRepos] = await Promise.all([
    octokit.paginate('GET /orgs/{org}/teams/{team_slug}/members', {
      org,
      team_slug: slug,
      per_page: 100,
    }),
    octokit.paginate('GET /orgs/{org}/teams/{team_slug}/invitations', {
      org,
      team_slug: slug,
      per_page: 100,
    }),
    repoName
      ? octokit.paginate('GET /orgs/{org}/teams/{team_slug}/repos', {
          org,
          team_slug: slug,
          per_page: 100,
        })
      : Promise.resolve([]),
  ]);

  const state = new Map<string, MembershipState>();
  for (const member of members) {
    if (member.login) state.set(member.login.toLowerCase(), 'active');
  }
  // Someone invited but not yet accepted still counts as present: re-inviting
  // them would only spam them, and the rubric's "Acceso al repo" row cares
  // about the distinction, so it is preserved rather than flattened.
  for (const invitation of invitations) {
    const login = invitation.login;
    if (login && !state.has(login.toLowerCase())) {
      state.set(login.toLowerCase(), 'pending');
    }
  }

  const grant = repoName
    ? teamRepos.find((r) => r.name.toLowerCase() === repoName.toLowerCase())
    : undefined;

  return {
    slug,
    id,
    members: state,
    repoPermission: (grant?.role_name as Permission | undefined) ?? null,
  };
}

export interface LoginCheck {
  login: string;
  exists: boolean;
  /** Numeric GitHub id — stable across username changes, unlike the login. */
  id: number | null;
}

/**
 * Verify every login against the API *before* any mutation runs.
 *
 * This is the fix for the original tool's fatal flaw: one typo'd username threw
 * inside Promise.all, rejected the whole run, and skipped writing the log, so
 * the record of the students who *had* been added was lost.
 */
export async function checkLogins(
  client: GitHubClient,
  logins: string[],
): Promise<Map<string, LoginCheck>> {
  const limit = pLimit(CONCURRENCY);
  const unique = [...new Set(logins.map((l) => l.toLowerCase()))];

  const results = await Promise.all(
    unique.map((login) =>
      limit(async (): Promise<LoginCheck> => {
        try {
          const { data } = await client.octokit.request('GET /users/{username}', {
            username: login,
          });
          return { login, exists: true, id: data.id };
        } catch (error) {
          if (isStatus(error, 404)) return { login, exists: false, id: null };
          throw error;
        }
      }),
    ),
  );

  return new Map(results.map((r) => [r.login, r]));
}

export function isStatus(error: unknown, status: number): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status: unknown }).status === status
  );
}

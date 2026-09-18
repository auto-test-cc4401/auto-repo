import type {
  Action,
  ActualState,
  ActualTeam,
  DesiredState,
  DesiredTeam,
  MembershipState,
  Permission,
} from './types.js';

/**
 * Compute the actions needed to bring GitHub in line with the roster.
 *
 * Pure: no I/O, no clock, no randomness. This is what makes re-running safe —
 * a converged org produces an empty action list — and it is where the bulk of
 * the test suite points.
 *
 * Teams and repositories are never deleted, and repos that exist but are not in
 * the roster are left completely alone. The only destructive action produced is
 * removing a person from a team, and `apply` skips those unless explicitly
 * allowed.
 */
export function diff(
  desired: DesiredState,
  actual: ActualState,
  permission: Permission,
): Action[] {
  const actions: Action[] = [];

  for (const team of desired.teams) {
    const key = team.slug.toLowerCase();
    const actualTeam = actual.teams.get(key);
    const actualRepo = actual.repos.get(team.repoName.toLowerCase());

    if (!actualTeam) {
      actions.push({
        kind: 'create-team',
        resourceId: `team:${team.slug}`,
        summary: `Create team ${team.slug}`,
        destructive: false,
        teamNumber: team.number,
        slug: team.slug,
        teamName: team.teamName,
      });
    }

    if (!actualRepo) {
      actions.push({
        kind: 'create-repo',
        resourceId: `repo:${team.repoName}`,
        summary: `Create private repo ${team.repoName}`,
        destructive: false,
        teamNumber: team.number,
        slug: team.slug,
        repoName: team.repoName,
      });
    }

    // A missing team or repo means the grant cannot exist yet either.
    if (!actualTeam || !actualRepo || actualTeam.repoPermission !== permission) {
      actions.push({
        kind: 'grant-team-repo',
        resourceId: `grant:${team.slug}:${team.repoName}`,
        summary: `Grant ${team.slug} "${permission}" on ${team.repoName}`,
        destructive: false,
        teamNumber: team.number,
        slug: team.slug,
        repoName: team.repoName,
        permission,
      });
    }

    actions.push(...membershipActions(team, actualTeam));
  }

  return actions;
}

function membershipActions(team: DesiredTeam, actualTeam: ActualTeam | undefined): Action[] {
  const actions: Action[] = [];
  const desiredMembers = new Set(team.memberLogins.map((l) => l.toLowerCase()));
  const actualMembers = actualTeam?.members ?? new Map<string, MembershipState>();

  for (const login of [...desiredMembers].sort()) {
    // A pending invitation already exists for this person; re-sending it would
    // just spam them, so a pending member counts as present.
    if (actualMembers.has(login)) continue;
    actions.push({
      kind: 'add-member',
      resourceId: `member:${team.slug}:${login}`,
      summary: `Add ${login} to ${team.slug}`,
      destructive: false,
      teamNumber: team.number,
      slug: team.slug,
      login,
    });
  }

  for (const login of [...actualMembers.keys()].sort()) {
    if (desiredMembers.has(login)) continue;
    actions.push({
      kind: 'remove-member',
      resourceId: `member:${team.slug}:${login}`,
      summary: `Remove ${login} from ${team.slug}`,
      destructive: true,
      teamNumber: team.number,
      slug: team.slug,
      login,
    });
  }

  return actions;
}

export function summarize(actions: Action[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const action of actions) counts[action.kind] = (counts[action.kind] ?? 0) + 1;
  return counts;
}

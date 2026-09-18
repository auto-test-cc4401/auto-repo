/** Domain types shared across the reconcile pipeline. */

/** Repository permission levels GitHub accepts for a team. */
export type Permission = 'pull' | 'triage' | 'push' | 'maintain' | 'admin';

/** A student as it appears in the normalized roster (desired state). */
export interface Student {
  fullName: string;
  email: string | null;
  /**
   * GitHub login, already normalized to a bare login.
   * `null` is a legitimate state: the student is on a team but never submitted
   * the form, so there is nobody to invite yet. It is reported, never fatal.
   */
  githubLogin: string | null;
  section: number;
  /** Team number, globally unique across sections. */
  team: number;
}

/** One group's desired GitHub footprint. */
export interface DesiredTeam {
  number: number;
  /** Display name used when creating the team, e.g. `2026-2-CC4401-grupo-5`. */
  teamName: string;
  /**
   * GitHub team slug. GitHub lowercases and slugifies team names, so this is
   * the lowercased form and is what every team API path must use.
   */
  slug: string;
  /** Repository name. Same string as `teamName`; repo names keep their case. */
  repoName: string;
  /** Bare GitHub logins that should be members, lowercased for comparison. */
  memberLogins: string[];
}

export interface DesiredState {
  org: string;
  prefix: string;
  teams: DesiredTeam[];
}

/** Membership state as GitHub reports it. */
export type MembershipState = 'active' | 'pending';

export interface ActualTeam {
  slug: string;
  id: number;
  members: Map<string, MembershipState>;
  /** Permission the team holds on its repo, or null if no grant exists. */
  repoPermission: Permission | null;
}

export interface ActualRepo {
  name: string;
  id: number;
  private: boolean;
}

export interface ActualState {
  /** Keyed by lowercased slug. */
  teams: Map<string, ActualTeam>;
  /** Keyed by lowercased repo name. */
  repos: Map<string, ActualRepo>;
}

export type ActionKind =
  | 'create-team'
  | 'create-repo'
  | 'grant-team-repo'
  | 'add-member'
  | 'remove-member';

export interface Action {
  kind: ActionKind;
  /** Stable identifier for the resource this action targets, for the audit log. */
  resourceId: string;
  /** Human-readable one-liner shown by `plan`. */
  summary: string;
  /**
   * Destructive actions are planned and displayed but skipped by `apply`
   * unless `--allow-removals` is passed.
   */
  destructive: boolean;
  teamNumber: number;
  slug: string;
  /** Display name, needed when creating the team (GitHub derives the slug). */
  teamName?: string;
  repoName?: string;
  login?: string;
  permission?: Permission;
}

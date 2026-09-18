import { describe, expect, it } from 'vitest';
import { diff, summarize } from '../src/core/diff.js';
import type { ActualState, DesiredState, MembershipState } from '../src/core/types.js';

const PREFIX = '2026-2-CC4401';

function desired(teams: { number: number; members: string[] }[]): DesiredState {
  return {
    org: 'DCC-CC4401',
    prefix: PREFIX,
    teams: teams.map((t) => ({
      number: t.number,
      teamName: `${PREFIX}-grupo-${t.number}`,
      slug: `${PREFIX}-grupo-${t.number}`.toLowerCase(),
      repoName: `${PREFIX}-grupo-${t.number}`,
      memberLogins: t.members.map((m) => m.toLowerCase()).sort(),
    })),
  };
}

function actual(
  teams: { number: number; members: Record<string, MembershipState>; permission?: string }[],
): ActualState {
  const state: ActualState = { teams: new Map(), repos: new Map() };
  for (const team of teams) {
    const name = `${PREFIX}-grupo-${team.number}`;
    state.repos.set(name.toLowerCase(), { name, id: 1000 + team.number, private: true });
    state.teams.set(name.toLowerCase(), {
      slug: name.toLowerCase(),
      id: team.number,
      members: new Map(Object.entries(team.members) as [string, MembershipState][]),
      repoPermission: (team.permission ?? 'push') as 'push',
    });
  }
  return state;
}

const empty: ActualState = { teams: new Map(), repos: new Map() };

describe('diff', () => {
  it('provisions a fresh semester from nothing', () => {
    const actions = diff(desired([{ number: 1, members: ['ana', 'bob'] }]), empty, 'push');
    expect(summarize(actions)).toEqual({
      'create-team': 1,
      'create-repo': 1,
      'grant-team-repo': 1,
      'add-member': 2,
    });
    // Ordering matters downstream: nothing can be granted or joined before the
    // team and repo exist.
    expect(actions[0]!.kind).toBe('create-team');
    expect(actions[1]!.kind).toBe('create-repo');
  });

  it('is a no-op when GitHub already matches the roster', () => {
    const state = actual([{ number: 1, members: { ana: 'active', bob: 'active' } }]);
    expect(diff(desired([{ number: 1, members: ['ana', 'bob'] }]), state, 'push')).toEqual([]);
  });

  it('adds only the late enrollment on a re-run', () => {
    const state = actual([{ number: 1, members: { ana: 'active' } }]);
    const actions = diff(desired([{ number: 1, members: ['ana', 'bob'] }]), state, 'push');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'add-member', login: 'bob', destructive: false });
  });

  it('treats a pending invitation as present so nobody is re-invited', () => {
    const state = actual([{ number: 1, members: { ana: 'active', bob: 'pending' } }]);
    expect(diff(desired([{ number: 1, members: ['ana', 'bob'] }]), state, 'push')).toEqual([]);
  });

  it('marks a dropped student as a destructive removal', () => {
    const state = actual([{ number: 1, members: { ana: 'active', gone: 'active' } }]);
    const actions = diff(desired([{ number: 1, members: ['ana'] }]), state, 'push');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'remove-member', login: 'gone', destructive: true });
  });

  it('handles a team change as a removal plus an addition', () => {
    const state = actual([
      { number: 1, members: { mover: 'active' } },
      { number: 2, members: {} },
    ]);
    const actions = diff(
      desired([
        { number: 1, members: [] },
        { number: 2, members: ['mover'] },
      ]),
      state,
      'push',
    );
    expect(actions.filter((a) => a.kind === 'remove-member')).toHaveLength(1);
    expect(actions.filter((a) => a.kind === 'add-member')).toHaveLength(1);
  });

  it('treats a renamed GitHub account as a swap, not a silent drop', () => {
    const state = actual([{ number: 1, members: { oldname: 'active' } }]);
    const actions = diff(desired([{ number: 1, members: ['newname'] }]), state, 'push');
    expect(actions.map((a) => a.kind).sort()).toEqual(['add-member', 'remove-member']);
  });

  it('is case-insensitive about logins', () => {
    const state = actual([{ number: 1, members: { anita: 'active' } }]);
    expect(diff(desired([{ number: 1, members: ['ANITA'] }]), state, 'push')).toEqual([]);
  });

  it('re-grants when the permission drifted from the configured level', () => {
    const state = actual([{ number: 1, members: { ana: 'active' }, permission: 'admin' }]);
    const actions = diff(desired([{ number: 1, members: ['ana'] }]), state, 'push');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: 'grant-team-repo', permission: 'push' });
  });

  it('leaves repos that are not in the roster completely alone', () => {
    const state = actual([
      { number: 1, members: { ana: 'active' } },
      { number: 99, members: { someone: 'active' } },
    ]);
    expect(diff(desired([{ number: 1, members: ['ana'] }]), state, 'push')).toEqual([]);
  });

  it('never emits a team or repo deletion', () => {
    const state = actual([{ number: 1, members: { a: 'active', b: 'active' } }]);
    const actions = diff(desired([]), state, 'push');
    expect(actions).toEqual([]);
  });

  it('creates a repo for a team that exists but has no repository yet', () => {
    const state: ActualState = { teams: new Map(), repos: new Map() };
    const name = `${PREFIX}-grupo-3`;
    state.teams.set(name.toLowerCase(), {
      slug: name.toLowerCase(),
      id: 3,
      members: new Map([['ana', 'active']]),
      repoPermission: null,
    });
    const actions = diff(desired([{ number: 3, members: ['ana'] }]), state, 'push');
    expect(actions.map((a) => a.kind)).toEqual(['create-repo', 'grant-team-repo']);
  });
});

import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * An in-memory stand-in for the subset of the GitHub API that auto-repo calls.
 *
 * It exists so the end-to-end tests can drive the real CLI — including the
 * database and report writers — without network access or credentials.
 *
 * It is written from the documented API, so it verifies that the tool's own
 * wiring is correct; it cannot verify that the endpoint paths and payload
 * shapes match what GitHub actually accepts. Only a run against the real API
 * can do that.
 */

export interface StubTeam {
  id: number;
  slug: string;
  name: string;
  /** login (lowercased) -> membership state */
  members: Map<string, 'active' | 'pending'>;
  /** repo name (lowercased) -> permission */
  repos: Map<string, string>;
}

export interface StubRepo {
  id: number;
  name: string;
  private: boolean;
  autoInit: boolean;
}

export interface StubState {
  org: string;
  /** Logins the stub considers to be real GitHub accounts. */
  knownUsers: Set<string>;
  /** Logins that are already members of the org; these join teams as active. */
  orgMembers: Set<string>;
  teams: Map<string, StubTeam>;
  repos: Map<string, StubRepo>;
  /** Every request received, for asserting on payloads. */
  calls: { method: string; path: string; body: unknown }[];
}

export interface StubServer {
  url: string;
  state: StubState;
  close(): Promise<void>;
}

/** GitHub lowercases a team name and replaces runs of non-alphanumerics. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function startGithubStub(options: {
  org: string;
  knownUsers: string[];
  orgMembers?: string[];
}): Promise<StubServer> {
  const state: StubState = {
    org: options.org,
    knownUsers: new Set(options.knownUsers.map((u) => u.toLowerCase())),
    orgMembers: new Set((options.orgMembers ?? []).map((u) => u.toLowerCase())),
    teams: new Map(),
    repos: new Map(),
    calls: [],
  };

  let nextId = 1000;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }

      const method = req.method ?? 'GET';
      const path = (req.url ?? '').split('?')[0]!;
      state.calls.push({ method, path, body });

      const send = (status: number, payload: unknown = null) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(payload === null ? '' : JSON.stringify(payload));
      };

      const route = handle(state, method, path, body, () => ++nextId);
      send(route.status, route.payload);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

interface Route {
  status: number;
  payload: unknown;
}

function handle(
  state: StubState,
  method: string,
  path: string,
  body: unknown,
  nextId: () => number,
): Route {
  const org = state.org;
  const segments = path.split('/').filter(Boolean);
  const payload = (body ?? {}) as Record<string, unknown>;

  if (method === 'GET' && path === '/user') {
    return { status: 200, payload: { login: 'stub-actor', id: 1, type: 'User' } };
  }

  if (method === 'GET' && path === '/rate_limit') {
    return {
      status: 200,
      payload: { resources: { core: { limit: 5000, remaining: 4999, reset: 0 } } },
    };
  }

  // GET /users/{username}
  if (method === 'GET' && segments[0] === 'users' && segments.length === 2) {
    const login = segments[1]!.toLowerCase();
    if (!state.knownUsers.has(login)) {
      return { status: 404, payload: { message: 'Not Found' } };
    }
    return { status: 200, payload: { login: segments[1], id: hashId(login) } };
  }

  if (segments[0] !== 'orgs' || segments[1]?.toLowerCase() !== org.toLowerCase()) {
    return { status: 404, payload: { message: 'Not Found' } };
  }

  // GET /orgs/{org}
  if (method === 'GET' && segments.length === 2) {
    return { status: 200, payload: { login: org, id: 99 } };
  }

  // GET|POST /orgs/{org}/repos
  if (segments[2] === 'repos' && segments.length === 3) {
    if (method === 'GET') {
      return { status: 200, payload: [...state.repos.values()] };
    }
    if (method === 'POST') {
      const name = String(payload.name);
      const repo: StubRepo = {
        id: nextId(),
        name,
        private: payload.private === true,
        autoInit: payload.auto_init === true,
      };
      state.repos.set(name.toLowerCase(), repo);
      return { status: 201, payload: repo };
    }
  }

  // GET|POST /orgs/{org}/teams
  if (segments[2] === 'teams' && segments.length === 3) {
    if (method === 'GET') {
      return {
        status: 200,
        payload: [...state.teams.values()].map((t) => ({
          id: t.id,
          slug: t.slug,
          name: t.name,
        })),
      };
    }
    if (method === 'POST') {
      const name = String(payload.name);
      const slug = slugify(name);
      const team: StubTeam = {
        id: nextId(),
        slug,
        name,
        members: new Map(),
        repos: new Map(),
      };
      state.teams.set(slug, team);
      return { status: 201, payload: { id: team.id, slug, name } };
    }
  }

  // Everything below is scoped to a team.
  if (segments[2] !== 'teams' || segments.length < 5) {
    return { status: 404, payload: { message: 'Not Found' } };
  }

  const team = state.teams.get(segments[3]!.toLowerCase());
  if (!team) return { status: 404, payload: { message: 'Not Found' } };
  const resource = segments[4];

  if (method === 'GET' && resource === 'members') {
    const active = [...team.members.entries()].filter(([, s]) => s === 'active');
    return { status: 200, payload: active.map(([login]) => ({ login, id: hashId(login) })) };
  }

  if (method === 'GET' && resource === 'invitations') {
    const pending = [...team.members.entries()].filter(([, s]) => s === 'pending');
    return { status: 200, payload: pending.map(([login]) => ({ login, id: hashId(login) })) };
  }

  if (method === 'GET' && resource === 'repos') {
    return {
      status: 200,
      payload: [...team.repos.entries()].map(([name, permission]) => ({
        name: state.repos.get(name)?.name ?? name,
        role_name: permission,
      })),
    };
  }

  // PUT /orgs/{org}/teams/{slug}/repos/{owner}/{repo}
  if (method === 'PUT' && resource === 'repos' && segments.length === 7) {
    const repoName = segments[6]!;
    if (!state.repos.has(repoName.toLowerCase())) {
      return { status: 422, payload: { message: 'Repository does not exist' } };
    }
    team.repos.set(repoName.toLowerCase(), String(payload.permission ?? 'pull'));
    return { status: 204, payload: null };
  }

  // PUT|DELETE /orgs/{org}/teams/{slug}/memberships/{username}
  if (resource === 'memberships' && segments.length === 6) {
    const login = segments[5]!.toLowerCase();

    if (method === 'PUT') {
      if (!state.knownUsers.has(login)) {
        return { status: 404, payload: { message: 'Not Found' } };
      }
      // Existing org members join directly; anyone else is invited and stays
      // pending until they accept.
      const membershipState = state.orgMembers.has(login) ? 'active' : 'pending';
      team.members.set(login, membershipState);
      return { status: 200, payload: { state: membershipState, role: 'member' } };
    }

    if (method === 'DELETE') {
      team.members.delete(login);
      return { status: 204, payload: null };
    }
  }

  return { status: 404, payload: { message: 'Not Found' } };
}

function hashId(login: string): number {
  let hash = 0;
  for (const char of login) hash = (hash * 31 + char.charCodeAt(0)) % 100000;
  return hash;
}
